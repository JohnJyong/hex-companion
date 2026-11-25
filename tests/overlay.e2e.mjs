// Test the native labels with the checked-in OCR boxes. An optional matching
// 2189×1123 reference PNG can be used as the background of the layout preview.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { indexCatalog, interactionLabel, rankCandidates } from '../app/core/engine.mjs';
import { emptySession } from '../app/core/session.mjs';
import { matchAugmentFrame } from '../app/core/recognition.mjs';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const { cardRectangles, sanitizeOverlay } = require('../desktop/overlays.cjs');
const originalPath = process.argv[2] || process.env.HEX_OVERLAY_REFERENCE_IMAGE;
const [catalog, augmentStats, frame, original, css, script] = await Promise.all([
  readFile(join(root, 'app/data/catalog.json'), 'utf8').then(JSON.parse),
  readFile(join(root, 'app/data/augment-stats.json'), 'utf8').then(JSON.parse),
  readFile(join(root, 'tests/fixtures/augment-titles.json'), 'utf8').then(JSON.parse),
  originalPath ? readFile(originalPath) : null, readFile(join(root, 'app/overlay.css'), 'utf8'), readFile(join(root, 'app/overlay.js'), 'utf8'),
]);
const db = indexCatalog({ ...catalog, meta:{...catalog.meta, now:augmentStats.meta.asOf}, augmentStats });
const matched = matchAugmentFrame(frame, db, { roi: { x: 0, y: 0, width: 1, height: 1 } });
assert.equal(matched.status, 'matched');
assert.deepEqual(matched.candidates, ['ARAM_Upgrade_IE', 'PatOnTheBack', 'Donation']);
const ranking = rankCandidates({ ...emptySession(), championId: 'Yasuo', candidates: matched.candidates, tier: matched.tier }, db);
const byId = new Map(ranking.map(item => [item.augment.id, item]));
const payload = sanitizeOverlay({
  hero: db.championMap.get('Yasuo').name, phase: 'confirmed', display: true, actionable: true,
  status: '离线标题位置回放',
  layout: { width: frame.width, height: frame.height, bounds: { x: 0, y: 0, width: frame.width, height: frame.height },
    boxes: matched.matches.map(match => match.box) },
  cards: matched.candidates.map((id, slot) => {
    const result = byId.get(id);
    return { slot, name: result.augment.name, tier: result.augment.tier, score: result.score,
      best: id === ranking[0].augment.id, statistics: result.statistics,
      reason: result.reasons?.slice(0, 2).join(' '), warning: result.warnings?.slice(0, 2).join(' ') };
  }),
});
const rects = cardRectangles(payload.layout);
assert.equal(rects.length, 3);
for (let i = 0; i < 3; i++) assert.ok(rects[i].y + rects[i].height < matched.matches[i].box.y, 'each overlay stays above its title');

const temporary = await mkdtemp(join(tmpdir(), 'hex-overlay-e2e-'));
await writeFile(join(temporary, 'main.fixture.cjs'), `
const {app,BrowserWindow,screen}=require('electron');
const {createCardOverlays}=require(${JSON.stringify(join(root, 'desktop/overlays.cjs'))});
app.setPath('userData',${JSON.stringify(temporary)});
globalThis.overlayRecords=[];
class TracedWindow extends BrowserWindow {
  constructor(options){super(options);this.testOptions=options;globalThis.overlayRecords.push(this);}
  setIgnoreMouseEvents(value,options){this.testIgnore={value,options};return super.setIgnoreMouseEvents(value,options);}
}
app.whenReady().then(()=>{
  globalThis.manager=createCardOverlays({BrowserWindow:TracedWindow,screen,
    preloadPath:${JSON.stringify(join(root, 'desktop/overlay-preload.cjs'))},
    htmlPath:${JSON.stringify(join(root, 'app/overlay.html'))},platform:process.platform});
});
app.on('window-all-closed',()=>{});
`);

