'use strict';

const path = require('node:path');
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const text = (value, max = 180) => String(value ?? '').slice(0, max);
const finite = Number.isFinite;
const validBox = b => b && [b.x,b.y,b.width,b.height].every(finite) && b.width > 0 && b.height > 0;

function sanitizeOverlay(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const layout = payload.layout;
  if (!layout || !validBox(layout.bounds) || ![layout.width,layout.height].every(n=>finite(n)&&n>0)
    || !Array.isArray(layout.boxes) || layout.boxes.length !== 3 || !layout.boxes.every(validBox)) return null;
  const boxes=layout.boxes.map(b=>({x:b.x,y:b.y,width:b.width,height:b.height}));
  if (boxes.some(b=>b.x<0||b.y<0||b.x+b.width>layout.width+2||b.y+b.height>layout.height+2)) return null;
  const cards = (Array.isArray(payload.cards)?payload.cards:[]).slice(0,3).map((card,i)=>{
    const s=card.statistics;
    const stats=s&&finite(s.winRate)&&s.winRate>=0&&s.winRate<=1&&Number.isSafeInteger(s.games)&&s.games>0?{
      winRate:s.winRate,games:s.games,deltaPP:finite(s.deltaPP)?s.deltaPP:null,
      tierRank:Number.isInteger(s.tierRank)?s.tierRank:null,tierCount:Number.isInteger(s.tierCount||s.tierTotal)?(s.tierCount||s.tierTotal):null,
      grade:text(s.grade,8),lowSample:s.lowSample===true,asOf:text(s.asOf,40),displayPatch:text(s.displayPatch||s.patch,20),
    }:null;
    return {slot:Number.isInteger(card.slot)&&card.slot>=0&&card.slot<3?card.slot:i,name:text(card.name,60),
      tier:text(card.tier,20),score:finite(card.score)?clamp(card.score,0,100):null,best:card.best===true,
      reason:text(card.reason,140),warning:text(card.warning,120),interaction:text(card.interaction,180),
      guide:text(card.guide,120),conflict:card.conflict===true,pending:card.pending===true,statistics:stats};
  });
  return {hero:text(payload.hero,60),status:text(payload.status),phase:text(payload.phase,24),
    display:payload.display!==false&&cards.length===3,actionable:payload.actionable===true||payload.fresh===true,
    layout:{width:layout.width,height:layout.height,bounds:{x:layout.bounds.x,y:layout.bounds.y,width:layout.bounds.width,height:layout.bounds.height},boxes},cards};
}

function sanitizeBuild(build) {
  if (!build || !build.hero || !Array.isArray(build.purchases) || !Array.isArray(build.selected)) return null;
  const purchases = build.purchases.slice(0, 3);
  if (purchases.some(item => !item || !/^\d{1,7}$/.test(item.id) || !item.name
    || !Number.isSafeInteger(item.cost) || item.cost < 0)) return null;
  if (build.complete === true ? purchases.length > 0 : purchases.length === 0) return null;
  return { hero: text(build.hero, 40), route: text(build.route, 60), reason: text(build.reason, 64), complete: build.complete === true,
    purchases: purchases.map(item => ({id: String(item.id), name: text(item.name, 48), cost: item.cost})),
    selected: build.selected.slice(0, 4).map(name => text(name, 60)) };
}

function cardRectangles(layout) {
  const centers=layout.boxes.map(b=>b.x+b.width/2);
  const gap=Math.min(centers[1]-centers[0],centers[2]-centers[1]);
  if (!finite(gap)||gap<=0) return [];
  const width=Math.min(gap*.84, layout.width*.31, clamp(layout.height*.30,160,420));
  const height=clamp(layout.height*.108,84,150);
  const separation=clamp(layout.height*.014,10,24);
  return layout.boxes.map((box,i)=>({
    x:Math.round(layout.bounds.x+clamp(centers[i]-width/2,0,layout.width-width)),
    y:Math.round(layout.bounds.y+Math.max(0,box.y-height-separation)),
    width:Math.round(width),height:Math.round(height),
  }));
}

