const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, nativeImage, net, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createCaptureService } = require('./capture.cjs');
const { readLiveGame } = require('./game-client.cjs');
const { createLocalOcr } = require('./ocr.cjs');
const { createLiveRuntime } = require('./live-runtime.cjs');
const { createCardOverlays } = require('./overlays.cjs');
const { createChampSelect } = require('./champ-select.cjs');
const { createSelectVision, createChampionBank } = require('./champ-select-vision.cjs');
const { createSelectOverlays } = require('./champ-select-overlays.cjs');
const { createDataUpdates } = require('./data-updates.cjs');

let window;
let fullBounds;
let compact = false;
const allowedHosts = new Set(['www.leagueoflegends.com', 'support.riotgames.com', 'developer.riotgames.com', 'raw.communitydragon.org', 'arammayhem.com', 'creativecommons.org', 'github.com', 'aramhex.com']);
if (process.env.HEX_COMPANION_TEST_USER_DATA) app.setPath('userData', process.env.HEX_COMPANION_TEST_USER_DATA);
protocol.registerSchemesAsPrivileged([{scheme:'hexasset', privileges:{standard:true,secure:true}}]);
const appRoot = path.join(__dirname, '../app');
const updates = createDataUpdates({
  appRoot, storage:path.join(app.getPath('userData'), 'data-updates', 'v1'),
  fetcher:(url, options) => net.fetch(url, options), notify:state => send('data:status', state),
});
const iconBase = () => updates.current()?.icons ? `hexasset://catalog/r${updates.current().manifest.revision}/` : '';

function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!window || window.isDestroyed() || event.sender !== window.webContents) throw new Error('不支持的调用来源');
    return callback(event, ...args);
  });
}

function openWindow() {
  window = new BrowserWindow({
    title: '海克斯参谋', width: 1440, height: 970, minWidth: 1060, minHeight: 720,
    backgroundColor: '#10141a', titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: path.join(__dirname, '../app/assets/app-icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.loadFile(path.join(__dirname, '../app/index.html'));
  window.on('closed', () => { stopAll(); overlays.destroy(); selectLabels.destroy(); });
  window.webContents.on('did-start-loading', stopAll);
  const template = [
    ...(process.platform === 'darwin' ? [{ label: '海克斯参谋', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] }] : []),
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'minimize' }, { role: 'close' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

handle('window:pin', () => {
  window.setAlwaysOnTop(!window.isAlwaysOnTop());
  return window.isAlwaysOnTop();
});
handle('window:compact', () => {
  compact = !compact;
  if (compact) {
    fullBounds = window.getBounds();
    window.setMinimumSize(440, 640);
    window.setSize(480, 860);
  } else {
    window.setMinimumSize(1060, 720);
    if (fullBounds) window.setBounds(fullBounds);
  }
  return compact;
});
handle('window:info', () => ({ platform: process.platform, version: app.getVersion(), pinned: window.isAlwaysOnTop() }));
handle('data:load', () => ({tables:updates.current().tables, iconBase:iconBase(), status:updates.status()}));
handle('data:check', () => updates.check());
handle('data:auto', (_event, enabled) => updates.setAutomatic(enabled));
handle('data:apply', () => {
  if (runtime.isRunning()) throw new Error('请先停止本局识别，再应用新数据');
  if (!updates.apply()) return false;
  champSelect.setEnabled(false);
  selectLabels.hide();
  championBank = guideSourceLinks = null;
  return true;
});
handle('session:export', async (_event, content) => {
  if (typeof content !== 'string' || content.length > 262144) throw new Error('对局文件过大');
  JSON.parse(content);
  const result = await dialog.showSaveDialog(window, { title: '导出当前对局', defaultPath: '海克斯参谋-对局.json', filters: [{ name: '对局文件', extensions: ['json'] }] });
  if (result.canceled || !result.filePath) return false;
  await fs.writeFile(result.filePath, content, 'utf8');
  return true;
});
handle('session:import', async () => {
  const result = await dialog.showOpenDialog(window, { title: '导入对局', properties: ['openFile'], filters: [{ name: '对局文件', extensions: ['json'] }] });
  if (result.canceled) return null;
  const file = result.filePaths[0];
  if ((await fs.stat(file)).size > 262144) throw new Error('对局文件不能超过 256 KB');
  return fs.readFile(file, 'utf8');
});
let guideSourceLinks;
async function isGuideSource(url) {
  if (!guideSourceLinks) {
    const {safeSourceUrl} = await import('../app/core/guides.mjs');
    const tables = updates.current().tables;
    guideSourceLinks = new Set([...tables['editorial-guides'], ...tables['community-guides']]
      .map(entry => safeSourceUrl(entry.sourceUrl)).filter(Boolean));
  }
  return guideSourceLinks.has(url.href);
}

handle('link:open', async (_event, value) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (!allowedHosts.has(url.hostname) && !await isGuideSource(url))) throw new Error('不支持此链接');
  await shell.openExternal(url.href);
});
app.whenReady().then(async () => {
  await updates.ready();
  protocol.handle('hexasset', request => {
    const base = iconBase();
    const bytes = base && request.url.startsWith(base) && updates.current().icons.get(request.url.slice(base.length));
    return bytes ? new Response(bytes, {headers:{'Content-Type':'image/png', 'Cache-Control':'public, max-age=31536000, immutable'}})
      : new Response(null, {status:404});
  });
  openWindow();
  void updates.autoCheck();
  setInterval(() => void updates.autoCheck(), 15 * 60 * 1000).unref();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) openWindow(); });
});
app.on('window-all-closed', () => app.quit());

