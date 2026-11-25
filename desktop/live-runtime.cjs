'use strict';
const {createDiscoveryScan}=require('./discovery-scan.cjs');

const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const rectangle=b=>b&&[b.x,b.y,b.width,b.height].every(Number.isFinite)&&b.width>0&&b.height>0;
const sameRect=(a,b)=>a&&b&&['x','y','width','height'].every(k=>Math.abs(a[k]-b[k])<.0001);

function titleRegion(layout, limit={x:0,y:0,width:1,height:1}) {
  if(!layout||![layout.width,layout.height].every(n=>Number.isFinite(n)&&n>0)||layout.boxes?.length!==3||!layout.boxes.every(rectangle))return null;
  const height=Math.max(...layout.boxes.map(b=>b.height));
  const top=Math.min(...layout.boxes.map(b=>b.y))-height*.55;
  const bottom=Math.max(...layout.boxes.map(b=>b.y+b.height))+height*.55;
  // Rerolled names can be much wider than the previous three. Keep the user's
  // full horizontal region and save OCR work by cropping only the title band.
  const x=limit.x;
  const y=clamp(top/layout.height,limit.y,limit.y+limit.height);
  const r=limit.x+limit.width;
  const b=clamp(bottom/layout.height,limit.y,limit.y+limit.height);
  return r>x&&b>y?{x,y,width:r-x,height:b-y}:null;
}

function retainTitleRegion(current,next,base,height) {
  if(!current||sameRect(current,base))return next;
  const tolerance=1/height;
  if(next.y>=current.y-tolerance&&next.y+next.height<=current.y+current.height+tolerance)return current;
  const centerShift=Math.abs(next.y+next.height/2-current.y-current.height/2);
  if(centerShift>Math.max(next.height,current.height)*.6)return next;
  const y=Math.min(current.y,next.y),bottom=Math.max(current.y+current.height,next.y+next.height);
  return {...next,y,height:bottom-y};
}

function frameMetadata(shot) {
  return {width:shot.sourceWidth||shot.width,height:shot.sourceHeight||shot.height,
    sourceWidth:shot.sourceWidth,sourceHeight:shot.sourceHeight,bounds:shot.bounds||shot.clientBounds,
    windowId:shot.windowId,capturedAt:shot.capturedAt,fingerprint:shot.fingerprint,
    foreground:shot.foreground,unchanged:shot.unchanged===true};
}
const errorInfo=error=>({code:String(error?.code||'CAPTURE_ERROR'),message:String(error?.message||error||'截图失败'),
  transient:error?.transient===true,category:error?.category,windowState:error?.windowState});

