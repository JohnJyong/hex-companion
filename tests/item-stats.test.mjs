import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getCoreBuildStats, getAugmentItemStats } from '../app/core/item-stats.mjs';
import { indexCatalog, recommendBuilds, canEquip, itemsConflict } from '../app/core/engine.mjs';
import { emptySession } from '../app/core/session.mjs';

const read = name => JSON.parse(readFileSync(new URL(`../app/data/${name}.json`, import.meta.url), 'utf8'));
const dataset = read('item-stats'), catalog = read('catalog');
const db = indexCatalog({ ...catalog, meta: { ...catalog.meta, now: '2026-11-17T00:00:00+08:00' }, itemStats: dataset });
const session = (championId, extra = {}) => ({ ...emptySession(), championId, ...extra });
const augment = id => db.augmentMap.get(id) || db.augmentMap.get(`ARAM_${id}`);

test('Yasuo default follows actual hero cores and never a generic Trinity Force template', () => {
  const builds = recommendBuilds(session('Yasuo'), db);
  assert.ok(builds[0].evidence.applied);
  assert.deepEqual(builds[0].evidence.items, dataset.coreBuilds['157'][0].items);
  assert.equal(builds[0].evidence.games, dataset.coreBuilds['157'][0].games);
  assert.ok(builds[0].evidence.scope.includes('不是六神装胜率'));
  for (const build of builds) assert.ok(!build.items.some(item => item.id === '3078'));
  const fallback = recommendBuilds(session('Yasuo'), { ...db, itemStats: null });
  assert.equal(fallback[0].id, 'crit');
  assert.ok(fallback.every(build => !build.items.some(item => item.id === '3078')));
});

test('Yasuo IE upgrade changes the next purchase; Marksmage does not invent AP scaling', () => {
  const upgraded = recommendBuilds(session('Yasuo', { selected: [augment('Upgrade_IE').id] }), db);
  assert.equal(upgraded[0].next.id, '3031');
  assert.equal(upgraded[0].evidence, null); // the source explicitly excludes this augment
  assert.ok(upgraded.every(build => !build.items.some(item => item.id === '3078')));
  const marksmage = recommendBuilds(session('Yasuo', { selected: [augment('Marksmage').id] }), db);
  assert.ok(marksmage[0].items.some(item => item.id === '3032' || item.id === '3031'));
  assert.ok(marksmage.every(build => !build.items.some(item => ['3115', '3089', '3135'].includes(item.id))));
});

test('Brand burn-crit build changes with the second pick and advances past the owned burn items', () => {
  const state = session('Brand', {selected:[augment('Vulnerability').id]});
  const preview = recommendBuilds(state, db, augment('JeweledGauntlet').id)[0];
  const actual = recommendBuilds({...state, selected:[...state.selected, augment('JeweledGauntlet').id]}, db)[0];
  assert.equal(actual.id, 'dotCrit');
  assert.deepEqual(preview.items, actual.items);
  assert.equal(actual.evidence, null);
  assert.deepEqual(actual.items.slice(0,4).map(item => item.id), ['2503','3020','6653','4645']);
  assert.equal(actual.nextReason,'易损可强化装备灼烧');
  const afterPurchases = recommendBuilds({...state, selected:[...state.selected,augment('JeweledGauntlet').id],owned:['2503','3020','6653']}, db)[0];
  assert.equal(afterPurchases.next.id,'4645');
  assert.deepEqual(state.selected,[augment('Vulnerability').id]);
});

test('core evidence is not reused for excluded augments, a different patch or different mode', () => {
  const hero = db.championMap.get('Yasuo');
  assert.ok(getCoreBuildStats(dataset, hero, [], db.meta).length);
  assert.deepEqual(getCoreBuildStats(dataset, hero, [augment('Upgrade_IE')], db.meta), []);
  assert.deepEqual(getCoreBuildStats(dataset, hero, [], { ...db.meta, dataDragonVersion: '16.23.1' }), []);
  assert.deepEqual(getCoreBuildStats(dataset, hero, [], { ...db.meta, mode: 'ARAM' }), []);
  assert.deepEqual(getAugmentItemStats(dataset, hero, [augment('Marksmage')], db.meta), []);
  assert.ok(getAugmentItemStats(dataset, hero, [3081], db.meta).length);
});

test('owned items persist and all hero statistical plans still satisfy equipment constraints', () => {
  const owned = recommendBuilds(session('Jinx', { owned: ['3032', '3006'] }), db);
  assert.ok(owned.every(build => build.items.filter(item => item.id === '3032').length === 1));
  for (const hero of db.champions) for (const build of recommendBuilds(session(hero.id), db)) {
    assert.equal(build.items.length, 6, `${hero.id}/${build.id}`);
    const ids = [];
    for (const item of build.items) {
      assert.ok(canEquip(item.id, ids, hero, db), `${hero.id}/${item.id}`);
      ids.push(item.id);
    }
  }
});

test('fallback profiles fix Vayne AP pollution, Mundo fighter gear and Teemo AD-first gear', () => {
  const rules = { ...db, itemStats: null };
  assert.ok(recommendBuilds(session('Vayne'), rules).every(build => build.id !== 'apAttack'));
  assert.equal(recommendBuilds(session('DrMundo'), rules)[0].id, 'tank');
  assert.equal(recommendBuilds(session('Teemo'), rules)[0].id, 'burn');
  assert.ok(itemsConflict('2510', '3100', db));
  assert.ok(itemsConflict('3508', '3078', db));
  assert.ok(itemsConflict('6631', '3074', db));
  assert.ok(canEquip('3085', [], db.championMap.get('Kayle'), db));
  const darius = recommendBuilds(session('Darius', { enemy: { ...emptySession().enemy, healing: true } }), rules)[0];
  assert.ok(darius.items.some(item => item.id === '6609'));
});
