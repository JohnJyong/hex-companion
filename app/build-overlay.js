window.desktop.onOverlay(({build, recordHint, iconBase = ''}) => {
  if (!build) return;
  const [next, ...later] = build.purchases;
  const icon = document.getElementById('item-icon');
  icon.hidden = !next;
  if (next) icon.src = iconBase + 'assets/items/' + next.id + '.png';
  else icon.removeAttribute('src');
  document.getElementById('hero').textContent = build.hero;
  document.getElementById('caption').textContent = next ? '下一件' + (build.reason ? ' · ' + build.reason : '') : '已购成装';
  document.getElementById('item').textContent = next?.name || '六格装备已齐';
  document.getElementById('price').textContent = next ? '整件 ' + next.cost.toLocaleString('zh-CN') + ' 金' : '';
  document.getElementById('following').textContent = later.length ? '随后　' + later.map(item => item.name).join(' → ') : build.route;
  const count = build.selected.length;
  const last = build.selected[count - 1];
  document.getElementById('record').textContent = recordHint
    ? `已记 ${count} 枚 · Ctrl+Alt+1/2/3 记录本轮`
    : count ? `已记 ${count} 枚 · 最近选择「${last}」` : '尚未记录海克斯';
});
