import { indexCatalog, TIERS, STRATEGIES, rankCandidates, scoreAugment, recommendBuilds, combinationInsights, interactionLabel, canEquip } from './core/engine.mjs';
import { championProfile, FEATURE_NAMES, ALIASES } from './core/profiles.mjs';
import { augmentRule } from './core/augment-rules.mjs';
import { emptySession, validateSession, chooseAugment } from './core/session.mjs';
import { createLiveController } from './core/live-controller.mjs';
import { heroStat, renderStats, statsRows, renderLive, liveBanner } from './views.mjs';
import { championStats, formatWinRate } from './core/champion-stats.mjs';
import { lookupAugmentStats, formatDeltaPP } from './core/augment-stats.mjs';

import { indexGuides } from './core/guides.mjs';
import { renderGuides, guideResults, contextualGuides } from './guide-views.mjs';

const guideFilters = { query: '', type: 'all', heroOnly: false, page: 0 };
let guideIndex;

function refreshGuideResults() {
  const container = document.getElementById('guide-results');
  if (container) container.innerHTML = guideResults(guideIndex, db, state, guideFilters);
}

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const paths = {
  hex: '<path d="m12 2 9 5v10l-9 5-9-5V7z"/><path d="m7 9 5-3 5 3v6l-5 3-5-3zM12 6v12M7 9l10 6M17 9 7 15"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2.5 5.5L8 16l2.5-5.5z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  chart: '<path d="M4 4v16h16M8 15l4-5 4 2 5-7"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>', arrowup: '<path d="M6 18 18 6H8m10 0v10"/>',
  check: '<path d="m5 12 4 4L19 6"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 14 6M18 18A8 8 0 0 1 4 12"/>',
  star: '<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  diamond: '<path d="m12 2 8 10-8 10-8-10zM4 12h16M12 2v20"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  sword: '<path d="m14 3 7-1-1 7-11 11-6-6zM3 21l4-4M2 13l9 9"/>',
  link: '<path d="m9 15 6-6m-7 9-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2-3 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 -1)"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  pin: '<path d="m8 3 8 0-1 6 3 3v2H6v-2l3-3zM12 14v8"/>',
  compact: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16M3 9h11"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>', upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  undo: '<path d="M4 10h10a6 6 0 0 1 0 12M9 5l-5 5 5 5"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  bolt: '<path d="m13 2-8 12h6l-1 8 9-13h-7z"/>',
};
const icon = (name, size = 17) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.hex}</svg>`;
const img = (src, alt, cls = '') => `<img src="${esc(src)}" alt="${esc(alt)}" class="${cls}" loading="lazy">`;
const btn = (action, text, opts = '') => `<button class="btn ${opts}" data-action="${action}">${text}</button>`;
const roles = { Tank: '坦克', Fighter: '战士', Assassin: '刺客', Mage: '法师', Marksman: '射手', Support: '辅助' };
const STORE = 'hex-companion.session.v1';
const SELECT_PREF = 'hex-companion.champ-select.v1';
let selectStatus = {enabled:false,status:'等待客户端'};
let db, state, undo = [], page = 'desk', previewId = null, buildIndex = 0, modalState = null;
let live, statsData, statsQuery = '', statsRole = 'all', statsSort = 'winRate';
let captureWindows = [], captureWindowId = '', captureLoading = false, captureError = '';
const captureOptions = { overlay: true, syncItems: true, roi: { x: 0, y: 0, width: 1, height: 1 } };
let liveRenderKey = '';
let pinned = false, compact = false, desktopInfo = null, atlasQuery = '', atlasTier = 'all', toastTimer;

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3300);
}
function save() {
  state.updatedAt = new Date().toISOString();
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { toast('本地保存失败，请导出对局备份'); }
}
function commit(next, message, preservePreview = false) {
  const valid = validateSession(next, db);
  undo.push(structuredClone(state));
  if (undo.length > 25) undo.shift();
  state = valid;
  if (!preservePreview) previewId = null;
  buildIndex = 0;
  save();
  render();
  live?.publish();
  if (message) toast(message);
}
function demoSession() {
  return validateSession({ ...emptySession(), championId: 'Jinx', selected: ['ARAM_Deft'],
    candidates: ['CriticalRhythm', 'ARAM_Firebrand', 'ARAM_Marksmage'], tier: 'gold', demo: true,
  }, db);
}
function render() {
  const c = db.championMap.get(state.championId);
  document.body.classList.toggle('compact', compact);
  $('#app').innerHTML = `
    <div class="titlebar"><div class="window-name">HEX COMPANION</div><div class="window-status"><i class="status-dot"></i>本地运行 <span>·</span> v${esc(desktopInfo?.version || '0.6.1')}</div></div>
    <aside class="sidebar">
      <div class="brand"><div class="brand-symbol">${icon('hex', 35)}</div><div class="brand-text"><strong>海克斯参谋</strong><small>HEX COMPANION</small></div></div>
      <div class="nav-caption">你的对局工作台</div>
      <button class="nav-item ${page === 'desk' ? 'active' : ''}" data-action="page" data-page="desk">${icon('compass')}<span>对局助手</span></button>
      <button class="nav-item ${page === 'live' ? 'active' : ''}" data-action="page" data-page="live">${icon('bolt')}<span>实时识别</span><span class="count">LIVE</span></button>
      <button class="nav-item" data-action="show-builds" title="推荐出装" aria-label="推荐出装">${icon('sword')}<span>推荐出装</span></button>
      <button class="nav-item ${page === 'stats' ? 'active' : ''}" data-action="page" data-page="stats">${icon('chart')}<span>英雄胜率</span></button>
      <button class="nav-item ${page === 'atlas' ? 'active' : ''}" data-action="page" data-page="atlas">${icon('layers')}<span>海克斯图鉴</span><span class="count">${db.augments.length}</span></button>
      <button class="nav-item ${page === 'guides' ? 'active' : ''}" data-action="page" data-page="guides">${icon('database')}<span>攻略库</span></button>
      <button class="nav-item ${page === 'history' ? 'active' : ''}" data-action="page" data-page="history">${icon('clock')}<span>本局记录</span></button>
      <div class="sidebar-rule"></div>
      <button class="nav-item ${page === 'settings' ? 'active' : ''}" data-action="page" data-page="settings">${icon('settings')}<span>设置与数据</span></button>
      <div class="sidebar-bottom"><div class="local-card"><div class="live"><i class="status-dot"></i>离线数据库已就绪</div><p>版本 ${db.meta.patch}<br>${db.champions.length} 位英雄 · ${db.augments.length} 个海克斯<br>Windows 本地识别 · 无需登录</p></div><div class="sidebar-foot">独立社区工具 / 非官方</div></div>
    </aside>
    <main class="workspace">
      ${page === 'desk' ? renderDesk(c) : page === 'guides' ? renderGuides(guideIndex, db, state, guideFilters) : page === 'atlas' ? renderAtlas() : page === 'stats' ? renderStats(db, statsData, statsQuery, statsRole, statsSort) : page === 'live' ? `<div id="live-content">${liveView()}</div>` : page === 'settings' ? renderSettings() : renderHistory()}
      <footer class="footnote"><span>适配分是机制规则评分，不是胜率。数值与开放情况以游戏内为准。</span><button class="text-btn" data-action="page" data-page="settings">数据 ${db.meta.asOf} ${icon('arrowup', 11)}</button></footer>
    </main>`;
}

function renderDesk(champion) {
  const liveState = live?.snapshot();
  const offered = liveState?.active ? [...(liveState.displayCandidates || [])] : [...state.candidates];
  while(offered.length < 3) offered.push(null);
  const ranked = rankCandidates({ ...state, candidates: offered, tier: liveState?.displayTier || state.tier }, db);
  const best = (!liveState?.active || liveState.actionable) ? ranked.find(r => !r.conflict && (r.score !== null || r.statistics?.reliable)) : null;
  const selected = state.selected.map(id => db.augmentMap.get(id));
  return `<header class="header"><div><div class="eyebrow">工作台 <span class="slash">/</span> 海克斯大乱斗 ${state.demo ? '<span class="badge demo">示例对局</span>' : liveState?.active ? '<span class="badge teal">实时识别</span>' : '<span class="badge">手动录入</span>'}</div><h1>这一局，选对每一步。</h1><p>从英雄出发，让海克斯组合与出装彼此成就。</p></div>
    <div class="header-actions"><button class="btn small" data-action="undo" title="撤销上一步" ${!undo.length ? 'disabled' : ''}>${icon('undo', 15)}</button><button class="btn small" data-action="compact" title="${compact ? '展开工作台' : '切换精简窗口'}">${icon('compact', 16)}</button><button class="btn small ${pinned ? 'primary' : ''}" data-action="pin" title="${pinned ? '取消置顶' : '窗口置顶'}">${icon('pin', 15)}</button><button class="btn export-button" data-action="export">${icon('download', 14)}<span class="export-label">导出</span></button><button class="btn primary new-button" data-action="new">${icon('plus', 15)}新对局</button></div></header>
    <div id="live-banner">${liveBanner(liveState)}</div>
    <div class="desk-grid"><div class="left-column">
      <section class="panel hero-panel"><div class="panel-top"><span class="section-kicker">01 / 当前英雄</span>${icon('compass', 14)}</div>
      ${champion ? `<div class="hero-info">${img(champion.icon, champion.name, 'hero-avatar')}<div><div class="hero-title">${esc(champion.title)}</div><h2 class="hero-name">${esc(champion.name)}</h2><div class="hero-english">${esc(champion.id.toUpperCase())}</div></div></div><div class="hero-tags">${champion.roles.map(r => `<span class="chip">${roles[r]}</span>`).join('')}<span class="chip">${champion.stats.attackrange < 300 ? '近战' : '远程'}</span></div>${heroStat(champion,statsData,db.meta)}<button class="hero-select" data-action="hero">更换英雄 <span>Ctrl K ${icon('arrow', 13)}</span></button>` : `<button class="hero-empty" data-action="hero">${icon('plus', 26)}<span>选择本局英雄</span><small>支持中文、称号和常用别名</small></button>`}</section>
      <section class="panel selected-panel"><div class="panel-top"><span class="panel-label">已选海克斯</span><button class="text-btn" data-action="selected">编辑 ${icon('layers', 12)}</button></div><div class="slot-stack">
      ${Array.from({ length: 4 }, (_, i) => { const a = selected[i]; return a ? `<div class="selected-slot" style="--tier:var(--${a.tier})">${img(a.icon, '')}<button class="slot-text" style="text-align:left;padding:0" data-action="detail" data-id="${a.id}"><strong>${esc(a.name)}</strong><small><i class="tier-dot"></i>${TIERS[a.tier]} · 第 ${i + 1} 次选择</small></button><button class="remove" data-action="remove-selected" data-id="${a.id}" aria-label="移除${esc(a.name)}">×</button></div>` : `<button class="selected-slot empty" data-action="selected"><span class="slot-number">${i + 1}</span><span class="slot-text"><strong>${i === selected.length ? '等待选择' : '尚未解锁'}</strong><small>${[3, 7, 11, 15][i]} 级 · 常规选择</small></span>${icon('plus', 12)}</button>`; }).join('')}
      </div><p class="small-note">随时补录或修改已选海克斯，建议会自动更新。</p></section>
      <section class="panel left-settings"><div class="panel-top"><span class="panel-label">对局条件</span>${icon('settings', 14)}</div>
        <label class="field"><span>出装方向</span><select data-field="strategy" aria-label="出装方向">${Object.entries(STRATEGIES).map(([id, label]) => `<option value="${id}" ${state.strategy === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label class="field"><span>当前目标</span><select data-field="priority" aria-label="当前目标">${[['balanced', '兼顾输出与生存'], ['damage', '优先输出'], ['survive', '优先生存']].map(([id, label]) => `<option value="${id}" ${state.priority === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label class="field"><span>敌方主要伤害</span><select data-field="damage" aria-label="敌方主要伤害">${[['balanced', '物理 / 魔法均衡'], ['ad', '物理伤害为主'], ['ap', '魔法伤害为主']].map(([id, label]) => `<option value="${id}" ${state.enemy.damage === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <div class="field full"><span>敌方特点</span><div class="toggle-grid">${[['tanks', '前排多'], ['healing', '回复强'], ['cc', '控制多']].map(([id, label]) => `<button class="toggle-chip ${state.enemy[id] ? 'active' : ''}" data-action="enemy" data-id="${id}" aria-pressed="${state.enemy[id]}">${label}</button>`).join('')}</div></div>
        <div class="field full"><span>已购成装 <button class="text-btn" style="float:right;font-size:9px" data-action="inventory">编辑</button></span><div class="inventory">${Array.from({ length: 6 }, (_, i) => { const item = db.itemMap.get(state.owned[i]); return `<button class="item-slot" data-action="${item ? 'item-detail' : 'inventory'}" ${item ? `data-id="${item.id}"` : ''} title="${item ? esc(item.name) : '添加已购装备'}">${item ? img(item.icon, item.name) : '+'}</button>`; }).join('')}</div></div>
        <label class="field"><span>现有金币</span><input type="number" min="0" max="99999" step="50" value="${state.gold}" data-field="gold" aria-label="现有金币"></label>
      </section>
    </div><div class="decision-column">
      <div class="round-strip"><span class="round-caption">${icon('clock', 14)}常规选择进度</span><div class="round-progress">${[3, 7, 11, 15].map((level, i) => `${i ? '<span class="round-link"></span>' : ''}<div class="round ${i < selected.length ? 'done' : i === selected.length ? 'current' : ''}"><span class="circle">${i < selected.length ? icon('check', 12) : i + 1}</span>${level} 级</div>`).join('')}</div></div>
      <div class="section-head"><div><div class="section-title"><span class="index">02</span><h2>${selected.length === 4 ? '本局选择已完成' : '这次海克斯，怎么选？'}</h2></div><div class="section-sub">${selected.length === 4 ? '可在左侧修正记录，或开启下一局' : liveState?.active ? '自动识别三选一；面板显示时 Ctrl + Alt + 1 / 2 / 3 记录' : '录入游戏里的候选，对比英雄适配与组合联动'}</div></div><div class="segmented" aria-label="本轮海克斯阶级">${Object.entries(TIERS).map(([id, label]) => `<button class="${state.tier === id ? 'active' : ''}" data-action="tier" data-value="${id}">${label}</button>`).join('')}</div></div>
      <div class="candidate-grid">${offered.map((id, slot) => { const r = ranked.find(r => r.augment.id === id); return r ? renderCandidate(r, best?.augment.id === id, slot, liveState?.active ? liveState.phase : null) : `<div class="candidate empty"><button class="empty-candidate-btn" data-action="candidate" data-slot="${slot}" ${selected.length === 4 ? 'disabled' : ''}><span class="plus">+</span><strong>${liveState?.active ? `等待识别 ${slot + 1}` : `录入候选 ${slot + 1}`}</strong><small>${liveState?.active ? '连续确认后显示推荐' : '搜索海克斯名称'}</small><span>${liveState?.active ? esc(liveState.status) : '只需填写游戏中实际出现的选项'}</span></button></div>`; }).join('')}</div>
      <div class="comparison-foot"><span>${icon('info', 12)}评分用于比较当前候选 · 不代表胜率或实际伤害</span><button class="text-btn" data-action="candidates" ${selected.length === 4 ? 'disabled' : ''}>${icon('refresh', 12)}批量录入 / 刷新结果</button></div>
      ${renderBuilds()}
      <section class="panel synergy-panel"><div class="panel-top"><div class="section-title">${icon('link', 15)}<h2 style="font-size:14px">组合联动</h2></div><span class="section-kicker">SYNERGY NOTES</span></div>${renderSynergies()}</section>
    </div></div>`;
}

function augmentStatistics(stat, compact = false) {
  if(!stat) return '<div class="augment-stat missing">暂无该英雄的海克斯样本 · 使用机制规则参考</div>';
  return `<div class="augment-stat ${stat.lowSample ? 'low-sample' : ''}"><div class="stat-rate"><strong>${formatWinRate(stat.winRate)}</strong><span>${formatDeltaPP(stat.deltaPP)}<small>相对该英雄基准</small></span></div><div class="stat-rank">${stat.tierRank ? `同阶第 ${stat.tierRank} / ${stat.tierCount} · ${stat.grade} 档` : '样本不足，不参与排名'}<span>${stat.games.toLocaleString('zh-CN')} 次样本</span></div>${compact ? '' : `<p>版本 ${esc(stat.displayPatch)} · 截至 ${esc(stat.asOf?.slice(0,10))}<br>观察胜率差，不是选中后的因果提升；分档为本工具计算。</p>`}${stat.warnings?.length ? `<p class="warn">${stat.warnings.map(esc).join('；')}</p>` : ''}</div>`;
}
function renderCandidate(result, isBest, slot, phase = null) {
  const a = result.augment, rule = augmentRule(a), pending = phase === 'preview', review = phase === 'review';
  const pairing = interactionLabel(result.interactions?.[0]);
  const firstWarning = result.warnings.find(w => /缺少|无法|失效|放弃|会失去|随机|冲突/.test(w));
  return `<article class="candidate ${a.tier} ${isBest ? 'best' : ''} ${pending ? 'pending' : review ? 'review' : ''} ${previewId === a.id ? 'previewing' : ''}"><div class="candidate-top"><span class="tier-label">${icon('diamond', 11)}${TIERS[a.tier]}海克斯</span>${isBest ? `<span class="best-label">${icon('star', 10)}当前优先</span>` : ''}<button class="icon-btn" data-action="candidate" data-slot="${slot}" title="更换候选 ${slot + 1}" aria-label="更换候选 ${slot + 1}">${icon('refresh', 12)}</button></div>
    <div class="candidate-body"><div class="candidate-symbol">${img(a.icon, '')}</div><h3 class="candidate-title">${esc(a.name)}</h3><p class="candidate-description">${esc(rule.summary || a.description)}</p>${pending ? '<div class="augment-stat missing">正在连续确认标题，暂不显示评分</div>' : augmentStatistics(result.statistics, true)}<div class="score-row"><div><span class="score">${pending ? '—' : result.score ?? '—'}<small>/ 100</small></span><span class="score-note">机制适配分</span></div><span class="score-confidence">${pending ? '正在确认' : review ? '上一帧 · 待复核' : result.confidence || '待补充'}</span></div><p class="candidate-reason">${icon(isBest ? 'check' : 'bolt', 12)}<span>${esc(pending ? '正在确认本轮候选，确认后可记录。' : review ? '短暂保留上一帧结果；当前禁止记录。' : pairing || result.reasons[0])}</span></p>${result.guide && !pending && !review ? `<button class="text-btn candidate-guide" data-action="external" data-url="${esc(result.guide.sourceUrl)}" title="${esc(result.guide.title)}">搭配攻略 · ${esc(result.guide.partners.join('、'))} ↗</button>` : ''}${firstWarning && !pending ? `<p class="candidate-warning">${esc(firstWarning)}</p>` : ''}</div>
    <div class="candidate-footer"><button class="choose" data-action="choose" data-id="${a.id}" ${state.selected.length >= 4 || pending || review ? 'disabled' : ''}>${isBest ? '记录此选择' : '选择这个'} ${icon('arrow', 12)}</button><div class="card-links"><button class="text-btn" data-action="detail" data-id="${a.id}">查看推荐依据</button><button class="text-btn" data-action="preview" data-id="${a.id}" ${pending || review ? 'disabled' : ''}>出装预览 ${icon('arrowup', 10)}</button></div></div></article>`;
}
function buildEvidence(build) {
  const evidence=build.evidence;
  if(!evidence) return '<div class="build-evidence">机制规则参考 · 按已选海克斯调整，并非经过伤害模拟的最优解。</div>';
  const names=(evidence.items || [evidence.itemId]).map(id=>db.itemMap.get(String(id))?.name || id).join(' → ');
  return `<div class="build-evidence"><strong>${esc(evidence.label || '原始装备样本')}</strong><p>${esc(names)}</p><p>原始样本胜率 ${formatWinRate(evidence.winRate)} · ${Number(evidence.games).toLocaleString('zh-CN')} 次 · 截至 ${esc(evidence.asOf?.slice(0,10))}</p><small>${evidence.modified ? '当前对局调整已改变上述核心，原始胜率不代表修改后的路线。' : '统计仅覆盖上述核心装备；其余位置按英雄、海克斯与敌方条件补齐。'} 不代表六件套胜率。</small></div>`;
}

function renderBuilds() {
  const builds = recommendBuilds(state, db, previewId);
  const build = builds[Math.min(buildIndex, builds.length - 1)];
  if (!build) return `<section class="panel build-panel"><div class="section-title"><span class="index">03</span><h2>推荐出装</h2></div><p class="small-note" style="padding:16px 0">选择本局英雄后即可查看六格出装。记录海克斯或购买成装后，路线会随之调整。</p><button class="btn small" data-action="hero">选择本局英雄</button></section>`;
  const preview = db.augmentMap.get(previewId);
  return `<section class="panel build-panel"><div class="build-heading"><div class="section-title"><span class="index">03</span><h2>推荐出装</h2></div><div class="build-pills">${preview ? `<span class="badge teal">预览 · ${esc(preview.name)}</span><button class="icon-btn" data-action="clear-preview" title="返回已选组合">${icon('close', 12)}</button>` : '<span class="badge">基于已选组合</span>'}</div></div><div class="build-heading" style="margin-bottom:9px"><h3 class="build-name">${icon('sword', 16)}${esc(build.name)}</h3><span class="muted" style="font-size:9px">推荐购买顺序 · 保留已购</span></div><p class="build-description">${esc(build.reason)}${preview ? ` <span class="teal-text">以下假设选择「${esc(preview.name)}」。</span>` : ''}</p>
    ${buildEvidence(build)}
    <div class="build-items">${build.items.map((item, i) => { const owned = state.owned.includes(item.id); return `<button class="build-item ${owned ? 'owned' : item.id === build.next?.id ? 'next' : ''}" data-action="item-detail" data-id="${item.id}"><span class="item-position">${owned ? '✓ 已购' : item.id === build.next?.id ? '下一件' : `0${i + 1}`}</span>${img(item.icon, '')}<strong>${esc(item.name)}</strong><small>${item.cost.toLocaleString()} G</small></button>`; }).join('')}</div>
    ${build.next ? `<div class="purchase-callout"><div><div class="next-caption">NEXT PURCHASE / 下一件建议</div><strong>${esc(build.next.name)} <span class="gold-text">· ${build.next.cost.toLocaleString()} G</span></strong><p>${state.gold >= build.next.cost ? '按整件价格计算，当前金币足够。' : `按整件价格计算，还需 ${(build.next.cost - state.gold).toLocaleString()} 金币。`} 未计入散件抵扣。</p></div><button class="btn small" data-action="buy" data-id="${build.next.id}">${icon('check', 13)}记为已购</button></div>` : '<div class="purchase-callout"><strong>六格装备已记录完整</strong><span class="muted" style="font-size:10px">点击装备可查看详情或移除记录</span></div>'}
    ${contextualGuides(guideIndex, db, state, previewId, { forBuild: true })}
    ${build.notes.length ? `<div class="build-notes">${build.notes.slice(0, 3).map(text => `<p>${icon('info', 12)}<span>${esc(text)}</span></p>`).join('')}</div>` : ''}
    <div class="alternative-builds"><span>对比其他思路</span>${builds.map((b, i) => `<button class="${i === buildIndex ? 'active' : ''}" data-action="build" data-index="${i}">${esc(b.name)}</button>`).join('')}</div><p class="small-note">装备建议结合英雄样本与已选海克斯，未模拟全部伤害与触发条件。任务合成后的专属装备请以游戏内为准。</p></section>`;
}

function renderSynergies() {
  const notes = combinationInsights(state, db);
  return notes.length ? `<div class="synergy-list">${notes.map(n => `<div class="insight ${n.conflict ? 'conflict' : ''}">${icon(n.conflict ? 'info' : 'link', 16)}<div><strong>${esc(n.title)}</strong><p>${esc(n.text)}</p></div></div>`).join('')}</div>` : `<div class="empty-insight">${icon('layers', 27)}<p>${state.selected.length < 2 ? '至少记录两个海克斯后，这里会解释组合的联动与冲突。' : '当前组合没有命中专属联动规则。可以用出装预览比较下一张海克斯。'}</p></div>`;
}

function renderAtlas() {
  return `<div class="page-header"><div class="eyebrow">知识库 / 版本 ${db.meta.patch}</div><h1>海克斯图鉴</h1><p>浏览客户端符文池，查看机制说明与当前英雄的适配情况。</p></div><div class="atlas-toolbar"><label class="search-box">${icon('search', 16)}<input id="atlas-search" placeholder="搜索海克斯名称或效果…" value="${esc(atlasQuery)}" aria-label="搜索海克斯图鉴"></label><div class="filter-row">${[['all', '全部阶级'], ...Object.entries(TIERS)].map(([id, label]) => `<button class="filter-pill ${atlasTier === id ? 'active' : ''}" data-action="atlas-tier" data-value="${id}">${label}</button>`).join('')}</div></div><div id="atlas-results">${atlasResults()}</div>`;
}
function matchesAugment(a, query) { return `${a.name} ${a.en} ${a.description} ${augmentRule(a).summary || ''}`.toLowerCase().includes(query.toLowerCase().trim()); }
function atlasResults() {
  const list = db.augments.filter(a => (atlasTier === 'all' || a.tier === atlasTier) && matchesAugment(a, atlasQuery));
  return `<p class="results-caption">${list.length} 个海克斯 ${state.championId ? `· 适配分基于当前英雄「${esc(db.championMap.get(state.championId).name)}」` : '· 选择英雄后显示适配分'}</p><div class="atlas-grid">${list.map(a => { const result = scoreAugment(a, state, db); return `<button class="atlas-card" data-action="detail" data-id="${a.id}"><div class="atlas-heading">${img(a.icon, '')}<div><strong>${esc(a.name)}</strong><span class="tier-${a.tier}" style="font-size:9px">${TIERS[a.tier]}${a.abilitySpecific ? ' · 指定技能' : ''}</span></div></div><p class="description">${esc(augmentRule(a).summary || a.description)}</p><div class="atlas-foot"><span>${a.descriptionScope === 'unverified' ? '机制待核对' : augmentRule(a).reviewed ? '专属适配规则' : '通用适配规则'}</span><span>${result.score === null ? '—' : `${result.score} 分`} ${icon('arrow', 11)}</span></div></button>`; }).join('') || '<p class="empty-search">没有找到匹配的海克斯，试试简称或效果关键词。</p>'}</div>`;
}

function renderSettings() {
  const reviewed = db.augments.filter(a => augmentRule(a).reviewed).length;
  return `<div class="page-header"><div class="eyebrow">本地工作台 / SETTINGS</div><h1>设置与数据</h1><p>了解建议从哪里来，以及当前版本能做到什么。</p></div><div class="settings-grid">
    <section class="panel settings-card"><h2>${icon('compact')}桌面体验</h2><div class="setting-row"><div><strong>窗口置顶</strong><p>切换到游戏时仍可查看助手，适合无边框窗口模式。</p></div><button class="btn small ${pinned ? 'primary' : ''}" data-action="pin">${pinned ? '已开启' : '开启'}</button></div><div class="setting-row"><div><strong>精简窗口</strong><p>用更窄的窗口查看候选和出装，保留桌面空间。</p></div><button class="btn small" data-action="compact">${compact ? '展开' : '切换'}</button></div><div class="setting-row"><div><strong>游戏画面自动识别</strong><p>Windows 本地 OCR 读取候选，Live Client 同步英雄与成装。</p></div><button class="btn small" data-action="page" data-page="live">设置识别</button></div><div class="setting-row"><div><strong>对局自动保存</strong><p>每次修改后保存到本机。重新打开时恢复当前对局。</p></div><span class="badge teal">已开启</span></div></section>
    <section class="panel settings-card"><h2>${icon('database')}离线数据库 <span class="badge">${db.meta.patch}</span></h2><p>数据日期 ${db.meta.asOf} · 客户端资源 ${db.meta.dataDragonVersion}<br>随软件附带，日常查询和推荐无需联网。</p><div class="stat-grid"><div class="stat-box"><strong>${db.champions.length}</strong><span>位英雄</span></div><div class="stat-box"><strong>${db.augments.length}</strong><span>个海克斯</span></div><div class="stat-box"><strong>${db.items.length}</strong><span>件装备</span></div></div><p>${esc(db.meta.note)}</p><div class="notice">这是客户端候选池，可能包含服务器暂时停用的符文；请只录入游戏实际给出的选项。模式限定为海克斯大乱斗，不适用于斗魂竞技场或经典风格版。</div></section>
    <section class="panel settings-card"><h2>${icon('chart')}推荐依据</h2><p>英雄机制 55 分 + 已选组合 25 分 + 已有装备 10 分 + 对局环境 10 分，再扣除触发条件和冲突成本。</p><div class="setting-row"><div><strong>${reviewed} 个海克斯带专属规则</strong><p>其余已知效果使用关键词规则；没有可靠机制资料的条目不评分。</p></div></div><div class="setting-row"><div><strong>出装比较</strong><p>比较 13 组基础路径及技能暴击、灼烧暴击、技能特效和法力成长路径，保留已购并检查装备互斥。</p></div></div><div class="notice">已接入定版英雄与海克斯统计，机制分仍不代表胜率或伤害模拟器。分数用于当前条件下的相对比较，不能保证收益最大。指定技能类符文尚未细分具体技能槽位。</div></section>
    <section class="panel settings-card"><h2>${icon('link')}资料来源</h2>${db.meta.sources.map(s => `<button class="source-link" data-action="external" data-url="${esc(s.url)}">${esc(s.name)} ${icon('arrowup', 13)}</button>`).join('')}<p class="small-note">英雄、装备、图标及游戏资料版权归 Riot Games。海克斯参谋为独立社区工具，未经 Riot Games 背书。</p></section>
    <section class="panel settings-card wide"><h2>${icon('download')}对局文件</h2><p>导出为 JSON 文件，可在另一台 Windows 电脑的海克斯参谋中继续。金币仅用于比较下一件成装价格；记录已购不会自动扣款。</p><div class="detail-actions">${btn('export', icon('download', 14) + ' 导出当前对局')}${btn('import', icon('upload', 14) + ' 导入对局')}${btn('demo', '载入示例对局', 'ghost')}</div></section>
  </div>`;
}
function renderHistory() {
  const c = db.championMap.get(state.championId);
  return `<div class="page-header"><div class="eyebrow">对局记录 / CURRENT SESSION</div><h1>本局的每一步</h1><p>${c ? `${esc(c.name)} · 已记录 ${state.selected.length} 个海克斯` : '开始对局后，这里会记录每轮选择。'} · 修改自动保存在本机</p></div><section class="panel settings-card"><h2>${icon('clock')}选择时间线</h2>${state.history.length ? state.history.map(h => `<div class="history-row"><span>${esc(h.label)}</span><time>${esc(new Date(h.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))}</time></div>`).join('') : '<p>还没有选择记录。示例中的已有海克斯不计入时间线。</p>'}<div class="detail-actions">${btn('page-desk', '返回对局助手', 'primary')}${btn('export', icon('download', 14) + ' 导出本局')}</div></section>`;
}

function liveView() {
  return renderLive({snapshot:live?.snapshot() || {},windows:captureWindows,windowId:captureWindowId,options:captureOptions,platform:desktopInfo?.platform,loading:captureLoading,error:captureError,selectStatus,statsPatch:statsData?.meta?.displayPatch});
}
function refreshLiveView() {
  const content=$('#live-content');
  if(content) content.innerHTML=liveView();
}
function updateSelectStatus(next) {
  selectStatus=next;
  const label=$('#champ-select-status'), input=$('#champ-select-enabled');
  if (label) label.textContent=next.status;
  if (input) input.checked=next.enabled;
}
function onLiveChange() {
  const s=live?.snapshot();
  if(!s)return;
  const key=JSON.stringify([s.active,s.fresh,s.phase,s.displayCandidates,s.status,s.error,s.gameConnected]);
  if(page==='live' && !['INPUT','SELECT','SUMMARY'].includes(document.activeElement?.tagName)) refreshLiveView();
  if(page==='desk' && key!==liveRenderKey && !modal.open && !['INPUT','SELECT'].includes(document.activeElement?.tagName)) render();
  liveRenderKey=key;
}
function autoCommit(next) {
  state=validateSession(next,db); previewId=null; buildIndex=0; save();
  // The picker is separate from #app; avoid replacing controls while typing.
  if(page==='desk' && !['INPUT','SELECT'].includes(document.activeElement?.tagName)) render();
}
async function handleLiveAction(action) {
  captureError='';
  try {
    if(action==='live-toggle') {
      const visibility=await window.desktop.toggleOverlay(); captureOptions.overlay=visibility.enabled;
      toast(visibility.enabled ? '浮层已开启，切回游戏后显示' : '浮层已隐藏');
    } else if(action==='live-diagnostics') {
      if(await window.desktop.exportDiagnostics())toast('识别诊断已导出，不含截图或玩家身份');
    } else if(action==='live-refresh') {
      captureLoading=true;refreshLiveView();
      captureWindows=await window.desktop.captureWindows();
      if(!captureWindows.some(w=>String(w.id)===captureWindowId)) captureWindowId=String(captureWindows.find(w=>w.isGame)?.id || '');
      if(!captureWindows.length) captureError='没有可用窗口。请先进入游戏对局，再刷新。';
    } else if(action==='live-start') {
      const r=captureOptions.roi;
      if(!Object.values(r).every(Number.isFinite)||r.x<0||r.y<0||r.width<=0||r.height<=0||r.x+r.width>1||r.y+r.height>1) throw new Error('识别区域需在 0–100% 内，边距与尺寸相加不能超出窗口');
      const result = await live.start({...captureOptions,roi:{...r},windowId:captureWindowId});
      if(result?.failedShortcuts?.length) captureError = `快捷键被占用：${result.failedShortcuts.join('、')}。请在助手中记录选择。`;
      toast('已启动，请切回游戏；Ctrl + Alt + H 可隐藏悬浮窗');
    } else if(action==='live-stop') await live.stop();
  } catch(error) { captureError=error.message; }
  finally {captureLoading=false;refreshLiveView();}
}

const modal = $('#modal');
function closeModal() { modal.close(); modalState = null; }
function showModal(kind, extra = {}) {
  if (!state.championId && ['candidate', 'candidates', 'selected', 'inventory'].includes(kind)) { showModal('hero'); toast('先选择本局英雄'); return; }
  modalState = { kind, query: '', filter: 'all', ...extra };
  if (kind === 'candidates') modalState.picks = state.candidates.filter(Boolean);
  if (kind === 'selected') modalState.picks = [...state.selected];
  if (kind === 'inventory') modalState.picks = [...state.owned];
  renderModal();
  if (!modal.open) modal.showModal();
  setTimeout(() => $('#modal-search')?.focus(), 30);
}
function renderModal() {
  const m = modalState;
  const detail = ['detail', 'item-detail'].includes(m.kind);
  const titles = { hero: '选择本局英雄', candidate: `录入候选 ${(m.slot ?? 0) + 1}`, candidates: '录入本轮候选海克斯', selected: '编辑已选海克斯', inventory: '记录已购成装' };
  const subtitles = { hero: '中文名、英雄称号、英文名或常用别名，都可以搜索。更换英雄会开始新的组合。', candidate: `选择游戏实际出现的${TIERS[state.tier]}阶候选。`, candidates: `最多选择三个${TIERS[state.tier]}阶海克斯；刷新后用新结果覆盖。`, selected: '按获得顺序录入，最多四个常规海克斯。点击已勾选条目可移除。', inventory: '仅记录已完成的装备，不包含散件。互斥装备会自动禁用。' };
  const a = db.augmentMap.get(m.id), item = db.itemMap.get(m.id);
  let title = titles[m.kind] || (m.kind === 'detail' ? a.name : item.name);
  modal.innerHTML = `<div class="modal-shell"><header class="modal-head"><div><h2>${esc(title)}</h2><p>${esc(detail ? m.kind === 'detail' ? `${TIERS[a.tier]}海克斯 · ${a.en}` : `${item.cost} 金币 · 装备详情` : subtitles[m.kind])}</p></div><button class="icon-btn" data-action="close-modal" aria-label="关闭对话框">${icon('close', 19)}</button></header>
    ${detail ? '' : `<div class="modal-toolbar"><label class="search-box">${icon('search', 16)}<input id="modal-search" placeholder="${m.kind === 'hero' ? '例如：金克斯、剑圣、ez…' : m.kind === 'inventory' ? '搜索装备名称…' : '搜索海克斯名称或效果…'}" value="${esc(m.query)}" aria-label="${m.kind === 'hero' ? '搜索英雄' : m.kind === 'inventory' ? '搜索装备' : '搜索候选海克斯'}"></label><div class="filter-row">${m.kind === 'hero' ? [['all', '全部'], ...Object.entries(roles)].map(([id, label]) => `<button class="filter-pill ${m.filter === id ? 'active' : ''}" data-action="modal-filter" data-value="${id}">${label}</button>`).join('') : m.kind === 'selected' ? [['all', '全部阶级'], ...Object.entries(TIERS)].map(([id, label]) => `<button class="filter-pill ${m.filter === id ? 'active' : ''}" data-action="modal-filter" data-value="${id}">${label}</button>`).join('') : `<span class="hero-search-hint">${m.kind === 'inventory' ? '点击勾选或移除，保留六格成装记录' : `${TIERS[state.tier]}阶 · 按当前英雄适配排序，未评分条目在后`}</span>`}</div></div>`}
    <div class="modal-body" id="modal-results">${modalResults()}</div><div class="modal-footer" id="modal-footer">${modalFooter()}</div></div>`;
}
function modalFooter() {
  const m = modalState;
  if (m.kind === 'candidates') return `<p>已录入 ${m.picks.length} / 3 个候选</p><button class="btn primary" data-action="apply-modal" ${!m.picks.length ? 'disabled' : ''}>应用候选 ${icon('check', 14)}</button>`;
  if (m.kind === 'selected') return `<p>已选 ${m.picks.length} / 4 个海克斯</p>${btn('apply-modal', '保存组合', 'primary')}`;
  if (m.kind === 'inventory') return `<p>已记录 ${m.picks.length} / 6 件成装</p>${btn('apply-modal', '保存装备', 'primary')}`;
  return `<p>${m.kind === 'hero' ? `${db.champions.length} 位英雄 · 客户端 ${db.meta.patch}` : '所有建议只记录在助手中，游戏内需自行操作。'}</p>${btn('close-modal', '关闭', 'small')}`;
}
function modalResults() {
  const m = modalState;
  if (m.kind === 'detail') return augmentDetail(db.augmentMap.get(m.id));
  if (m.kind === 'item-detail') return itemDetail(db.itemMap.get(m.id));
  if (m.kind === 'hero') {
    const q = m.query.toLowerCase().trim();
    const list = db.champions.filter(c => (m.filter === 'all' || c.roles.includes(m.filter)) && `${c.name} ${c.title} ${c.id} ${ALIASES[c.id] || ''}`.toLowerCase().includes(q));
    return `<div class="hero-grid">${list.map(c => `<button class="hero-option ${state.championId === c.id ? 'selected' : ''}" data-action="pick-hero" data-id="${c.id}">${img(c.icon, '')}<strong>${esc(c.name)}</strong><small>${esc(c.title)}</small><span class="hero-rate">${formatWinRate(championStats(c,statsData,db.meta)?.winRate)} 胜率</span></button>`).join('') || '<p class="empty-search">没有找到英雄，试试中文名或常用别名。</p>'}</div>`;
  }
  if (m.kind === 'inventory') {
    const c = db.championMap.get(state.championId);
    const list = db.items.filter(i => i.name.toLowerCase().includes(m.query.toLowerCase().trim()));
    return `<div class="item-picker">${list.map(i => { const picked = m.picks.includes(i.id), allowed = picked || (m.picks.length < 6 && canEquip(i.id, m.picks, c, db)); return `<button class="item-option ${picked ? 'selected' : ''}" data-action="toggle-item" data-id="${i.id}" ${!allowed ? 'disabled' : ''}>${img(i.icon, '')}<div><strong>${esc(i.name)}</strong><small>${i.cost} G</small></div>${picked ? icon('check', 15) : ''}</button>`; }).join('') || '<p class="empty-search">没有找到可记录的成装。</p>'}</div>`;
  }
  const list = db.augments.filter(a => (m.kind === 'selected' ? (m.filter === 'all' || a.tier === m.filter) : a.tier === state.tier && !state.selected.includes(a.id)) && matchesAugment(a, m.query));
  const ranked = list.map(a => scoreAugment(a, state, db)).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return `<div class="augment-picker">${ranked.map(r => { const a = r.augment; const picked = m.picks ? m.picks.includes(a.id) : state.candidates[m.slot] === a.id; return `<button class="augment-option ${picked ? 'selected' : ''}" data-action="pick-augment" data-id="${a.id}">${img(a.icon, '')}<div><strong>${esc(a.name)}</strong><p><span class="tier-${a.tier}">${TIERS[a.tier]}</span> · ${esc(augmentRule(a).summary || a.description)}</p></div><span class="${picked ? 'option-check' : 'option-score'}">${picked ? icon('check', 16) : r.score ?? '—'}</span></button>`; }).join('') || '<p class="empty-search">没有匹配结果。检查本轮阶级，或试试效果关键词。</p>'}</div>`;
}
function refreshModalResults() {
  $('#modal-results').innerHTML = modalResults();
  $('#modal-footer').innerHTML = modalFooter();
}
function augmentDetail(a) {
  const r = scoreAugment(a, state, db), rule = augmentRule(a);
  const statistic = lookupAugmentStats(db.augmentStats, db.championMap.get(state.championId), a, db.meta);
  return `<div class="detail-top">${img(a.icon, '')}<div><span class="score">${r.score ?? '—'}<small>/ 100</small></span><p class="small-note">${r.confidence || '先选择英雄'} · 机制适配分</p></div></div>${augmentStatistics(statistic)}<div class="detail-description">${esc(rule.summary || a.description)}</div>${rule.summary ? `<p class="small-note">客户端机制说明：${esc(a.description)}</p>` : ''}<p class="small-note">客户端动态数值已省略，完整数值请对照游戏内说明。</p>
    <div class="breakdown">${r.breakdown.map(b => `<div><div class="breakdown-label"><span>${b.label}</span><span>${b.value > 0 ? '+' : ''}${b.value}${b.value >= 0 ? ` / ${b.max}` : ''}</span></div><div class="bar-track"><div class="bar-fill ${b.value < 0 ? 'negative' : ''}" style="width:${Math.min(100, Math.abs(b.value) / b.max * 100)}%"></div></div></div>`).join('')}</div>
    <section class="detail-section"><h3>为什么这样推荐</h3>${r.reasons.map(t => `<p>• ${esc(t)}</p>`).join('')}</section>${r.warnings.length ? `<section class="detail-section"><h3>选之前要考虑</h3>${r.warnings.map(t => `<p class="warn">• ${esc(t)}</p>`).join('')}</section>` : ''}
    ${contextualGuides(guideIndex, db, state, state.selected.includes(a.id) ? null : a.id, { focusAugmentId: a.id })}
    <div class="detail-actions"><button class="btn primary" data-action="detail-preview" data-id="${a.id}" ${!state.championId || state.selected.includes(a.id) ? 'disabled' : ''}>预览这张的出装 ${icon('arrow', 13)}</button><button class="btn" data-action="detail-candidate" data-id="${a.id}" ${!state.championId || state.selected.includes(a.id) || state.selected.length === 4 ? 'disabled' : ''}>加入本轮候选</button></div><p class="small-note">关键词：${rule.tags.map(t => FEATURE_NAMES[t]).filter(Boolean).join(' / ') || '待补充'}<br>来源：CommunityDragon · 客户端 ${db.meta.dataDragonVersion}${a.descriptionScope === 'shared' ? ' · 共享机制说明，不使用竞技场数值' : ''}</p>`;
}
function itemDetail(item) {
  return `<div class="detail-top">${img(item.icon, '')}<div><h3>${esc(item.name)}</h3><p class="gold-text" style="margin-top:10px">${item.cost.toLocaleString()} G</p></div></div><div class="detail-description">${esc(item.description).replace(/\n/g, '<br>')}</div><p class="small-note">装备属性来自 ${db.meta.dataDragonVersion} 静态数据，模式修正以游戏商店为准。</p><div class="detail-actions"><button class="btn primary" data-action="${state.owned.includes(item.id) ? 'remove-item' : 'buy'}" data-id="${item.id}" ${!state.championId ? 'disabled' : ''}>${state.owned.includes(item.id) ? '移除已购记录' : '记为已购'}</button></div>`;
}

async function exportSession() {
  const json = JSON.stringify(state, null, 2);
  if (window.desktop) { if (await window.desktop.exportSession(json)) toast('对局已导出'); }
  else { const url = URL.createObjectURL(new Blob([json], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = '海克斯参谋-对局.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
async function importSession() {
  if (window.desktop) { const data = await window.desktop.importSession(); if (data) { commit(validateSession(JSON.parse(data), db), '已导入对局'); page = 'desk'; render(); } }
  else { const input = document.createElement('input'); input.type = 'file'; input.accept = '.json'; input.onchange = async () => { try { const file = input.files[0]; if (file.size > 262144) throw new Error('对局文件过大'); commit(validateSession(JSON.parse(await file.text()), db), '已导入对局'); } catch (e) { toast(e.message); } }; input.click(); }
}

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const { action, id, value } = target.dataset;
  try {
    if (action.startsWith('live-')) { await handleLiveAction(action); }
    else if (action === 'guide-page') {
      guideFilters.page = Number(value);
      refreshGuideResults();
      document.getElementById('guide-search')?.scrollIntoView({block:'center'});
    }
    else if (action === 'stats-role') { statsRole = value; render(); }
    else if (action === 'stats-pick') { if(live?.snapshot().active) await live.stop(); commit({ ...emptySession(), championId:id }, '已选择英雄'); page='desk'; render(); }
    else if (action === 'page') { page = target.dataset.page; render(); window.scrollTo(0, 0); }
    else if (action === 'show-builds') { page = 'desk'; previewId = null; buildIndex = 0; render(); $('.build-panel')?.scrollIntoView({block:'start'}); }
    else if (action === 'page-desk') { page = 'desk'; render(); }
    else if (action === 'new') { live?.reset(); commit(emptySession(), '已开始新对局，可以撤销恢复上一局'); page = 'desk'; render(); showModal('hero'); }
    else if (action === 'demo') { commit(demoSession(), '已载入金克斯示例对局'); page = 'desk'; render(); }
    else if (action === 'undo') { if (undo.length) { state = undo.pop(); previewId = null; buildIndex = 0; save(); render(); live?.publish(); toast('已撤销上一步'); } }
    else if (action === 'hero') showModal('hero');
    else if (action === 'pick-hero') {
      if (state.championId !== id) commit({ ...emptySession(), championId: id }, `已选择${db.championMap.get(id).name}，组合已重置`);
      closeModal();
    }
    else if (['candidate', 'candidates', 'selected', 'inventory'].includes(action)) showModal(action, { slot: Number(target.dataset.slot || 0) });
    else if (action === 'detail' || action === 'item-detail') showModal(action, { id });
    else if (action === 'close-modal') closeModal();
    else if (action === 'modal-filter') { modalState.filter = value; renderModal(); }
    else if (action === 'pick-augment') {
      const m = modalState;
      if (m.kind === 'candidate') {
        if (state.candidates.some((x, i) => x === id && i !== m.slot)) throw new Error('这个海克斯已在另一个候选栏中');
        const candidates = [...state.candidates]; candidates[m.slot] = id;
        commit({ ...state, candidates, demo: false }); closeModal();
      } else {
        if (m.picks.includes(id)) m.picks = m.picks.filter(x => x !== id);
        else if (m.picks.length < (m.kind === 'selected' ? 4 : 3)) m.picks.push(id);
        else throw new Error(m.kind === 'selected' ? '最多记录四个常规海克斯' : '最多选择三个候选，请先取消一个');
        refreshModalResults();
      }
    }
    else if (action === 'toggle-item') { if (modalState.picks.includes(id)) modalState.picks = modalState.picks.filter(x => x !== id); else modalState.picks.push(id); refreshModalResults(); }
    else if (action === 'apply-modal') {
      const m = modalState;
      if (m.kind === 'candidates') commit({ ...state, candidates: [...m.picks, ...Array(3 - m.picks.length).fill(null)], demo: false }, '候选已更新，推荐已重新计算');
      if (m.kind === 'selected') commit({ ...state, selected: m.picks, candidates: state.candidates.map(id => m.picks.includes(id) || m.picks.length === 4 ? null : id), demo: false }, '已选组合已更新');
      if (m.kind === 'inventory') commit({ ...state, owned: m.picks, demo: false }, '已更新装备记录');
      closeModal();
    }
    else if (action === 'remove-selected') commit({ ...state, selected: state.selected.filter(x => x !== id), demo: false }, '已移除海克斯记录');
    else if (action === 'choose') { if (live?.snapshot().active && !live.snapshot().fresh) throw new Error('候选已过期，请等待重新识别'); commit(chooseAugment(state, id, db), '已记录选择，等待下一轮候选'); live?.reset({keepMatch:true}); render(); }
    else if (action === 'tier') { if (state.tier !== value) commit({ ...state, tier: value, candidates: [null, null, null] }, '已切换阶级，请录入该阶级的新候选'); }
    else if (action === 'preview' || action === 'detail-preview') { previewId = id; buildIndex = 0; if (modal.open) closeModal(); page = 'desk'; render(); $('.build-panel')?.scrollIntoView({block:'start'}); toast(`正在预览选择「${db.augmentMap.get(id).name}」后的出装`); }
    else if (action === 'clear-preview') { previewId = null; buildIndex = 0; render(); }
    else if (action === 'build') { buildIndex = Number(target.dataset.index); render(); }
    else if (action === 'enemy') commit({ ...state, enemy: { ...state.enemy, [id]: !state.enemy[id] } }, null, true);
    else if (action === 'buy') {
      if (state.owned.length >= 6) throw new Error('装备栏已满，请先移除一件');
      if (!canEquip(id, state.owned, db.championMap.get(state.championId), db)) throw new Error('这件装备与已购装备或英雄限制冲突');
      commit({ ...state, owned: [...state.owned, id], demo: false }, '已记录为成装；金币未自动扣除，请按游戏实际余额更新', true);
      if (modal.open) closeModal();
    }
    else if (action === 'remove-item') { commit({ ...state, owned: state.owned.filter(x => x !== id) }, '已移除装备记录'); closeModal(); }
    else if (action === 'detail-candidate') {
      const a = db.augmentMap.get(id);
      if (state.candidates.includes(id)) throw new Error('这个海克斯已在候选中');
      const candidates = state.tier === a.tier ? [...state.candidates] : [null, null, null];
      const free = candidates.indexOf(null);
      if (free === -1) throw new Error('候选已满，请从对局助手中更换一个候选');
      candidates[free] = id;
      commit({ ...state, tier: a.tier, candidates }, '已加入候选；请确认这是游戏实际给出的选项'); closeModal();
    }
    else if (action === 'atlas-tier') { atlasTier = value; render(); }
    else if (action === 'pin') { if (!window.desktop) throw new Error('窗口置顶请在桌面应用中使用'); pinned = await window.desktop.pin(); render(); toast(pinned ? '窗口已置顶' : '已取消置顶'); }
    else if (action === 'compact') { compact = window.desktop ? await window.desktop.compact() : !compact; page = 'desk'; render(); }
    else if (action === 'export') await exportSession();
    else if (action === 'import') await importSession();
    else if (action === 'external') { if (window.desktop) await window.desktop.openLink(target.dataset.url); else window.open(target.dataset.url, '_blank', 'noopener,noreferrer'); }
  } catch (error) { toast(error.message || '操作失败，请重试'); }
});
document.addEventListener('input', event => {
  if (event.target.id === 'modal-search') { modalState.query = event.target.value; refreshModalResults(); }
  if (event.target.id === 'stats-search') { statsQuery = event.target.value; $('#stats-results').innerHTML = statsRows(db,statsData,statsQuery,statsRole,statsSort); }
  if (event.target.id === 'guide-search') {
    guideFilters.query = event.target.value;
    guideFilters.page = 0;
    refreshGuideResults();
  }
  if (event.target.id === 'atlas-search') { atlasQuery = event.target.value; $('#atlas-results').innerHTML = atlasResults(); }
});
document.addEventListener('change', event => {
  if (['guide-type', 'guide-hero'].includes(event.target.id)) {
    if (event.target.id === 'guide-type') guideFilters.type = event.target.value;
    else guideFilters.heroOnly = event.target.checked;
    guideFilters.page = 0;
    refreshGuideResults();
  }
  if (event.target.id === 'stats-sort') { statsSort = event.target.value; $('#stats-results').innerHTML = statsRows(db,statsData,statsQuery,statsRole,statsSort); }
  if (event.target.id === 'capture-window') { captureWindowId = event.target.value; refreshLiveView(); }
  if (event.target.id === 'champ-select-enabled') {
    const checked=event.target.checked;
    window.desktop.setChampSelectEnabled(checked).then(next=>{
      localStorage.setItem(SELECT_PREF,String(next.enabled)); updateSelectStatus(next);
    }).catch(error=>{updateSelectStatus(selectStatus); toast(error.message);});
  }
  if (event.target.id === 'live-overlay') { captureOptions.overlay = event.target.checked; window.desktop?.setOverlayVisible?.(captureOptions.overlay).catch(e=>toast(e.message)); }
  if (event.target.id === 'live-sync') captureOptions.syncItems = event.target.checked;
  if (event.target.id.startsWith('roi-')) captureOptions.roi[event.target.id.slice(4)] = Number(event.target.value) / 100;
  const field = event.target.dataset.field;
  if (!field) return;
  try {
    const value = event.target.value;
    if (field === 'damage') commit({ ...state, enemy: { ...state.enemy, damage: value } }, null, true);
    else commit({ ...state, [field]: field === 'gold' ? Number(value) : value }, null, true);
  } catch (e) { toast(e.message); render(); }
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); showModal('hero'); }
});
modal.addEventListener('click', event => { if (event.target === modal) { const r = modal.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeModal(); } });
modal.addEventListener('close', () => { modalState = null; });

try {
  const response = await fetch('./data/catalog.json');
  if (!response.ok) throw new Error('无法读取离线数据库');
  db = indexCatalog(await response.json());
  const statsResponse = await fetch('./data/champion-stats.json');
  if (!statsResponse.ok) throw new Error('无法读取英雄胜率数据');
  statsData = await statsResponse.json();
  const additional = await Promise.all(['augment-stats','item-stats'].map(async name => { const response = await fetch(`./data/${name}.json`); if(!response.ok) throw new Error(`无法读取${name}统计`); return response.json(); }));
  [db.augmentStats,db.itemStats]=additional;
  const guideLists = await Promise.all(['editorial-guides', 'community-guides'].map(async name => {
    const response = await fetch(`./data/${name}.json`);
    if (!response.ok) throw new Error('无法读取离线攻略库');
    return response.json();
  }));
  guideIndex = indexGuides(guideLists.flat(), db);
  db.guideIndex = guideIndex;
  let restoreError = false;
  try { const saved = localStorage.getItem(STORE); state = saved ? validateSession(JSON.parse(saved), db) : demoSession(); }
  catch { state = emptySession(); restoreError = true; }
  if (window.desktop) { desktopInfo = await window.desktop.info(); pinned = desktopInfo.pinned; }
  if (desktopInfo?.platform==='win32' && window.desktop.setChampSelectEnabled) {
    window.desktop.onChampSelectStatus(updateSelectStatus);
    try { updateSelectStatus(await window.desktop.setChampSelectEnabled(localStorage.getItem(SELECT_PREF)!=='false')); }
    catch { updateSelectStatus({enabled:false,status:'选人提示启动失败，可重新开启'}); }
  }
  live = createLiveController({ desktop: window.desktop, db, getState: () => state, commit: autoCommit, onChange: onLiveChange, toast });
  window.desktop?.onOverlayVisibility?.(value => { if(captureOptions.overlay !== value.enabled){captureOptions.overlay=value.enabled;refreshLiveView();} });
  render();
  if (restoreError) toast('旧对局格式无法恢复，已创建空白对局');
} catch (error) {
  $('#app').innerHTML = `<div class="loading"><div><h2>启动时遇到问题</h2><p style="margin-top:15px">${esc(error.message)}</p><p style="margin-top:10px">请确认应用的离线数据文件完整。</p></div></div>`;
}
