import { championProfile, FEATURE_NAMES } from './profiles.mjs';
import { augmentRule, directPairReason, shortId } from './augment-rules.mjs';
import { lookupAugmentStats } from './augment-stats.mjs';
import { getCoreBuildStats, getAugmentItemStats } from './item-stats.mjs';
import { comboReading } from './guides.mjs';

export const TIERS = { silver: '白银', gold: '黄金', prismatic: '棱彩' };
export const STRATEGIES = { auto: '自动判断', marksman: '暴击普攻', onhit: '攻击特效', mage: '法术输出', burn: '持续灼烧', fighter: '战士续航', tank: '前排坦度', support: '治疗保护' };
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const mean = arr => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
const same = (a, b) => a.filter(x => b.includes(x));

export function indexCatalog(catalog) {
  return { ...catalog, championMap: new Map(catalog.champions.map(c => [c.id, c])), augmentMap: new Map(catalog.augments.map(a => [a.id, a])), itemMap: new Map(catalog.items.map(i => [i.id, i])) };
}

export function itemFeatures(item) {
  const m = { Damage: 'ad', SpellDamage: 'ap', CriticalStrike: 'crit', AttackSpeed: 'attack', OnHit: 'onhit', Health: 'health', Armor: 'resist', SpellBlock: 'resist', MagicResist: 'resist', AbilityHaste: 'haste', CooldownReduction: 'haste', Mana: 'mana', LifeSteal: 'heal', NonbootsMovement: 'speed' };
  const tags = [...new Set(item.tags.map(t => m[t]).filter(Boolean))];
  if (['6653', '2503', '3068', '6664'].includes(item.id)) tags.push('dot');
  if (['6617', '6620', '6621', '3107', '3504', '3222', '4005'].includes(item.id)) tags.push('ally', 'heal', 'shield');
  if (['3157', '2502', '3084', '6610', '3107'].includes(item.id)) tags.push('itemhaste');
  return [...new Set(tags)];
}

function effectiveProfile(champion, selected, state) {
  const p = championProfile(champion, state.strategy);
  p.features = { ...p.features };
  const f = p.features;
  const rules = selected.map(augmentRule);
  if (rules.some(r => r.tags.includes('dot') || r.grants?.includes('burn'))) f.dot = Math.max(f.dot, .8);
  if (rules.some(r => r.grants?.includes('spellCrit'))) f.crit = Math.max(f.crit, f.spell * .95);
  if (rules.some(r => r.grants?.includes('dotCrit'))) f.crit = Math.max(f.crit, f.dot * .95);
  if (rules.some(r => r.grants?.includes('healCrit'))) f.crit = Math.max(f.crit, Math.max(f.heal, f.shield) * .9);
  if (rules.some(r => r.grants?.includes('onhit'))) f.onhit = Math.max(f.onhit, f.spell * .9);
  if (rules.some(r => r.disablesUltimate)) f.ult = 0;
  return p;
}

const pairRules = [
  ['spellCrit', 'crit', 10, '技能已经能暴击，新增暴击收益可以作用到技能上'],
  ['dotCrit', 'dot', 11, '持续伤害可以暴击，强化持续伤害的收益更高'],
  ['dotCrit', 'crit', 9, '暴击收益可以强化已有的持续伤害效果'],
  ['healCrit', 'crit', 8, '已有治疗暴击机制，新增暴击能力可强化回复'],
  ['onhit', 'onhit', 9, '已有技能触发攻击特效的机制，可放大攻击特效收益'],
  ['burn', 'dot', 10, '灼烧与持续伤害形成同一输出方向'],
];

