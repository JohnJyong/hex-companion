import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { comboReading, indexGuides, searchGuides, matchGuides } from '../app/core/guides.mjs';
import { indexCatalog, rankCandidates } from '../app/core/engine.mjs';
import { emptySession } from '../app/core/session.mjs';

const catalog = JSON.parse(await readFile(new URL('../app/data/catalog.json', import.meta.url), 'utf8'));
const db = indexCatalog(catalog);
const A = 'ARAM_Firebrand', B = 'ARAM_Vulnerability', C = 'ARAM_Recursion';
const options = { today: '2026-11-18', currentPatch: '26.22' };
const guide = (id, extra = {}) => ({
  id, title: `攻略 ${id}`, championIds: ['Brand'], augmentIds: [A], itemIds: ['6653'],
  summary: '说明持续伤害与海克斯机制，并介绍出装顺序。', sourceTitle: '测试攻略来源',
  sourceUrl: `https://example.com/guides/${id}`, patch: '26.22', checkedAt: '2026-11-18', kind: 'editorial', ...extra,
});
const session = (selected = [A], extra = {}) => ({ ...emptySession(), championId: 'Brand', selected, ...extra });
const index = entries => indexGuides(entries, db, options);

test('a card links a fully matched multi-augment source without counting loose mentions or modifying its score', () => {
  const conditions = {augmentIds:[A,B,C],relation:'mentioned-together',kind:'community',patch:null};
  const guides = index([guide('reference',conditions),guide('old',{augmentIds:[A,B],patch:'26.20'}),
    guide('warning',{augmentIds:[A,B],stance:'caution'}),guide('fun',{augmentIds:[A,B],stance:'entertainment'})]);
  assert.equal(comboReading(guides, session([A],{candidates:[C,B,null]}), B), null);
  assert.equal(comboReading(guides, session([A,C],{championId:'Yasuo'}), B), null);
  const state = session([A,C],{candidates:[B,null,null]});
  const card = rankCandidates(state, {...db,guideIndex:guides})[0];
  assert.deepEqual(card.guide.partners, ['火上浇油','循环往复']);
  assert.equal(card.guide.sourceUrl, 'https://example.com/guides/reference');
  assert.equal(card.decisionScore, rankCandidates(state, db)[0].decisionScore);
});

test('indexes valid associations without mutating the source and deduplicates IDs and equivalent content', () => {
  const first = guide('original', { championIds: ['Brand', 'Brand'], augmentIds: [A, A], sourceUrl: 'https://example.com/article?utm_source=test#build' });
  const input = [first, { ...first, id: 'copy', championIds: ['Brand'], augmentIds: [A], sourceUrl: 'https://example.com/article#build' },
    guide('original', { title: '相同 ID 的另一内容' })];
  const before = structuredClone(input), result = index(input);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0].augmentIds, [A]);
  assert.equal(result.entries[0].sourceUrl, 'https://example.com/article#build');
  assert.deepEqual(result.issues.map(issue => issue.code), ['duplicate-content', 'duplicate-id']);
  assert.deepEqual(result.byChampion.get('Brand').map(entry => entry.id), ['original']);
  assert.deepEqual(result.byAugment.get(A).map(entry => entry.id), ['original']);
  assert.deepEqual(result.byItem.get('6653').map(entry => entry.id), ['original']);
  assert.deepEqual(input, before);
});

test('unknown IDs reject the entire entry instead of silently broadening its prerequisites', () => {
  const result = index([
    guide('bad-hero', { championIds: ['Brand', 'FutureHero'] }),
    guide('bad-augment', { augmentIds: [A, 'unrecognized'] }),
    guide('bad-item', { itemIds: ['6653', 3031] }),
    guide('malformed', { championIds: 'Brand' }), guide('valid'),
  ]);
  assert.deepEqual(result.entries.map(entry => entry.id), ['valid']);
  assert.equal(result.issues.filter(issue => issue.code === 'invalid-id').length, 4);
});

test('rejects executable, credentialed, local and malformed links while retaining normal HTTPS source paths', () => {
  const invalid = ['javascript:alert(1)', 'data:text/html,bad', 'http://example.com/a', '//example.com/a',
    'https://user:secret@example.com/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://2130706433/a',
    'https://localhost/a', 'https://example.local/a', 'https://example.com:2999/a', 'https://example.com/\nattack'];
  const result = index([...invalid.map((sourceUrl, i) => guide(`bad-${i}`, { sourceUrl })),
    guide('video', { sourceUrl: 'https://www.bilibili.com/video/BV1abc?p=2&spm=tracking' })]);
  assert.deepEqual(result.entries.map(entry => entry.id), ['video']);
  assert.equal(result.entries[0].sourceUrl, 'https://www.bilibili.com/video/BV1abc?p=2');
});

