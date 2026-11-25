export const FEATURE_NAMES = {
  attack: '持续普攻', spell: '技能输出', ad: '攻击力', ap: '法术强度', crit: '暴击', onhit: '攻击特效',
  haste: '技能急速', health: '生命值', resist: '双抗', heal: '回复能力', shield: '护盾', ally: '保护队友',
  cc: '硬控', dash: '位移', dot: '持续伤害', range: '远程消耗', mana: '法力值', ult: '终极技能',
  pets: '召唤物', stack: '永久成长', slow: '减速', speed: '移动速度', itemhaste: '装备急速',
  economy: '经济成长', spin: '旋转技能', spellblade: '技能衔接普攻', snowball: '雪球进场',
};

const archetypes = {
  marksman: { attack: 1, spell: .35, ad: 1, ap: .08, crit: .9, onhit: .85, haste: .35, health: .18, resist: .2, heal: .4, shield: .2, range: .9, ult: .5, speed: .8 },
  onhit: { attack: 1, spell: .5, ad: .8, ap: .15, crit: .45, onhit: 1, haste: .4, health: .25, resist: .3, heal: .5, range: .8, ult: .5, speed: .8 },
  mage: { attack: .15, spell: 1, ad: .04, ap: 1, crit: .05, onhit: .1, haste: .9, health: .3, resist: .25, heal: .15, shield: .25, range: .85, ult: .7, speed: .45 },
  burn: { attack: .15, spell: 1, ad: .04, ap: 1, crit: .05, onhit: .1, haste: .75, health: .5, resist: .4, heal: .4, shield: .2, range: .6, ult: .75, dot: 1, speed: .5 },
  fighter: { attack: .8, spell: .7, ad: 1, ap: .08, crit: .2, onhit: .65, haste: .75, health: .85, resist: .7, heal: .8, shield: .45, range: .1, ult: .65, speed: .7, snowball: .8 },
  assassin: { attack: .5, spell: .9, ad: 1, ap: .05, crit: .25, onhit: .35, haste: .8, health: .3, resist: .3, heal: .35, range: .25, ult: .8, speed: .8, snowball: .65 },
  apAssassin: { attack: .45, spell: 1, ad: .05, ap: 1, crit: .08, onhit: .45, haste: .8, health: .4, resist: .35, heal: .4, range: .2, ult: .8, speed: .75, snowball: .7 },
  tank: { attack: .4, spell: .45, ad: .25, ap: .25, crit: .04, onhit: .3, haste: .65, health: 1, resist: 1, heal: .7, shield: .7, range: .05, ult: .8, speed: .55, snowball: 1 },
  support: { attack: .25, spell: .5, ad: .1, ap: .65, crit: .05, onhit: .15, haste: 1, health: .45, resist: .4, heal: 1, shield: 1, ally: 1, range: .55, ult: .7, speed: .6 },
};

