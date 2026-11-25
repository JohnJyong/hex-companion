import { statsStatus } from './champion-stats.mjs';

const idOf = value => String(typeof value === 'object' && value ? value.gameId : value ?? '');
const validCount = row => row && Number.isSafeInteger(row.games) && row.games > 0
  && Number.isSafeInteger(row.wins) && row.wins >= 0 && row.wins <= row.games;

export function itemStatsStatus(dataset, context = {}) {
  return statsStatus({ meta: dataset?.meta, heroes: dataset?.equipmentHeroes }, context);
}

export function getCoreBuildStats(dataset, champion, selectedAugments = [], context = {}) {
  if (!dataset) return [];
  const status = itemStatsStatus(dataset, context);
  if (!status.compatible || status.patchMismatch || status.stale) return [];
  const excluded = new Set((dataset.meta.equipment?.excluded_augment_ids || []).map(String));
  // These participants were explicitly excluded upstream: no evidence for their modified gear paths.
  if (selectedAugments.some(augment => excluded.has(idOf(augment)))) return [];
  return (dataset.coreBuilds?.[idOf(champion)] || []).filter(row => validCount(row) && row.games >= 3000
    && row.ordered === true && Array.isArray(row.items) && row.items.length === 3 && new Set(row.items).size === 3
    && Number.isFinite(row.win) && Math.abs(row.win - row.wins / row.games) < .000001)
    .map(row => ({ kind: 'observed-core', items: [...row.items], ordered: true,
      games: row.games, wins: row.wins, winRate: row.win, pickRate: row.pick,
      scope: '同英雄、过滤装备干扰海克斯后的前三件传说装备顺序；不是六神装胜率，也非当前海克斯组合条件胜率',
      asOf: status.asOf, patch: status.patch, source: status.source, nonCommercialOnly: status.nonCommercialOnly }));
}

export function getAugmentItemStats(dataset, champion, selectedAugments = [], context = {}) {
  if (!dataset) return [];
  const status = itemStatsStatus(dataset, context);
  if (!status.compatible || status.patchMismatch || status.stale) return [];
  const selected = new Set(selectedAugments.map(idOf));
  const excluded = new Set((dataset.meta.destiny?.excluded_coexisting_augment_ids || []).map(String));
  if ([...selected].some(id => excluded.has(id))) return [];
  const rows = [];
  for (const augmentId of selected) {
    const config = dataset.heroAugmentItems?.[idOf(champion)]?.[augmentId];
    if (config?.source !== 'stats') continue;
    for (const row of config.items || []) if (validCount(row) && row.games >= 1000 && !row.low_sample) rows.push({
      kind: 'observed-augment-item', augmentGameId: augmentId, itemId: String(row.item),
      games: row.games, wins: row.wins, winRate: row.wins / row.games,
      scope: '同英雄持有命运之武器的首条传说装备记录；先按使用数取三件再按胜率排序，代理口径，不是完整购买路径',
      asOf: status.asOf, patch: status.patch, source: status.source, nonCommercialOnly: status.nonCommercialOnly,
    });
  }
  return rows.sort((a, b) => b.winRate - a.winRate || b.games - a.games);
}

export function lookupItemStats(dataset, champion, itemId, context = {}) {
  const status = itemStatsStatus(dataset, context);
  const row = dataset?.heroItems?.[idOf(champion)]?.[String(itemId)];
  if (!status.compatible || !validCount(row)) return null;
  return { games: row.games, wins: row.wins, winRate: row.wins / row.games,
    lowSample: row.low_sample === true || row.games < 3000,
    scope: '过滤装备干扰海克斯后的结算持有统计，不表示购买顺序', source: status.source };
}