test('search joins hero aliases, augment names, item names and text, with AND terms and unrestricted pagination limits', () => {
  const result = index([guide('burn'), guide('yasuo', { championIds: ['Yasuo'], augmentIds: [C], itemIds: ['3031'] }),
    guide('other', { championIds: ['Ashe'], summary: '优先保证站位' })]);
  assert.deepEqual(searchGuides(result, '火男').map(entry => entry.id), ['burn']);
  assert.deepEqual(searchGuides(result, '布兰德 火上浇油 兰德里的折磨').map(entry => entry.id), ['burn']);
  assert.deepEqual(searchGuides(result, '快乐风男 无尽之刃').map(entry => entry.id), ['yasuo']);
  assert.deepEqual(searchGuides(result, '站位').map(entry => entry.id), ['other']);
  assert.deepEqual(searchGuides(result, '火男 无尽之刃'), []);
  const many = index(Array.from({ length: 130 }, (_, i) => guide(`row-${i}`)));
  assert.equal(searchGuides(many, '', { limit: many.entries.length }).length, 130);
  assert.equal(searchGuides(many, '', { limit: 0 }).length, 0);
  assert.deepEqual(searchGuides(result, '', { championId: 'invalid' }), []);
});

test('explicit catalog aliases share a current patch, while old and unlabelled versions remain clearly marked', () => {
  const result = index([
    guide('current'), guide('internal-version', { patch: '16.22.1' }),
    guide('old', { patch: '26.21' }), guide('internal-old', { patch: '16.21' }),
    guide('unspecified', { patch: null }), guide('unknown', { patch: '春季特别版' }), guide('future', { patch: '26.23' }),
  ]);
  const status = id => result.entries.find(entry => entry.id === id).version.status;
  assert.equal(status('current'), 'current'); assert.equal(status('internal-version'), 'current');
  assert.equal(status('old'), 'outdated'); assert.equal(status('internal-old'), 'outdated');
  assert.equal(status('unspecified'), 'unspecified'); assert.equal(status('unknown'), 'unknown'); assert.equal(status('future'), 'unknown');
  assert.equal(result.entries.find(entry => entry.id === 'current').version.label, '与资料库 26.22 一致');
  assert.ok(result.entries.find(entry => entry.id === 'old').version.label.includes('不用于本局决策'));
  assert.equal(searchGuides(result).length, 7);
  assert.deepEqual(new Set(matchGuides(result, session()).map(entry => entry.id)), new Set(['current', 'internal-version']));
  const override = indexGuides([guide('previous'), guide('old-alias', { patch: '16.22' })], db, { ...options, currentPatch: '26.23' });
  assert.ok(override.entries.every(entry => !entry.decisionEligible));
});

test('invalid calendar dates are rejected and future checks do not imply verification', () => {
  const result = index([guide('bad-date', { checkedAt: '2026-02-30' }), guide('future-check', { checkedAt: '2026-11-19' })]);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].decisionEligible, false);
  assert.match(result.entries[0].warnings.join(' '), /晚于今天/);
  assert.deepEqual(matchGuides(result, session()), []);
  assert.deepEqual(matchGuides(result, session(), { includeReferences: true }), []);
});

test('all editorial prerequisites must match one selected-plus-candidate hypothesis, never the offered trio union', () => {
  const result = index([guide('a'), guide('ab', { augmentIds: [A, B] }), guide('abc', { augmentIds: [A, B, C] })]);
  const current = session([A], { candidates: [B, C, 'ARAM_Marksmage'] });
  assert.deepEqual(matchGuides(result, current).map(entry => entry.id), ['a']);
  assert.deepEqual(matchGuides(result, current, { candidateId: B }).map(entry => entry.id), ['ab']);
  assert.deepEqual(matchGuides(result, current, { candidateId: C }), []);
  assert.deepEqual(matchGuides(result, session([A, B]), { candidateId: C }).map(entry => entry.id), ['abc']);
  assert.deepEqual(matchGuides(result, current, { candidateId: A }), []);
  assert.deepEqual(matchGuides(result, current, { candidateId: 'unknown' }), []);
  assert.equal(matchGuides(result, current, { candidateId: B })[0].match.mode, 'candidate');
});

test('item associations describe the guide build and do not require owning those items', () => {
  const result = index([guide('suggested-items', { itemIds: ['6653', '3116', '3135'] })]);
  assert.deepEqual(matchGuides(result, session([A], { owned: [] }))[0].match.itemIds, ['6653', '3116', '3135']);
});

test('hero applicability is mandatory, general guides remain available, and exact combinations sort first', () => {
  const result = index([
    guide('general', { championIds: [], augmentIds: [A, B] }), guide('hero-single'),
    guide('hero-combo', { augmentIds: [A, B] }), guide('wrong-hero', { championIds: ['Yasuo'], augmentIds: [A, B] }),
  ]);
  assert.deepEqual(matchGuides(result, session([A, B])).map(entry => entry.id), ['hero-combo', 'hero-single', 'general']);
  assert.equal(matchGuides(result, session([A, B]))[2].match.scope, 'general');
  assert.deepEqual(matchGuides(result, session([A], { championId: 'Unknown' })), []);
});

