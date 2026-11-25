// These deliberately synthetic OCR geometry fixtures test the matcher, not
// Windows OCR accuracy or real-game capture compatibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { matchAugmentFrame, createRecognitionTracker, normalizeOcrText } from '../app/core/recognition.mjs';

const catalog = JSON.parse(await readFile(new URL('../app/data/catalog.json', import.meta.url), 'utf8'));
let captureId = 0;
const line = (text, center = 960, y = 400, width = [...text].length * 22) => ({ text, x: center - width / 2, y, width, height: 28 });
const frame = (names = ['火上浇油', '暴击律动', '神射法师'], extra = {}) => ({
  width: 1920, height: 1080, captureId: ++captureId,
  text: names.join('\n'), lines: names.map((name, i) => line(name, [500, 960, 1420][i])), ...extra,
});

test('normalizes spaces and full-width punctuation without fabricating text', () => {
  assert.equal(normalizeOcrText(' 升级： 无尽之刃！ '), '升级无尽之刃');
  const result = matchAugmentFrame(frame(['火 上 浇 油', '暴击律动！', '神射法师']), catalog);
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.candidates, ['ARAM_Firebrand', 'CriticalRhythm', 'ARAM_Marksmage']);
  assert.equal(result.tier, 'gold');
});

test('returns candidates in spatial left-to-right order, independent of OCR line ordering', () => {
  const input = frame(); input.lines.reverse();
  assert.deepEqual(matchAugmentFrame(input, catalog).candidates, ['ARAM_Firebrand', 'CriticalRhythm', 'ARAM_Marksmage']);
});

test('rejects free text, partial captures, scattered names, and mixed tiers', () => {
  assert.equal(matchAugmentFrame({ text: '火上浇油 暴击律动 神射法师' }, catalog).code, 'geometry-required');
  assert.equal(matchAugmentFrame(frame(['火上浇油', '暴击律动']), catalog).code, 'not-three');
  const scattered = frame(); scattered.lines[2].y = 700;
  assert.equal(matchAugmentFrame(scattered, catalog).status, 'uncertain');
  assert.equal(matchAugmentFrame(frame(['火上浇油', '灵巧', '神射法师']), catalog).code, 'mixed-tier');
  const sentences = frame(['推荐火上浇油非常好', '暴击律动可以用', '我觉得神射法师更好']);
  assert.notEqual(matchAugmentFrame(sentences, catalog).status, 'matched');
});

test('does not collapse punctuation-distinguished real augment names', () => {
  const result = matchAugmentFrame(frame(['罪恶快感！', '暴击律动', '神射法师']), catalog);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.code, 'ambiguous-title');
});

test('uses word geometry to split a merged title row, not arbitrary text offsets', () => {
  const words = [line('火上浇油', 500), line('暴击律动', 960), line('神射法师', 1420)];
  const input = frame([], { lines: [{ text: words.map(w => w.text).join(' '), x: 450, y: 400, width: 1100, height: 28, words }] });
  assert.equal(matchAugmentFrame(input, catalog).status, 'matched');
  assert.equal(matchAugmentFrame({ ...input, lines: input.lines.map(({ words, ...rest }) => rest) }, catalog).status, 'no-panel');
});

test('handles wrapped exact titles and rejects ambiguous fuzzy spellings', () => {
  const wrapped = frame(['面包和黄油', '暴击律动', '神射法师']);
  wrapped.lines.splice(0, 1, line('面包和', 500, 380), line('黄油', 500, 413));
  assert.equal(matchAugmentFrame(wrapped, catalog).status, 'matched');
  const custom = { augments: [
    { id: 'a', name: '火焰海克斯', tier: 'gold' }, { id: 'b', name: '冰焰海克斯', tier: 'gold' },
    { id: 'c', name: '神射法师', tier: 'gold' }, { id: 'd', name: '暴击律动', tier: 'gold' },
  ] };
  assert.equal(matchAugmentFrame(frame(['水焰海克斯', '神射法师', '暴击律动']), custom).code, 'ambiguous-title');
});

test('requires stable frames, deduplicates updates, and does not infer a choice on disappearance', () => {
  const tracker = createRecognitionTracker(catalog);
  assert.equal(tracker.ingest(frame()).status, 'stabilizing');
  const stable = tracker.ingest(frame());
  assert.equal(stable.status, 'stable');
  assert.equal(stable.observation.source, 'ocr');
  assert.equal(stable.observation.selected, undefined);
  assert.equal(stable.observation.championId, undefined);
  assert.equal(tracker.ingest(frame()).status, 'unchanged');
  assert.equal(tracker.ingest(frame([], { lines: [], text: '' })).observation, null);
  assert.equal(tracker.ingest(frame()).status, 'stabilizing');
  assert.equal(tracker.ingest(frame()).status, 'unchanged');
  tracker.reset();
  assert.equal(tracker.ingest(frame()).status, 'stabilizing');
  assert.equal(tracker.ingest(frame()).status, 'stable');
});

