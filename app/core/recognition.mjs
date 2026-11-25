/**
 * Conservative, local OCR title matching. The caller must capture an explicitly
 * selected game window. This module never infers the chosen augment from a menu
 * disappearing, and never changes champion/selected/item state.
 *
 * Confidence values describe rule strength, not calibrated OCR probabilities.
 */

const TIERS = new Set(['silver', 'gold', 'prismatic']);
const DEFAULT_REGION = { x: .08, y: .16, width: .84, height: .66 };
const finite = n => typeof n === 'number' && Number.isFinite(n);
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const codepoints = value => [...String(value)];

export function normalizeOcrText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[\p{P}\p{Z}\p{S}\p{C}]/gu, '')
    .trim();
}

function validBox(value, width, height) {
  return value && [value.x, value.y, value.width, value.height].every(finite)
    && value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0
    && value.x + value.width <= width + 2 && value.y + value.height <= height + 2;
}

function checkedRegion(roi) {
  if (!roi) return DEFAULT_REGION;
  if (![roi.x, roi.y, roi.width, roi.height].every(finite)
    || roi.x < 0 || roi.y < 0 || roi.width <= 0 || roi.height <= 0
    || roi.x + roi.width > 1.000001 || roi.y + roi.height > 1.000001) {
    throw new TypeError('识别区域必须是位于窗口内的归一化矩形');
  }
  return roi;
}

function inRegion(line, region, width, height) {
  const x = (line.x + line.width / 2) / width;
  const y = (line.y + line.height / 2) / height;
  return x >= region.x && x <= region.x + region.width
    && y >= region.y && y <= region.y + region.height;
}

function unionBox(lines) {
  const x = Math.min(...lines.map(l => l.x));
  const y = Math.min(...lines.map(l => l.y));
  return {
    x, y, width: Math.max(...lines.map(l => l.x + l.width)) - x,
    height: Math.max(...lines.map(l => l.y + l.height)) - y,
  };
}

// Only one OCR edit is tolerated. Short names (e.g. 易损/大力) are exact-only.
function oneEditApart(left, right) {
  const a = codepoints(left), b = codepoints(right);
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + Number(i < a.length || j < b.length) === 1;
}

function catalogIndex(catalog) {
  const augments = Array.isArray(catalog) ? catalog : catalog?.augments;
  if (!Array.isArray(augments)) throw new TypeError('缺少海克斯数据库');
  const byName = new Map();
  for (const augment of augments) {
    if (!augment?.id || !TIERS.has(augment.tier)) continue;
    for (const name of [augment.name, augment.en]) {
      const normalized = normalizeOcrText(name);
      if (!normalized) continue;
      const existing = byName.get(normalized) || [];
      if (!existing.some(a => a.id === augment.id)) existing.push(augment);
      byName.set(normalized, existing);
    }
  }
  return byName;
}

function lookupTitle(text, index, allowFuzzy) {
  const key = normalizeOcrText(text);
  if (!key || key.length > 70) return null;
  if (index.has(key)) {
    const candidates = index.get(key);
    // Punctuation can distinguish different real augments. If normalization
    // collapses those names, do not pretend the OCR output can disambiguate them.
    return candidates.length === 1
      ? { augment: candidates[0], quality: 'exact', score: 1 }
      : { ambiguous: true, ids: candidates.map(a => a.id), text };
  }
  if (!allowFuzzy || codepoints(key).length < 5) return null;
  const matches = new Map();
  for (const [name, candidates] of index) {
    if (codepoints(name).length < 5 || !oneEditApart(key, name)) continue;
    for (const augment of candidates) matches.set(augment.id, augment);
  }
  if (matches.size > 1) return { ambiguous: true, ids: [...matches.keys()], text };
  if (matches.size === 1) return { augment: [...matches.values()][0], quality: 'fuzzy', score: .86 };
  return null;
}

/** Split OCR rows by large spatial word gaps, never by imagined text positions. */
function candidateLines(frame) {
  const lines = [];
  for (const line of frame.lines) {
    if (!validBox(line, frame.width, frame.height) || typeof line.text !== 'string') continue;
    lines.push({ ...line, text: line.text.trim() });
    const words = (Array.isArray(line.words) ? line.words : [])
      .filter(w => typeof w.text === 'string' && validBox(w, frame.width, frame.height))
      .sort((a, b) => a.x - b.x);
    if (words.length < 2) continue;
    const groups = [];
    let group = [];
    for (const word of words) {
      const last = group.at(-1);
      if (last && word.x - last.x - last.width > Math.max(frame.width * .025, last.height * 1.8)) {
        groups.push(group); group = [];
      }
      group.push(word);
    }
    if (group.length) groups.push(group);
    if (groups.length > 1) {
      for (const part of groups) lines.push({ text: part.map(w => w.text).join(' '), ...unionBox(part), fromWords: true });
    }
  }
  // A long title may wrap onto a second line. Only combine vertically adjacent
  // lines that share a horizontal center, and require the result to be a name.
  const merged = [];
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i];
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j];
      const [top, bottom] = a.y <= b.y ? [a, b] : [b, a];
      const verticalGap = bottom.y - top.y - top.height;
      const horizontalDrift = Math.abs(top.x + top.width / 2 - bottom.x - bottom.width / 2);
      if (verticalGap < 0 || verticalGap > Math.max(top.height, bottom.height) * .8) continue;
      if (horizontalDrift > Math.max(top.height, bottom.height) * 1.2) continue;
      merged.push({ text: top.text + bottom.text, ...unionBox([top, bottom]), wrapped: true });
    }
  }
  return [...lines, ...merged];
}