const groups = {
  marksman: 'Aphelios Ashe Caitlyn Draven Jhin Jinx Kindred Lucian MissFortune Nilah Samira Sivir Tristana Xayah Zeri',
  onhit: 'Akshan Kaisa Kalista Kayle KogMaw MasterYi Teemo Twitch Varus Vayne',
  mage: 'Ahri Annie Anivia AurelionSol Aurora Azir Cassiopeia Hwei Karthus Kennen Leblanc Lissandra Lux Mel Neeko Orianna Ryze Syndra TwistedFate Veigar Velkoz Vex Viktor Xerath Ziggs Zoe',
  burn: 'Brand Fiddlesticks Heimerdinger Lillia Malzahar Morgana Rumble Singed Swain Zyra',
  fighter: 'Aatrox Ambessa Belveth Briar Camille Darius DrMundo Fiora Gangplank Garen Gnar Gwen Hecarim Illaoi Irelia Jax Jayce Kled KSante LeeSin MonkeyKing Nasus Olaf Pantheon RekSai Renekton Rengar Riven Sett Shyvana Skarner Trundle Tryndamere Udyr Urgot Vi Viego Volibear Warwick XinZhao Yasuo Yone Yorick Zaahen',
  assassin: 'Khazix Naafiri Nocturne Pyke Qiyana Shaco Talon Zed',
  apAssassin: 'Akali Diana Ekko Elise Evelynn Fizz Kassadin Katarina Nidalee Sylas Vladimir',
  tank: 'Alistar Amumu Blitzcrank Braum Chogath Galio Gragas Leona Malphite Maokai Nautilus Nunu Ornn Poppy Rammus Rell Sejuani Shen Sion TahmKench Taric Thresh Zac',
  support: 'Bard Ivern Janna Karma Lulu Milio Nami Rakan Renata Senna Seraphine Sona Soraka Yuumi Zilean',
};
const groupIndex = new Map(Object.entries(groups).flatMap(([type, ids]) => ids.split(' ').map(id => [id, type])));
const traits = {
  pets: 'Annie Aphelios Azir Elise Heimerdinger Ivern Malzahar Naafiri Shaco Yorick Zyra',
  stack: 'AurelionSol Bard Chogath Kindred Nasus Senna Shyvana Sion Smolder Swain Thresh Veigar',
  spin: 'Darius Garen Katarina MonkeyKing Samira Tryndamere',
  dot: 'Brand Cassiopeia Darius Fiddlesticks Karthus Lillia Malzahar Morgana Rumble Singed Swain Teemo Twitch Udyr Zyra',
  ally: 'Alistar Annie Bard Braum Hwei Ivern Janna Karma Kayle LeeSin Lulu Lux Milio Morgana Nami Nidalee Orianna Rakan Renata Senna Seraphine Shen Sona Soraka Taric Thresh Yuumi Zilean',
};
const noDashes = new Set('Anivia Aphelios Ashe Brand Caitlyn Cassiopeia Chogath Darius Draven DrMundo Fiddlesticks Gangplank Garen Heimerdinger Hwei Illaoi Janna Jhin Jinx Karthus KogMaw Kled Lillia Lulu Lux Malzahar Mel Milio MissFortune Mordekaiser Morgana Nami Nasus Neeko Olaf Orianna Renata Rumble Ryze Senna Seraphine Sett Shaco Singed Sion Sivir Smolder Sona Soraka Swain Syndra TahmKench Taliyah Taric Teemo Thresh Trundle Twitch Udyr Urgot Varus Veigar Velkoz Viktor Vladimir Volibear Xerath Yorick Zeri Ziggs Zilean Zyra'.split(' '));

export const ALIASES = {
  Jinx: '金克斯 暴走萝莉 萝莉 jks', Ashe: '寒冰 艾希 ax', MissFortune: '女枪 好运姐 厄运小姐 mf',
  MasterYi: '剑圣 易 js', Yasuo: '亚索 快乐风男 ys', Yone: '永恩 yone ye', Malphite: '石头人 石头 st',
  Garen: '盖伦 德玛 德玛西亚 gl', Teemo: '提莫 tm', DrMundo: '蒙多 md', MonkeyKing: '猴子 孙悟空 悟空 hz',
  KogMaw: '大嘴 克格莫 dz', Khazix: '螳螂 卡兹克 tl', Chogath: '大虫子 科加斯', Blitzcrank: '机器人 jqr',
  Hecarim: '人马 赫卡里姆', Aatrox: '剑魔 亚托克斯', Darius: '诺手 诺克萨斯之手', Tryndamere: '蛮王',
  TahmKench: '塔姆 蛤蟆', Orianna: '发条', Twitch: '老鼠', Leona: '日女 曙光', Diana: '皎月',
  Ezreal: 'ez 伊泽瑞尔 探险家', Lucian: '卢锡安 奥巴马', Caitlyn: '女警', Vayne: 'vn 薇恩',
  Kaisa: '卡莎', Tristana: '小炮', Lux: '光辉 拉克丝', Leblanc: '妖姬', Annie: '安妮 火女',
  Brand: '火男 布兰德', Veigar: '小法 维迦', Malzahar: '蚂蚱', Vladimir: '吸血鬼',
  Swain: '乌鸦 斯维因', Singed: '炼金 辛吉德', Fiddlesticks: '稻草人', Lillia: '莉莉娅 小鹿',
  Sona: '琴女', Soraka: '奶妈 星妈', Nami: '娜美 鱼人', Fizz: '小鱼人', Zed: '劫', Riven: '锐雯 瑞文',
  Rengar: '狮子狗', Warwick: '狼人', Rammus: '龙龟', Thresh: '锤石', Nasus: '狗头', Renekton: '鳄鱼',
  AurelionSol: '龙王', Smolder: '斯莫德 小火龙', KSante: '奎桑提 黑哥', Nidalee: '豹女',
};

