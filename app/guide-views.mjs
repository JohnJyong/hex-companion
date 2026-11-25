import { escapeHtml as escape } from './views.mjs';
import { matchGuides, searchGuides } from './core/guides.mjs';

const pageSize = 15;

function names(ids, map) {
  return ids.map(id => map.get(id)?.name).filter(Boolean).join('、');
}

function guideCard(entry, db) {
  const editorial = entry.kind === 'editorial';
  const champions = names(entry.championIds, db.championMap) || '所有英雄';
  const augments = names(entry.augmentIds, db.augmentMap);
  const items = names(entry.itemIds, db.itemMap);
  const source = entry.author ? entry.author + ' · ' + entry.sourceTitle : entry.sourceTitle;
  const label = editorial ? '攻略笔记' : { caution: '慎选索引', entertainment: '娱乐玩法索引' }[entry.stance] || '搭配索引';
  return `<article class="guide-card" data-guide-id="${escape(entry.id)}">
    <div class="guide-meta"><span class="guide-kind">${label}</span><span>${escape(champions)}</span><span>${escape(entry.version.label)}</span></div>
    <h3>${escape(entry.title)}</h3>
    <p>${escape(entry.summary)}</p>
    <div class="guide-fields"><span>${entry.relation === 'mentioned-together' ? '文中涉及' : '海克斯'}</span> ${escape(augments)}</div>
    ${items ? `<div class="guide-fields"><span>攻略装备</span> ${escape(items)}</div>` : ''}
    ${entry.note ? `<p class="guide-note">${escape(entry.note)}</p>` : ''}
    <div class="guide-source"><button class="text-btn" data-action="external" data-url="${escape(entry.sourceUrl)}" title="${escape(source)}">阅读原文 ↗</button><span>${escape(source)} · 核对日期 ${escape(entry.checkedAt)}</span></div>
    ${entry.sourceCredit || entry.evidenceLocator ? `<details class="guide-evidence"><summary>核对依据</summary>
      ${[entry.publishedAt, entry.sourceCredit, entry.evidenceLocator].filter(Boolean).map(detail => `<p>${escape(detail)}</p>`).join('')}</details>` : ''}
  </article>`;
}

export function guideResults(index, db, state, filters) {
  const championId = filters.heroOnly ? state.championId : undefined;
  let results = searchGuides(index, filters.query, { championId, limit: index.entries.length });
  if (filters.type === 'equipment') results = results.filter(entry => entry.itemIds.length);
  if (filters.type === 'notes') results = results.filter(entry => entry.kind === 'editorial');
  const pages = Math.ceil(results.length / pageSize);
  const current = Math.max(0, Math.min(pages - 1, filters.page));
  if (!results.length) return '<p class="notice">没有找到匹配的攻略。可以清除筛选，或换一个英雄、海克斯或装备名称。</p>';
  const page = results.slice(current * pageSize, (current + 1) * pageSize);
  return `<p class="results-caption" aria-live="polite">共 ${results.length} 条 · 第 ${current + 1} / ${pages} 页</p>
    <div class="guide-grid">${page.map(entry => guideCard(entry, db)).join('')}</div>
    ${pages > 1 ? `<nav class="guide-pagination" aria-label="攻略翻页"><button class="btn small" data-action="guide-page" data-value="${current - 1}" ${current === 0 ? 'disabled' : ''}>上一页</button><button class="btn small" data-action="guide-page" data-value="${current + 1}" ${current + 1 >= pages ? 'disabled' : ''}>下一页</button></nav>` : ''}`;
}

export function renderGuides(index, db, state, filters) {
  const champion = db.championMap.get(state.championId);
  const notes = index.entries.filter(entry => entry.kind === 'editorial').length;
  return `<div class="page-header"><h1>攻略库</h1><p>${notes} 条攻略笔记 · ${index.entries.length - notes} 条搭配索引。可按英雄、海克斯或装备查找。</p></div>
    <div class="atlas-toolbar"><label class="search-box"><input id="guide-search" aria-label="搜索攻略" placeholder="搜索英雄、海克斯、装备或玩法…" value="${escape(filters.query)}"></label>
    <select id="guide-type" aria-label="攻略类型">${[['all', '全部条目'], ['notes', '攻略笔记'], ['equipment', '有装备说明']].map(([value, label]) =>
      `<option value="${value}" ${value === filters.type ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
    ${champion ? `<label class="check-field"><input id="guide-hero" type="checkbox" ${filters.heroOnly ? 'checked' : ''}>仅看本局英雄「${escape(champion.name)}」及通用攻略</label>` : ''}
    <div id="guide-results">${guideResults(index, db, state, filters)}</div>`;
}

export function contextualGuides(index, db, state, candidateId, { forBuild = false, focusAugmentId = null } = {}) {
  const entries = matchGuides(index, state, { candidateId, limit: index.entries.length, includeReferences: true });
  const relevant = entries.filter(entry => (!forBuild || entry.itemIds.length)
    && (!focusAugmentId || entry.augmentIds.includes(focusAugmentId)));
  if (!relevant.length) return '';
  return `<section class="context-guides"><h3>${forBuild ? '相关出装攻略' : '相关选法攻略'}</h3>
    ${relevant.slice(0, 2).map(entry => guideCard(entry, db)).join('')}</section>`;
}