export function synergyBetween(a, b) {
  const ra = augmentRule(a), rb = augmentRule(b);
  if (a.id === b.id || !ra.verified || !rb.verified) return { value: 0, reasons: [], conflict: false };
  if ((ra.disablesUltimate && rb.requires === 'ult') || (rb.disablesUltimate && ra.requires === 'ult')) return { value: -28, reasons: ['回归基本功禁用大招，使另一符文的触发条件失效'], conflict: true, kind: 'conflict' };
  if (ra.conversion && rb.conversion && ra.conversion !== rb.conversion) return { value: -25, reasons: ['物理与魔法转换方向冲突'], conflict: true, kind: 'conflict' };
  const direct = directPairReason(a, b);
  if (direct) return { value: 18, reasons: [direct], conflict: false, kind: 'direct' };
  let value = 0;
  const reasons = [];
  for (const [from, to, bonus, text] of pairRules) {
    if ((ra.grants?.includes(from) && rb.tags.includes(to)) || (rb.grants?.includes(from) && ra.tags.includes(to))) { value += bonus; reasons.push(text); }
  }
  const shared = same(ra.tags, rb.tags).filter(x => !['economy', 'stack'].includes(x));
  if (shared.length) {
    value += Math.min(7, shared.length * 3);
    reasons.push(`共同强化${shared.slice(0, 2).map(x => FEATURE_NAMES[x]).join('、')}`);
  }
  return { value: Math.min(18, value), reasons: [...new Set(reasons)], conflict: false, kind: 'direction' };
}

function selectedInteractions(candidate, selected, profile) {
  return selected.map(previous => {
    const pair = synergyBetween(candidate, previous);
    const requires = [augmentRule(candidate).requires, augmentRule(previous).requires].filter(Boolean);
    if (!pair.conflict && requires.some(tag => tag === 'ranged' ? profile.melee : (profile.features[tag] || 0) < .3)) return null;
    return pair.value ? { ...pair, partnerId: previous.id, partner: previous.name } : null;
  }).filter(Boolean).sort((a, b) => Number(b.conflict) - Number(a.conflict)
    || Number(b.kind === 'direct') - Number(a.kind === 'direct') || b.value - a.value);
}

export function interactionLabel(pair) {
  if (!pair) return '';
  const label = pair.conflict ? '冲突' : pair.kind === 'direct' ? '联动' : '搭配';
  return `${label} · 已选「${pair.partner}」${pair.reasons[0] ? ' · ' + pair.reasons[0] : ''}`;
}

