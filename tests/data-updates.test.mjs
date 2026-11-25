import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, mkdtemp, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import format from '../desktop/data-format.cjs';
import {createDataUpdates, CHANNEL} from '../desktop/data-updates.cjs';
import {restoreSession, emptySession, validateSession} from '../app/core/session.mjs';
import {indexCatalog} from '../app/core/engine.mjs';

const appPath = path.resolve(import.meta.dirname, '../app');
const original = await format.readTables(appPath);
const sample = structuredClone(original);
for (const group of ['champions','augments','items']) sample.catalog[group] = original.catalog[group].slice(0, 1);
for (const name of ['editorial-guides','community-guides']) sample[name] = original[name].slice(0, 1);
for (const name of ['champion-stats','augment-stats','item-stats']) {
  for (const key of Object.keys(sample[name]).filter(k => k !== 'meta'))
    sample[name][key] = Object.fromEntries(Object.entries(sample[name][key]).slice(0, 1));
}
const images = {};
for (const group of ['champions','augments','items']) {
  const {icon} = sample.catalog[group][0];
  images[icon] = (await readFile(path.join(appPath, icon))).toString('base64');
}
function release(revision, tables = sample, icons = images) {
  const manifest = {schema:1, revision, patch:sample.catalog.meta.patch, statsAsOf:sample['champion-stats'].meta.asOf, bundles:{}};
  const files = new Map();
  for (const [key, value] of Object.entries({tables, icons})) {
    const bytes = gzipSync(JSON.stringify(value)), part = {bytes:bytes.length, sha256:format.hash(bytes)};
    manifest.bundles[key] = part;
    files.set(format.filename(key, part), bytes);
  }
  return {manifest, files};
}
function changed(revision) {
  const tables = structuredClone(sample);
  tables.catalog.meta.note = '已整理数据 ' + revision;
  return release(revision, tables);
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(),'hex-channel-test-'));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const appRoot = path.join(dir,'app'), storage = path.join(dir,'cache');
  const data = path.join(appRoot, 'data');
  await mkdir(data,{recursive:true});
  for (const [key, contents] of Object.entries(sample)) await writeFile(path.join(data,key+'.json'),JSON.stringify(contents));
  const bundled = release(1);
  await writeFile(path.join(data,'bundled-snapshot.json'),JSON.stringify(bundled.manifest));
  const requests = [], state = {feed:bundled, time:Date.parse('2026-11-25T00:00:00Z')};
  const fetcher = async url => {
    assert.ok(url.startsWith(CHANNEL));
    const key = url.slice(CHANNEL.length).split('?')[0];
    const query = new URL(url).searchParams;
    if (key === 'manifest.json') assert.equal(query.get('minute'),String(Math.floor(state.time/60000)));
    else assert.equal(query.size,0);
    requests.push(key);
    if (state.failure) throw new Error('offline');
    const body = key === 'manifest.json' ? JSON.stringify(state.feed.manifest) : state.feed.files.get(key);
    return body ? new Response(body) : new Response(null,{status:404});
  };
  const start = async () => {
    const service = createDataUpdates({appRoot,storage,fetcher,now:()=>state.time});
    await service.ready(); return service;
  };
  return {state,storage,requests,start,service:await start()};
}

test('one in-flight check, changed tables only, stage during play, apply or restart offline', async t => {
  const {state, storage, requests, start, service} = await fixture(t);
  state.feed = changed(2);
  const check = service.check();
  assert.equal(check,service.check());
  assert.equal((await check).phase,'ready');
  assert.deepEqual(requests,['manifest.json',format.filename('tables',state.feed.manifest.bundles.tables)]);
  assert.equal(service.status().active.revision,1);
  assert.equal(service.status().pending.revision,2);
  assert.deepEqual(await readdir(path.join(storage,'releases')),['2.json']);
  assert.ok(service.apply());
  assert.equal(service.current().tables.catalog.meta.note,'已整理数据 2');
  assert.equal(service.apply(),false);
  state.failure = true;
  const restarted = await start();
  assert.equal(restarted.status().active.revision,2);
  assert.equal((await restarted.check()).phase,'error');
  assert.equal(restarted.current().tables.catalog.meta.note,'已整理数据 2');
});

test('missing, corrupt or incompatible content never replaces a working snapshot', async t => {
  const {state, storage, service} = await fixture(t);
  for (const kind of ['hash','missing','schema','wrong-patch','null','missing-image','path']) {
    const tables = structuredClone(sample);
    let feed = changed(2);
    const key = format.filename('tables',feed.manifest.bundles.tables);
    if (kind === 'hash') feed.files.set(key,Buffer.from('corrupt'));
    if (kind === 'missing') feed.files.delete(key);
    if (kind === 'schema') feed.manifest.schema = 100;
    if (kind === 'wrong-patch') {tables['item-stats'].meta.displayPatch = '99.1'; feed = release(2,tables);}
    if (kind === 'null') feed = release(2,null);
    if (kind === 'missing-image') feed = release(2,tables,{});
    if (kind === 'path') {tables.catalog.items[0].icon = '../secret.png'; feed = release(2,tables);}
    state.feed = feed;
    assert.equal((await service.check()).phase,'error',kind);
    assert.equal(service.status().pending,null);
    assert.equal(service.status().active.revision,1);
  }
  assert.deepEqual(await readdir(path.join(storage,'releases')).catch(()=>[]),[]);
});

