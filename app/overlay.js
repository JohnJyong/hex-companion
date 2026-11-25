'use strict';

const tierNames = { silver: '白银', gold: '黄金', prismatic: '棱彩' };
const count = new Intl.NumberFormat('zh-CN');
const field = Object.fromEntries(
  [...document.querySelectorAll('[id]')].map(element => [element.id, element])
);

function verdict(card, phase) {
  if (phase === 'review') return ['待复核', 'review'];
  if (phase === 'preview' || card.pending) return ['正在确认', 'pending'];
  if (card.conflict) return ['组合有冲突', 'conflict'];
  if (/冲突|失效|无法|不能|缺少|放弃/.test(card.warning || '')) return ['留意触发条件', 'conditional'];
  if (card.statistics?.lowSample) return ['样本较少', 'caution'];
  if (card.best) return ['首选', 'best'];
  if (card.statistics?.deltaPP < 0) return ['可考虑刷新', 'caution'];
  if (!card.statistics && !Number.isFinite(card.score)) return ['资料不足', 'neutral'];
  return ['可选', 'neutral'];
}

window.desktop.onOverlay(({ card = {}, phase, hero }) => {
  const [heading, state] = verdict(card, phase);
  const pending = state === 'pending';
  const stats = pending ? null : card.statistics;
  const scored = !pending && !stats && Number.isFinite(card.score);
  const tier = tierNames[card.tier] || '';
  const ranked = stats?.tierRank > 0 && stats.tierCount > 0;
  field.card.className = state;
  field.card.classList.toggle('unrated', !pending && !stats && !scored);
  field.headline.textContent = heading;
  field.placement.textContent = ranked ? `${tier || '同阶'}第${stats.tierRank}/${stats.tierCount}`
    : stats ? [tier, '未评级'].filter(Boolean).join(' · ') : tier;
  field.grade.textContent = ranked && stats.grade ? `${stats.grade}档` : '';
  field.grade.hidden = !field.grade.textContent;

  field.value.textContent = pending ? (card.name || '识别中')
    : stats ? (stats.winRate * 100).toFixed(1) : scored ? String(card.score) : '暂无数据';
  field.unit.textContent = stats ? '%' : scored ? '/100' : '';
  field.measure.textContent = stats ? '胜率' : scored ? '适配分' : '';
  const recordHint = Number.isInteger(card.slot) ? `确认后按 Ctrl+Alt+${card.slot + 1} 记录` : '确认后可记录选择';
  field.sample.textContent = pending ? recordHint
    : stats ? `${count.format(stats.games)} 次样本` : '暂无该英雄样本';
  field.sample.hidden = !pending && !stats && !scored;

  const delta = stats?.deltaPP;
  field.comparison.hidden = !Number.isFinite(delta);
  field.difference.textContent = Number.isFinite(delta) ? `${delta > 0 ? '+' : ''}${delta.toFixed(1)}` : '';
  field.delta.dataset.direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';

  let note = '';
  if (pending) note = 'Ctrl+Alt+H / F8 隐藏提示';
  else if (state === 'review') note = '上次识别结果 · 暂停记录';
  else {
    if (card.conflict) note = card.interaction || card.warning;
    else if (state === 'conditional') note = card.warning;
    else note = card.interaction || card.guide || (!stats && card.reason)
      || (stats?.displayPatch ? [hero, `${stats.displayPatch} 样本`].filter(Boolean).join(' · ') : '');
  }
  field.note.textContent = note || '';
  field.note.hidden = !note;
  field.note.classList.toggle('interaction', Boolean(note && note === card.interaction));
});
