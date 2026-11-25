import { canEquip } from './engine.mjs';

export const emptySession = () => ({
  schema: 1, championId: null, selected: [], candidates: [null, null, null], owned: [],
  tier: 'gold', strategy: 'auto', priority: 'balanced',
  enemy: { damage: 'balanced', tanks: false, healing: false, cc: false },
  gold: 3000, demo: false, history: [], updatedAt: new Date().toISOString(),
});

export function validateSession(input, db) {
  if (!input || typeof input !== 'object' || input.schema !== 1) throw new Error('不是受支持的海克斯参谋对局文件');
  if (input.championId !== null && !db.championMap.has(input.championId)) throw new Error('对局中的英雄不在当前数据库中');
  const ids = (values, map, limit, name) => {
    if (!Array.isArray(values) || values.length > limit || values.some(id => typeof id !== 'string' || !map.has(id)) || new Set(values).size !== values.length) throw new Error(`${name}有重复、未知条目或数量超限`);
    return [...values];
  };
  const selected = ids(input.selected, db.augmentMap, 4, '已选海克斯');
  if (!Array.isArray(input.candidates) || input.candidates.length !== 3) throw new Error('候选海克斯必须保留三个栏位');
  const filled = ids(input.candidates.filter(x => x !== null), db.augmentMap, 3, '候选海克斯');
  if (filled.some(id => selected.includes(id))) throw new Error('候选海克斯不能与已选重复');
  if (!['silver', 'gold', 'prismatic'].includes(input.tier) || filled.some(id => db.augmentMap.get(id).tier !== input.tier)) throw new Error('同一轮候选海克斯必须是相同阶级');
  const owned = ids(input.owned, db.itemMap, 6, '已购装备');
  const champion = db.championMap.get(input.championId);
  if (!champion && (owned.length || selected.length || filled.length)) throw new Error('请先选择英雄');
  if (champion) for (let i = 0; i < owned.length; i++) if (!canEquip(owned[i], owned.slice(0, i), champion, db)) throw new Error('已有装备存在互斥或英雄限制');
  if (!['auto', 'marksman', 'onhit', 'mage', 'burn', 'fighter', 'tank', 'support'].includes(input.strategy)) throw new Error('未知出装方向');
  if (!['balanced', 'survive', 'damage'].includes(input.priority)) throw new Error('未知对局目标');
  if (!['balanced', 'ad', 'ap'].includes(input.enemy?.damage)) throw new Error('未知敌方伤害类型');
  if (!Number.isFinite(input.gold) || input.gold < 0 || input.gold > 99999) throw new Error('金币数值超出范围');
  return {
    ...emptySession(), championId: input.championId, selected, candidates: [...input.candidates], owned,
    tier: input.tier, strategy: input.strategy, priority: input.priority, gold: Math.round(input.gold), demo: input.demo === true,
    enemy: { damage: input.enemy.damage, tanks: input.enemy.tanks === true, healing: input.enemy.healing === true, cc: input.enemy.cc === true },
    history: Array.isArray(input.history) ? input.history.slice(-20).filter(x => x && typeof x.label === 'string').map(x => ({ label: x.label.slice(0, 180), time: String(x.time || '').slice(0, 40) })) : [],
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt.slice(0, 40) : new Date().toISOString(),
  };
}

// Only local restoration migrates references removed by a catalog update.
// Imports still use validateSession and report invalid input to the player.
export function restoreSession(input, db) {
  try { return {state:validateSession(input, db), migrated:false}; }
  catch (error) {
    if (input?.schema !== 1 || !Array.isArray(input.selected) || !Array.isArray(input.owned)
        || !Array.isArray(input.candidates) || input.candidates.length !== 3) throw error;
    const champion = db.championMap.get(input.championId);
    const selected = champion ? input.selected.filter(id => db.augmentMap.has(id)) : [];
    const candidates = input.candidates.map(id => champion && db.augmentMap.get(id)?.tier === input.tier ? id : null);
    const owned = [];
    for (const id of input.owned) {
      if (champion && db.itemMap.has(id) && canEquip(id, owned, champion, db)) owned.push(id);
    }
    const state = validateSession({...input, championId:champion?.id ?? null, selected, candidates, owned}, db);
    return {state, migrated:true};
  }
}

export function chooseAugment(state, id, db) {
  if (!state.championId) throw new Error('请先选择英雄');
  if (!state.candidates.includes(id)) throw new Error('只能选择本轮候选中的海克斯');
  if (state.selected.length >= 4) throw new Error('四次常规选择已完成');
  if (state.selected.includes(id)) throw new Error('这个海克斯已经选过');
  return validateSession({ ...state, selected: [...state.selected, id], candidates: [null, null, null], demo: false,
    history: [...state.history, { label: `第 ${state.selected.length + 1} 轮选择了「${db.augmentMap.get(id).name}」`, time: new Date().toISOString() }],
  }, db);
}

// OCR adapters use this neutral observation format after stability checks.
// Uncertain observations require manual correction and must not be applied.
export function applyObservation(state, observation, db) {
  if (!observation || observation.schema !== 1 || !['manual', 'ocr'].includes(observation.source) || observation.confirmed !== true) throw new Error('识别结果需通过连续帧校验或手动确认后再应用');
  const { championId, candidates, tier } = observation;
  return validateSession({ ...state, ...(championId ? { championId } : {}), ...(candidates ? { candidates } : {}), ...(tier ? { tier } : {}) }, db);
}
