'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const gunzip = promisify(require('node:zlib').gunzip);
const format = require('./data-format.cjs');

const CHANNEL = 'https://raw.githubusercontent.com/JohnJyong/hex-companion/data-v1/';
const INTERVAL = 6 * 60 * 60 * 1000;
const MANIFEST_LIMIT = 16 * 1024;

async function atomicWrite(file, contents) {
  await fs.mkdir(path.dirname(file), {recursive:true});
  const temp = file + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temp, contents); await fs.rename(temp, file); }
  finally { await fs.rm(temp, {force:true}); }
}
async function limitedFile(file, limit) {
  if ((await fs.stat(file)).size > limit) throw new Error('本地数据文件过大');
  return fs.readFile(file);
}
async function fetchBytes(fetcher, name, limit, checkTime) {
  const url = new URL(name,CHANNEL);
  // The branch manifest changes in place. Raw GitHub also caches it at the
  // edge, independently of the Electron profile's HTTP cache.
  if (name === 'manifest.json') url.searchParams.set('minute', String(Math.floor(checkTime/60000)));
  const response = await fetcher(url.href, {cache:'no-store', credentials:'omit', redirect:'error',
    signal:AbortSignal.timeout(name === 'manifest.json' ? 18000 : 90000)});
  if (!response.ok || !response.body) throw new Error(`更新源暂不可用（HTTP ${response.status}）`);
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body.cancel(); throw new Error('更新文件超过大小上限');
  }
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw new Error('更新文件超过大小上限');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks,total);
}

