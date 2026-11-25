'use strict';

const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const TABLES = ['catalog', 'champion-stats', 'augment-stats', 'item-stats', 'editorial-guides', 'community-guides', 'recommendation-rules'];
const PARTS = ['tables', 'icons'];
const MAX_COMPRESSED = 32 * 1024 * 1024;
const MAX_EXPANDED = 64 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const patchPattern = /^\d{1,3}\.\d{1,3}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const pngHeader = Buffer.from('89504e470d0a1a0a', 'hex');
const isSkill = value => record(value) && typeof value.description === 'string' && typeof value.name === 'string';

function requireData(condition, message) {
  if (!condition) throw new Error(message);
}

function validateRules(rules) {
  const id = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(s) && !['__proto__','constructor','prototype'].includes(s);
  const text = s => typeof s === 'string' && s.length > 0 && s.length <= 2000;
  const list = (v, test) => Array.isArray(v) && v.every(test);
  const entries = (v, test) => record(v) && Object.entries(v).every(([k,value]) => id(k) && test(value));
  const item = s => typeof s === 'string' && /^\d{1,9}$/.test(s);
  const heroList = s => typeof s === 'string' && s.split(' ').every(id);
  const heroes = rules?.champions;
  const features = value => entries(value,n => Number.isFinite(n) && n >= 0 && n <= 1);
  const build = b => id(b?.id) && id(b.type) && text(b.name) && text(b.note) && list(b.tags,id) && b.tags.length > 0
    && list(b.ids,item) && b.ids.length >= 1 && b.ids.length <= 12;
  const augment = a => record(a) && list(a.tags,id) && (a.grants === undefined || list(a.grants,id))
    && (a.requiredItems === undefined || list(a.requiredItems,item)) && (a.requires === undefined || id(a.requires))
    && ['summary','warning'].every(k => a[k] === undefined || text(a[k]));
  requireData(rules?.schema === 1 && record(heroes) && entries(heroes.archetypes,features)
    && entries(heroes.overrides,features)
    && ['marksman','fighter','mage','tank','support'].every(type => Object.hasOwn(heroes.archetypes,type))
    && entries(heroes.groups,heroList) && entries(heroes.traits,heroList) && entries(heroes.aliases,text)
    && list(heroes.noDashes,id) && entries(rules.augments,augment)
    && list(rules.directPairs, p => Array.isArray(p) && p.length === 3 && id(p[0]) && id(p[1]) && text(p[2]))
    && list(rules.synergies, p => Array.isArray(p) && p.length === 4 && id(p[0]) && id(p[1])
      && Number.isFinite(p[2]) && Math.abs(p[2]) <= 25 && text(p[3]))
    && list(rules.builds,build) && rules.builds.length > 0 && entries(rules.specialBuilds,build)
    && ['spellCrit','dotCrit','spellOnhit','mana'].every(k => build(rules.specialBuilds[k]))
    && list(rules.exclusiveItems, ids => list(ids,item)), '联动或出装规则库格式无效');
}

function validateManifest(m) {
  requireData(m?.schema === 1 && Number.isSafeInteger(m.revision) && m.revision > 0,
    '数据发布格式不兼容，请检查软件版本');
  requireData(patchPattern.test(m.patch) && timestampPattern.test(m.statsAsOf) && Number.isFinite(Date.parse(m.statsAsOf)),
    '数据清单的版本或统计截止时间无效');
  for (const key of PARTS) {
    const part = m.bundles?.[key];
    requireData(/^[a-f0-9]{64}$/.test(part?.sha256) && Number.isSafeInteger(part?.bytes) && part.bytes > 0
      && part.bytes <= MAX_COMPRESSED, '数据清单中的文件信息无效');
  }
  return m;
}

