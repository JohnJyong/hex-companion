'use strict';

const labels=document.getElementById('labels');
window.desktop.onOverlay(({kind,slots,mine,patch})=>{
  if (!['team','bench'].includes(kind) || !Array.isArray(slots)) return;
  labels.className=kind;
  const elements=[];
  if (kind==='team') {
    const header=document.createElement('header');
    header.textContent=`海克斯 · ${patch}`;
    elements.push(header);
  }
  for (const [i,slot] of slots.entries()) {
    const cell=document.createElement('div');
    if (slot) {
      cell.className=`chip grade-${slot.grade}`+(kind==='team' && mine===i?' mine':'');
      cell.setAttribute('aria-label',`${slot.name} · ${slot.rate}`);
      const score=document.createElement('strong');
      score.textContent=[slot.grade,slot.rate].filter(Boolean).join(' ');
      cell.append(score);
      if (kind==='team') {
        const rank=document.createElement('small');
        rank.textContent=(mine===i?'我 · ':'')+slot.rankText;
        cell.append(rank);
      }
    }
    elements.push(cell);
  }
  labels.replaceChildren(...elements);
});