function createDataUpdates({appRoot, storage, fetcher, notify = () => {}, now = Date.now}) {
  const prefFile = path.join(storage,'preferences.json');
  const releases = path.join(storage,'releases'), objects = path.join(storage,'objects');
  let bundled, active, pending, initializing, checking;
  let automatic = true, lastChecked = null, attempted = 0, phase = 'idle', error = '';
  let writes = Promise.resolve();
  const info = snapshot => snapshot && ({revision:snapshot.manifest.revision, patch:snapshot.manifest.patch,
    statsAsOf:snapshot.manifest.statsAsOf, source:snapshot === bundled ? 'bundled' : 'cache'});
  const status = () => ({ active:info(active), pending:info(pending) || null, automatic, lastChecked, phase, error });
  const emit = () => notify(status());
  const prefWrite = () => {
    const bytes = JSON.stringify({automatic,lastChecked});
    writes = writes.catch(() => {}).then(() => atomicWrite(prefFile, bytes));
    return writes;
  };

  async function snapshot(manifest, online) {
    const parts = {};
    for (const key of format.PARTS) {
      const part = manifest.bundles[key];
      if (part.sha256 === bundled.manifest.bundles[key].sha256) {
        if (part.bytes !== bundled.manifest.bundles[key].bytes) throw new Error('内置数据的清单不一致');
        continue;
      }
      const name = format.filename(key, part), file = path.join(objects, name);
      const verify = bytes => {
        if (bytes.length !== part.bytes || format.hash(bytes) !== part.sha256) throw new Error('更新文件校验失败');
        return bytes;
      };
      let bytes;
      try {
        if (online) { const date = new Date(now()); await fs.utimes(file, date, date); }
        bytes = verify(await limitedFile(file,part.bytes));
      }
      catch (failure) {
        if (!online) throw failure;
        bytes = verify(await fetchBytes(fetcher, name,part.bytes));
        await atomicWrite(file,bytes);
      }
      parts[key] = JSON.parse(await gunzip(bytes,{maxOutputLength:format.MAX_EXPANDED}));
    }
    const tables = Object.hasOwn(parts,'tables') ? parts.tables : bundled.tables;
    const paths = format.validateTables(tables,manifest);
    const icons = Object.hasOwn(parts,'icons') ? format.decodeIcons(parts.icons,paths) : null;
    if (!icons && [...paths].some(key => !bundled.paths.has(key))) throw new Error('新目录缺少对应的图标包');
    return {manifest,tables,icons,paths};
  }

  // Keep a previous usable release for recovery. The grace period also covers
  // objects from interrupted downloads and writers in another app instance.
  async function pruneCache(revisions) {
    const cutoff = now() - 7 * 24 * 60 * 60 * 1000;
    const keep = new Set([...revisions.slice(0,2), active.manifest.revision,
      revisions.find(r => r < active.manifest.revision)]);
    const referenced = new Set();
    for (const revision of revisions) {
      const file = path.join(releases, revision+'.json');
      if (!keep.has(revision) && (await fs.stat(file)).mtimeMs < cutoff) {
        await fs.rm(file, {force:true});
        continue;
      }
      const manifest = format.validateManifest(JSON.parse(await limitedFile(file, MANIFEST_LIMIT)));
      for (const key of format.PARTS) referenced.add(format.filename(key, manifest.bundles[key]));
    }
    for (const name of await fs.readdir(objects).catch(() => [])) {
      if (!/^(tables|icons)-[a-f0-9]{64}\.json\.gz$/.test(name) || referenced.has(name)) continue;
      const file = path.join(objects, name);
      if ((await fs.stat(file)).mtimeMs < cutoff) await fs.rm(file, {force:true});
    }
  }

  async function initialize() {
    const [tables, raw] = await Promise.all([format.readTables(appRoot), fs.readFile(path.join(appRoot,'data/bundled-snapshot.json'),'utf8')]);
    const manifest = format.validateManifest(JSON.parse(raw));
    bundled = active = {manifest,tables,icons:null,paths:format.validateTables(tables,manifest)};
    try {
      const prefs = JSON.parse(await limitedFile(prefFile, MANIFEST_LIMIT));
      automatic = prefs.automatic !== false;
      lastChecked = Number.isSafeInteger(prefs.lastChecked) ? prefs.lastChecked : null;
    } catch { /* A missing preference file uses the application defaults. */ }
    const names = await fs.readdir(releases).catch(() => []);
    const revisions = names.filter(s => /^[1-9]\d{0,14}\.json$/.test(s))
      .map(s=>Number.parseInt(s,10)).filter(n=>n>manifest.revision).sort((a,b)=>b-a);
    for (const revision of revisions) {
      try {
        const saved = format.validateManifest(JSON.parse(await limitedFile(path.join(releases,revision+'.json'),MANIFEST_LIMIT)));
        if (saved.revision !== revision) throw new Error('缓存版本不正确');
        active = await snapshot(saved,false);
        break;
      } catch { phase='recovered'; error='本地更新数据不完整，已回到可用版本'; }
    }
    await pruneCache(revisions).catch(() => {});
    return status();
  }
  const ready = () => initializing ??= initialize();

  async function runCheck() {
    await ready();
    phase='checking'; error=''; attempted=now(); emit();
    try {
      const m = format.validateManifest(JSON.parse(await fetchBytes(fetcher,'manifest.json',MANIFEST_LIMIT,attempted)));
      const newest = (pending || active).manifest;
      const sameParts = format.PARTS.every(key => m.bundles[key].sha256 === newest.bundles[key].sha256
        && m.bundles[key].bytes === newest.bundles[key].bytes);
      if (m.revision === newest.revision && (!sameParts || m.patch !== newest.patch || m.statsAsOf !== newest.statsAsOf)) {
        throw new Error('同一数据版本出现不同内容，已保留本地数据');
      }
      if (m.revision > newest.revision) {
        phase='downloading'; emit();
        const verified = await snapshot(m,true);
        // This small immutable publication record commits both verified parts together.
        await atomicWrite(path.join(releases, m.revision+'.json'),JSON.stringify(m));
        pending = verified;
      }
      lastChecked=now(); phase = pending ? 'ready' : m.revision < newest.revision ? 'ahead' : 'current';
      await prefWrite();
    } catch (failure) {
      phase='error';
      error = /更新|清单|图标|统计|目录|数据|攻略/.test(failure.message) ? failure.message : '无法获取更新，请检查网络后重试';
    }
    emit();
    return status();
  }
  function check() {
    if (!checking) checking=runCheck().finally(()=>{checking=null;});
    return checking;
  }
  async function autoCheck() {
    await ready();
    const since = now() - (lastChecked || 0);
    if (automatic && (!lastChecked || since < 0 || since >= INTERVAL)
        && (!attempted || now() < attempted || now()-attempted >= 15*60*1000)) await check();
  }
  async function setAutomatic(value) {
    await ready();
    automatic = value === true; await prefWrite(); emit();
    if (automatic) void autoCheck();
    return status();
  }
  function apply() {
    if (!pending) return false;
    active=pending; pending=null; phase='current'; error=''; emit();
    return true;
  }
  return {ready, check, autoCheck, setAutomatic, status, apply, current:() => active};
}

module.exports = {createDataUpdates, CHANNEL};