// The three transparent labels follow the selected game window's card titles.
const scriptPath = path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'recognize.ps1');
const capture = createCaptureService({ scriptPath });
const hotkeys = createCaptureService({ scriptPath });
const ocr = createLocalOcr();
let gameWindowId=null;
const diagnosticEvents = [];
let pendingOcrDiagnostic = null;
function recordDiagnostic(data) {
  if (data.type === 'game') return;
  const frame = data.frame;
  const entry = {time:new Date().toISOString(),kind:data.type||'ocr',error:data.error ? {code:data.error.code,message:data.error.message} : null,
    metrics:data.metrics||null,frame:frame ? {width:frame.width,height:frame.height,imageWidth:frame.imageWidth,imageHeight:frame.imageHeight,foreground:frame.foreground} : null};
  diagnosticEvents.push(entry);
  if (data.evidenceId) pendingOcrDiagnostic = {id:data.evidenceId,entry,sentAt:performance.now()};
  if (data.error || data.type === 'window-state') pendingOcrDiagnostic = null;
  if(diagnosticEvents.length>120)diagnosticEvents.shift();
}
function send(channel, payload) { if (window && !window.isDestroyed()) window.webContents.send(channel, payload); }
const overlays = createCardOverlays({ BrowserWindow, screen,
  getIconBase:iconBase,
  preloadPath: path.join(__dirname, 'overlay-preload.cjs'), htmlPath: path.join(__dirname, '../app/overlay.html'),
  onVisibility: state => { champSelect.setVisible(state.enabled); send('overlay:visibility', state); },
});
const selectLabels = createSelectOverlays({BrowserWindow,screen,
  preloadPath:path.join(__dirname,'overlay-preload.cjs'), htmlPath:path.join(__dirname,'../app/champ-select.html')});
let championBank;
function getChampionBank() {
  const {tables, icons} = updates.current();
  championBank ??= createChampionBank(nativeImage, tables.catalog, tables['champion-stats'], appRoot, icons);
  return championBank;
}
const champSelect=createChampSelect({capture:createCaptureService({scriptPath}),
  createVision:()=>createSelectVision({nativeImage,ocr:createLocalOcr(),getBank:getChampionBank}),
  draw:selectLabels.draw,hide:selectLabels.hide,onStatus:value=>send('select:status',value),
  onToggle:id=>{ if (!(runtime.isRunning() && gameWindowId===id)) overlays.toggle(); }});
const runtime = createLiveRuntime({ capture, hotkeys, ocr, readGame: readLiveGame,
  sendFrame: data => { recordDiagnostic(data); send('capture:frame', data); }, sendRecord: slot => send('capture:record', slot),
  onToggle: () => overlays.toggle(), onWindowState: (visible, state) => overlays.setGameVisible(visible, state),
});
function stopCapture() { gameWindowId=null; pendingOcrDiagnostic = null; overlays.clear(); return runtime.stop(); }
function stopAll() { champSelect.setEnabled(false); return stopCapture(); }
handle('select:enabled', (_event,value) => champSelect.setEnabled(process.platform==='win32' && value===true));
handle('capture:windows', () => capture.listWindows());
handle('capture:capabilities', () => capture.capabilities());
handle('capture:stop', async () => { await stopCapture(); return true; });
handle('capture:export-diagnostics', async () => {
  const result=await dialog.showSaveDialog(window,{title:'导出识别诊断',defaultPath:'海克斯参谋-识别诊断.json',filters:[{name:'识别诊断',extensions:['json']}]});
  if(result.canceled||!result.filePath)return false;
  await fs.writeFile(result.filePath,JSON.stringify({schema:1,appVersion:app.getVersion(),platform:process.platform,createdAt:new Date().toISOString(),overlay:overlays.state(),events:diagnosticEvents},null,2),'utf8');
  return true;
});
handle('capture:start', async (_event, options) => {
  gameWindowId=String(options?.windowId || '');
  overlays.clear(); overlays.setEnabled(options?.overlay !== false);
  return runtime.start(options);
});
handle('overlay:visibility', (_event, enabled) => typeof enabled === 'boolean' ? overlays.setEnabled(enabled) : overlays.state());
handle('overlay:toggle', () => overlays.toggle());
handle('overlay:update', (_event, payload) => {
  if (!runtime.isRunning()) return overlays.state();
  runtime.acceptLayout(payload);
  if (pendingOcrDiagnostic && pendingOcrDiagnostic.id === payload?.evidenceId) {
    const {entry,sentAt} = pendingOcrDiagnostic;
    entry.decision = {phase:payload.phase,actionable:payload.actionable===true,rendererRoundTripMs:Math.round(performance.now()-sentAt)};
    pendingOcrDiagnostic = null;
  }
  return overlays.update(payload);
});
app.on('will-quit', stopAll);