export function scoreAugment(augment, state, db) {
  const champion = db.championMap.get(state.championId);
  if (!champion) return { augment, score: null, reasons: ['请先选择英雄'], warnings: [], breakdown: [] };
  const selected = state.selected.filter(id => id !== augment.id).map(id => db.augmentMap.get(id)).filter(Boolean);
  const owned = state.owned.map(id => db.itemMap.get(id)).filter(Boolean);
  const rule = augmentRule(augment);
  if (!rule.verified || !rule.tags.length) return { augment, score: null, reasons: ['机制规则尚未覆盖，暂不参与精确排序'], warnings: ['请对照游戏内说明，不能把未评分理解为弱。'], breakdown: [], confidence: '待补充' };
  const profile = effectiveProfile(champion, selected, state);
  const f = { ...profile.features };
  if (rule.grants?.includes('spellCrit')) f.crit = Math.max(f.crit, f.spell * .95);
  if (rule.grants?.includes('dotCrit')) f.crit = Math.max(f.crit, f.dot * .95);
  if (rule.grants?.includes('healCrit')) f.crit = Math.max(f.crit, Math.max(f.heal, f.shield) * .9);
  if (rule.tags.includes('dot') && (rule.tags.includes('spell') || rule.tags.includes('attack'))) f.dot = Math.max(f.dot, .75);
  if (rule.grants?.includes('onhit')) f.onhit = Math.max(f.onhit, f.spell * .9);
  const weights = rule.tags.map(t => f[t] || 0);
  let fit = mean(weights);
  if (shortId(augment.id) === 'Marksmage') fit = Math.sqrt(f.ap * f.attack);
  if (shortId(augment.id) === 'MasterofDuality') fit = Math.sqrt(f.attack * f.spell) * Math.max(f.ad, f.ap);
  const reasons = [], warnings = [];
  let penalty = 0;
  if (rule.requires) {
    const available = rule.requires === 'ranged' ? !profile.melee : (f[rule.requires] || 0) >= .3;
    if (!available) {
      penalty += 38;
      warnings.push(rule.requires === 'ranged' ? '当前英雄本来就是近战，不能充分兑现舍弃射程的收益。' : `当前英雄或组合缺少稳定的${FEATURE_NAMES[rule.requires]}触发条件。`);
    }
  }
  const topFeatures = rule.tags.filter(t => (f[t] || 0) >= .65).slice(0, 3);
  reasons.push(topFeatures.length ? `${champion.name}能较好利用${topFeatures.map(t => FEATURE_NAMES[t]).join('、')}。` : '与英雄当前输出方式的直接关联较弱。');
  if (shortId(augment.id) === 'Marksmage' && f.ap < .5) reasons.unshift('当前路线的法强收益较低，难以兑现基于法强的普攻附伤。');
  let combo = selected.length ? 3 : 9;
  const interactions = selectedInteractions(augment, selected, profile);
  for (const pair of interactions) {
    if (pair.value > 0) { combo += pair.value; reasons.push(`搭配「${pair.partner}」：${pair.reasons[0]}。`); }
    if (pair.conflict) { penalty += -pair.value; warnings.push(pair.reasons[0] + '。'); }
  }
  combo = Math.min(25, combo);
  let equipment = owned.length ? 2 : 6;
  const matchingItems = owned.filter(i => same(itemFeatures(i), rule.tags).length >= 2);
  equipment += Math.min(8, matchingItems.length * 3);
  if (matchingItems.length) reasons.push(`已购${matchingItems.slice(0, 2).map(i => `「${i.name}」`).join('、')}支持这个方向。`);
  if (rule.requiredItems) {
    const found = rule.requiredItems.filter(id => state.owned.includes(id));
    const satisfied = rule.anyItem ? found.length > 0 : found.length === rule.requiredItems.length;
    if (satisfied) { equipment = 10; reasons.push('所需装备已经具备，可以较早兑现强化收益。'); }
    else {
      const missing = rule.requiredItems.filter(id => !state.owned.includes(id));
      const names = missing.map(id => db.itemMap.get(id)?.name).filter(Boolean);
      if (names.length) warnings.push(`需补出${names.map(n => `「${n}」`).join(rule.anyItem ? '或' : '、')}。`);
      if (state.owned.length >= 6) { penalty += 15; warnings.push('装备栏已满，需要卖装才能完成该路线。'); }
    }
  }
  let context = 5;
  if (state.enemy.tanks && (rule.tags.includes('dot') || shortId(augment.id) === 'ThreadtheNeedle')) context += 3;
  if (state.enemy.cc && (rule.tags.includes('resist') || ['UltimateUnstoppable', 'LegDay'].includes(shortId(augment.id)))) context += 2;
  if (state.enemy.damage !== 'balanced' && rule.tags.includes('resist')) context += 2;
  if (state.priority === 'survive') { if (rule.tags.some(t => ['health', 'resist', 'shield', 'heal'].includes(t))) context += 4; else context -= 2; }
  if (state.priority === 'damage') { if (rule.tags.some(t => ['attack', 'spell', 'crit', 'dot'].includes(t))) context += 3; }
  const round = state.selected.length + 1;
  if (rule.scalingQuest && round >= 3) { penalty += (round - 2) * 7; warnings.push('当前已经进入后半程，任务完成时间会限制实际收益。'); }
  if (rule.disablesUltimate && championProfile(champion).features.ult >= .65) { penalty += 16; warnings.push('这个英雄较依赖终极技能，放弃大招的代价较大。'); }
  if (rule.conversion && ((rule.conversion === 'ap' && profile.features.ad > profile.features.ap) || (rule.conversion === 'ad' && profile.features.ap > profile.features.ad))) penalty += 25;
  if (rule.warning) warnings.push(rule.warning);
  if (augment.abilitySpecific) warnings.push('此强化绑定游戏内指定技能；当前模型未区分具体技能槽位，排名仅供初筛。');
  if (rule.random) warnings.push('结果随机，当前分数只表示一般成长价值，不预测随机结果。');
  if (!rule.reviewed) warnings.push('使用通用关键词规则，尚未加入这张符文的专属交互规则。');
  const hero = Math.round(12 + fit * 43);
  context = clamp(context, 0, 10);
  const score = clamp(Math.round(hero + combo + Math.min(equipment, 10) + context - penalty), 5, 99);
  return {
    augment, score, fit, interactions, reasons: reasons.slice(0, 4), warnings: [...new Set(warnings)],
    confidence: rule.reviewed && profile.reviewed && !augment.abilitySpecific ? '专属规则' : '基础规则',
    breakdown: [{ label: '英雄适配', value: hero, max: 55 }, { label: '组合联动', value: combo, max: 25 }, { label: '已有装备', value: Math.min(equipment, 10), max: 10 }, { label: '对局环境', value: context, max: 10 }, ...(penalty ? [{ label: '条件扣分', value: -penalty, max: 100 }] : [])],
  };
}

