// Hand-authored qualitative rules. These are NOT measured win rates or DPS.
// Tags describe benefits; requires describes the champion capability needed to trigger them.
const rule = (tags, extra = {}) => ({ tags: tags.split(' '), ...extra });
export const AUGMENT_RULES = {
  TapDancer: rule('attack onhit speed', { summary: '普攻叠加移动速度，再由移速转化为攻速。持续输出越久，收益越高。' }),
  SymphonyofWar: rule('attack ad onhit heal', { summary: '获得致命节奏和征服者，持续普攻提供攻速、适应之力与回复。' }),
  Deft: rule('attack onhit'),
  DualWield: rule('attack onhit', { summary: '提高总攻速，攻击附带额外箭矢，以削减后的效能触发攻击特效。' }),
  DoubleTap: rule('crit onhit attack', { summary: '获得暴击几率；暴击时额外触发一次攻击特效。' }),
  CriticalRhythm: rule('crit attack'),
  Firebrand: rule('attack onhit dot', { summary: '普攻施加可叠加的持续灼烧，适合长时间连续攻击。' }),
  Typhoon: rule('attack onhit'),
  LightemUp: rule('attack onhit'),
  Marksmage: rule('ap attack', { summary: '普通攻击附加基于法术强度的物理伤害；需要实际进行普攻。' }),
  MasterofDuality: rule('attack spell ap ad', { summary: '普攻叠加法强，技能命中叠加攻击力。适合普攻与技能交替输出。' }),
  EtherealWeapon: rule('spell onhit', { summary: '技能命中可以触发攻击特效，同一目标存在触发冷却。', grants: ['onhit'] }),
  MysticPunch: rule('attack haste spellblade'),
  ScopedWeapons: rule('attack range'), ScopierWeapons: rule('attack range'), ScopiestWeapons: rule('attack range'),
  DrawYourSword: rule('attack ad health', { requires: 'ranged', warning: '会失去远程普攻优势，必须按近战进场方式调整站位和生存装备。' }),
  JeweledGauntlet: rule('spell crit', { grants: ['spellCrit'], summary: '技能伤害可以暴击，并获得暴击几率。优先配合高频或高伤害技能。' }),
  JeweledBracelet: rule('spell crit', { grants: ['spellCrit'], warning: '仅强化游戏内标注的那一个技能；当前模型按英雄整体能力估算。' }),
  Vulnerability: rule('dot crit itemhaste', { grants: ['dotCrit'], summary: '持续伤害和装备效果可以暴击，并获得暴击几率；不会让所有技能都暴击。' }),
  InfernalConduit: rule('spell dot haste', { grants: ['burn'], summary: '技能施加可叠加灼烧，灼烧效果帮助缩短基础技能冷却。' }),
  MagicMissile: rule('spell range'), SkilledSniper: rule('spell range haste'),
  PhenomenalEvil: rule('spell ap stack'), WitchfulThinking: rule('ap spell'),
  BluntForce: rule('ad attack'), ItsCritical: rule('crit'), SoulSiphon: rule('crit heal attack'),
  Recursion: rule('haste spell'), InfiniteRecursion: rule('haste spell stack'),
  BreadAndButter: rule('haste spell'), BreadAndCheese: rule('haste spell'), BreadAndJam: rule('haste spell'),
  Eureka: rule('ap haste spell'), Archmage: rule('spell haste'),
  WithHaste: rule('haste speed'), DontBlink: rule('speed'), LegDay: rule('speed'),
  OutlawsGrit: rule('dash resist', { requires: 'dash' }),
  Dashing: rule('dash haste', { requires: 'dash' }),
  Earthwake: rule('dash spell', { requires: 'dash' }),
  ShadowRunner: rule('dash speed', { requires: 'dash' }),
  SwiftAndSafe: rule('dash shield', { requires: 'dash' }),
  CourageoftheColossus: rule('cc shield health', { requires: 'cc' }),
  Cruelty: rule('cc spell', { requires: 'cc' }),
  SlapAround: rule('cc stack', { requires: 'cc' }),
  Impassable: rule('cc resist', { requires: 'cc' }),
  SoulEater: rule('cc health stack', { requires: 'cc' }),
  IceCold: rule('slow'),
  Goliath: rule('health resist ad ap', { summary: '提升生命值、适应之力和体型。适合能持续留在战场的英雄。' }),
  CelestialBody: rule('health resist', { warning: '会降低造成的伤害；承担主输出时需要权衡。' }),
  HeavyHitter: rule('health attack onhit'), TankEngine: rule('health stack'),
  ImTheJuggernaut: rule('health resist attack spell'), DawnbringersResolve: rule('health heal'),
  Goredrink: rule('heal attack spell'), CircleofDeath: rule('heal health'),
  AllForYou: rule('ally heal shield', { requires: 'ally' }),
  FirstAidKit: rule('heal shield ally'), CriticalHealing: rule('heal shield crit', { grants: ['healCrit'] }),
  SonicBoom: rule('ally heal shield', { requires: 'ally' }),
  WindspeakersBlessing: rule('ally heal shield resist', { requires: 'ally' }),
  SpiritBomb: rule('ally heal shield', { requires: 'ally' }),
  EmpoweredByTheFaithful: rule('ally heal shield', { requires: 'ally' }),
  EmpyreanPromise: rule('ally heal shield', { requires: 'ally' }),
  ProteinShake: rule('resist heal shield ally'),
  BigBrain: rule('ap shield'), MightyShield: rule('shield'),
  Overflow: rule('mana spell', { requires: 'mana', warning: '法力消耗提高；需要同时解决续航。' }),
  MindtoMatter: rule('mana health', { requires: 'mana' }),
  Juiced: rule('mana attack onhit', { requires: 'mana' }),
  BlueBarrier: rule('mana shield spell', { requires: 'mana' }),
  NoManaNoProblem: rule('spell mana', { requires: 'mana' }),
  StackosaurusRex: rule('stack', { requires: 'stack', summary: '增加英雄技能获得的永久层数；先确认英雄本身具有对应叠层机制。' }),
  Minionmancer: rule('pets', { requires: 'pets' }),
  SpinToWin: rule('spin haste', { requires: 'spin' }),
  BacktoBasics: rule('spell haste', { disablesUltimate: true, warning: '无法使用终极技能，会使依赖大招触发的海克斯失效。' }),
  UltimateRevolution: rule('ult', { requires: 'ult' }), UltimateAwakening: rule('ult haste', { requires: 'ult' }),
  UltimateUnstoppable: rule('ult resist', { requires: 'ult' }), CantTouchThis: rule('ult', { requires: 'ult' }),
  FinalForm: rule('ult health heal', { requires: 'ult' }), ItsKillingTime: rule('ult spell', { requires: 'ult' }),
  StuckInHereWithMe: rule('ult resist health', { requires: 'ult' }), FeyMagic: rule('ult cc', { requires: 'ult' }),
  RISE: rule('ult spell', { requires: 'ult', summary: '使用被强化的技能完成击杀后可以再次施放；收益依赖击杀条件。' }),
  UltimateRecursion: rule('ult haste', { requires: 'ult' }),
  ApexInventor: rule('itemhaste', { summary: '提升装备急速，适合有冷却时间的装备主动或被动效果；不加快所有持续伤害。' }),
  Upgrade_IE: rule('crit ad', { requiredItems: ['3031'] }),
  Upgrade_Collector: rule('ad crit', { requiredItems: ['6676'] }),
  Upgrade_ZH: rule('ap itemhaste', { requiredItems: ['3157'] }),
  Upgrade_Immolate: rule('health dot', { requiredItems: ['3068', '6664'], anyItem: true }),
  Upgrade_Sheen: rule('spellblade onhit', { requiredItems: ['3078', '3100', '6662'], anyItem: true }),
  Upgrade_SwordOfBlossom: rule('attack ally heal', { requiredItems: ['124011'] }),
  Upgrade_SunderedSky: rule('attack health heal', { requiredItems: ['6610'] }),
  Upgrade_Ravenous: rule('ad attack heal', { requiredItems: ['3074'] }),
  Upgrade_DeathDance: rule('ad resist heal', { requiredItems: ['6333'] }),
  Upgrade_Stormsurge: rule('ap spell', { requiredItems: ['4646'] }),
  Quest_SteelYourHeart: rule('health stack', { requiredItems: ['3084'], scalingQuest: true, summary: '持有心之钢并完成叠层任务后获得额外成长。越晚拿到，完成任务的机会越少。' }),
  Quest_WoogletsWitchcap: rule('ap spell', { requiredItems: ['3089', '3157'], scalingQuest: true }),
  Quest_VoidImmolation: rule('health dot resist', { requiredItems: ['3068', '6664'], scalingQuest: true }),
  Quest_UltraHydra: rule('ad attack health', { requiredItems: ['3074', '3748', '6698'], anyItem: true, scalingQuest: true }),
  Quest_UrfsChampion: rule('economy stack', { scalingQuest: true }),
  ADAPt: rule('ap spell', { conversion: 'ap', warning: '会将额外攻击力转为法强；不适合仍依赖攻击力收益的方案。' }),
  escAPADe: rule('ad attack', { conversion: 'ad', warning: '会将法强转为额外攻击力；不适合仍依赖法强收益的方案。' }),
  GlassCannon: rule('spell attack', { warning: '降低最大生命值，收益高度依赖安全输出环境。' }),
  Snowday: rule('snowball'), BiggestSnowballEver: rule('snowball cc'), GoldenSnowball: rule('snowball resist'), PinballSnowball: rule('snowball'), SharkTempest: rule('snowball dot'),
  TransmuteGold: rule('economy', { random: true }), TransmutePrismatic: rule('economy', { random: true }), TransmuteChaos: rule('economy', { random: true }),
  PandorasBox: rule('economy', { random: true, warning: '会替换现有组合，无法在随机结果产生前确定收益。' }),
  Donation: rule('economy'), Stats: rule('economy'), StatsOnStats: rule('economy'), StatsOnStatsOnStats: rule('economy'),
};

