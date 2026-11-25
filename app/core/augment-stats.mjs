import { statsStatus } from './champion-stats.mjs';

const validStats = row => row && Number.isSafeInteger(row.games) && row.games > 0
  && Number.isSafeInteger(row.wins) && row.wins >= 0 && row.wins <= row.games
  && Number.isFinite(row.win_rate) && row.win_rate >= 0 && row.win_rate <= 1
  && Math.abs(row.win_rate - row.wins / row.games) <= 0.000001;
const idOf = value => String(typeof value === 'object' && value ? value.gameId : value ?? '');
const rankingCache = new WeakMap();

function heroRanking(dataset, heroId) {
  let cache = rankingCache.get(dataset);
  if (!cache) { cache = new Map(); rankingCache.set(dataset, cache); }
  if (cache.has(heroId)) return cache.get(heroId);
  const groups = new Map(), output = new Map();
  const minimum = dataset.meta?.lowSampleThreshold || 3000;
  for (const [id, row] of Object.entries(dataset.heroAugments?.[heroId] || {})) {
    const augment = dataset.augments?.[id];
    if (!augment || !validStats(row) || row.low_sample || row.games < minimum) continue;
    const list = groups.get(augment.rarity) || [];
    list.push({ id, row }); groups.set(augment.rarity, list);
  }
  for (const [tier, list] of groups) {
    list.sort((a, b) => b.row.win_rate - a.row.win_rate || b.row.games - a.row.games || Number(a.id) - Number(b.id));
    list.forEach(({ id }, i) => {
      const percentile = (i + 1) / list.length;
      output.set(id, { tier, tierRank: i + 1, tierCount: list.length, tierTotal: list.length,
        grade: percentile <= .1 ? 'S' : percentile <= .3 ? 'A' : percentile <= .6 ? 'B' : percentile <= .85 ? 'C' : 'D' });
    });
  }
  cache.set(heroId, output);
  return output;
}

export function lookupAugmentStats(dataset, champion, augment, context = {}) {
  if (!dataset) return null;
  const status = statsStatus(dataset, context);
  if (!status.compatible) return null;
  const heroId = idOf(champion), augmentId = idOf(augment);
  const baseline = dataset.heroes?.[heroId], row = dataset.heroAugments?.[heroId]?.[augmentId];
  if (!dataset.augments?.[augmentId] || !validStats(row) || !validStats(baseline)) return null;
  const lowSample = row.low_sample === true || row.games < (dataset.meta.lowSampleThreshold || 3000);
  const rank = heroRanking(dataset, heroId).get(augmentId);
  const deltaPP = (row.win_rate - baseline.win_rate) * 100;
  // Shrink only the internal decision signal. Displayed rates/delta remain raw observations.
  const smoothedWinRate = (row.wins + baseline.win_rate * 3000) / (row.games + 3000);
  return {
    heroGameId: heroId, augmentGameId: augmentId,
    winRate: row.win_rate, games: row.games, wins: row.wins, baselineWinRate: baseline.win_rate,
    baselineGames: baseline.games, deltaPP, smoothedWinRate, smoothedDeltaPP: (smoothedWinRate - baseline.win_rate) * 100,
    tier: dataset.augments[augmentId].rarity, tierRank: rank?.tierRank ?? null,
    tierCount: rank?.tierCount ?? 0, tierTotal: rank?.tierTotal ?? 0, grade: rank?.grade ?? null,
    gradeSource: '本工具按本英雄同阶有效样本原始胜率分位分档：S前10%、A前30%、B前60%、C前85%、D其余；不是官方评级',
    rankDefinition: dataset.meta.rankDefinition, deltaDefinition: '该英雄持有此海克斯的观察胜率 − 同英雄全体基准胜率，单位百分点（pp），不是因果提升',
    lowSample, reliable: !lowSample && !status.patchMismatch && !status.stale,
    patchMismatch: status.patchMismatch, stale: status.stale, patch: status.patch, displayPatch: status.displayPatch,
    asOf: status.asOf, bandName: status.bandName, source: status.source,
    warnings: [...status.warnings, ...(lowSample ? ['样本不足，不参与同阶排名与评级'] : [])],
    license: status.license, nonCommercialOnly: status.nonCommercialOnly,
  };
}

export function rankHeroAugments(dataset, champion, context = {}) {
  return Object.keys(dataset?.augments || {}).map(id => lookupAugmentStats(dataset, champion, id, context)).filter(Boolean)
    .sort((a, b) => Number(b.reliable) - Number(a.reliable) || b.winRate - a.winRate || b.games - a.games);
}

export const formatDeltaPP = value => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(1)} pp` : '暂无数据';
