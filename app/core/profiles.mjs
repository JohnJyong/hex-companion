import { advice } from './recommendation-data.mjs';
export { aliases as ALIASES } from './recommendation-data.mjs';

export const FEATURE_NAMES = {
  attack: '持续普攻', spell: '技能输出', ad: '攻击力', ap: '法术强度', crit: '暴击', onhit: '攻击特效',
  haste: '技能急速', health: '生命值', resist: '双抗', heal: '回复能力', shield: '护盾', ally: '保护队友',
  cc: '硬控', dash: '位移', dot: '持续伤害', range: '远程消耗', mana: '法力值', ult: '终极技能',
  pets: '召唤物', stack: '永久成长', slow: '减速', speed: '移动速度', itemhaste: '装备急速',
  economy: '经济成长', spin: '旋转技能', spellblade: '技能衔接普攻', snowball: '雪球进场',
};

export function championProfile(champion, strategy = 'auto') {
  const {archetypes, groupIndex, noDashes, traits} = advice.champions;
  let type = groupIndex.get(champion.id);
  if (!type) type = champion.roles.includes('Marksman') ? 'marksman' : champion.roles.includes('Tank') ? 'tank' : champion.roles.includes('Mage') ? 'mage' : champion.roles.includes('Support') ? 'support' : 'fighter';
  const f = { ...Object.fromEntries(Object.keys(FEATURE_NAMES).map(k => [k, 0])), ...archetypes[type] };
  const text = [...champion.spells, champion.passive].map(s => s.description).join(' ');
  f.mana = champion.resource === '法力' ? .65 : 0;
  f.cc = /眩晕|晕眩|禁锢|束缚|缚地|击飞|嘲讽|恐惧|压制|魅惑|击退/.test(text) ? .75 : 0;
  f.slow = /减速/.test(text) ? .7 : 0;
  f.dash = !noDashes.has(champion.id) && /冲刺|突进|跃|跳|位移|闪烁|传送/.test(text) ? .85 : 0;
  f.economy = .55;
  f.itemhaste = .3;
  f.spellblade = f.attack > .5 && f.spell > .6 ? .75 : .15;
  for (const [feature, ids] of Object.entries(traits)) if (ids.split(' ').includes(champion.id)) f[feature] = 1;
  if (/治疗自己|回复生命|恢复生命|生命偷取/.test(text)) f.heal = Math.max(f.heal, .7);
  if (/护盾/.test(text)) f.shield = Math.max(f.shield, .65);
  Object.assign(f, advice.champions.overrides[champion.id]);
  if (strategy !== 'auto' && archetypes[strategy]) {
    const target = archetypes[strategy];
    for (const k of ['attack', 'spell', 'ad', 'ap', 'crit', 'onhit', 'haste', 'health', 'resist', 'range']) f[k] = .35 * f[k] + .65 * (target[k] || 0);
    type = strategy;
  }
  return { type, features: f, melee: champion.stats.attackrange < 300 && champion.id !== 'Kayle', reviewed: groupIndex.has(champion.id) };
}
