'use strict';

// Two narrow, click-through surfaces leave the portrait and title sampling
// regions uncovered, including on Windows builds that black out protected UI.
const strips={
  team:{x:332,y:145,width:116,height:565},
  bench:{x:521,y:89,width:878,height:25},
};

function selectStripRect(kind,bounds) {
  const strip=strips[kind];
  return {x:Math.round(bounds.x+strip.x*bounds.width/1920), y:Math.round(bounds.y+strip.y*bounds.height/1080),
    width:Math.round(strip.width*bounds.width/1920),height:Math.round(strip.height*bounds.height/1080)};
}

function createSelectOverlays({BrowserWindow,screen,platform=process.platform,htmlPath,preloadPath}) {
  const windows=new Map();
  let current=null;
  function hide() {
    current=null;
    for (const entry of windows.values()) if (!entry.win.isDestroyed() && entry.win.isVisible()) entry.win.hide();
  }
  function get(kind) {
    const existing=windows.get(kind);
    if (existing && !existing.win.isDestroyed()) return existing;
    const win=new BrowserWindow({width:120,height:60,minWidth:1,minHeight:1,frame:false,transparent:true,focusable:false,
      show:false,skipTaskbar:true,resizable:false,hasShadow:false,alwaysOnTop:true,backgroundColor:'#00000000',
      webPreferences:{preload:preloadPath,contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(true);
    win.setAlwaysOnTop(true,'screen-saver');
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',event=>event.preventDefault());
    const entry={win,content:null,position:null,ready:false};
    windows.set(kind,entry);
    win.webContents.on('did-start-loading',()=>{entry.ready=false;});
    win.webContents.on('did-stop-loading',()=>{
      entry.content=null; entry.ready=true;
      if (current && !win.isDestroyed()) render(kind);
    });
    void win.loadFile(htmlPath);
    return entry;
  }
  function render(kind) {
    const {labels,bounds}=current;
    const slots=labels[kind];
    if (!slots.some(Boolean) && !(kind==='team' && labels.bench.some(Boolean))) {
      const old=windows.get(kind)?.win;
      if (old && !old.isDestroyed() && old.isVisible()) old.hide();
      return;
    }
    const entry=get(kind);
    const raw=selectStripRect(kind,bounds);
    const dip=platform==='win32'?screen.screenToDipRect(null,raw):raw;
    const position=JSON.stringify(dip);
    if (position!==entry.position) { entry.win.setBounds(dip); entry.position=position; }
    if (!entry.ready) return;
    const message={kind,slots,mine:labels.mine,patch:labels.patch};
    const content=JSON.stringify(message);
    if (entry.content!==content) { entry.win.webContents.send('overlay:state',message); entry.content=content; }
    if (!entry.win.isVisible()) entry.win.showInactive();
  }
  function draw(labels,bounds) { current={labels,bounds}; render('team'); render('bench'); }
  function destroy() { hide(); for (const {win} of windows.values()) if (!win.isDestroyed()) win.destroy(); windows.clear(); }
  return {hide,draw,destroy};
}
module.exports={createSelectOverlays,selectStripRect};
