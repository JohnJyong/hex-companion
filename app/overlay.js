const tierNames={silver:'白银',gold:'黄金',prismatic:'棱彩'};
const percent=n=>`${(n*100).toFixed(1)}%`;
const signed=n=>`${n>0?'+':''}${n.toFixed(1)}pp`;
window.desktop.onOverlay(payload=>{
  const card=payload.card||{},stats=card.statistics;
  const phase=payload.phase;
  const pending=phase==='preview'||(card.pending&&phase!=='review');
  const review=phase==='review';
  const severe=card.warning&&/冲突|失效|无法|不能|缺少|放弃/.test(card.warning);
  let heading,style='neutral';
  if(pending){heading='正在确认 · '+(card.name||'本轮候选');style='pending';}
  else if(review){heading='等待复核 · 上一帧结果';style='review';}
  else if(card.conflict){heading='组合有冲突';style='warning';}
  else if(severe){heading='留意触发条件';style='warning';}
  else if(stats?.lowSample){heading='样本较少 · 谨慎选择';style='warning';}
  else if(card.best){heading='首选';style='best';}
  else if(stats&&stats.deltaPP<0){heading='可考虑刷新';style='warning';}
  else{heading='可选';}
  document.querySelector('#card').className=style;
  document.querySelector('#headline').textContent=heading;
  document.querySelector('#statistics').textContent=pending?'连续画面确认后显示统计与建议':stats?`${stats.deltaPP===null?'':signed(stats.deltaPP)+' · '}胜率 ${percent(stats.winRate)}`:Number.isFinite(card.score)?`机制适配 ${card.score}/100 · 暂无该英雄样本`:'暂无足够数据';
  document.querySelector('#rank').textContent=pending?'Ctrl+Alt+H / F8 隐藏':stats?`${tierNames[card.tier]||'同阶'}${stats.tierRank ? `第 ${stats.tierRank}/${stats.tierCount} · ${stats.grade}档` : ' · 暂不评级'} · ${stats.games.toLocaleString('zh-CN')} 次`:'依据当前英雄、已选组合与装备';
  const note=document.querySelector('#note');
  note.classList.toggle('interaction',Boolean(!pending&&!review&&card.interaction));
  if (pending) note.textContent='位置从左到右为 1 / 2 / 3';
  else if (review) note.textContent='当前不可记录，等待画面确认';
  else if (card.conflict) note.textContent=card.interaction || card.warning;
  else if (severe) note.textContent=card.warning;
  else if (card.interaction || card.guide) note.textContent=card.interaction || card.guide;
  else note.textContent=stats ? `${payload.hero||''} · ${stats.displayPatch||''}样本 · 差值非因果提升` : card.reason || '可在主窗口查看推荐依据';
});