function rowGeometry(matches, width, height, region, calibrated) {
  const sorted = [...matches].sort((a, b) => a.box.x + a.box.width / 2 - b.box.x - b.box.width / 2);
  const centers = sorted.map(m => ({ x: m.box.x + m.box.width / 2, y: m.box.y + m.box.height / 2 }));
  const heights = sorted.map(m => m.box.height);
  const maxH = Math.max(...heights), minH = Math.min(...heights);
  const gap1 = centers[1].x - centers[0].x, gap2 = centers[2].x - centers[1].x;
  const expectedWidth = calibrated ? width * region.width : width;
  if (Math.min(gap1, gap2) < expectedWidth * .09) return null;
  if (centers[2].x - centers[0].x < expectedWidth * .25) return null;
  if (Math.max(gap1, gap2) / Math.min(gap1, gap2) > 1.85) return null;
  if (Math.max(...centers.map(p => p.y)) - Math.min(...centers.map(p => p.y)) > Math.max(height * .02, maxH * 1.2)) return null;
  if (maxH / minH > 2.5) return null;
  if (sorted.some((m, i) => i && sorted[i - 1].box.x + sorted[i - 1].box.width > m.box.x + minH)) return null;
  return sorted;
}

function result(status, code, reason, matches = []) {
  return { status, code, reason, candidates: [], tier: null, confidence: 0, matches };
}

function matchWithIndex(frame, index, options = {}) {
  if (!frame || !finite(frame.width) || !finite(frame.height) || frame.width < 100 || frame.height < 100
    || !Array.isArray(frame.lines) || frame.lines.length > 1500) {
    return result('uncertain', 'geometry-required', '需要带文字坐标的有效截图，纯文本不会自动覆盖候选。');
  }
  const region = checkedRegion(options.roi);
  const matches = [], ambiguous = [];
  for (const line of candidateLines(frame)) {
    if (!inRegion(line, region, frame.width, frame.height)) continue;
    if (line.height < frame.height * .008 || line.height > frame.height * .09 || line.width > frame.width * .4) continue;
    const lookup = lookupTitle(line.text, index, options.allowFuzzy !== false);
    if (!lookup) continue;
    if (lookup.ambiguous) { ambiguous.push({ text: line.text, box: unionBox([line]), ids: lookup.ids }); continue; }
    const match = {
      id: lookup.augment.id, name: lookup.augment.name, tier: lookup.augment.tier,
      text: line.text, quality: lookup.quality, confidence: lookup.score,
      box: unionBox([line]),
    };
    const duplicate = matches.find(m => m.id === match.id
      && Math.abs(m.box.x + m.box.width / 2 - match.box.x - match.box.width / 2) < frame.width * .015
      && Math.abs(m.box.y + m.box.height / 2 - match.box.y - match.box.height / 2) < frame.height * .015);
    if (duplicate) {
      if (match.quality === 'exact' && duplicate.quality !== 'exact') Object.assign(duplicate, match);
    } else matches.push(match);
  }
  if (!matches.length && !ambiguous.length) return result('no-panel', 'no-titles', '未检测到可确认的三选一面板，保留已有结果。');
  if (matches.length < 3) return result('uncertain', ambiguous.length ? 'ambiguous-title' : 'not-three', ambiguous.length ? '存在同名或近似名称，等待更清晰画面或手动校正。' : '未完整识别三个候选，保留已有结果。', matches);
  if (matches.length > 35) return result('uncertain', 'too-many-titles', '画面包含过多海克斯名称，请缩小识别区域。', matches);

  const groups = new Map();
  let mixedTierRow = false, ambiguousRow = false, competingRow = false;
  for (let i = 0; i < matches.length - 2; i++) for (let j = i + 1; j < matches.length - 1; j++) for (let k = j + 1; k < matches.length; k++) {
    const row = rowGeometry([matches[i], matches[j], matches[k]], frame.width, frame.height, region, Boolean(options.roi));
    if (!row) continue;
    if (new Set(row.map(m => m.id)).size !== 3) continue;
    if (new Set(row.map(m => m.tier)).size !== 1) { mixedTierRow = true; continue; }
    if (row.filter(m => m.quality === 'fuzzy').length > 1) continue;
    const centerY = row.reduce((sum, m) => sum + m.box.y + m.box.height / 2, 0) / 3;
    const maxHeight = Math.max(...row.map(m => m.box.height));
    // A fourth title is evidence against a three-choice panel even when it is
    // another tier or repeats an ID. Do not discard it to manufacture a triad.
    if (matches.some(m => !row.includes(m)
      && Math.abs(m.box.y + m.box.height / 2 - centerY) < maxHeight * 1.25)) {
      competingRow = true; continue;
    }
    if (ambiguous.some(m => Math.abs(m.box.y + m.box.height / 2 - centerY) < maxHeight * 1.25)) { ambiguousRow = true; continue; }
    const signature = row.map(m => m.id).join('|');
    const existing = groups.get(signature);
    if (!existing || row.filter(m => m.quality === 'exact').length > existing.filter(m => m.quality === 'exact').length) groups.set(signature, row);
  }
  if (groups.size !== 1 || competingRow) {
    if (groups.size > 1 || competingRow) return result('uncertain', 'multiple-rows', '检测到多个可能的候选组合，请缩小区域或手动校正。', matches);
    if (ambiguousRow) return result('uncertain', 'ambiguous-title', '候选行包含无法区分的相似名称，保留已有结果。', matches);
    if (mixedTierRow) return result('uncertain', 'mixed-tier', '三个名称的阶级不一致，暂不更新。', matches);
    return result('uncertain', 'layout-mismatch', '名称未形成可信的三列候选布局，保留已有结果。', matches);
  }
  const row = [...groups.values()][0];
  const fuzzy = row.some(m => m.quality === 'fuzzy');
  return {
    status: 'matched', code: fuzzy ? 'one-fuzzy-title' : 'exact-row',
    reason: fuzzy ? '识别到三列候选，其中一个名称经近似匹配，等待连续画面确认。' : '识别到三个同阶级、独立排列的候选标题。',
    candidates: row.map(m => m.id), tier: row[0].tier,
    confidence: fuzzy ? .86 : .99, matches: row,
  };
}