export function rankCandidates(state, db) {
  const champion = db.championMap.get(state.championId);
  return state.candidates.filter(Boolean).map(id => db.augmentMap.get(id)).filter(Boolean).map(augment => {
    const result = scoreAugment(augment, state, db);
    const statistics = lookupAugmentStats(db.augmentStats, champion, augment, db.meta);
    const pairs = result.interactions || [];
    const conflict = pairs.some(pair => pair.conflict);
    let decisionScore = result.score ?? -1;
    let rankingBasis = '机制规则参考';
    if (statistics?.reliable) {
      // Observed uplift dominates a generic hero template; local interactions
      // adjust it. This internal score is deliberately never labelled win rate.
      decisionScore = 55 + clamp(statistics.smoothedDeltaPP * 2.5, -30, 30)
        + (result.score === null ? 0 : clamp((result.score - 60) / 3, -8, 8))
        + clamp(pairs.reduce((sum, pair) => sum + Math.max(0, pair.value), 0) * .4, 0, 9);
      const conditionPenalty = result.breakdown?.find(row => row.label === '条件扣分');
      if (conditionPenalty) decisionScore += Math.max(-35, conditionPenalty.value * .6);
      rankingBasis = '英雄×海克斯样本参考＋当前机制修正；非组合胜率';
    }
    if (conflict) decisionScore = -1000;
    return { ...result, statistics, decisionScore, rankingBasis, conflict, guide: comboReading(db.guideIndex, state, augment.id) };
  }).sort((a, b) => b.decisionScore - a.decisionScore);
}

const BUILDS = [
  { id: 'crit', name: '暴击持续输出', type: 'marksman', tags: ['attack', 'crit', 'ad'], ids: ['3032', '3006', '3031', '3085', '3036', '3072'], note: '先建立攻击力与攻速，再补暴击伤害和穿透。' },
  { id: 'onhit', name: '攻速特效流', type: 'onhit', tags: ['attack', 'onhit'], ids: ['3153', '3006', '3124', '3085', '3302', '3072'], note: '用攻速重复触发装备特效，对持续普攻环境要求较高。' },
  { id: 'apAttack', name: '法强普攻流', type: 'onhit', tags: ['ap', 'attack', 'onhit'], ids: ['3115', '3006', '3124', '3089', '3135', '3157'], note: '同时利用法强与攻击特效，适合技能和普攻都有法强收益的英雄。' },
  { id: 'adCaster', name: '技能衔接普攻', type: 'marksman', tags: ['ad', 'haste', 'spellblade'], ids: ['3078', '3158', '3004', '3161', '3036', '3072'], note: '通过技能急速与咒刃衔接普攻；魔宗需要提前叠层。' },
  { id: 'mage', name: '法术爆发流', type: 'mage', tags: ['ap', 'spell', 'range'], ids: ['6655', '3020', '4645', '3089', '3135', '3157'], note: '先解决法力与技能输出，再补法强和法术穿透。' },
  { id: 'burn', name: '持续灼烧流', type: 'burn', tags: ['ap', 'spell', 'dot'], ids: ['2503', '3020', '6653', '3116', '3135', '3089'], note: '保持技能覆盖和持续灼烧，敌方前排较多时价值更高。' },
  { id: 'fighter', name: '战士持续作战', type: 'fighter', tags: ['ad', 'health', 'heal', 'haste'], ids: ['6610', '3047', '3071', '3053', '6333', '3065'], note: '用生命值、回复和抗性延长输出时间。' },
  { id: 'spellblade', name: '咒刃战士流', type: 'fighter', tags: ['ad', 'spellblade', 'attack', 'health'], ids: ['3078', '3047', '6610', '3053', '6333', '3065'], note: '技能与普攻交替，持续触发咒刃与回复效果。' },
  { id: 'apFighter', name: '法系持续作战', type: 'burn', tags: ['ap', 'spell', 'health', 'heal'], ids: ['6653', '3047', '4633', '3116', '3157', '3065'], note: '在生命值与法强之间平衡，适合近距离持续交战。' },
  { id: 'tank', name: '前排承伤流', type: 'tank', tags: ['health', 'resist', 'cc'], ids: ['3084', '3047', '3068', '2502', '3065', '3083'], note: '优先保证能活着进场，再通过生命值和装备效果贡献伤害。' },
  { id: 'support', name: '治疗保护流', type: 'support', tags: ['ally', 'heal', 'shield', 'haste'], ids: ['6617', '3158', '6620', '3504', '3107', '6621'], note: '提高治疗与护盾频率，给队伍核心持续创造输出空间。' },
  { id: 'assassin', name: '物理爆发流', type: 'assassin', tags: ['ad', 'spell', 'dash'], ids: ['3142', '3158', '6696', '6694', '3814', '6699'], note: '以穿甲和技能爆发寻找击杀窗口，避免承担长时间正面承伤。' },
  { id: 'apAssassin', name: '法系突进流', type: 'apAssassin', tags: ['ap', 'spell', 'dash'], ids: ['3100', '3020', '4646', '3089', '3135', '3157'], note: '利用法强与进场爆发，保留中娅作为容错。' },
];