function validateTables(t, m) {
  const catalog = t?.catalog, meta = catalog?.meta;
  requireData(meta?.schema === 1 && meta.mode === 'KIWI' && meta.patch === m.patch && datePattern.test(meta.asOf)
    && /^\d+\.\d+\.\d+$/.test(meta.dataDragonVersion) && Array.isArray(meta.sources)
    && meta.sources.every(s => typeof s?.name === 'string' && typeof s.url === 'string' && s.url.startsWith('https://')), '英雄与海克斯目录格式或版本不符');
  const paths = new Set();
  for (const group of ['champions','augments','items']) {
    const rows = catalog[group];
    requireData(Array.isArray(rows) && rows.length > 0 && rows.length <= 10000, '游戏目录不完整');
    const ids = new Set();
    for (const row of rows) {
      requireData(typeof row?.id === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(row.id) && !ids.has(row.id)
        && typeof row.name === 'string' && row.name.length > 0, '游戏目录条目无效');
      ids.add(row.id);
      const iconId = group === 'augments' ? row.gameId : row.id;
      requireData(/^[A-Za-z0-9_-]{1,96}$/.test(String(iconId)) && row.icon === `assets/${group}/${iconId}.png`, '游戏图标路径无效');
      paths.add(row.icon);
      if (group === 'champions') requireData(Number.isSafeInteger(row.gameId) && Array.isArray(row.roles)
        && row.roles.every(role => typeof role === 'string') && Array.isArray(row.spells) && row.spells.every(isSkill)
        && isSkill(row.passive) && record(row.stats) && typeof row.title === 'string', '英雄资料不完整');
      if (group === 'augments') requireData(Number.isSafeInteger(row.gameId) && ['gold','silver','prismatic'].includes(row.tier)
        && typeof row.description === 'string', '海克斯资料不完整');
      if (group === 'items') requireData(/^\d+$/.test(row.id) && Number.isSafeInteger(row.cost) && row.cost >= 0
        && typeof row.description === 'string' && Array.isArray(row.tags) && record(row.stats), '装备资料不完整');
    }
  }
  const required = {
    'champion-stats':['heroes'], 'augment-stats':['heroes','augments','heroAugments'],
    'item-stats':['coreBuilds','heroItems','heroAugmentItems','equipmentHeroes','itemMetadata'],
  };
  for (const [name, keys] of Object.entries(required)) {
    const data = t[name], info = data?.meta;
    requireData(info?.schema === 1 && info.mode === 'KIWI' && info.rule === 'normal' && info.band === 'all'
      && info.displayPatch === m.patch && info.patch === meta.dataDragonVersion.split('.').slice(0,2).join('.')
      && info.asOf === m.statsAsOf && info.source?.license === 'CC BY-NC 4.0' && info.source?.nonCommercialOnly === true
      && Number.isSafeInteger(info.matches?.valid) && info.matches.valid > 0 && info.matches.valid === t['champion-stats'].meta.matches.valid
      && info.source.seq === t['champion-stats'].meta.source.seq && typeof info.source.attribution === 'string'
      && keys.every(key => record(data[key]) && Object.keys(data[key]).length > 0), '胜率与装备统计的版本、口径或来源不匹配');
  }
  for (const name of ['editorial-guides','community-guides']) {
    requireData(Array.isArray(t[name]) && t[name].every(g => typeof g?.sourceUrl === 'string'
      && typeof g.id === 'string' && Array.isArray(g.championIds) && Array.isArray(g.augmentIds) && Array.isArray(g.itemIds)), '攻略资料格式无效');
  }
  // Early schema-1 releases use the rulebook bundled with the application.
  if (Object.hasOwn(t,'recommendation-rules')) validateRules(t['recommendation-rules']);
  return paths;
}

function decodeIcons(encoded, paths) {
  requireData(record(encoded) && Object.keys(encoded).length === paths.size, '图标包与目录不匹配');
  const icons = new Map();
  for (const key of paths) {
    const value = encoded[key];
    requireData(typeof value === 'string' && value.length <= 2_800_000, '图标文件缺失或过大');
    const bytes = Buffer.from(value, 'base64');
    requireData(bytes.length >= 33 && bytes.subarray(0,8).equals(pngHeader) && bytes.toString('ascii',12,16) === 'IHDR'
      && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 2048
      && bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 2048, '图标不是受支持的 PNG');
    icons.set(key, bytes);
  }
  return icons;
}

async function readTables(appRoot) {
  return Object.fromEntries(await Promise.all(TABLES.map(async name =>
    [name, JSON.parse(await readFile(path.join(appRoot, 'data', name + '.json'), 'utf8'))])));
}

const filename = (kind, part) => `${kind}-${part.sha256}.json.gz`;
module.exports = { PARTS, MAX_COMPRESSED, MAX_EXPANDED, hash, validateManifest, validateTables, decodeIcons, readTables, filename };
