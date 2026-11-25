import { ALIASES } from './profiles.mjs';

const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\p{S}\p{C}]/gu, '');
const text = (value, max = 4000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const todayInChina = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dateOnly = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : null;
const patchKey = value => {
  const match = text(value, 80).match(/^v?(\d{1,4})\.(\d{1,3})(?:\.\d{1,4})?$/i);
  return match ? `${Number(match[1])}.${Number(match[2])}` : null;
};
const limited = (value, fallback, length) => {
  const count = Number(value);
  return Number.isFinite(count) ? Math.min(length, Math.max(0, Math.floor(count))) : Math.min(length, fallback);
};

function safeSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    const host = url.hostname.toLowerCase();
    if (!host.includes('.') || host.endsWith('.') || /[:\[\]]/.test(host) || /^\d+(?:\.\d+){3}$/.test(host)
      || /(^|\.)(localhost|local|internal|home|lan)$/.test(host)) return null;
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|spm$|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}

function catalogMap(db, map, array) {
  if (db?.[map] instanceof Map) return db[map];
  if (Array.isArray(db?.[array])) return new Map(db[array].map(entry => [entry.id, entry]));
  throw new TypeError('攻略索引需要完整的英雄、海克斯与装备数据库');
}

function versionFor(value, currentPatch, aliases) {
  const guidePatch = value === null || value === undefined || value === '' ? null : text(value, 80);
  const normalized = patchKey(guidePatch), current = patchKey(currentPatch);
  if (!guidePatch) return { status: 'unspecified', label: '未注明版本，仅供阅读参考', guidePatch: null, currentPatch };
  if (!normalized || !current) return { status: 'unknown', label: `版本 ${guidePatch} 尚未与资料库 ${currentPatch || '未知版本'} 核对`, guidePatch, currentPatch };
  if (aliases.has(normalized)) return { status: 'current', label: `与资料库 ${currentPatch} 一致`, guidePatch, currentPatch };
  const [major, minor] = normalized.split('.').map(Number);
  const peers = [...aliases].map(key => key.split('.').map(Number));
  const sameSeries = peers.find(([m]) => m === major);
  const older = sameSeries ? minor < sameSeries[1] : major < Math.min(...peers.map(([m]) => m));
  return older
    ? { status: 'outdated', label: `旧版 ${guidePatch} · 资料库 ${currentPatch}，不用于本局决策`, guidePatch, currentPatch }
    : { status: 'unknown', label: `版本 ${guidePatch} 与资料库 ${currentPatch} 不一致，尚未核对`, guidePatch, currentPatch };
}

/** Build a local, read-only guide index. Invalid IDs reject the whole entry;
 * dropping an unknown prerequisite would incorrectly broaden its conditions.
 * References never modify recommendation scores or observed win rates. */