export const shortId = id => id.replace(/^ARAM_/, '');

// Direct interactions from the KIWI descriptions. Matching benefit tags alone
// cannot establish these effects. Values are bounded rule weights, not rates.
const pairKey = (a, b) => a < b ? a + '|' + b : b + '|' + a;
const directPairs = new Map([
  ['CourageoftheColossus', 'CriticalHealing', '定身英雄获得的护盾可以暴击'],
  ['CourageoftheColossus', 'FirstAidKit', '治疗与护盾强度提高定身英雄时获得的护盾'],
  ['CriticalHealing', 'FirstAidKit', '治疗与护盾强度也会提高可暴击的治疗和护盾量'],
  ['CriticalHealing', 'ProteinShake', '额外双抗提供治疗与护盾强度，可放大暴击的治疗和护盾'],
  ['Firebrand', 'Vulnerability', '普攻叠加的灼烧可以暴击'],
  ['InfernalConduit', 'Vulnerability', '技能叠加的灼烧可以暴击'],
  ['JeweledGauntlet', 'Vulnerability', '技能与装备灼烧都能利用两枚符文提供的暴击率'],
  ['Goliath', 'HeavyHitter', '提高生命上限会增加每次普攻的附加伤害'],
  ['TankEngine', 'HeavyHitter', '击杀参与叠出的最大生命值会增加普攻附伤'],
  ['DawnbringersResolve', 'Goliath', '生命上限越高，低血量时触发的回复越多'],
  ['CriticalRhythm', 'ItsCritical', '提高普攻暴击率，有助于更快叠起攻速'],
  ['DoubleTap', 'ItsCritical', '提高暴击率，普攻更容易额外触发攻击特效'],
].map(([a, b, reason]) => [pairKey(a, b), reason]));

export const directPairReason = (a, b) => directPairs.get(pairKey(shortId(a.id), shortId(b.id)));

export function augmentRule(augment) {
  const manual = AUGMENT_RULES[shortId(augment.id)];
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