const app = await electron.launch({ args: [join(temporary, 'main.fixture.cjs')], cwd: root });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => {
  const end = Date.now() + 5000;
  while (!await predicate()) { if (Date.now() >= end) throw new Error('Electron overlay state did not settle'); await delay(30); }
};
const visibility = () => app.evaluate(() => globalThis.overlayRecords.map(window => window.isVisible()));
try {
  await until(() => app.evaluate(() => Boolean(globalThis.manager)));
  // macOS constrains native windows to its 1512px display on this host. Preserve
  // the measured geometry's proportions inside that work area; the exported
  // reference image below still uses the original full-resolution coordinates.
  const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  const nativeScale = Math.min(1, (workArea.width - 80) / frame.width, (workArea.height - 80) / frame.height);
  const nativePayload = { ...payload, layout: {
    width: frame.width * nativeScale, height: frame.height * nativeScale,
    bounds: { x: workArea.x + 40, y: workArea.y + 40, width: frame.width * nativeScale, height: frame.height * nativeScale },
    boxes: payload.layout.boxes.map(box => Object.fromEntries(Object.entries(box).map(([key, value]) => [key, value * nativeScale]))),
  } };
  const nativeRects = cardRectangles(nativePayload.layout);
  await app.evaluate((_electron, value) => { globalThis.manager.setGameVisible(true); globalThis.manager.update(value); }, nativePayload);
  try { await until(async () => (await visibility()).length === 3 && (await visibility()).every(Boolean)); }
  catch (error) {
    const diagnostic = await app.evaluate(() => globalThis.overlayRecords.map(window => ({ visible: window.isVisible(), loading: window.webContents.isLoading(), url: window.webContents.getURL() })));
    throw new Error(`${error.message}: ${JSON.stringify(diagnostic)}`);
  }
  const actual = await app.evaluate(async () => Promise.all(globalThis.overlayRecords.map(async window => ({
    bounds: window.getBounds(), visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(),
    transparent: window.testOptions.transparent, requestedBackground: window.testOptions.backgroundColor, ignore: window.testIgnore,
    cornerAlpha: (await window.webContents.capturePage()).toBitmap()[3],
    alwaysOnTop: window.isAlwaysOnTop(),
    statistics: await window.webContents.executeJavaScript("document.querySelector('#statistics').textContent"),
    rank: await window.webContents.executeJavaScript("document.querySelector('#rank').textContent"),
    heading: await window.webContents.executeJavaScript("document.querySelector('#headline').textContent"),
  }))));
  for (let i = 0; i < actual.length; i++) {
    const window = actual[i], stats = payload.cards[i].statistics;
    assert.deepEqual(window.bounds, nativeRects[i], 'native window coordinates derive from the observed title boxes');
    assert.equal(window.transparent, true); assert.equal(window.requestedBackground, '#00000000');
    assert.equal(window.cornerAlpha, 0, 'the actual renderer surface preserves transparent corners');
    assert.equal(window.focusable, false); assert.equal(window.focused, false);
    assert.equal(window.alwaysOnTop, true);
    assert.deepEqual(window.ignore, { value: true, options: { forward: true } });
    if (stats) {
      assert.ok(window.statistics.includes(`${(stats.winRate * 100).toFixed(1)}%`));
      assert.ok(window.statistics.includes(`${stats.deltaPP > 0 ? '+' : ''}${stats.deltaPP.toFixed(1)}pp`));
      assert.ok(window.rank.includes(stats.games.toLocaleString('zh-CN')));
      assert.ok(window.rank.includes('黄金第'));
    } else assert.ok(window.statistics.includes('暂无该英雄样本'), 'unavailable observations must not become invented rates');
  }
  assert.equal(actual[2].heading, '首选');

  await app.evaluate((_electron, value) => { globalThis.manager.toggle(); globalThis.manager.update(value); }, nativePayload);
  assert.deepEqual(await visibility(), [false, false, false], 'incoming updates cannot undo the hide toggle');
  await app.evaluate(() => { globalThis.manager.setGameVisible(false); globalThis.manager.setGameVisible(true); });
  assert.deepEqual(await visibility(), [false, false, false], 'a foreground transition cannot undo the hide toggle');
  await app.evaluate(() => globalThis.manager.toggle());
  await until(async () => (await visibility()).every(Boolean));
  await app.evaluate(() => globalThis.manager.setGameVisible(false));
  assert.deepEqual(await visibility(), [false, false, false]);
  await app.evaluate(() => globalThis.manager.setGameVisible(true));
  await until(async () => (await visibility()).every(Boolean));
  assert.equal((await visibility()).length, 3, 'updates reuse the same three native windows');

  const idleBuild = {phase:'idle', display:false, cards:[], build:{
    hero:'亚索', route:'暴击持续输出', reason:'升级：无尽之刃', selected:['升级：无尽之刃'], complete:false,
    purchases:['3031','3032','3006'].map(id => { const {name,cost} = db.itemMap.get(id); return {id,name,cost}; }),
  }};
  await app.evaluate((_electron, {bounds,value}) => {
    globalThis.manager.setGameVisible(true, {bounds}); globalThis.manager.update(value);
  }, {bounds:nativePayload.layout.bounds,value:idleBuild});
  await until(async () => (await visibility()).join() === 'false,false,false,true');
  const buildPage = app.windows().find(w => w.url().endsWith('/build-overlay.html'));
  await buildPage.waitForFunction(() => document.querySelector('#item-icon').naturalWidth > 0);
  assert.equal(await buildPage.locator('#item').innerText(), '无尽之刃');
  assert.match(await buildPage.locator('#caption').innerText(), /下一件.*升级：无尽之刃/);
  assert.match(await buildPage.locator('#price').innerText(), /整件/);
  assert.match(await buildPage.locator('#following').innerText(), /育恩塔尔荒野箭 → 狂战士胫甲/);
  assert.match(await buildPage.locator('footer').innerText(), /已记 1 枚.*升级：无尽之刃/);
  assert.ok(await buildPage.evaluate(() => {
    const footer = document.querySelector('footer').getBoundingClientRect();
    return footer.bottom <= innerHeight && document.body.scrollWidth <= innerWidth;
  }));
  await mkdir(join(root,'artifacts'),{recursive:true});
  await buildPage.screenshot({path:join(root,'artifacts/build-overlay-yasuo.png'),omitBackground:true});
  const withCombo = structuredClone(nativePayload);
  withCombo.build = {...idleBuild.build, selected:['巨像的勇气','升级：无尽之刃']};
  const shield = rankCandidates({...emptySession(), championId:'Yasuo', selected:['ARAM_CourageoftheColossus','ARAM_Upgrade_IE'],
    candidates:['ARAM_CriticalHealing', 'PatOnTheBack', 'Donation']}, db).find(entry => entry.augment.id === 'ARAM_CriticalHealing');
  Object.assign(withCombo.cards[0], {name:shield.augment.name, statistics:shield.statistics, warning:'', interaction:interactionLabel(shield.interactions[0])});
  await app.evaluate((_electron,value) => globalThis.manager.update(value),withCombo);
  await until(async () => (await visibility()).filter(Boolean).length === 4);
  assert.match(await buildPage.locator('footer').innerText(), /Ctrl\+Alt\+1\/2\/3/);
  assert.match(await app.evaluate(() => globalThis.overlayRecords[0].webContents.executeJavaScript("document.querySelector('#note').textContent")), /巨像的勇气.*护盾可以暴击/);
  await app.evaluate((_electron, value) => globalThis.manager.update(value), {...idleBuild,build:{...idleBuild.build,purchases:[],complete:true}});
  await buildPage.getByText('六格装备已齐').waitFor();
  assert.equal(await buildPage.locator('#item-icon').isVisible(), false);

  // Hide native windows while rendering a repeatable, full-resolution preview.
  // Iframes use the real overlay CSS/JS and a minimal event bridge, not a redraw.
  await app.evaluate(() => globalThis.manager.setEnabled(false));
  const nextWindow = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, size) => {
    globalThis.referenceWindow = new BrowserWindow({ ...size, show: false, frame: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await globalThis.referenceWindow.loadURL('about:blank');
  }, { width: frame.width, height: frame.height });
  const page = await nextWindow;
  await page.setViewportSize({ width: frame.width, height: frame.height });
  const background = original ? `<img id="reference" src="data:image/png;base64,${original.toString('base64')}">` : '';
  await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#071018}#reference{position:absolute;inset:0;width:100%;height:100%}iframe{position:absolute;border:0;background:transparent}</style>${background}`);
  const frames = rects.map((rect, slot) => {
    const data = JSON.stringify({ ...payload, card: payload.cards[slot], cards: undefined, layout: undefined }).replaceAll('<', '\\u003c');
    return { rect, html: `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${css}</style></head><body><article id="card"><strong id="headline"></strong><div id="statistics"></div><div id="rank"></div><small id="note"></small></article><script>window.desktop={onOverlay:callback=>{callback(${data});return()=>{}}};</script><script>${script}</script></body></html>` };
  });
  await page.evaluate(items => { for (const { rect, html } of items) {
    const iframe = document.createElement('iframe');
    Object.assign(iframe.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    iframe.srcdoc = html; document.body.append(iframe);
  } }, frames);
  await page.waitForFunction(() => {
    const reference = document.querySelector('#reference');
    return (!reference || reference.complete && reference.naturalWidth > 0) && [...document.querySelectorAll('iframe')]
      .every(iframe => iframe.contentDocument?.querySelector('#statistics')?.textContent);
  });
  await mkdir(join(root, 'artifacts'), { recursive: true });
  const previewPath = join(root, 'artifacts', original ? 'overlay-reference.png' : 'overlay-layout.png');
  await page.screenshot({ path: previewPath, animations: 'disabled' });
  console.log('PASS: three native transparent, nonfocusable, click-through-configured overlays; title-derived positions; persistent hide and foreground visibility; factual statistics.');
  console.log('PASS: independently visible purchase panel, packaged item art, later purchases, held augment, and readable combo text with statistics.');
  console.log('Offline layout preview:', previewPath);
} finally { await app.close(); await rm(temporary, { recursive: true, force: true }); }
