import { championStats, rankChampions, statsStatus, formatWinRate } from './core/champion-stats.mjs';
import { ALIASES } from './core/profiles.mjs';

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const e = escapeHtml;
const num = n => Number(n || 0).toLocaleString('zh-CN');
const date = value => value ? new Date(value).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',hour12:false}) : '未知';
const roleNames = { Tank:'坦克',Fighter:'战士',Assassin:'刺客',Mage:'法师',Marksman:'射手',Support:'辅助' };

export function heroStat(champion, dataset, context) {
  const stats = championStats(champion, dataset, context);
  return `<div class="hero-stat"><strong>${formatWinRate(stats?.winRate)}</strong><span>模式胜率 · ${num(stats?.games)} 次出场<br>版本 ${e(stats?.displayPatch || '—')} · ${stats?.lowSample ? '小样本' : '全体样本'}<br>截至 ${e(stats?.asOf?.slice(0,10)||'未知日期')}${stats?.stale ? ' · 快照较旧' : ''}</span></div>`;
}

export function renderStats(db, dataset, query='', role='all', sort='winRate') {
  const status = statsStatus(dataset, db.meta);
  return `<div class="page-header"><div class="eyebrow">英雄情报 / ARAM MAYHEM</div><h1>选英雄，也有依据。</h1><p>常规海克斯大乱斗 · 全体样本 · 版本 ${e(status.displayPatch)}，统计截至 ${e(date(status.asOf))}（北京时间）</p></div>
    <div class="stats-summary"><div><strong>${num(status.validMatches)}</strong><span>有效对局</span></div><div><strong>${db.champions.length}</strong><span>位英雄</span></div><div><strong>真实样本</strong><span>胜场 ÷ 出场次数</span></div><div><strong>独立展示</strong><span>胜率不等于海克斯适配分</span></div></div>
    <div class="atlas-toolbar"><label class="search-box"><input id="stats-search" aria-label="搜索英雄胜率" placeholder="搜索英雄、称号或别名…" value="${e(query)}"></label><select id="stats-sort" aria-label="胜率榜排序"><option value="winRate" ${sort==='winRate'?'selected':''}>按胜率排序</option><option value="games" ${sort==='games'?'selected':''}>按出场次数排序</option></select></div>
    <div class="filter-row stats-filters">${[['all','全部定位'],...Object.entries(roleNames)].map(([id,label])=>`<button class="filter-pill ${role===id?'active':''}" data-action="stats-role" data-value="${id}">${label}</button>`).join('')}</div>
    ${status.warnings.length ? `<div class="notice">${status.warnings.map(e).join('<br>')}</div>`:''}
    <div id="stats-results">${statsRows(db,dataset,query,role,sort)}</div>
    <div class="panel stats-source"><p>统计反映历史对局表现；阵容、熟练度与海克斯选择都会影响结果。出场占比是该英雄出场次数 ÷ 所有英雄出场次数，不是选人界面被选中的概率。</p><p>来源：AramHex Data · CC BY-NC 4.0，仅限非商业使用。软件附带快照，未接入自动更新。</p><button class="text-btn" data-action="external" data-url="https://github.com/czgreat/aramhex-data">查看数据来源 ↗</button></div>`;
}

export function statsRows(db, dataset, query='', role='all', sort='winRate') {
  const q=query.trim().toLowerCase();
  const all=rankChampions(db.champions,dataset,db.meta);
  const list=all.filter(({champion:c})=>(role==='all'||c.roles.includes(role))&&`${c.name} ${c.title} ${c.id} ${ALIASES[c.id]||''}`.toLowerCase().includes(q));
  if(sort==='games')list.sort((a,b)=>(b.stats?.games||0)-(a.stats?.games||0));
  return `<div class="stats-table-wrap"><table class="stats-table"><thead><tr><th>胜率排名</th><th>英雄</th><th>胜率</th><th>出场次数</th><th>出场占比</th><th>本局使用</th></tr></thead><tbody>${list.map(({champion:c,stats:s})=>`<tr><td class="rank-number">${s ? all.findIndex(r=>r.champion.id===c.id)+1 : '—'}</td><td><div class="stats-hero"><img src="${e(c.icon)}" alt="" loading="lazy"><div><strong>${e(c.name)}</strong><small>${c.roles.map(r=>roleNames[r]).join(' / ')}</small></div></div></td><td><strong class="${s?.winRate>=.5?'teal-text':''}">${formatWinRate(s?.winRate)}</strong>${s?.lowSample?'<small class="sample-warning">小样本</small>':''}</td><td>${s?num(s.games):'—'}</td><td>${formatWinRate(s?.pickRate)}</td><td><button class="btn small" data-action="stats-pick" data-id="${e(c.id)}">选择英雄</button></td></tr>`).join('')||'<tr><td colspan="6">没有匹配的英雄</td></tr>'}</tbody></table></div>`;
}

