import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const guides = JSON.parse(readFileSync(new URL('../app/data/community-guides.json', import.meta.url)));
const catalog = JSON.parse(readFileSync(new URL('../app/data/catalog.json', import.meta.url)));
const source = 'https://arammayhem.com';
const release = 'test-reviewed-release';
const wrapper = rows => ({ schemaVersion: 1, source: `${source}/data/`,
  license: 'CC BY 4.0: free with attribution', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  dataSource: 'ARAM: Mayhem match statistics', meta: { releaseId: release }, rows });
const fixture = () => {
  const names = [{ en: 'Marksmage', 'zh-CN': '神射法师' }, { en: 'Quest: Steel Your Heart', 'zh-CN': '任务：钢化你心' }];
  return { catalog: { meta: { mode: 'KIWI' }, champions: [{ id: 'Shyvana', name: '希瓦娜' }], augments: [
    { id: 'Marksmage', name: '神射法师', en: 'Marksmage', tier: 'gold' },
    { id: 'ARAM_Quest_SteelYourHeart', name: '钢化你心', en: 'Steel Your Heart', tier: 'gold' },
  ] }, augments: wrapper(names.map((name, i) => ({ augmentId: ['marksmage', 'quest_steel_your_heart'][i], name, rarity: 'gold', retiredPatch: null }))),
  combos: wrapper([{ comboId: 2, slug: 'shyvana-中文旧别名', championId: 'Shyvana',
    augmentIds: ['marksmage', 'quest_steel_your_heart'], augmentNames: structuredClone(names),
    types: ['trap'], url: `${source}/combo/shyvana-marksmage-2/` }]),
  checkedAt: '2026-11-18', release, chineseUrls: [`${source}/zh-cn/combo/shyvana-marksmage-2/`] };
};
function transform(input) {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, ['-c', `
import importlib.util,json,sys
s=importlib.util.spec_from_file_location('guides','scripts/import-community-guides.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
d=json.load(sys.stdin)
try:
 print(json.dumps({'result':m.transform(d['catalog'],d['combos'],d['augments'],d['checkedAt'],d['release'],d['chineseUrls'])},ensure_ascii=False))
except ValueError as e:
 print(json.dumps({'error':str(e)}))
`], { cwd: root, input: JSON.stringify(input), encoding: 'utf8', env: {...process.env, PYTHONUTF8:'1'} });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('licensed community indexes retain only resolvable KIWI relationships and true source routes', () => {
  assert.equal(guides.length, 420);
  assert.equal(new Set(guides.flatMap(g => g.championIds)).size, 147);
  const heroes = new Set(catalog.champions.map(c => c.id)), augments = new Set(catalog.augments.map(a => a.id));
  const identities = new Set(), relationships = new Set();
  for (const guide of guides) {
    assert.ok(!identities.has(guide.id)); identities.add(guide.id);
    const key = `${guide.championIds.join('|')}/${[...guide.augmentIds].sort().join('|')}`;
    assert.ok(!relationships.has(key)); relationships.add(key);
    assert.ok(guide.championIds.every(id => heroes.has(id)));
    assert.ok(guide.augmentIds.length > 0 && guide.augmentIds.every(id => augments.has(id)));
    assert.deepEqual(guide.itemIds, [], 'the source export contains no equipment recommendations');
    assert.equal(guide.patch, null, 'a release date or homepage patch is not a guide patch');
    assert.equal(guide.checkedAt, '2026-11-18');
    assert.equal(guide.license, 'CC BY 4.0');
    assert.equal(guide.mode, 'KIWI');
    assert.equal(guide.kind, 'community');
    assert.equal(guide.contentType, 'index');
    assert.equal(guide.relation, guide.augmentIds.length === 1 ? 'hero-augment' : 'mentioned-together');
    assert.match(guide.sourceUrl, /^https:\/\/arammayhem\.com\/zh-cn\/combo\/[a-z0-9-]+\/$/);
    assert.equal(guide.sourceUrl.replace('/zh-cn/', '/'), guide.sourceCanonicalUrl);
    assert.equal(guide.sourceUrlEvidence, 'published-sitemap');
    assert.match(guide.summary, /仅为攻略检索索引/);
    assert.ok(!('winRate' in guide) && !('score' in guide) && !('requiredAugmentIds' in guide));
  }
  assert.equal(guides.filter(g => g.stance === 'caution').length, 29);
  assert.equal(guides.filter(g => g.stance === 'entertainment').length, 21);
});

