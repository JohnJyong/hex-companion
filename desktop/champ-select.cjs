'use strict';

const {BENCH_STRIP,TEAM_STRIP} = require('./champ-select-vision.cjs');

function sameClient(a,b) {
  return Boolean(a && b && a.windowId===b.windowId && a.bounds && b.bounds &&
    ['x','y','width','height'].every(k=>a.bounds[k]===b.bounds[k]));
}

// The foreground poll keeps running during OCR so switching windows or hiding
// the overlay invalidates a slow read. Each context owns its OCR worker.
function createChampSelect({capture, createVision, draw, hide, onToggle, onStatus=()=>{},
  now=Date.now, setTimer=setTimeout, clearTimer=clearTimeout}) {
  let enabled=false, visible=true, epoch=0, timer=null, context=null;
  let status='已关闭选人提示';
  const state=()=>({enabled,status});
  function report(value) {
    if (value!==status) { status=value; onStatus(state()); }
  }
  function discard() {
    const old=context;
    context=null;
    hide();
    if (old) { clearTimer(old.expiryTimer); void old.vision.stop(); }
  }
  function withdraw(ctx,message) {
    if (ctx!==context) return;
    clearTimer(ctx.expiryTimer); hide(); report(message);
  }
  async function scan(ctx) {
    ctx.busy=true;
    let interval=550;
    try {
      const {windowId}=ctx.client;
      const top=await capture.captureWindow(windowId,{roi:BENCH_STRIP,leagueClientOnly:true});
      if (ctx!==context) return;
      if (!sameClient(top,ctx.client) || !top.foreground) return withdraw(ctx,'等待客户端窗口稳定');
      const bench=await ctx.vision.readBench(top);
      if (ctx!==context) return;
      if (!bench) {
        interval=900;
        return withdraw(ctx,'等待出现「可用」英雄栏');
      }
      const left=await capture.captureWindow(windowId,{roi:TEAM_STRIP,leagueClientOnly:true});
      if (ctx!==context) return;
      if (!sameClient(left,ctx.client) || !left.foreground) return withdraw(ctx,'等待客户端窗口稳定');
      const labels=await ctx.vision.readTeam(left,bench);
      if (ctx!==context) return;
      const target=await capture.inspectWindow(windowId);
      if (ctx!==context) return;
      if (!target.foreground || !sameClient(target,ctx.client)) return withdraw(ctx,'等待选人客户端处于前台');
      const teamCount=labels.team.filter(Boolean).length, benchCount=labels.bench.filter(Boolean).length;
      if (!teamCount && !benchCount) return withdraw(ctx,'等待读取英雄头像或称号');
      draw(labels,target.bounds);
      clearTimer(ctx.expiryTimer);
      ctx.expiryTimer=setTimer(()=>withdraw(ctx,'正在重新核对选人画面'),2200);
      report(`已显示队伍 ${teamCount} 位、备选席 ${benchCount} 位英雄的模式胜率`);
    } catch {
      withdraw(ctx,'选人画面暂不可读，正在重试');
    } finally {
      ctx.busy=false; ctx.nextScan=now()+interval;
    }
  }
  async function poll(token) {
    let delay=700;
    try {
      const {client,toggle}=await capture.champSelectForeground();
      if (!enabled || epoch!==token) return;
      if (client?.foreground && toggle) onToggle(client.windowId);
      if (client?.foreground) delay=50;
      if (!visible || !client?.foreground || !client.bounds) {
        if (context) discard();
        report(visible?'等待选人客户端处于前台':'选人浮层已隐藏');
        return;
      }
      const {width,height}=client.bounds;
      if (width<960 || height<540 || Math.abs((width/height)/(16/9)-1)>.035) {
        if (context) discard();
        report('等待标准比例的英雄联盟客户端');
        return;
      }
      if (!sameClient(context?.client,client)) {
        discard();
        context={client,vision:createVision(),nextScan:0,busy:false,expiryTimer:null};
      }
      if (!context.busy && now()>=context.nextScan) void scan(context);
    } catch {
      if (epoch===token) { discard(); report('暂时无法读取客户端窗口，正在重试'); }
    } finally {
      if (enabled && epoch===token) timer=setTimer(()=>void poll(token),delay);
    }
  }
  function setEnabled(value) {
    if (enabled===value) return state();
    enabled=value; epoch++;
    if (timer!==null) clearTimer(timer);
    timer=null;
    if (enabled) { report('等待选人客户端处于前台'); void poll(epoch); }
    else { discard(); capture.stop(); report('已关闭选人提示'); }
    return state();
  }
  function setVisible(value) {
    visible=value;
    if (!visible) { discard(); if (enabled) report('选人浮层已隐藏'); }
  }
  return {setEnabled,setVisible,state};
}

module.exports={createChampSelect};