export function matchAugmentFrame(frame, catalog, options = {}) {
  return matchWithIndex(frame, catalogIndex(catalog), options);
}

/**
 * Stabilizes consecutive frames. An uncertain/missing frame breaks the pending
 * streak but does not erase the last emitted observation. Identical results are
 * deduplicated until reset(), even if the panel briefly disappears.
 */
export function createRecognitionTracker(catalog, options = {}) {
  const index = catalogIndex(catalog);
  const requestedFrames = Number(options.stableFrames);
  const stableFrames = finite(requestedFrames) ? clamp(Math.floor(requestedFrames), 2, 8) : 2;
  let pending = null, emittedKey = null, lastFrameId = null;
  function reset() { pending = null; emittedKey = null; lastFrameId = null; }
  function ingest(frame) {
    const matched = matchWithIndex(frame, index, options);
    const captureId = frame?.captureId ?? frame?.capturedAt ?? frame?.timestamp;
    const sourceKey = `${frame?.windowId ?? frame?.sourceId ?? ''}:${frame?.width}:${frame?.height}`;
    const frameId = captureId === undefined ? null : `${sourceKey}:${captureId}`;
    if (frameId && frameId === lastFrameId) return { ...matched, status: 'duplicate-frame', observation: null, stableCount: pending?.count || 0 };
    lastFrameId = frameId;
    if (matched.status !== 'matched') {
      pending = null;
      return { ...matched, observation: null, stableCount: 0 };
    }
    const key = `${sourceKey}:${matched.tier}:${matched.candidates.join('|')}`;
    const positionStable = pending && pending.matches.every((m, i) =>
      Math.abs(m.box.x - matched.matches[i].box.x) <= frame.width * .035
      && Math.abs(m.box.y - matched.matches[i].box.y) <= frame.height * .035);
    pending = pending?.key === key && positionStable
      ? { ...pending, count: pending.count + 1, matches: matched.matches, fuzzy: pending.fuzzy || matched.matches.some(m => m.quality === 'fuzzy') }
      : { key, count: 1, matches: matched.matches, fuzzy: matched.matches.some(m => m.quality === 'fuzzy') };
    const requiredFrames = Math.max(stableFrames, pending.fuzzy ? 3 : 2);
    if (pending.count < requiredFrames) return { ...matched, status: 'stabilizing', observation: null, stableCount: pending.count, requiredFrames };
    if (key === emittedKey) return { ...matched, status: 'unchanged', observation: null, stableCount: pending.count, requiredFrames };
    emittedKey = key;
    return {
      ...matched, status: 'stable', stableCount: pending.count, requiredFrames,
      observation: {
        schema: 1, source: 'ocr', confirmed: true, autoDetected: true,
        candidates: [...matched.candidates], tier: matched.tier,
        confidence: matched.confidence,
      },
    };
  }
  return { ingest, reset };
}