test('canonical route beats old localized slug; quest names map exactly and traps stay cautionary', () => {
  const [rows, rejected] = transform(fixture()).result;
  assert.deepEqual(rejected, []);
  assert.deepEqual(rows[0].augmentIds, ['Marksmage', 'ARAM_Quest_SteelYourHeart']);
  assert.equal(rows[0].stance, 'caution');
  assert.match(rows[0].title, /慎选索引/);
  assert.equal(rows[0].relation, 'mentioned-together');
  assert.equal(rows[0].sourceUrl, `${source}/zh-cn/combo/shyvana-marksmage-2/`);
  assert.equal(rows[0].patch, null);
  const en = fixture(); en.chineseUrls = [];
  assert.equal(transform(en).result[0][0].sourceUrl, en.combos.rows[0].url);
});

test('unmapped, retired or conflicting names reject the whole relationship instead of inventing a smaller combo', () => {
  for (const change of [
    f => { f.combos.rows[0].augmentIds.push('not-in-current-pool'); },
    f => { f.augments.rows[1].retiredPatch = '26.20'; },
    f => { f.augments.rows[1].rarity = 'silver'; },
    f => { f.combos.rows[0].augmentNames[0]['zh-CN'] = '错误的符文'; },
    f => { f.catalog.augments.push({ ...f.catalog.augments[0], id: 'Ambiguous' }); },
  ]) {
    const f = fixture(); change(f);
    const [rows, rejected] = transform(f).result;
    assert.deepEqual(rows, []);
    assert.equal(rejected.length, 1);
  }
});

test('source license, mode and release must be reviewed before importing', () => {
  for (const change of [
    f => { f.combos.license = 'All rights reserved'; },
    f => { f.combos.meta.releaseId = 'new-unreviewed-release'; },
    f => { f.catalog.meta.mode = 'CHERRY'; },
    f => { f.combos.dataSource = 'Arena match statistics'; },
  ]) {
    const f = fixture(); change(f);
    assert.ok(transform(f).error);
  }
});

test('an old internal ID alone cannot map a renamed augment to different current mechanics', () => {
  const f = fixture();
  f.catalog.augments = [{ id: 'DoubleDefense', name: '加固护盾', en: 'Bolstered', tier: 'silver' }];
  const name = { en: 'Double Defense', 'zh-CN': '双重防御' };
  f.augments.rows = [{ augmentId: 'double_defense', name, rarity: 'silver', retiredPatch: null }];
  f.combos.rows[0].augmentIds = ['double_defense']; f.combos.rows[0].augmentNames = [name];
  assert.deepEqual(transform(f).result[0], []);
});

test('malformed records and external URLs cannot enter the guide index; duplicate relationships collapse', () => {
  const f = fixture();
  f.combos.rows.push(null, { ...f.combos.rows[0], comboId: 3, championId: [] },
    { ...f.combos.rows[0], comboId: 4, types: [{}] },
    { ...f.combos.rows[0], comboId: 5, url: 'https://other.example/combo/unsafe/' },
    { ...f.combos.rows[0], comboId: 6 });
  const [rows, rejected] = transform(f).result;
  assert.equal(rows.length, 1);
  assert.equal(rejected.length, 5);
  assert.ok(rejected.some(r => r.reason === 'duplicate-relationship'));
});