const EXCLUSIVE = [
  ['3036', '3033', '6694', '3071'], ['3135', '3137'], ['3053', '3156', '6673'],
  ['3078', '3100', '6662', '2510', '3508'], ['3003', '3004', '3119'], ['3074', '3748', '6698', '6631'],
];
export function itemsConflict(a, b, db) {
  if (a === b) return true;
  if (db.itemMap.get(a)?.tags.includes('Boots') && db.itemMap.get(b)?.tags.includes('Boots')) return true;
  return EXCLUSIVE.some(group => group.includes(a) && group.includes(b));
}
export function canEquip(id, ids, champion, db) {
  const item = db.itemMap.get(id);
  if (!item || ids.some(x => itemsConflict(id, x, db))) return false;
  if (id === '3085' && champion.stats.attackrange < 300 && champion.id !== 'Kayle') return false;
  if (item.tags.includes('Boots') && champion.id === 'Cassiopeia') return false;
  return true;
}

export function recommendBuilds(state, db, previewId = null) {
  const champion = db.championMap.get(state.championId);
  if (!champion) return [];
  const augments = [...state.selected, ...(previewId ? [previewId] : [])].map(id => db.augmentMap.get(id)).filter(Boolean);
  const profile = effectiveProfile(champion, augments, state);
  const rules = augments.map(augmentRule);
  const f = profile.features;
  const lock = [...state.owned];
  const specialBuilds = [];
  if (rules.some(r => r.grants?.includes('spellCrit')) && f.spell >= .65 && f.ap >= .6)
    specialBuilds.push({ id: 'spellCrit', name: '技能暴击流', type: 'mage', tags: ['ap', 'spell', 'crit'], ids: ['6655', '3020', '3089', '3031', '3135', '3157'], note: '技能可暴击后，把无尽作为可选的暴击增幅；仍保留法强与法穿基础。' });
  if (rules.some(r => r.grants?.includes('dotCrit')) && f.dot >= .5 && f.ap >= .6)
    specialBuilds.push({ id: 'dotCrit', name: '灼烧暴击流', type: 'burn', tags: ['ap', 'dot', 'crit'], ids: ['2503', '3020', '6653', '3031', '3135', '3089'], note: '易损让持续伤害和装备效果可以暴击，围绕灼烧与暴击增幅组织装备。' });
  if (rules.some(r => r.grants?.includes('onhit')) && f.spell >= .65 && f.ap >= .6)
    specialBuilds.push({ id: 'spellOnhit', name: '技能触发特效', type: 'mage', tags: ['ap', 'spell', 'onhit'], ids: ['3115', '3020', '3100', '3089', '3135', '3157'], note: '虚幻武器让技能触发攻击特效，纳什之牙可通过技能兑现收益。仍需留意每目标触发冷却。' });
  if (rules.some(r => r.tags.includes('mana')) && f.mana > 0 && f.ap >= .6)
    specialBuilds.push({ id: 'mana', name: '法力成长流', type: 'mage', tags: ['mana', 'ap', 'spell'], ids: ['3003', '3020', '6657', '3089', '3135', '3157'], note: '用法力装备兑现海克斯的法力收益；女神泪与时光之杖需要成长时间。' });
  const ruleBuilds = [...BUILDS, ...specialBuilds];
  const closestTemplate = ids => [...BUILDS].sort((a, b) => {
    const fit = build => mean(build.tags.map(tag => f[tag] || 0)) * 30
      + (build.type === profile.type ? 12 : 0) + build.ids.filter(id => ids.includes(id)).length * 8;
    return fit(b) - fit(a);
  })[0];
  const observedBuilds = [];
  if (state.strategy === 'auto' && !specialBuilds.length) {
    const equipped = lock.filter(id => !db.itemMap.get(id)?.tags.includes('Boots'));
    for (const evidence of getCoreBuildStats(db.itemStats, champion, augments, db.meta)) {
      if (evidence.items.some(id => !db.itemMap.has(id)) || equipped.some(id => !evidence.items.includes(id))) continue;
      const base = closestTemplate(evidence.items);
      const boots = base.ids.find(id => db.itemMap.get(id)?.tags.includes('Boots'));
      observedBuilds.push({ ...base, id: `stats-core-${observedBuilds.length}`, name: '英雄统计核心路线',
        ids: [evidence.items[0], ...(boots ? [boots] : []), ...evidence.items.slice(1), ...base.ids], evidence,
        note: '前三件传说装备使用该英雄的观察购买顺序；鞋子、补齐装备及对局调整为机制规则参考。' });
    }
    for (const evidence of getAugmentItemStats(db.itemStats, champion, augments, db.meta)) {
      if (equipped.length || !db.itemMap.has(evidence.itemId)) continue;
      const base = closestTemplate([evidence.itemId]);
      observedBuilds.push({ ...base, id: `stats-augment-${evidence.itemId}`, name: '命运之武器装备参考',
        ids: [evidence.itemId, ...base.ids], evidence,
        note: '第一件参考同英雄持有命运之武器的统计；后续装备为规则推演，没有对应六件套胜率。' });
    }
  }
  const meleeCrit = ['Yasuo', 'Yone', 'Tryndamere'].includes(champion.id);
  const needsSheen = rules.some(rule => rule.requiredItems?.includes('3078'));
  const needsIE = rules.some(rule => rule.requiredItems?.includes('3031'));
  const builds = [...ruleBuilds, ...observedBuilds].filter(build => {
    if (build.id === 'apAttack' && f.ap < .5) return false;
    if (meleeCrit && !needsSheen && ['adCaster', 'spellblade'].includes(build.id)) return false;
    if (meleeCrit && needsIE && !build.tags.includes('crit')) return false;
    return true;
  }).map(build => {
    let ids = [...build.ids];
    const notes = [];
    const magic = build.tags.includes('ap');
    const physical = build.tags.includes('ad') || build.id === 'onhit';
    const support = build.type === 'support';
    const replace = (old, next) => { const i = ids.indexOf(old); if (i !== -1 && db.itemMap.has(next)) ids[i] = next; };
    if (champion.stats.attackrange < 300 && champion.id !== 'Kayle') replace('3085', '3046');
    if (['Yasuo', 'Yone', 'Tryndamere'].includes(champion.id) && build.id === 'crit') {
      ids = ['3032', '3006', '3031', '3072', '6333', '3026'];
      notes.push('利用近战暴击英雄的暴击收益，避免套用通用三相战士路线。');
    }
    if (champion.id === 'Jhin') { replace('3032', '6676'); replace('3085', '3094'); }
    if (champion.id === 'Brand' && build.id === 'dotCrit' && rules.some(r => r.grants?.includes('spellCrit'))) {
      replace('3031', '4645');
      notes.push('珠光护手配易损时，火炬和兰德里的灼烧能利用暴击率，后续可补影焰的法强与法穿。');
    }
    if (champion.id === 'Yasuo' && ids.includes('123430')
      && augments.some(a => a.id === 'ARAM_CourageoftheColossus') && augments.some(a => a.id === 'ARAM_CriticalHealing')) {
      notes.push('巨像的勇气和毁坏仪式都能提供护盾，会心治疗让护盾有机会暴击。');
    }
    if (build.id === 'tank' && augments.some(a => shortId(a.id) === 'ApexInventor')) {
      ids = ['2502', '3047', '3084', '3068', '3065', '3083'];
      notes.push('尖端发明家可以缩短有冷却的装备效果，优先考虑无终恨意。');
    }
    if (!f.mana) { replace('6655', '4646'); replace('2503', '4633'); replace('3004', '6692'); }
    if (state.enemy.cc || state.enemy.damage === 'ap') {
      ids = ids.map(id => db.itemMap.get(id)?.tags.includes('Boots') ? '3111' : id);
      notes.push('敌方控制或魔法威胁较高，鞋子优先考虑水银之靴；其韧性不能缩短击飞、压制。');
    }
    if (state.enemy.damage === 'ad' && ['tank', 'fighter'].includes(build.type)) { replace('3065', '3143'); notes.push('敌方物理输出偏多，增加护甲装备。'); }
    if (state.enemy.damage === 'ap' && build.type === 'tank') { replace('3068', '6664'); replace('2502', '4401'); notes.push('以魔抗装备承接主要伤害。'); }
    if (state.enemy.healing) {
      if (physical && build.type === 'fighter') {
        ids[4] = '6609';
      } else if (physical && build.type !== 'tank') {
        if (ids.includes('3036')) replace('3036', '3033');
        else if (ids.includes('6694')) replace('6694', '3033');
        else if (ids.includes('3071')) replace('3071', '3033');
        else ids[4] = '3033';
      } else if (magic || support) ids[4] = '3165';
      else ids[4] = '3075';
      notes.push('敌方回复较强，加入重伤装备；荆棘之甲需要敌人普攻你才能施加重伤。');
    }
    if (state.enemy.tanks && magic && !ids.includes('3135')) ids[4] = '3135';
    if (state.enemy.tanks && physical && !ids.some(id => ['3036', '3033', '6694', '3071', '3302'].includes(id))) ids[4] = '3036';
    if (state.priority === 'survive') {
      if (magic && !support) ids[5] = '3157';
      else if (physical && build.type === 'marksman') ids[5] = '6673';
    }
    const required = [];
    for (const r of rules) {
      if (!r.requiredItems) continue;
      const options = r.requiredItems.filter(id => db.itemMap.has(id));
      if (r.anyItem) {
        const pick = options.find(id => lock.includes(id)) || options.find(id => ids.includes(id)) || options[0];
        if (pick) required.push(pick);
      } else required.push(...options);
    }
    if (required.length) notes.push(`海克斯需要优先考虑：${[...new Set(required)].map(id => db.itemMap.get(id).name).join('、')}。`);
    const result = [...lock];
    const pending = [...new Set([...required, ...ids])].filter(id => !lock.includes(id));
    for (const id of pending) {
      if (result.length === 6) break;
      if (canEquip(id, result, champion, db)) result.push(id);
    }
    // Complete a valid six-slot plan after exclusions (e.g. Cassiopeia cannot buy boots).
    const fallback = magic ? ['3089', '3135', '4645', '3157', '6653', '4633', '3116'] : physical ? ['3072', '6692', '3094', '3153', '6333', '3026'] : ['3065', '4401', '3143', '3083', '2502', '3075'];
    for (const id of fallback) if (result.length < 6 && canEquip(id, result, champion, db)) result.push(id);
    let value = mean(build.tags.map(tag => f[tag] || 0)) * 65;
    if (build.type === profile.type) value += 15;
    if (['spellCrit', 'dotCrit', 'spellOnhit', 'mana'].includes(build.id)) value += 10;
    if (build.id === 'apAttack' && augments.some(a => shortId(a.id) === 'Marksmage') && f.ap >= .6) value += 20;
    if (build.id === 'adCaster' && ['Ezreal', 'Smolder', 'Corki'].includes(champion.id)) value += 20;
    if (build.id === 'apAttack' && ['Kayle', 'Azir', 'Gwen'].includes(champion.id)) value += 15;
    if (build.id === 'apFighter' && ['Mordekaiser', 'Swain', 'Vladimir', 'Gwen', 'Singed'].includes(champion.id)) value += 12;
    if (build.id === 'tank' && championProfile(champion).type !== 'tank') value -= 15;
    if (build.type === 'support' && !f.ally) value -= 40;
    if (build.id === 'apAttack' && f.ap < .3) value -= 20;
    for (const rule of rules) value += same(rule.tags, build.tags).length * 3;
    const retainedMatch = lock.filter(id => same(itemFeatures(db.itemMap.get(id)), build.tags).length > 1).length;
    value += retainedMatch * 3;
    if (state.enemy.tanks && build.id === 'burn') value += 6;
    if (state.priority === 'survive' && ['fighter', 'tank'].includes(build.type)) value += 6;
    if (required.some(id => !result.includes(id))) { value -= 15; notes.push('已有装备或装备互斥限制了任务装备的补入，需手动考虑换装。'); }
    let evidence = null;
    if (build.evidence) {
      const observed = build.evidence;
      const applied = observed.kind === 'observed-core'
        ? result.filter(id => !db.itemMap.get(id)?.tags.includes('Boots')).slice(0, 3).join('|') === observed.items.join('|')
        : result[0] === observed.itemId;
      evidence = { ...observed, applied, modified: !applied,
        label: observed.kind === 'observed-core' ? '原始前三件传说装备样本' : '原始命运之武器首件样本' };
      notes.push(applied ? '统计只覆盖标明的核心装备，不能把其胜率解释为当前六件套胜率。' : '当前装备或对局调整已改变统计核心，原始样本不代表修改后方案的胜率。');
      value += applied ? 30 : 8;
    }
    const purchases = result.filter(id => !lock.includes(id));
    const next = db.itemMap.get(purchases[0]);
    const task = next && augments.find(a => augmentRule(a).requiredItems?.includes(next.id));
    let nextReason = task ? task.name : '';
    if (!task && next?.id === '123430' && rules.some(r => r.grants?.includes('healCrit'))) nextReason = '会心治疗可强化护盾';
    if (!task && ['2503', '6653'].includes(next?.id) && rules.some(r => r.grants?.includes('dotCrit'))) nextReason = '易损可强化装备灼烧';
    return { ...build, evidence, method: evidence ? '统计核心＋规则补齐' : '机制规则参考', value: Math.round(value), items: result.map(id => db.itemMap.get(id)), next, nextReason, cost: purchases.reduce((n, id) => n + db.itemMap.get(id).cost, 0), notes, reason: build.note };
  });
  // Avoid presenting identical equipment lists as different alternatives.
  const seen = new Set();
  return builds.sort((a, b) => b.value - a.value).filter(b => { const key = b.items.map(x => x.id).join(','); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 3);
}

export function combinationInsights(state, db) {
  const augments = state.selected.map(id => db.augmentMap.get(id)).filter(Boolean);
  const champion = db.championMap.get(state.championId);
  if (!champion) return [];
  const profile = effectiveProfile(champion, augments, state);
  const out = [];
  for (const [i, candidate] of augments.entries()) {
    for (const pair of selectedInteractions(candidate, augments.slice(0, i), profile)) {
      out.push({ ...pair, title: `${pair.partner} × ${candidate.name}`, text: pair.reasons[0] });
    }
  }
  return out.sort((a, b) => Number(b.conflict) - Number(a.conflict) || b.value - a.value).slice(0, 4);
}