export function championProfile(champion, strategy = 'auto') {
  let type = groupIndex.get(champion.id);
  if (!type) type = champion.roles.includes('Marksman') ? 'marksman' : champion.roles.includes('Tank') ? 'tank' : champion.roles.includes('Mage') ? 'mage' : champion.roles.includes('Support') ? 'support' : 'fighter';
  if (['Ezreal', 'Smolder', 'Corki'].includes(champion.id)) type = 'marksman';
  if (['Gwen', 'Mordekaiser'].includes(champion.id)) type = 'burn';
  if (champion.id === 'DrMundo') type = 'tank';
  if (champion.id === 'Teemo') type = 'burn';
  if (['Yasuo', 'Yone', 'Tryndamere'].includes(champion.id)) type = 'marksman';
  const f = { ...Object.fromEntries(Object.keys(FEATURE_NAMES).map(k => [k, 0])), ...archetypes[type] };
  const text = [...champion.spells, champion.passive].map(s => s.description).join(' ');
  f.mana = champion.resource === '法力' ? .65 : 0;
  f.cc = /眩晕|晕眩|禁锢|束缚|缚地|击飞|嘲讽|恐惧|压制|魅惑|击退/.test(text) ? .75 : 0;
  f.slow = /减速/.test(text) ? .7 : 0;
  f.dash = !noDashes.has(champion.id) && /冲刺|突进|跃|跳|位移|闪烁|传送/.test(text) ? .85 : 0;
  if (['Caitlyn', 'Kled', 'Shaco', 'TahmKench', 'Urgot', 'Zeri', 'Ziggs'].includes(champion.id)) f.dash = .65;
  if (['Fiddlesticks', 'Sion', 'Volibear'].includes(champion.id)) f.dash = .35;
  f.economy = .55;
  f.itemhaste = .3;
  f.spellblade = f.attack > .5 && f.spell > .6 ? .75 : .15;
  for (const [feature, ids] of Object.entries(traits)) if (ids.split(' ').includes(champion.id)) f[feature] = 1;
  if (/治疗自己|回复生命|恢复生命|生命偷取/.test(text)) f.heal = Math.max(f.heal, .7);
  if (/护盾/.test(text)) f.shield = Math.max(f.shield, .65);
  if (champion.id === 'Jhin') Object.assign(f, { onhit: .2, attack: .55, crit: 1, spell: .7 });
  if (champion.id === 'Ezreal') Object.assign(f, { spell: 1, haste: 1, crit: .1, spellblade: 1, dash: .65, ap: .3 });
  if (champion.id === 'Smolder') Object.assign(f, { spell: 1, haste: .8, crit: .65, attack: .6 });
  if (['Yasuo', 'Yone', 'Tryndamere'].includes(champion.id)) Object.assign(f, { crit: 1, attack: 1 });
  if (champion.id === 'DrMundo') Object.assign(f, { health: 1, heal: 1, ad: .65, ap: .05, attack: .7, shield: .1, crit: .05 });
  if (champion.id === 'Teemo') Object.assign(f, { ap: 1, attack: .75, onhit: .8, dot: 1 });
  if (['Kaisa', 'KogMaw', 'Varus'].includes(champion.id)) f.ap = .65;
  if (champion.id === 'Senna') Object.assign(f, { ad: .9, attack: .8, crit: .6, onhit: .5, ap: .3 });
  if (['Kayle', 'Gwen', 'Azir'].includes(champion.id)) Object.assign(f, { ap: 1, attack: .95, onhit: .95 });
  if (champion.id === 'Katarina') Object.assign(f, { onhit: .9, dash: 1, dot: .2 });
  if (['Ryze', 'Kassadin', 'Cassiopeia', 'Anivia'].includes(champion.id)) f.mana = 1;
  if (['Elise', 'Nidalee', 'Jayce', 'Udyr'].includes(champion.id)) f.ult = .1;
  if (strategy !== 'auto' && archetypes[strategy]) {
    const target = archetypes[strategy];
    for (const k of ['attack', 'spell', 'ad', 'ap', 'crit', 'onhit', 'haste', 'health', 'resist', 'range']) f[k] = .35 * f[k] + .65 * (target[k] || 0);
    type = strategy;
  }
  return { type, features: f, melee: champion.stats.attackrange < 300 && champion.id !== 'Kayle', reviewed: groupIndex.has(champion.id) || ['Ezreal', 'Smolder', 'Corki', 'Mordekaiser'].includes(champion.id) };
}