test('missing associations or summaries are rejected; no selection means no live guide suggestion', () => {
  const result = index([guide('introduction', { augmentIds: [] }), guide('missing-summary', { summary: '  ' }), guide('conditional')]);
  assert.deepEqual(matchGuides(result, session([]), { includeReferences: true }), []);
  assert.deepEqual(matchGuides(result, session([A])).map(entry => entry.id), ['conditional']);
  assert.equal(searchGuides(result).length, 1);
  assert.equal(result.issues.filter(issue => issue.code === 'missing-content').length, 2);
});

test('community co-mentions are opt-in related reading; one association is enough and never asserts a combo', () => {
  const result = index([guide('co-mentioned', { kind: 'community', patch: null, relation: 'mentioned-together', stance: 'caution', augmentIds: [A, B, C] })]);
  assert.deepEqual(matchGuides(result, session([A])), []);
  const [related] = matchGuides(result, session([A]), { includeReferences: true });
  assert.equal(related.match.type, 'related');
  assert.equal(related.decisionEligible, false);
  assert.deepEqual(related.match.augmentIds, [A]);
  assert.deepEqual(related.match.requiredAugmentIds, []);
  assert.match(related.match.label, /不是组合结论/);
  assert.match(related.warnings.join(' '), /不代表组合已经验证/);
  assert.equal(related.version.status, 'unspecified');
  const hypothesis = matchGuides(result, session([]), { candidateId: B, includeReferences: true });
  assert.equal(hypothesis.length, 1);
  assert.equal(hypothesis[0].match.candidateId, B);
  assert.deepEqual(matchGuides(result, session([A]), { candidateId: 'ARAM_Marksmage', includeReferences: true }), []);
});

test('reference opt-in never bypasses editorial all-of conditions or reactivates an outdated guide', () => {
  const result = index([
    guide('editorial-reference', { patch: null, relation: 'mentioned-together', augmentIds: [A, B] }),
    guide('outdated-reference', { kind: 'community', patch: '26.21', relation: 'mentioned-together', augmentIds: [A, B] }),
    guide('unknown-reference', { kind: 'community', patch: null, stance: 'reference' }),
    guide('future-reference', { kind: 'community', patch: '26.23', stance: 'reference' }),
    guide('unclear-reference', { kind: 'community', patch: '作者未注明', stance: 'reference' }),
  ]);
  assert.deepEqual(matchGuides(result, session([A]), { includeReferences: true }).map(entry => entry.id), ['unknown-reference']);
  const fullyMatched = matchGuides(result, session([A, B]), { includeReferences: true });
  assert.ok(fullyMatched.some(entry => entry.id === 'editorial-reference' && entry.match.type === 'related'));
  assert.ok(!fullyMatched.some(entry => entry.id === 'outdated-reference'));
  assert.ok(searchGuides(result).some(entry => entry.id === 'outdated-reference'));
});

test('editorial notes precede same-context indexes even when the index names the catalog patch', () => {
  const result = index([guide('index', { kind: 'community', contentType: 'index' }), guide('note', { patch: null })]);
  assert.deepEqual(searchGuides(result).map(entry => entry.id), ['note', 'index']);
  assert.deepEqual(matchGuides(result, session(), { includeReferences: true }).map(entry => entry.id), ['note', 'index']);
  assert.equal(result.entries.find(entry => entry.id === 'index').decisionEligible, false);
});

test('entertainment and index labels never become strict advice and retained credits remain readable', () => {
  const result = index([
    guide('entertainment', { stance: 'entertainment' }), guide('index', { contentType: 'index' }),
    guide('note', { caution: '作者提醒先考虑触发条件', sourceCredit: '原作者与视频来源', publishedAt: '2026-10-26' }),
  ]);
  assert.deepEqual(matchGuides(result, session()).map(entry => entry.id), ['note']);
  const note = result.entries.find(entry => entry.id === 'note');
  assert.equal(note.note, '作者提醒先考虑触发条件');
  assert.equal(note.sourceCredit, '原作者与视频来源');
  assert.equal(note.publishedAt, '2026-10-26');
});

test('guide matching and searching leave session state and recommendation scores unchanged', () => {
  const current = session([A], { candidates: [B, C, 'ARAM_Marksmage'] });
  const before = structuredClone(current), scores = rankCandidates(current, db).map(row => [row.augment.id, row.score]);
  const result = index([guide('related-build', { augmentIds: [A, B] })]);
  matchGuides(result, current, { candidateId: B, includeReferences: true }); searchGuides(result, '火男');
  assert.deepEqual(current, before);
  assert.deepEqual(rankCandidates(current, db).map(row => [row.augment.id, row.score]), scores);
});
