import { advice, augmentRules, pairKey } from './recommendation-data.mjs';
export { augmentRules as AUGMENT_RULES } from './recommendation-data.mjs';

export const shortId = id => id.replace(/^ARAM_/, '');
export const directPairReason = (a, b) => advice.directPairs.get(pairKey(shortId(a.id), shortId(b.id)));

export function augmentRule(augment) {
  const manual = augmentRules[shortId(augment.id)];
  if (manual) return { ...manual, reviewed: true, verified: true };
  if (augment.descriptionScope === 'unverified') return { tags: [], reviewed: false, verified: false };
  const text = augment.description;
  const probes = {
    attack: /普攻|攻击速度|你的攻击/, spell: /技能伤害|技能.*造成|伤害.*技能/, ap: /法术强度/,
    ad: /攻击力/, crit: /暴击/, onhit: /攻击特效/, haste: /技能急速|冷却时间/,
    health: /最大生命值|获得.*生命值/, resist: /护甲|魔法抗性|伤害减免/,
    heal: /治疗|生命回复|回复生命|吸血/, shield: /护盾/, ally: /友军|友方/,
    dot: /持续伤害|灼烧/, range: /攻击距离|狙击/, mana: /法力/,
    speed: /移动速度/, snowball: /雪球/, economy: /金币|锻造器/,
  };
  const tags = Object.entries(probes).filter(([, regex]) => regex.test(text)).map(([key]) => key);
  let requires;
  if (/在.*(?:冲刺|闪烁).*后/.test(text)) requires = 'dash';
  if (/定身.*(?:时|后)/.test(text)) requires = 'cc';
  if (/为友.*(?:治疗|护盾)/.test(text)) requires = 'ally';
  if (/施放.*终极技能|使用.*终极技能/.test(text)) { requires = 'ult'; tags.push('ult'); }
  return { tags: [...new Set(tags)], requires, reviewed: false, verified: true };
}