test('verified PNGs are available to the catalog, native portraits and HUD; bad cache rolls back', async t => {
  const {state, storage, start, service} = await fixture(t);
  state.feed = changed(2);
  await service.check(); service.apply();
  const tables = structuredClone(sample);
  const art = {...images};
  const row = tables.catalog.items[0];
  art['assets/items/888888.png'] = art[row.icon]; delete art[row.icon];
  row.id = '888888'; row.icon = 'assets/items/888888.png';
  state.feed = release(3,tables,art);
  assert.equal((await service.check()).phase,'ready');
  const newest = await start();
  assert.equal(newest.current().manifest.revision,3);
  assert.ok(newest.current().icons.get(row.icon).equals(Buffer.from(art[row.icon],'base64')));
  const name = format.filename('icons',state.feed.manifest.bundles.icons);
  await writeFile(path.join(storage,'objects',name),'interrupted');
  const recovered = await start();
  assert.equal(recovered.status().phase,'recovered');
  assert.equal(recovered.status().active.revision,2);
  assert.equal((await recovered.check()).phase,'ready');
});

test('schedule and preference persist, manual checks bypass the interval, and older releases never downgrade', async t => {
  const {state, requests, start, service} = await fixture(t);
  await service.autoCheck(); await service.autoCheck();
  assert.deepEqual(requests,['manifest.json']);
  const restarted = await start(); await restarted.autoCheck();
  assert.equal(requests.length,1);
  state.time += 6*60*60*1000;
  await restarted.autoCheck(); assert.equal(requests.length,2);
  await restarted.setAutomatic(false);
  const disabled = await start();
  state.time += 24*60*60*1000;
  await disabled.autoCheck(); assert.equal(requests.length,2);
  state.feed = changed(4); await disabled.check(); disabled.apply();
  state.feed = release(1);
  assert.equal((await disabled.check()).phase,'ahead');
  assert.equal(disabled.status().active.revision,4);
  state.feed = changed(4); state.feed.manifest.bundles.icons.bytes++;
  assert.equal((await disabled.check()).phase,'error');
});

test('local sessions keep valid picks, candidate positions, inventory and history across catalog changes', () => {
  const db = indexCatalog(original.catalog);
  const originalState = {...emptySession(),championId:'Yasuo',selected:['ARAM_Deft','retired'],
    candidates:[null,'ARAM_Firebrand','retired-other'],owned:['3031','999999'],gold:1717,history:[{time:'10:00',label:'选过'}]};
  assert.throws(()=>validateSession(originalState,db));
  const {state,migrated} = restoreSession(originalState,db);
  assert.equal(migrated,true);
  assert.deepEqual(state.selected,['ARAM_Deft']);
  assert.deepEqual(state.candidates,[null,'ARAM_Firebrand',null]);
  assert.deepEqual(state.owned,['3031']);
  assert.deepEqual([state.championId,state.gold,state.history[0].label],['Yasuo',1717,'选过']);
  assert.equal(restoreSession(state,db).migrated,false);
});

test('updated recommendations change hero profiles, augment interactions and build templates between games', async t => {
  const {useRecommendationRules, advice:before} = await import('../app/core/recommendation-data.mjs');
  const {championProfile} = await import('../app/core/profiles.mjs');
  const {directPairReason, augmentRule} = await import('../app/core/augment-rules.mjs');
  t.after(()=>useRecommendationRules());
  const {state, service} = await fixture(t);
  const tables = structuredClone(sample), rules = tables['recommendation-rules'];
  rules.champions.overrides.Yasuo.crit = .93;
  rules.directPairs.find(pair=>pair[0]==='Firebrand' && pair[1]==='Vulnerability')[2] = '修订后的组合说明';
  rules.augments.Firebrand.summary = '修订后的效果';
  rules.builds[0].ids.reverse();
  state.feed = release(2,tables);
  assert.equal((await service.check()).phase,'ready');
  assert.ok(service.apply());
  useRecommendationRules(service.current().tables['recommendation-rules']);
  const hero = original.catalog.champions.find(c=>c.id==='Yasuo');
  assert.equal(championProfile(hero).features.crit,.93);
  assert.equal(augmentRule({id:'ARAM_Firebrand'}).summary,'修订后的效果');
  assert.equal(directPairReason({id:'Vulnerability'},{id:'ARAM_Firebrand'}),'修订后的组合说明');
  const {advice} = await import('../app/core/recommendation-data.mjs');
  assert.deepEqual(advice.builds[0].ids,[...before.builds[0].ids].reverse());
});