export function liveBanner(snapshot) {
  return `<div class="live-banner ${snapshot?.active?'enabled':''}"><div><i class="status-dot"></i><strong>${snapshot?.active?'实时识别中':'开启游戏画面识别'}</strong><span>${e(snapshot?.active?snapshot.status:'自动读取英雄与三选一候选，悬浮提示随画面更新')}</span></div><button class="btn small" data-action="page" data-page="live">${snapshot?.active?'查看状态':'设置识别'} →</button></div>`;
}

export function renderLive({snapshot:s,windows,windowId,options,platform,loading,error,selectStatus,statsPatch}) {
  const supported=platform==='win32';
  const stage = {'tracking':'跟踪三张卡的标题','search-band':'在上轮标题位置查找','search-full':'在设定范围内定位卡片'}[s.metrics?.roiMode] || '本地标题识别';
  const ocrTime = s.metrics?.cached ? '本帧已跳过' : Number.isFinite(s.metrics?.ocrMs) ? Math.round(s.metrics.ocrMs)+' ms' : '—';
  return `<div class="page-header"><div class="eyebrow">实战模式 / LIVE ASSISTANT</div><h1>把注意力留给团战。</h1><p>自动读取当前英雄与成装，本地识别三选一海克斯；建议显示在不抢焦点的悬浮窗中。</p></div>
    <div class="live-layout"><section class="panel settings-card wide"><h2>选人阶段</h2><label class="check-field"><input type="checkbox" id="champ-select-enabled" ${selectStatus?.enabled?'checked':''} ${supported?'':'disabled'}>选人时显示英雄胜率</label><p class="small-note">客户端出现「可用」英雄栏时，自动在队友和备选头像旁显示常规海克斯大乱斗 ${e(statsPatch||'')} 的英雄胜率。相同布局的普通大乱斗也会显示这份海克斯数据。</p><p id="champ-select-status" role="status">${e(supported?selectStatus?.status:'仅支持 Windows 桌面版')}</p></section>
    <section class="panel settings-card"><h2>对局内识别 <span class="badge ${s.active?'teal':''}">${s.active?'运行中':'未启动'}</span></h2>
    ${!supported?'<div class="notice">自动识别仅支持 Windows 10 / 11 桌面版。当前环境可查看界面和手动建议。</div>':''}
    <label class="field"><span>画面来源</span><select id="capture-window" aria-label="选择游戏窗口" ${s.active||loading?'disabled':''}><option value="">先进入游戏，再刷新窗口</option>${windows.map(w=>`<option value="${e(w.id)}" ${String(w.id)===String(windowId)?'selected':''}>${e(w.title)} · ${e(w.processName)} (${w.width} × ${w.height})</option>`).join('')}</select></label>
    <div class="detail-actions"><button class="btn" data-action="live-refresh" ${!supported||loading||s.active?'disabled':''}>${loading?'正在读取…':'刷新窗口'}</button><button class="btn primary" data-action="${s.active?'live-stop':'live-start'}" ${!supported||s.busy||loading||(!s.active&&!windowId)?'disabled':''}>${s.busy?'正在启动…':s.active?'停止识别':'启动实时识别'}</button></div>
    <div class="detail-actions"><button class="btn" data-action="live-toggle" ${!supported?'disabled':''}>${options.overlay?'隐藏全部浮层':'显示浮层'}</button><button class="btn" data-action="live-diagnostics" ${!supported?'disabled':''}>导出识别诊断</button></div><label class="check-field"><input type="checkbox" id="live-overlay" ${options.overlay?'checked':''} >显示候选卡片提示和右上角推荐出装</label>
    <label class="check-field"><input type="checkbox" id="live-sync" ${options.syncItems?'checked':''} ${s.active?'disabled':''}>同步游戏中的已购成装与金币</label>
    <details class="roi-settings"><summary>调整识别区域</summary><p class="small-note">相对于游戏客户区的百分比。首次定位后自动追踪标题窄条。此处可限制首次搜索范围，须保留三列标题。</p><div class="roi-fields">${[['x','左边距'],['y','上边距'],['width','宽度'],['height','高度']].map(([key,label])=>`<label class="field"><span>${label} %</span><input id="roi-${key}" aria-label="识别区域${label}" type="number" min="0" max="100" value="${options.roi[key]*100}" ${s.active?'disabled':''}></label>`).join('')}</div></details>
    <p class="small-note">启动后切回对局窗口，建议使用无边框或窗口模式。点击「停止识别」会结束对局采集；选人提示可用上方的独立开关关闭。</p>
    ${error||s.error?`<div class="notice" role="status">${e(error||s.error)}</div>`:''}</section>
    <section class="panel settings-card live-status-card"><h2>当前状态</h2><div class="live-status"><i class="status-dot"></i><strong>${e(s.status||'等待启动')}</strong></div><div class="live-metrics"><div><span>当前窗口</span><strong>${e(s.windowTitle||'尚未连接')}</strong></div><div><span>游戏数据</span><strong>${s.gameConnected?'已连接本机 Live Client':'等待进入对局；也可手动选英雄'}</strong></div><div><span>本轮候选</span><strong>${s.fresh?'已连续确认，可按快捷键记录':'等待清晰、稳定的三选一画面'}</strong></div></div>
    <div class="shortcut-grid"><kbd>Ctrl + Alt + 1 / 2 / 3</kbd><span>按从左到右的位置，在面板显示时记录要选的海克斯，再到游戏中确认</span><kbd>Ctrl + Alt + H / F8</kbd><span>一起显示或隐藏卡片提示和右上角的推荐出装</span></div><p class="small-note">快捷键只更新助手记录。候选消失时不猜测你选了哪一个，偶发漏字时短暂保留灰色结果，明确刷新后撤下旧分数。可在“已选海克斯”中修正记录。</p>
    <div class="live-performance"><span>截图 ${Number.isFinite(s.metrics?.captureMs)?Math.round(s.metrics.captureMs)+' ms':'—'}</span><span>OCR ${ocrTime}</span><span>${s.metrics?.cached?'标题区未变，复用已确认结果':e(stage)}</span></div><details><summary>识别诊断${s.errorCode?' · '+e(s.errorCode):''}</summary><pre class="ocr-text">${e(s.frameText||'等待首帧 OCR 文本；截图只在内存处理。')}</pre></details></section>
    <section class="panel settings-card wide"><h2>首次使用</h2><div class="live-steps"><div><span>01</span><strong>解压完整软件</strong><p>OCR 引擎和中文模型已随软件附带，无需安装系统语言包或申请 API Key。</p></div><div><span>02</span><strong>连接一次，切回游戏</strong><p>进入无边框游戏，选中游戏窗口并启动。英雄从本机游戏接口读取，海克斯从画面识别。</p></div><div><span>03</span><strong>根据实战做选择</strong><p>连续清晰画面确认后显示推荐，在面板仍显示时用快捷键记录，再到游戏内确认；右上角的推荐出装会随已记录的海克斯和已购成装更新。</p></div></div><p class="small-note">无需账号或 AI API Key，截图不上传。当前识别流程已完成代码与合成场景验证，Windows 游戏实机准确率及叠层兼容性仍待验收。</p></section></div>`;
}