function createCardOverlays({BrowserWindow,screen,preloadPath,htmlPath,platform=process.platform,onVisibility=()=>{},getIconBase=()=>''}) {
  let enabled=true,gameVisible=false,payload=null,build=null,gameBounds=null;
  const windows=[];
  const buildSlot=3;
  const lastRender = new WeakMap();
  let reportedVisibility = null;
  function hide() {for(const w of windows)if(w&&!w.isDestroyed()&&w.isVisible())w.hide();}
  function state() {return {enabled,visible:windows.some(w=>w&&!w.isDestroyed()&&w.isVisible())};}
  function reportVisibility() {
    const current = state();
    if (reportedVisibility?.enabled === current.enabled && reportedVisibility.visible === current.visible) return;
    reportedVisibility = current;
    onVisibility(current);
  }
  function getWindow(slot) {
    if(windows[slot]&&!windows[slot].isDestroyed())return windows[slot];
    const w=new BrowserWindow({width:420,height:120,frame:false,transparent:true,focusable:false,skipTaskbar:true,
      show:false,resizable:false,hasShadow:false,alwaysOnTop:true,backgroundColor:'#00000000',
      webPreferences:{preload:preloadPath,contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
    w.setContentProtection(true);
    w.setIgnoreMouseEvents(true,{forward:true});
    w.setAlwaysOnTop(true,'screen-saver');
    w.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    w.webContents.on('will-navigate',event=>event.preventDefault());
    windows[slot]=w;
    w.webContents.on('did-stop-loading',()=>{lastRender.delete(w);render();});
    w.loadFile(slot === buildSlot ? path.join(path.dirname(htmlPath), 'build-overlay.html') : htmlPath);
    return w;
  }
  function draw(slot, bounds, message) {
    const w = getWindow(slot), previous = lastRender.get(w) || {};
    const position = JSON.stringify(bounds);
    if (previous.position !== position) {
      w.setBounds(bounds);
      previous.position = position;
    }
    if (!w.webContents.isLoading()) {
      const content = JSON.stringify(message);
      if (previous.content !== content) {
        w.webContents.send('overlay:state', message);
        previous.content = content;
      }
      if (!w.isVisible()) w.showInactive();
    }
    lastRender.set(w, previous);
  }
  const dip = raw => platform === 'win32' ? screen.screenToDipRect(null, raw) : raw;
  function hideSlot(slot) {
    const w = windows[slot];
    if (w && !w.isDestroyed() && w.isVisible()) w.hide();
  }
  function render() {
    if (!enabled || !gameVisible) { hide(); reportVisibility(); return; }
    const rects = payload?.display && payload.phase !== 'suspended' ? cardRectangles(payload.layout) : [];
    if (rects.length === 3) {
      for (const card of payload.cards) {
        const rect = dip(rects[card.slot]);
        const width = Math.max(160, Math.round(rect.width));
        const height = Math.max(80, Math.round(rect.height));
        // Grow a small DIP surface away from its title while keeping it centered.
        const x = Math.round(rect.x - Math.max(0, width - rect.width) / 2);
        const y = Math.round(rect.y - Math.max(0, height - rect.height));
        draw(card.slot, {x, y, width, height},
          {hero:payload.hero, status:payload.status, phase:payload.phase, display:payload.display, actionable:payload.actionable, card});
      }
    } else for (let slot = 0; slot < 3; slot++) hideSlot(slot);
    if (build && gameBounds) {
      // Anchor in the foreground client's DIP rectangle, below the scoreboard.
      const area = dip(gameBounds);
      const width = Math.round(Math.min(area.width - 12, clamp(area.width * .16, 248, 360)));
      const height = 117, inset = Math.round(clamp(area.width * .008, 6, 20));
      if (width >= 200 && area.height >= height + 60) {
        draw(buildSlot, {x:Math.round(area.x+area.width-width-inset), y:Math.round(area.y+clamp(area.height*.066,42,100)), width, height},
          {build, iconBase:getIconBase(), recordHint: payload?.actionable === true && rects.length === 3});
      } else hideSlot(buildSlot);
    } else {
      hideSlot(buildSlot);
    }
    reportVisibility();
  }
  return {
    update(value){payload=sanitizeOverlay(value);build=value?.phase==='suspended'?null:sanitizeBuild(value?.build);render();return state();},
    setEnabled(value){enabled=Boolean(value);render();return state();},
    toggle(){enabled=!enabled;render();return state();},
    setGameVisible(value, windowState){
      const next = Boolean(value);
      const bounds = next && validBox(windowState?.bounds) ? windowState.bounds : null;
      const moved = bounds ? !gameBounds || ['x','y','width','height'].some(key => gameBounds[key] !== bounds[key]) : Boolean(gameBounds);
      if (gameVisible !== next || moved) { gameVisible = next; gameBounds = bounds && {...bounds}; render(); }
    },
    clear(){payload=null;build=null;gameBounds=null;gameVisible=false;hide();reportVisibility();},
    destroy(){for(const w of windows)if(w&&!w.isDestroyed())w.destroy();windows.length=0;payload=null;build=null;gameBounds=null;},
    state,
  };
}
module.exports={createCardOverlays,sanitizeOverlay,cardRectangles};