test('uncertain frame breaks stabilization and repeated capture IDs do not count as new evidence', () => {
  const tracker = createRecognitionTracker(catalog);
  const first = frame();
  assert.equal(tracker.ingest(first).status, 'stabilizing');
  assert.equal(tracker.ingest(first).status, 'duplicate-frame');
  assert.equal(tracker.ingest(frame(['火上浇油'])).status, 'uncertain');
  assert.equal(tracker.ingest(frame()).status, 'stabilizing');
  assert.equal(tracker.ingest(frame()).status, 'stable');
});

test('a single long typo needs three frames while short-name fuzzy matches are refused', () => {
  const tracker = createRecognitionTracker(catalog);
  const names = ['尖端发明冢', '暴击律动', '神射法师'];
  assert.equal(tracker.ingest(frame(names)).status, 'stabilizing');
  assert.equal(tracker.ingest(frame(names)).status, 'stabilizing');
  const result = tracker.ingest(frame(names));
  assert.equal(result.status, 'stable');
  assert.equal(result.observation.candidates[0], 'ARAM_ApexInventor');
  assert.ok(result.confidence < 1);
  assert.notEqual(matchAugmentFrame(frame(['易陨', '暴击律动', '神射法师']), catalog).status, 'matched');
});

test('supports explicit normalized ROI and rejects invalid coordinates', () => {
  const input = frame(); input.lines.forEach(l => { l.y = 100; });
  assert.equal(matchAugmentFrame(input, catalog).status, 'no-panel');
  assert.equal(matchAugmentFrame(input, catalog, { roi: { x: 0, y: 0, width: 1, height: .3 } }).status, 'matched');
  assert.throws(() => matchAugmentFrame(input, catalog, { roi: { x: .9, y: 0, width: .5, height: .5 } }), /归一化/);
});

test('does not select one triad from four competing titles or duplicate choices', () => {
  const input = frame([], { lines: ['火上浇油', '暴击律动', '神射法师', '循环往复'].map((name, i) => line(name, 400 + i * 360)) });
  assert.equal(matchAugmentFrame(input, catalog).code, 'multiple-rows');
  input.lines[3].text = '灵巧'; // A different tier is still a fourth title.
  assert.equal(matchAugmentFrame(input, catalog).code, 'multiple-rows');
  input.lines[3].text = '火上浇油'; // A repeated ID is also a fourth title.
  assert.equal(matchAugmentFrame(input, catalog).code, 'multiple-rows');
  assert.notEqual(matchAugmentFrame(frame(['火上浇油', '火上浇油', '神射法师']), catalog).status, 'matched');
});

test('invalid configuration cannot disable the minimum two-frame stability gate', () => {
  for (const stableFrames of ['invalid', NaN, Infinity, -1, 0, 1]) {
    const tracker = createRecognitionTracker(catalog, { stableFrames });
    assert.equal(tracker.ingest(frame()).status, 'stabilizing');
    assert.equal(tracker.ingest(frame()).status, 'stable');
  }
});

test('supplied screenshot OCR regression matches a generic one-character error without a fixed alias', async () => {
  const input = JSON.parse(await readFile(new URL('./fixtures/augment-titles.json', import.meta.url), 'utf8'));
  const options = { roi: { x: 0, y: 0, width: 1, height: 1 } };
  const matched = matchAugmentFrame(input, catalog, options);
  assert.deepEqual(matched.candidates, ['ARAM_Upgrade_IE', 'PatOnTheBack', 'Donation']);
  assert.equal(matched.code, 'one-fuzzy-title');
  const tracker = createRecognitionTracker(catalog, options);
  assert.equal(tracker.ingest({ ...input, captureId: 1 }).status, 'stabilizing');
  assert.equal(tracker.ingest({ ...input, captureId: 2 }).status, 'stabilizing');
  assert.equal(tracker.ingest({ ...input, captureId: 3 }).status, 'stable');
  const scaled = { ...input, width: 2560, height: 1440, lines: input.lines.map(l => ({ ...l,
    x: l.x * 2560 / 2189, width: l.width * 2560 / 2189, y: l.y * 1440 / 1123, height: l.height * 1440 / 1123 })) };
  assert.deepEqual(matchAugmentFrame(scaled, catalog, options).candidates, matched.candidates);
  // Another unrelated substitution is handled by the same bounded edit rule.
  input.lines[0].text = '升级: 无尽之仞';
  assert.deepEqual(matchAugmentFrame(input, catalog, options).candidates, matched.candidates);
});
