'use strict';

const labels = document.getElementById('labels');
function span(className, text) {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

window.desktop.onOverlay(({ kind, slots, mine, patch }) => {
  if (!['team', 'bench'].includes(kind) || !Array.isArray(slots)) return;
  labels.className = kind;
  const elements = [];
  if (kind === 'team') {
    const header = document.createElement('header');
    const title = document.createElement('b');
    title.textContent = '英雄胜率';
    header.append(title, span('patch', patch || ''));
    elements.push(header);
  }
  for (const [index, slot] of slots.entries()) {
    const cell = document.createElement('div');
    elements.push(cell);
    if (!slot) continue;

    const isMine = kind === 'team' && index === mine;
    const hasRate = typeof slot.rate === 'string' && slot.rate.endsWith('%');
    cell.className = 'chip';
    if (slot.grade) cell.classList.add('grade-' + slot.grade);
    cell.classList.toggle('mine', isMine);
    cell.classList.toggle('no-data', !hasRate);
    cell.setAttribute('aria-label', [isMine && '我', slot.name, slot.rate, slot.grade && slot.grade + '档', slot.rankText].filter(Boolean).join('，'));

    const line = span('score-line', '');
    const tier = slot.grade || (kind === 'bench' && slot.rankText === '样本少' ? '少' : '');
    if (tier) line.append(span('tier', tier));
    const rate = span('rate', hasRate ? slot.rate.slice(0, -1) : (slot.rate || '暂无数据'));
    if (hasRate) rate.append(span('percent', '%'));
    line.append(rate);
    cell.append(line);

    if (kind === 'team') {
      const ranking = span('ranking', '');
      if (isMine) ranking.append(span('self', '我'));
      ranking.append(span('place', slot.rankText));
      cell.append(ranking);
    }
  }
  labels.replaceChildren(...elements);
});
