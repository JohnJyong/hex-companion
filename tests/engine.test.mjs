import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { indexCatalog, scoreAugment, recommendBuilds, canEquip, synergyBetween } from '../app/core/engine.mjs';
import { emptySession, validateSession, chooseAugment, applyObservation } from '../app/core/session.mjs';

const db = indexCatalog(JSON.parse(await readFile(new URL('../app/data/catalog.json', import.meta.url), 'utf8')));
const session = (championId, extra = {}) => ({ ...emptySession(), championId, ...extra });
const a = id => { const found = db.augmentMap.get(id) || db.augmentMap.get(`ARAM_${id}`); assert.ok(found, id); return found; };
const score = (id, s) => scoreAugment(a(id), s, db).score;

test('catalog contains the Mayhem pool, all local images and unique identities', async () => {
  assert.equal(db.meta.mode, 'KIWI');
  assert.ok(db.champions.length >= 170);
  assert.equal(db.championMap.get('Jinx').name, '金克丝');
  for (const group of [db.champions, db.augments, db.items]) {
    assert.equal(new Set(group.map(x => x.id)).size, group.length);
    for (const item of group) assert.ok((await readFile(new URL(`../app/${item.icon}`, import.meta.url))).length > 100);
  }
  assert.ok(db.augments.every(x => x.name.trim()));
});
test('champion recommendations distinguish attack carries, mages, dash and mana prerequisites', () => {
  assert.ok(score('Deft', session('Jinx')) > score('WitchfulThinking', session('Jinx')) + 15);
  assert.ok(score('WitchfulThinking', session('Lux')) > score('Deft', session('Lux')) + 15);
  assert.ok(score('OutlawsGrit', session('Yasuo')) > score('OutlawsGrit', session('Jinx')) + 25);
  assert.ok(score('Overflow', session('Ryze')) > score('Overflow', session('Garen')) + 25);
  assert.ok(score('Minionmancer', session('Zyra')) > score('Minionmancer', session('Jinx')) + 25);
});
test('spell crit and damage over time synergies affect candidate ranking', () => {
  const before = score('ItsCritical', session('Lux'));
  const after = score('ItsCritical', session('Lux', { selected: [a('JeweledGauntlet').id] }));
  assert.ok(after > before + 15);
  assert.ok(synergyBetween(a('Vulnerability'), a('InfernalConduit')).value >= 10);
  const existing = scoreAugment(a('Deft'), session('Jinx', { selected: [a('Deft').id] }), db);
  assert.ok(!existing.reasons.some(reason => reason.includes('搭配「灵巧」')));
});
test('Back to Basics conflicts with ultimate-triggered augments', () => {
  const s = session('Malphite', { selected: [a('BacktoBasics').id] });
  const result = scoreAugment(a('UltimateRevolution'), s, db);
  assert.ok(result.score < 35);
  assert.ok(result.warnings.some(x => x.includes('失效')));
});
test('late scaling quests have lower value than early acquisition', () => {
  const early = score('Quest_SteelYourHeart', session('Sion'));
  const late = score('Quest_SteelYourHeart', session('Sion', { selected: [a('Deft').id, a('WitchfulThinking').id, a('Recursion').id] }));
  assert.ok(early > late);
});
test('unverified augment mechanisms remain unscored', () => {
  assert.equal(score('Multishot', session('Jinx')), null);
});
test('default builds follow champion roles, and combinations open new paths', () => {
  assert.equal(recommendBuilds(session('Jinx'), db)[0].id, 'crit');
  assert.equal(recommendBuilds(session('Brand'), db)[0].id, 'burn');
  assert.equal(recommendBuilds(session('Soraka'), db)[0].id, 'support');
  assert.equal(recommendBuilds(session('Malphite'), db)[0].id, 'tank');
  const crit = recommendBuilds(session('Lux', { selected: [a('JeweledGauntlet').id] }), db)[0];
  assert.equal(crit.id, 'spellCrit');
  assert.ok(crit.items.some(i => i.id === '3031'));
  assert.equal(recommendBuilds(session('Lux', { selected: [a('EtherealWeapon').id] }), db)[0].id, 'spellOnhit');
});
test('preview is pure and alters build output without mutating current selection', () => {
  const s = session('Lux'); const copy = structuredClone(s);
  const result = recommendBuilds(s, db, a('JeweledGauntlet').id);
  assert.equal(result[0].id, 'spellCrit'); assert.deepEqual(s, copy);
});
test('every hero gets six valid slots, including Cassiopeia and melee limitations', () => {
  for (const champion of db.champions) for (const enemy of [emptySession().enemy, { damage: 'ap', tanks: true, healing: true, cc: true }, { damage: 'ad', tanks: false, healing: true, cc: false }]) {
    const builds = recommendBuilds(session(champion.id, { enemy }), db);
    assert.equal(builds.length, 3);
    for (const build of builds) {
      const ids = build.items.map(i => i.id);
      assert.equal(ids.length, 6, champion.id + ' / ' + build.id);
      for (let i = 0; i < ids.length; i++) assert.ok(canEquip(ids[i], ids.slice(0, i), champion, db), champion.id + ' / ' + ids.join(','));
    }
  }
});
test('owned gear persists, a second pair of boots is excluded, and item quests are honored', () => {
  const s = session('Lux', { owned: ['3158', '3157'], selected: [a('Quest_WoogletsWitchcap').id] });
  for (const b of recommendBuilds(s, db)) {
    assert.ok(b.items.some(i => i.id === '3158')); assert.ok(b.items.some(i => i.id === '3157'));
    assert.equal(b.items.filter(i => i.tags.includes('Boots')).length, 1);
    assert.ok(b.items.some(i => i.id === '3089'));
    assert.ok(!s.owned.includes(b.next.id));
  }
});
test('enemy sustain leads to anti-heal without stacking exclusive penetration items', () => {
  const s = session('Jinx', { enemy: { ...emptySession().enemy, healing: true } });
  const build = recommendBuilds(s, db)[0];
  assert.ok(build.items.some(i => i.id === '3033'));
  assert.ok(!build.items.some(i => i.id === '3036'));
});
test('candidate commits clear offered cards and are export/import round-trippable', () => {
  const s = session('Jinx', { candidates: [a('Firebrand').id, a('Recursion').id, a('Marksmage').id] });
  const next = chooseAugment(s, a('Firebrand').id, db);
  assert.deepEqual(next.selected, [a('Firebrand').id]); assert.deepEqual(next.candidates, [null, null, null]);
  assert.equal(validateSession(JSON.parse(JSON.stringify(next)), db).selected[0], a('Firebrand').id);
  assert.equal(s.selected.length, 0);
});
test('invalid imports and unconfirmed observations cannot change sessions', () => {
  assert.throws(() => validateSession(session('Jinx', { candidates: [a('Deft').id, a('Firebrand').id, null] }), db), /相同阶级/);
  assert.throws(() => validateSession(session('Jinx', { owned: ['3006', '3111'] }), db), /互斥/);
  assert.throws(() => validateSession(session('Jinx', { owned: Array(6).fill('3031') }), db), /重复/);
  assert.throws(() => validateSession(session('Unknown'), db), /英雄/);
  assert.throws(() => validateSession(session('Jinx', { gold: Infinity }), db), /金币/);
  assert.throws(() => applyObservation(session('Jinx'), { schema: 1, source: 'ocr', confirmed: false }, db), /确认/);
});