/** Independent image, game-data and hotkey loops; none waits for another. */
function createLiveRuntime({capture,hotkeys,ocr,readGame,sendFrame,sendRecord,onToggle,onWindowState=()=>{},now=Date.now,
  setTimer=setTimeout,clearTimer=clearTimeout,captureIntervalMs=250,confirmationIntervalMs=100,keyIntervalMs=50,gameIntervalMs=800}) {
  let running=false,generation=0,target=null,options={},timers=new Set();
  let roi=null,baseRoi=null,fingerprint=null,confirmed=false,roiMisses=0;
  let foreground=null,lastDimensions=null,lastOcrAt=0,lastCaptureMs=null,lastOcrMs=null;
  let recordAllowed=false,ocrInFlight=false,evidenceSequence=0,currentEvidenceId=null,foregroundEpoch=0;
  let confirmationPending=false,captureBusy=false,captureTimer=null,captureDue=0,captureLoop=null,lastCaptureStarted=0,lastVerdictId=null,completedCapture=null;
  const discovery=createDiscoveryScan();
  const confirmationCadence=clamp(Number(confirmationIntervalMs)||100,80,150);
  function schedule(fn,ms,token){if(!running||token!==generation)return;const timer=setTimer(()=>{timers.delete(timer);void fn();},ms);timers.add(timer);}
  function scheduleCapture(fn,ms,token,earlierOnly=false){
    if(!running||token!==generation||captureBusy)return;
    const due=now()+ms;
    if(captureTimer!==null){
      if(earlierOnly&&captureDue<=due)return;
      clearTimer(captureTimer);timers.delete(captureTimer);
    }
    const timer=setTimer(()=>{timers.delete(timer);if(captureTimer===timer)captureTimer=null;void fn();},ms);
    captureTimer=timer;captureDue=due;timers.add(timer);
  }
  const captureDelay=()=>Math.max(35,(confirmationPending?confirmationCadence:captureIntervalMs)-(now()-lastCaptureStarted));
  function send(data,token){if(running&&token===generation)sendFrame(data);}
  function focus(value,state,token){
    if(token!==generation||!running)return;
    const visible=value===true;
    onWindowState(visible,state);
    if(foreground!==visible){
      foregroundEpoch++;recordAllowed=false;currentEvidenceId=null;confirmationPending=false;completedCapture=null;lastVerdictId=null;
      if(foreground!==null){roi=baseRoi;fingerprint=null;confirmed=false;roiMisses=0;discovery.reset();}
      foreground=visible;send({type:'window-state',foreground:visible,windowState:state,timestamp:now()},token);
    }
  }
  function acceptLayout(payload){
    if(!running)return;
    if(foreground===false){recordAllowed=false;return;}
    const currentAck=foreground===true&&!ocrInFlight&&currentEvidenceId!==null&&payload?.evidenceId===currentEvidenceId;
    // A delayed acknowledgement must neither unlock nor revoke newer evidence.
    if(payload?.evidenceId!=null&&!currentAck)return;
    const wasPending=confirmationPending;
    // Pixel changes lock recording without changing the visible cards. Only the
    // renderer's stable verdict for this exact OCR job can unlock it again.
    recordAllowed=currentAck&&payload?.phase==='confirmed'&&payload?.actionable===true;
    if(payload?.phase==='suspended'){confirmed=false;confirmationPending=false;return;}
    // Never let a delayed old positive verdict retarget the next screenshot.
    // Bare layouts remain compatible as geometry only, never as evidence.
    const visibleLayout=payload?.display!==false&&['preview','confirmed'].includes(payload?.phase)?payload.layout:null;
    const layout=visibleLayout||(currentAck?payload?.roiHint:null);
    const validLayout=layout?.boxes?.length===3&&(!lastDimensions||`${layout.width}x${layout.height}`===lastDimensions);
    const suggested=validLayout?titleRegion(layout,baseRoi):null;
    const next=suggested?retainTitleRegion(roi,suggested,baseRoi,layout.height):null;
    const newVerdict=currentAck&&lastVerdictId!==currentEvidenceId;
    if(next){
      if(next&&!sameRect(next,roi)){roi=next;fingerprint=null;confirmed=false;}
      if(newVerdict||payload?.evidenceId==null)roiMisses=0;
      discovery.endSearch();
      if(recordAllowed)discovery.learn(next);
      confirmed=recordAllowed;
      confirmationPending=currentAck&&!recordAllowed&&payload.confirmationPending===true;
    }else{recordAllowed=false;confirmed=false;confirmationPending=false;if(newVerdict&&completedCapture?.tracking)roiMisses++;}
    if(newVerdict)lastVerdictId=currentEvidenceId;
    if(newVerdict||wasPending!==confirmationPending){
      // IPC can arrive after captureTick's finally already queued a normal
      // timer. Replace that one timer, without creating parallel capture work.
      if(!captureBusy&&captureLoop)scheduleCapture(captureLoop,captureDelay(),generation,confirmationPending);
    }
  }
  async function stop(){
    running=false;generation++;for(const timer of timers)clearTimer(timer);timers.clear();
    fingerprint=null;roi=null;confirmed=false;foreground=null;target=null;
    recordAllowed=false;ocrInFlight=false;currentEvidenceId=null;
    confirmationPending=false;captureTimer=null;captureLoop=null;captureBusy=false;lastVerdictId=null;completedCapture=null;discovery.reset();
    onWindowState(false,null);
    await Promise.allSettled([capture.stop(),hotkeys.stop(),ocr.stop()]);
  }
  async function start(config={}){
    await stop();const token=++generation;
    options={...config};baseRoi=config.roi||{x:0,y:0,width:1,height:1};
    try{
      const windows=await capture.listWindows();
      if(token!==generation)throw new Error('识别启动已取消');
      const selected=windows.find(w=>String(w.id)===String(config.windowId));
      if(!selected)throw new Error('所选窗口已关闭，请刷新并选择实际游戏对局窗口');
      const [capabilities]=await Promise.all([capture.capabilities(),hotkeys.capabilities(),ocr.initialize()]);
      if(capabilities.available===false)throw new Error(capabilities.message||'Windows 截图组件不可用');
      if(token!==generation)throw new Error('识别启动已取消');
      target=selected;running=true;roi=baseRoi;fingerprint=null;confirmed=false;roiMisses=0;lastDimensions=null;lastOcrAt=0;
      evidenceSequence=0;recordAllowed=false;currentEvidenceId=null;
      confirmationPending=false;captureBusy=false;lastVerdictId=null;completedCapture=null;discovery.reset();
      const captureTick=async()=>{
        if(!running||token!==generation||captureBusy)return;
        captureBusy=true;
        const started=lastCaptureStarted=now();
        try{
          if(!sameRect(roi,baseRoi)&&roiMisses>=2){roi=baseRoi;fingerprint=null;confirmed=false;roiMisses=0;confirmationPending=false;}
          const tracking=!sameRect(roi,baseRoi);
          const discoveryRoi=tracking?null:discovery.search(now());
          const captureRoi=tracking?roi:discoveryRoi||baseRoi;
          const roiMode=tracking?'tracking':discoveryRoi?'search-band':'search-full';
          const mayCache=confirmed&&recordAllowed&&now()-lastOcrAt<5000;
          const captureEpoch=foregroundEpoch;
          const shot=await capture.captureWindow(String(target.id),{roi:captureRoi,previousFingerprint:mayCache?fingerprint:undefined,skipUnchanged:mayCache});
          if(!running||token!==generation)return;
          if(captureEpoch!==foregroundEpoch)return;
          lastCaptureMs=now()-started;
          if(shot.foreground===false||foreground===null)focus(shot.foreground===true,{...frameMetadata(shot),valid:true},token);
          if(foreground!==true)return;
          const dimensions=`${shot.sourceWidth}x${shot.sourceHeight}`;
          if(lastDimensions&&dimensions!==lastDimensions){
            roi=baseRoi;confirmed=false;fingerprint=null;confirmationPending=false;roiMisses=0;discovery.reset();
            recordAllowed=false;currentEvidenceId=null;completedCapture=null;lastVerdictId=null;lastDimensions=dimensions;
            send({type:'panel-gone',frame:frameMetadata(shot),timestamp:now()},token);
            // An unchanged native reply may omit PNG bytes. Recapture the new
            // full-client geometry rather than OCR a stale or missing image.
            return;
          }
          lastDimensions=dimensions;
          if(shot.unchanged&&confirmed&&fingerprint===shot.fingerprint&&sameRect(captureRoi,roi)){
            send({type:'heartbeat',frame:frameMetadata(shot),timestamp:shot.timestamp||now(),metrics:{captureMs:lastCaptureMs,ocrMs:lastOcrMs,cached:true,roiMode}},token);
          }else{
            // A raw pixel change may only be background animation. Let OCR decide
            // whether titles changed; don't make the cards flash for every pixel.
            recordAllowed=false;ocrInFlight=true;confirmationPending=false;
            const evidenceId=currentEvidenceId=`${token}:${++evidenceSequence}`;
            const ocrEpoch=foregroundEpoch,ocrStart=now();
            const frame=await ocr.recognize(shot);
            if(!running||token!==generation)return;
            ocrInFlight=false;
            if(foreground!==true||ocrEpoch!==foregroundEpoch)return;
            lastOcrMs=now()-ocrStart;lastOcrAt=now();fingerprint=sameRect(captureRoi,roi)?shot.fingerprint||null:null;
            completedCapture={evidenceId,tracking,foregroundEpoch:ocrEpoch};
            send({frame,error:null,evidenceId,timestamp:shot.timestamp||Date.parse(shot.capturedAt)||started,
              metrics:{captureMs:lastCaptureMs,ocrMs:lastOcrMs,cached:false,roiMode}},token);
          }
        }catch(error){
          if(!running||token!==generation)return;
          ocrInFlight=false;recordAllowed=false;currentEvidenceId=null;confirmationPending=false;completedCapture=null;
          const detail=errorInfo(error);
          if(['WINDOW_NOT_FOREGROUND','WINDOW_MINIMIZED','WINDOW_CLOSED','WINDOW_OFFSCREEN'].includes(detail.code))focus(false,{...detail.windowState,message:detail.message,code:detail.code},token);
          send({frame:null,error:detail,timestamp:now(),metrics:{captureMs:lastCaptureMs,ocrMs:lastOcrMs}},token);
        }finally{
          if(running&&token===generation){captureBusy=false;scheduleCapture(captureTick,captureDelay(),token);}
        }
      };
      const gameTick=async()=>{if(!running||token!==generation)return;try{const game=await readGame();send({type:'game',game,timestamp:now()},token);}catch{send({type:'game',game:null,timestamp:now()},token);}schedule(gameTick,gameIntervalMs,token);};
      const keyTick=async()=>{
        if(!running||token!==generation)return;
        try{
          const keys=await hotkeys.pollHotkeys(String(target.id));
          if(!running||token!==generation)return;
          focus(keys.foreground===true,keys.windowState||keys,token);
          for(const key of keys.pressed||[]){
            if(key==='toggle')onToggle();
            else if(/^slot-[012]$/.test(key)&&keys.foreground===true){
              if(recordAllowed)sendRecord(Number(key.slice(-1)));
              else send({type:'record-blocked',reason:'画面正在复核，请稍后再记录',timestamp:now()},token);
            }
          }
        }catch(error){focus(false,errorInfo(error),token);send({type:'diagnostic',component:'hotkeys',error:errorInfo(error),timestamp:now()},token);}
        schedule(keyTick,keyIntervalMs,token);
      };
      captureLoop=captureTick;scheduleCapture(captureTick,40,token);schedule(gameTick,0,token);schedule(keyTick,0,token);
      return {window:selected,capabilities:{...capabilities,ocr:'Tesseract.js 7'},hotkeys:'native',failedShortcuts:[]};
    }catch(error){if(token===generation)await stop();throw error;}
  }
  return {start,stop,acceptLayout,isRunning:()=>running};
}
module.exports={createLiveRuntime,titleRegion,frameMetadata};
