// ARAM: Mayhem statistics are observational reference data, not recommendation scores.
const DAY_MS = 24 * 60 * 60 * 1000;
const isRate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const patchKey = value => String(value || '').match(/^(\d+\.\d+)(?:\.|$)/)?.[1] || null;

export function formatWinRate(value, digits = 1) {
  return isRate(value) ? `${(value * 100).toFixed(Math.min(3, Math.max(0, Math.trunc(digits) || 0)))}%` : '暂无数据';
}

export function statsStatus(dataset, context = {}) {
  const meta = dataset?.meta || {};
  const warnings = [];
  const available = meta.schema === 1 && meta.mode === 'KIWI' && meta.rule === 'normal'
    && meta.band === 'all' && dataset?.heroes && typeof dataset.heroes === 'object' && !Array.isArray(dataset.heroes);
  if (!available) warnings.push('没有适用于常规海克斯大乱斗的英雄统计');
  const modeMismatch = Boolean(context.mode && context.mode !== meta.mode);
  const ruleMismatch = Boolean(context.rule && context.rule !== meta.rule);
  if (modeMismatch || ruleMismatch) warnings.push('当前玩法与统计口径不同，不能使用此胜率');
  // Data Dragon 16.22.1 and the public patch label 26.22 refer to the same
  // catalog snapshot. Compare the explicit source versions, not arbitrary offsets.
  const currentPatch = patchKey(context.dataDragonVersion || context.patch);
  const acceptedPatches = new Set([patchKey(meta.patch), patchKey(meta.displayPatch)].filter(Boolean));
  const patchMismatch = Boolean(currentPatch && !acceptedPatches.has(currentPatch));
  if (patchMismatch) warnings.push(`统计版本 ${meta.displayPatch || meta.patch} 与当前版本 ${context.patch || context.dataDragonVersion} 不同`);
  const snapshot = Date.parse(meta.asOf || '');
  const now = context.now === undefined ? Date.now() : new Date(context.now).getTime();
  const stale = Number.isFinite(snapshot) && Number.isFinite(now) && now - snapshot > 14 * DAY_MS;
  if (!Number.isFinite(snapshot)) warnings.push('统计日期未知');
  if (stale) warnings.push('统计快照已超过 14 天，请结合游戏版本参考');
  return {
    available: Boolean(available), compatible: Boolean(available && !modeMismatch && !ruleMismatch),
    modeMismatch, ruleMismatch, patchMismatch, stale, warnings,
    patch: meta.patch || null, displayPatch: meta.displayPatch || meta.patch || null,
    asOf: meta.asOf || null, modeName: meta.modeName || '海克斯大乱斗', ruleName: meta.ruleName || '常规',
    bandName: meta.bandName || '全体样本', validMatches: meta.matches?.valid || 0,
    source: meta.source || null, license: meta.source?.license || null,
    nonCommercialOnly: meta.source?.nonCommercialOnly === true,
    attribution: meta.source?.attribution || '', limitations: meta.limitations || [],
  };
}

export function lookupChampionStats(dataset, champion, context = {}) {
  const status = statsStatus(dataset, context);
  if (!status.compatible) return null;
  const gameId = typeof champion === 'object' && champion ? champion.gameId : champion;
  if (gameId === undefined || gameId === null || !/^\d+$/.test(String(gameId))) return null;
  const row = dataset.heroes[String(gameId)];
  if (!row || !Number.isSafeInteger(row.games) || row.games < 1 || !Number.isSafeInteger(row.wins)
      || row.wins < 0 || row.wins > row.games || !isRate(row.win_rate)
      || Math.abs(row.win_rate - row.wins / row.games) > 0.000001) return null;
  const threshold = Number.isSafeInteger(dataset.meta.lowSampleThreshold) ? dataset.meta.lowSampleThreshold : 3000;
  const lowSample = row.low_sample === true || row.games < threshold;
  const warnings = [...status.warnings];
  if (lowSample) warnings.push(`样本仅 ${row.games.toLocaleString('zh-CN')} 次出场，胜率可能有较大波动`);
  return {
    gameId: String(gameId), name: row.name, title: row.title,
    winRate: row.win_rate, games: row.games, wins: row.wins,
    pickRate: isRate(row.pick_rate) ? row.pick_rate : null,
    rank: Number.isSafeInteger(row.rank) && row.rank > 0 ? row.rank : null,
    lowSample, warnings, patchMismatch: status.patchMismatch, stale: status.stale,
    asOf: status.asOf, patch: status.patch, displayPatch: status.displayPatch,
    bandName: status.bandName, source: status.source, license: status.license,
    nonCommercialOnly: status.nonCommercialOnly, attribution: status.attribution,
  };
}

export function rankHeroes(champions, dataset, context = {}) {
  return champions.map(champion => ({ champion, stats: lookupChampionStats(dataset, champion, context) }))
    .sort((a, b) => {
      if (!a.stats || !b.stats) return Number(Boolean(b.stats)) - Number(Boolean(a.stats))
        || String(a.champion.name || a.champion.id).localeCompare(String(b.champion.name || b.champion.id), 'zh-CN');
      return b.stats.winRate - a.stats.winRate || b.stats.games - a.stats.games
        || String(a.champion.id).localeCompare(String(b.champion.id));
    });
}

// Descriptive aliases keep callers concise whether they start from a hero or dataset.
export const championStats = (champion, dataset, context) => lookupChampionStats(dataset, champion, context);
export const rankChampions = rankHeroes;
