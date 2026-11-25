import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lookupAugmentStats, rankHeroAugments, formatDeltaPP } from '../app/core/augment-stats.mjs';
import { indexCatalog, rankCandidates } from '../app/core/engine.mjs';
import { emptySession } from '../app/core/session.mjs';

const read = name => JSON.parse(readFileSync(new URL(`../app/data/${name}.json`, import.meta.url), 'utf8'));
const dataset = read('augment-stats'), catalog = read('catalog');
const context = { ...catalog.meta, now: '2026-11-17T00:00:00+08:00' };
const db = indexCatalog({ ...catalog, meta: context, augmentStats: dataset });
const hero = db.championMap.get('Yasuo');
const a = id => db.augmentMap.get(id) || db.augmentMap.get(`ARAM_${id}`);

test('hero and augment game IDs map to actual sample rates; pp is an absolute difference', () => {
  const augment = a('Deft');
  const result = lookupAugmentStats(dataset, hero, augment, context);
  const row = dataset.heroAugments[hero.gameId][augment.gameId];
  assert.equal(result.winRate, row.win_rate);
  assert.equal(result.games, row.games);
  assert.ok(Math.abs(result.deltaPP - (row.win_rate - dataset.heroes[hero.gameId].win_rate) * 100) < 1e-10);
  assert.equal(result.nonCommercialOnly, true);
  assert.equal(formatDeltaPP(5.3), '+5.3 pp');
  assert.equal(formatDeltaPP(null), '暂无数据');
});

test('rarity rank uses only the same hero, current catalog and sufficient observed samples', () => {
  const result = lookupAugmentStats(dataset, hero, a('Deft'), context);
  const peers = Object.entries(dataset.heroAugments[hero.gameId]).filter(([id, row]) =>
    dataset.augments[id]?.rarity === result.tier && row.games >= 3000 && !row.low_sample)
    .sort((a, b) => b[1].win_rate - a[1].win_rate || b[1].games - a[1].games || Number(a[0]) - Number(b[0]));
  assert.equal(result.tierRank, peers.findIndex(([id]) => id === String(a('Deft').gameId)) + 1);
  assert.equal(result.tierCount, peers.length);
  assert.ok(result.gradeSource.includes('不是官方评级'));
  const expectedIds = Object.keys(dataset.heroAugments[hero.gameId]).filter(id => dataset.augments[id]).sort();
  assert.deepEqual(rankHeroAugments(dataset, hero, context).map(row => row.augmentGameId).sort(), expectedIds);
});

test('excluded, unknown and wrong-mode data never acquire invented rates or grades', () => {
  assert.equal(lookupAugmentStats(dataset, hero, 1337, context), null);
  assert.equal(lookupAugmentStats(dataset, hero, 999999, context), null);
  assert.equal(lookupAugmentStats(dataset, hero, a('Deft'), { ...context, mode: 'ARAM' }), null);
  const small = structuredClone(dataset), id = a('Deft').gameId;
  small.heroAugments[hero.gameId][id] = { games: 4, wins: 3, win_rate: .75, low_sample: true };
  const result = lookupAugmentStats(small, hero, id, context);
  assert.equal(result.winRate, .75);
  assert.equal(result.grade, null);
  assert.equal(result.tierRank, null);
  assert.equal(result.reliable, false);
  assert.equal(lookupAugmentStats(dataset, hero, id, { ...context, patch: '26.23', dataDragonVersion: '16.23.1' }).reliable, false);
});

test('a very high observed rate cannot override a known ultimate-disable conflict', () => {
  const stats = structuredClone(dataset), malphite = db.championMap.get('Malphite');
  const conflict = a('UltimateRevolution'), normal = a('Deft');
  stats.heroAugments[malphite.gameId][conflict.gameId] = { games: 100000, wins: 99000, win_rate: .99, low_sample: false };
  const candidates = rankCandidates({ ...emptySession(), championId: 'Malphite',
    selected: [a('BacktoBasics').id], candidates: [conflict.id, normal.id, null] }, { ...db, augmentStats: stats });
  assert.equal(candidates.at(-1).augment.id, conflict.id);
  assert.equal(candidates.at(-1).conflict, true);
  assert.equal(candidates.at(-1).statistics.winRate, .99);
  assert.notEqual(candidates.at(-1).score, 99);
});