export function indexGuides(dataset, db, { currentPatch = db?.meta?.patch ?? null, today = todayInChina() } = {}) {
  if (!Array.isArray(dataset)) throw new TypeError('攻略数据必须是条目数组');
  const champions = catalogMap(db, 'championMap', 'champions');
  const augments = catalogMap(db, 'augmentMap', 'augments');
  const items = catalogMap(db, 'itemMap', 'items');
  const current = patchKey(currentPatch);
  const catalogAliases = [db?.meta?.patch, db?.meta?.displayPatch, db?.meta?.dataDragonVersion].map(patchKey).filter(Boolean);
  // Only explicit labels from this catalog are aliases. Do not invent a +10
  // patch conversion or keep old catalog aliases after a currentPatch override.
  const aliases = new Set([current, ...(catalogAliases.includes(current) ? catalogAliases : [])].filter(Boolean));
  const checkedToday = dateOnly(today) || todayInChina();
  const entries = [], issues = [], seenIds = new Set(), seenContent = new Set(), searchText = new Map();
  const byChampion = new Map(), byAugment = new Map(), byItem = new Map();
  const issue = (index, id, code, message) => issues.push({ index, id: text(id, 160), code, message });
  const ids = (value, map) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 2000 || value.some(id => typeof id !== 'string' || !map.has(id))) return null;
    return [...new Set(value)];
  };
  const addTo = (index, ids, entry) => { for (const id of ids) { if (!index.has(id)) index.set(id, []); index.get(id).push(entry); } };
  for (const [position, raw] of dataset.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { issue(position, '', 'invalid-entry', '攻略条目必须是对象'); continue; }
    const id = text(raw.id, 161), title = text(raw.title, 180), sourceTitle = text(raw.sourceTitle, 180);
    if (!id || id.length > 160 || /[\p{C}]/u.test(id) || !title || !sourceTitle || !['community', 'editorial'].includes(raw.kind)) {
      issue(position, id, 'invalid-entry', '缺少有效 ID、标题、来源或条目类型'); continue;
    }
    const championIds = ids(raw.championIds, champions), augmentIds = ids(raw.augmentIds, augments), itemIds = ids(raw.itemIds, items);
    if (!championIds || !augmentIds || !itemIds) { issue(position, id, 'invalid-id', '条目包含未知或无效关联 ID，整条不参与索引'); continue; }
    const summary = text(raw.summary);
    if (!augmentIds.length || !summary) { issue(position, id, 'missing-content', '攻略需要关联海克斯与非空摘要'); continue; }
    const sourceUrl = safeSourceUrl(raw.sourceUrl), checkedAt = dateOnly(raw.checkedAt);
    if (!sourceUrl) { issue(position, id, 'invalid-link', '来源需要公开网站的 HTTPS 地址'); continue; }
    if (!checkedAt || (raw.patch !== null && raw.patch !== undefined && typeof raw.patch !== 'string')) {
      issue(position, id, 'invalid-metadata', '核对日期或版本格式无效'); continue;
    }
    if (seenIds.has(id)) { issue(position, id, 'duplicate-id', '重复 ID，保留首个有效条目'); continue; }
    const relation = text(raw.relation, 80) || 'all-required', stance = text(raw.stance, 80) || 'unspecified';
    const contentType = text(raw.contentType, 80) || (raw.kind === 'editorial' ? 'note' : 'index');
    const version = versionFor(raw.patch, currentPatch, aliases);
    const futureCheck = checkedAt > checkedToday;
    const referenceOnly = raw.kind !== 'editorial' || ['index', 'entertainment'].includes(contentType)
      || relation === 'mentioned-together' || ['caution', 'reference', 'entertainment', 'fun'].includes(stance);
    const warnings = [version.status !== 'current' ? version.label : '', futureCheck ? '核对日期晚于今天，尚未验证' : '',
      relation === 'mentioned-together' ? '来源将这些海克斯一同提及，不代表组合已经验证' : '',
      stance === 'caution' ? '此条为注意事项，不是推荐采用该组合' : '',
      stance === 'entertainment' || contentType === 'entertainment' ? '娱乐思路，不作为已验证的组合建议' : ''].filter(Boolean);
    const entry = {
      id, title, championIds, augmentIds, itemIds, summary, sourceTitle, sourceUrl,
      patch: raw.patch === undefined || raw.patch === null ? null : text(raw.patch, 80), checkedAt, kind: raw.kind, relation, stance,
      tags: Array.isArray(raw.tags) ? [...new Set(raw.tags.filter(tag => typeof tag === 'string').map(tag => text(tag, 80)).filter(Boolean))].slice(0, 50) : [],
      author: text(raw.author, 160), license: text(raw.license, 200), attribution: text(raw.attribution, 500), note: text(raw.note || raw.caution, 1000),
      sourceCredit: text(raw.sourceCredit, 1000), publishedAt: dateOnly(raw.publishedAt), contentType,
      evidenceLocator: text(raw.evidenceLocator, 1200), mode: text(raw.mode, 40) || null,
      version, warnings, decisionEligible: version.status === 'current' && !futureCheck && !referenceOnly,
    };
    // Same article may legitimately contain different heroes or sections. Do
    // not merge their associations into an invented combined prerequisite set.
    const contentKey = JSON.stringify([sourceUrl, normalize(title), normalize(entry.summary), [...championIds].sort(), [...augmentIds].sort(),
      [...itemIds].sort(), entry.patch, entry.kind, relation, stance, contentType]);
    if (seenContent.has(contentKey)) { issue(position, id, 'duplicate-content', '重复内容与适用条件，保留首个有效条目'); continue; }
    seenIds.add(id); seenContent.add(contentKey); entries.push(entry);
    const heroTerms = championIds.flatMap(heroId => { const hero = champions.get(heroId); return [heroId, hero.name, hero.title, ALIASES[heroId] || '', ...(Array.isArray(hero.aliases) ? hero.aliases : [])]; });
    const augmentTerms = augmentIds.flatMap(augmentId => { const augment = augments.get(augmentId); return [augmentId, augment.name, augment.en]; });
    const itemTerms = itemIds.flatMap(itemId => { const item = items.get(itemId); return [itemId, item.name, item.en]; });
    searchText.set(id, normalize([title, entry.summary, sourceTitle, entry.author, entry.note, ...entry.tags, ...heroTerms, ...augmentTerms, ...itemTerms].join(' ')));
    addTo(byChampion, championIds, entry); addTo(byAugment, augmentIds, entry); addTo(byItem, itemIds, entry);
    if (futureCheck) issue(position, id, 'future-check-date', '未来核对日期只能作为待核对参考');
  }
  return { entries, issues, currentPatch, today: checkedToday, byChampion, byAugment, byItem, searchText, champions, augments, items };
}

