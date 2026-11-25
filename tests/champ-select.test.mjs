import test from 'node:test';
import assert from 'node:assert/strict';
import {createChampSelect} from '../desktop/champ-select.cjs';
import {selectStripRect} from '../desktop/champ-select-overlays.cjs';

const flush=async()=>{for(let i=0;i<20;i++) await Promise.resolve();};
const client={foreground:true,windowId:'42',bounds:{x:-1920,y:50,width:1920,height:1080}};
const roster={mine:0,patch:'26.22',team:[{rate:'53.6%'},null,null,null,null],bench:[null,{rate:'49.1%'}]};

function setup(t) {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const events=[], requests=[];
  const fixture={client:null,toggle:false,bench:['first'],read:()=>roster,markers:0,stops:0};
  const capture={
    champSelectForeground:async()=>{const toggle=fixture.toggle;fixture.toggle=false;return {client:fixture.client,toggle};},
    captureWindow:async(id,settings)=>{requests.push({id,settings});return {...fixture.client};},
    inspectWindow:async()=>fixture.client,
    stop:()=>fixture.stops++,
  };
  let visible=true;
  const watcher=createChampSelect({capture,createVision:()=>({
    readBench:async()=>{fixture.markers++;return fixture.bench;},readTeam:()=>fixture.read(),stop:async()=>{},
  }),draw:(labels,bounds)=>events.push({labels,bounds}),hide:()=>events.push(null),
    onToggle:()=>{visible=!visible;watcher.setVisible(visible);}});
  async function advance(ms) {
    for (let i=0;i<ms;i+=50) {t.mock.timers.tick(Math.min(ms-i,50));await flush();}
  }
  watcher.setEnabled(true);
  t.after(()=>watcher.setEnabled(false));
  return {fixture,events,requests,watcher,advance};
}

test('only recognised foreground select frames produce labels, and bench holes keep their physical slots',async t=>{
  const {fixture,events,requests,watcher,advance}=setup(t);
  await flush();assert.equal(requests.length,0);
  fixture.client=client;await advance(700);
  assert.deepEqual(events.at(-1),{labels:roster,bounds:client.bounds});
  assert.equal(requests.length,2);
  assert.ok(requests.every(r=>r.id==='42' && r.settings.leagueClientOnly && r.settings.roi.height<.6));
  fixture.bench=null;await advance(600);
  assert.equal(events.at(-1),null);
  assert.equal(requests.length,3,'leaving the pick screen must avoid any team capture');
  fixture.bench=['other'];fixture.read=()=>({...roster,mine:3});await advance(1000);
  assert.equal(events.at(-1).labels.mine,3);
  const before=requests.length;
  fixture.toggle=true;await advance(1300);
  assert.equal(events.at(-1),null);assert.equal(requests.length,before);
  fixture.toggle=true;await advance(50);assert.equal(events.at(-1).labels.mine,3);
  watcher.setEnabled(false);await advance(1500);
  assert.equal(events.at(-1),null);assert.equal(fixture.stops,1);
});

test('focus loss during OCR drops its late result; stalled follow-up reads expire the last labels',async t=>{
  const {fixture,events,advance}=setup(t);await flush();
  fixture.client=client;await advance(700);
  let finish;
  fixture.read=()=>new Promise(resolve=>{finish=resolve;});await advance(600);
  assert.equal(typeof finish,'function');
  await advance(1700);assert.equal(events.at(-1),null,'window expiry runs even while the OCR promise is pending');
  fixture.client=null;await advance(100);
  finish(roster);await flush();assert.equal(events.at(-1),null);
  assert.equal(events.filter(Boolean).length,1);
});

test('unsupported client geometry produces no requests; matching regions follow the client on a second monitor',async t=>{
  const {fixture,requests,advance}=setup(t);await flush();
  fixture.client={...client,bounds:{...client.bounds,width:900,height:750}};await advance(1000);
  assert.equal(requests.length,0);
  assert.deepEqual(selectStripRect('team',client.bounds),{x:-1588,y:195,width:105,height:565});
  assert.deepEqual(selectStripRect('bench',{x:100,y:200,width:1280,height:720}),{x:447,y:259,width:585,height:17});
});
