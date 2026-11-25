import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lookupChampionStats, championStats, rankHeroes, statsStatus, formatWinRate } from '../app/core/champion-stats.mjs';

const data = JSON.parse(readFileSync(new URL('../app/data/champion-stats.json', import.meta.url), 'utf8'));
const catalog = JSON.parse(readFileSync(new URL('../app/data/catalog.json', import.meta.url), 'utf8'));
const context = { ...catalog.meta, now: '2026-11-17T00:00:00+08:00' };

test('bundled data is the attributed normal Mayhem snapshot with coherent counts', () => {
  assert.equal(data.meta.mode, 'KIWI');
  assert.equal(data.meta.rule, 'normal');
  assert.equal(data.meta.band, 'all');
  assert.equal(data.meta.patch, '16.22');
  assert.equal(data.meta.asOf, '2026-11-15T17:00:00+08:00');
  assert.equal(data.meta.matches.valid, 48_081_485);
  assert.equal(data.meta.source.license, 'CC BY-NC 4.0');
  assert.equal(data.meta.source.nonCommercialOnly, true);
  assert.ok(data.meta.source.attribution.includes('github.com/czgreat/aramhex-data'));
  const rows = Object.values(data.heroes);
  assert.equal(rows.reduce((sum, row) => sum + row.games, 0), data.meta.matches.valid * 10);
  assert.equal(rows.reduce((sum, row) => sum + row.wins, 0), data.meta.matches.valid * 5);
  for (const champion of catalog.champions) {
    assert.ok(lookupChampionStats(data, champion, context), `Missing or invalid statistics: ${champion.id}`);
  }
});

test('lookup uses numeric game IDs and keeps licensing with returned data', () => {
  const annie = catalog.champions.find(champion => champion.id === 'Annie');
  const row = lookupChampionStats(data, annie, context);
  assert.equal(row.winRate, .492792);
  assert.equal(row.games, 1_116_957);
  assert.equal(row.wins, 550_427);
  assert.equal(row.license, 'CC BY-NC 4.0');
  assert.equal(row.nonCommercialOnly, true);
  assert.deepEqual(championStats(annie, data, context), row);
  assert.equal(lookupChampionStats(data, 'Annie', context), null);
  assert.equal(lookupChampionStats(data, '999999', context), null);
});

test('classic ARAM and other event rules cannot reuse normal Mayhem win rates', () => {
  assert.equal(lookupChampionStats(data, 1, { ...context, mode: 'ARAM' }), null);
  assert.equal(lookupChampionStats(data, 1, { ...context, rule: 'first-prismatic' }), null);
  assert.equal(statsStatus({ ...data, meta: { ...data.meta, mode: 'ARAM' } }, context).available, false);
});

test('public and internal patch names match, older data stays visibly marked', () => {
  assert.equal(statsStatus(data, context).patchMismatch, false);
  assert.equal(statsStatus(data, { patch: '26.22', now: context.now }).patchMismatch, false);
  const old = lookupChampionStats(data, 1, { patch: '26.23', now: '2026-12-10' });
  assert.equal(old.patchMismatch, true);
  assert.equal(old.stale, true);
  assert.ok(old.warnings.some(warning => warning.includes('不同')));
  assert.ok(old.warnings.some(warning => warning.includes('14 天')));
});

test('small samples are marked and inconsistent statistics are rejected', () => {
  const custom = structuredClone(data);
  custom.heroes['1'] = { ...custom.heroes['1'], games: 4, wins: 3, win_rate: .75, low_sample: false };
  const small = lookupChampionStats(custom, 1, context);
  assert.equal(small.lowSample, true);
  assert.ok(small.warnings.some(warning => warning.includes('4 次出场')));
  custom.heroes['1'].win_rate = .9;
  assert.equal(lookupChampionStats(custom, 1, context), null);
  custom.heroes['1'].games = 0;
  assert.equal(lookupChampionStats(custom, 1, context), null);
});

test('ranking uses observed win rate and leaves input order intact, unknowns last', () => {
  const champions = [...catalog.champions, { id: 'Missing', gameId: 999999, name: '未知' }];
  const original = champions.map(champion => champion.id);
  const ranking = rankHeroes(champions, data, context);
  assert.deepEqual(champions.map(champion => champion.id), original);
  assert.equal(ranking.at(-1).stats, null);
  for (let i = 1; i < ranking.length - 1; i++) assert.ok(ranking[i - 1].stats.winRate >= ranking[i].stats.winRate);
});

test('win-rate formatting never turns missing or invalid data into zero percent', () => {
  assert.equal(formatWinRate(.492792), '49.3%');
  assert.equal(formatWinRate(0), '0.0%');
  assert.equal(formatWinRate(null), '暂无数据');
  assert.equal(formatWinRate(NaN), '暂无数据');
  assert.equal(formatWinRate(53), '暂无数据');
});