/** Search also includes old/unspecified versions, always with visible labels. */
export function searchGuides(index, query = '', { championId = null, limit = 100 } = {}) {
  if (championId && !index.champions.has(championId)) return [];
  const terms = String(query ?? '').trim().split(/[\s,，;；/|]+/u).map(normalize).filter(Boolean);
  return index.entries.filter(entry => (!championId || !entry.championIds.length || entry.championIds.includes(championId))
    && terms.every(term => index.searchText.get(entry.id)?.includes(term)))
    .sort((a, b) => Number(Boolean(championId && b.championIds.includes(championId))) - Number(Boolean(championId && a.championIds.includes(championId)))
      || Number(terms.length > 0 && terms.every(term => normalize(b.title).includes(term))) - Number(terms.length > 0 && terms.every(term => normalize(a.title).includes(term)))
      || Number(b.kind === 'editorial') - Number(a.kind === 'editorial')
      || Number(b.version.status === 'current') - Number(a.version.status === 'current')
      || b.checkedAt.localeCompare(a.checkedAt) || a.id.localeCompare(b.id))
    .slice(0, limited(limit, 100, index.entries.length));
}

/** Match one explicit hypothesis at a time. state.candidates is intentionally
 * never read: three offered alternatives cannot jointly satisfy a combo. */
export function matchGuides(index, state, { candidateId = null, limit = 6, includeReferences = false } = {}) {
  const championId = state?.championId;
  if (!index.champions.has(championId)) return [];
  const selected = new Set((Array.isArray(state.selected) ? state.selected : []).filter(id => index.augments.has(id)));
  if (candidateId !== null && (!index.augments.has(candidateId) || selected.has(candidateId))) return [];
  if (!selected.size && candidateId === null) return [];
  const available = new Set([...selected, ...(candidateId ? [candidateId] : [])]);
  const matches = [];
  for (const entry of candidateId ? index.byAugment.get(candidateId) || [] : index.entries) {
    if (!['current', 'unspecified'].includes(entry.version.status) || entry.checkedAt > index.today
      || (entry.championIds.length && !entry.championIds.includes(championId))) continue;
    if (candidateId && !entry.augmentIds.includes(candidateId)) continue;
    const matchedIds = entry.augmentIds.filter(id => available.has(id));
    if (!matchedIds.length) continue;
    // Public co-mentions are associations, not a claim of a working combo.
    // Editorial multi-condition notes always retain their all-of requirements.
    const association = entry.kind === 'community' && entry.relation === 'mentioned-together';
    const complete = matchedIds.length === entry.augmentIds.length;
    if (!association && !complete) continue;
    const applicable = entry.decisionEligible && complete && !association;
    if (!applicable && includeReferences !== true) continue;
    const scope = entry.championIds.length ? 'champion' : 'general';
    matches.push({ ...entry, decisionEligible: applicable,
      match: {
        type: applicable ? 'applicable' : 'related', label: applicable ? '当前条件已匹配' : '关联资料（不是组合结论）',
        scope, championId, candidateId, mode: candidateId ? 'candidate' : 'selected',
        augmentIds: matchedIds, requiredAugmentIds: association ? [] : [...entry.augmentIds], itemIds: [...entry.itemIds],
        specificity: (scope === 'champion' ? 100 : 0) + (applicable ? 20 : 0) + matchedIds.length,
      },
    });
  }
  return matches.sort((a, b) => Number(b.match.scope === 'champion') - Number(a.match.scope === 'champion')
    || Number(b.decisionEligible) - Number(a.decisionEligible) || Number(b.kind === 'editorial') - Number(a.kind === 'editorial')
    || b.match.augmentIds.length - a.match.augmentIds.length
    || b.checkedAt.localeCompare(a.checkedAt) || a.id.localeCompare(b.id))
    .slice(0, limited(limit, 6, matches.length));
}

/** One fully matched combination the reader can open. A community reference
 * can supply an article, but never contributes numerical points. */
export function comboReading(index, state, candidateId) {
  if (!index || !state.selected.length) return null;
  const limit = index.byAugment.get(candidateId)?.length || 0;
  if (!limit) return null;
  const found = matchGuides(index, state, { candidateId, limit, includeReferences: true }).find(entry =>
    entry.augmentIds.length > 1 && entry.match.augmentIds.length === entry.augmentIds.length
    && !['caution', 'fun', 'entertainment'].includes(entry.stance) && entry.contentType !== 'entertainment');
  if (!found) return null;
  return { title: found.title, sourceUrl: found.sourceUrl,
    partners: found.augmentIds.filter(id => id !== candidateId).map(id => index.augments.get(id).name) };
}
