// Integration fixtures use synthetic OCR boxes and the real catalog/engine.
// They verify state coordination, not Windows OCR accuracy or in-game capture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLiveController } from '../app/core/live-controller.mjs';
import { indexCatalog, recommendBuilds, rankCandidates } from '../app/core/engine.mjs';
import { emptySession, validateSession } from '../app/core/session.mjs';
import { indexGuides } from '../app/core/guides.mjs';

const db = indexCatalog(JSON.parse(await readFile(new URL('../app/data/catalog.json', import.meta.url), 'utf8')));
const names = ['火上浇油', '暴击律动', '神射法师'];
const ids = ['ARAM_Firebrand', 'CriticalRhythm', 'ARAM_Marksmage'];
let captureSequence = 0;
function frame(titles = names, y = 400) {
  return {
    captureId: ++captureSequence, windowId: '42', width: 1920, height: 1080, text: titles.join('\n'),
    fingerprint: 'panel-a', bounds: { x: 320, y: 80, width: 1920, height: 1080 },
    lines: titles.map((text, i) => ({ text, x: 440 + i * 460, y, width: 120, height: 28 })),
  };
}
function game(championId = 'Ashe', { gameTime = 300, items = ['3006'], gold = 1700 } = {}) {
  return {
    activePlayer: { riotId: 'Active#CN', currentGold: gold },
    allPlayers: [
      { riotId: 'Other#CN', rawChampionName: 'game_character_displayname_Garen', items: [] },
      { riotId: 'Active#CN', rawChampionName: `game_character_displayname_${championId}`, items: items.map(itemID => ({ itemID })) },
    ],
    gameData: { gameMode: 'KIWI', gameTime },
  };
}

function harness(initial = {}, overrides = {}, runtimeDb = db) {
  let state = validateSession({ ...emptySession(), championId: 'Ashe', ...initial }, db);
  let time = 100000;
  const captureListeners = new Set(), recordListeners = new Set();
  const overlays = [], commits = [], toasts = [], changes = [], starts = [];
  const desktop = {
    onCapture(callback) { captureListeners.add(callback); return () => captureListeners.delete(callback); },
    onRecord(callback) { recordListeners.add(callback); return () => recordListeners.delete(callback); },
    async captureStart(options) { starts.push(options); return { window: { id: '42', title: 'League of Legends', isGame: true }, failedShortcuts: [] }; },
    async captureStop() {},
    async updateOverlay(payload) { overlays.push(structuredClone(payload)); },
    ...overrides,
  };
  const controller = createLiveController({ desktop, db: runtimeDb, now: () => time, getState: () => state,
    commit(next) { state = validateSession(next, db); commits.push(structuredClone(state)); },
    onChange(next) { changes.push(next); }, toast(text) { toasts.push(text); },
  });
  return {
    controller, desktop, overlays, commits, toasts, changes, starts, captureListeners, recordListeners,
    get state() { return state; },
    setState(next) { state = validateSession(next, db); },
    advance(ms) { time += ms; },
    emit(event) { for (const callback of captureListeners) callback({ timestamp: time, ...event }); },
    shot(titles = names, liveGame = null, y = 400) { this.emit({ frame: frame(titles, y), game: liveGame }); },
    record(slot) { for (const callback of recordListeners) callback(slot); },
  };
}

test('a recorded first-round pick changes the next leader and exposes the same mechanic as the offline guide', async t => {
  const readData = async name => JSON.parse(await readFile(new URL('../app/data/' + name + '.json', import.meta.url)));
  const [augmentStats, itemStats, notes] = await Promise.all(['augment-stats','item-stats','editorial-guides'].map(readData));
  const runtimeDb = {...db, meta:{...db.meta, now:'2026-11-18T00:00:00+08:00'}, augmentStats, itemStats};
  runtimeDb.guideIndex = indexGuides(notes, runtimeDb, {today:'2026-11-18'});
  const h = harness({demo:true}, {}, runtimeDb);
  t.after(() => h.controller.stop());
  await h.controller.start({windowId:'42'});
  assert.equal(h.overlays.at(-1).build, null);
  h.emit({type:'game', game:game('Ashe', {items:[]})});
  assert.ok(h.overlays.at(-1).build.purchases[0], 'equipment appears before the first OCR result');
  const row = ['易损', '升级：无尽之刃', '捐赠'];
  h.shot(row); h.shot(row);
  const before = h.overlays.at(-1).cards;
  assert.equal(before.find(card => card.best).name, '升级：无尽之刃');
  h.emit({type:'panel-gone'});
  assert.deepEqual(h.state.selected, [], 'closing a panel cannot identify a pick');
  h.shot(); h.shot(); h.record(0);
  assert.deepEqual(h.overlays.at(-1).build.selected, ['火上浇油']);
  h.shot(row);
  assert.ok(h.overlays.at(-1).cards.every(card => !card.best && !card.interaction));
  h.shot(row);
  const after = h.overlays.at(-1).cards;
  assert.equal(after.find(card => card.best).name, '易损');
  assert.match(after[0].interaction, /火上浇油.*灼烧可以暴击/);
  assert.match(after[0].guide, /火上浇油/);
  assert.equal(after[0].statistics.winRate, before[0].statistics.winRate);
  assert.deepEqual(h.state.selected, ['ARAM_Firebrand']);
});

test('live equipment follows the committed Yasuo build between rounds, across purchases and after restarting', async t => {
  const h = harness({demo:true});
  t.after(() => h.controller.stop());
  await h.controller.start({windowId:'42'});
  const update = items => h.emit({type:'game', game:game('Yasuo', {items})});
  update([]);
  const initial = h.overlays.at(-1).build;
  const row = ['升级：无尽之刃', '轻拍背部', '捐赠'];
  h.shot(row); h.shot(row);
  assert.deepEqual(h.overlays.at(-1).build, initial, 'a candidate is not a purchase commitment');
  h.record(0);
  h.emit({type:'panel-gone'});
  assert.deepEqual(h.overlays.at(-1).cards, []);
  assert.equal(h.overlays.at(-1).build.purchases[0].id, '3031');
  assert.equal(h.overlays.at(-1).build.reason, row[0]);
  update(['3031']);
  assert.ok(h.overlays.at(-1).build.purchases.every(item => item.id !== '3031'));
  const partial = game('Yasuo'); delete partial.allPlayers[1].items;
  h.emit({type:'game', game:partial});
  assert.deepEqual(h.state.owned, ['3031'], 'a missing inventory cannot undo an observed purchase');
  update(['3031','3006','3072','3046','6333','3036']);
  assert.deepEqual(h.overlays.at(-1).build.purchases, []);
  assert.equal(h.overlays.at(-1).build.complete, true);
  h.emit({type:'window-state', foreground:false});
  assert.equal(h.overlays.at(-1).build, null);
  await h.controller.stop();
  await h.controller.start({windowId:'42'});
  assert.equal(h.overlays.at(-1).build, null, 'a new capture needs its own match evidence');
});

test('an ambiguous ARAM mode waits for a Mayhem panel before showing the equipment HUD', async t => {
  const h = harness();
  t.after(() => h.controller.stop());
  await h.controller.start({windowId:'42'});
  const legacy = game(); legacy.gameData.gameMode = 'ARAM';
  h.emit({type:'game',game:legacy});
  assert.equal(h.overlays.at(-1).build, null);
  h.shot(names,legacy); h.shot(names,legacy);
  h.emit({type:'panel-gone'});
  assert.ok(h.overlays.at(-1).build?.purchases.length);
  const unsupported = game(); unsupported.gameData.gameMode = 'CLASSIC';
  h.emit({type:'game',game:unsupported});
  assert.equal(h.overlays.at(-1).build, null);
});

test('local active-player API resets a same-hero demo and synchronizes legal completed items and gold', async t => {
  const h = harness({ demo: true, selected: ['ARAM_Deft'], candidates: ids, owned: ['3031'], history: [{ label: '演示选择', time: '' }] });
  t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' });
  h.shot([], game('Ashe', { items: ['3006', '3047', '3078', '3100', 'not-an-item'], gold: 1899.9 }));
  assert.equal(h.state.championId, 'Ashe');
  assert.equal(h.state.demo, false);
  assert.deepEqual(h.state.selected, []);
  assert.deepEqual(h.state.candidates, [null, null, null]);
  assert.deepEqual(h.state.history, []);
  assert.deepEqual(h.state.owned, ['3006', '3078']);
  assert.equal(h.state.gold, 1899);
  assert.equal(h.controller.snapshot().gameConnected, true);
  assert.equal(h.controller.snapshot().windowTitle, 'League of Legends');
  assert.deepEqual(h.toasts, []);
});

test('same-hero reconnect preserves real records; observed time rollback or hero change resets the match', async t => {
  const h = harness({ selected: ['ARAM_Deft'], history: [{ label: '真实选择', time: '' }] });
  t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' });
  h.shot([], game('Ashe', { gameTime: 20 }));
  assert.deepEqual(h.state.selected, ['ARAM_Deft']); // Early-game reconnect is not proof of a new match.
  h.shot([], game('Ashe', { gameTime: 300 }));
  h.shot([], game('Ashe', { gameTime: 8 }));
  assert.deepEqual(h.state.selected, []);
  h.setState({ ...h.state, selected: ['ARAM_Deft'] });
  h.shot([], game('Garen', { items: ['3085', '3031'] }));
  assert.equal(h.state.championId, 'Garen');
  assert.deepEqual(h.state.selected, []);
  assert.deepEqual(h.state.owned, ['3031']); // Melee champion cannot equip Runaan's.
});

test('unknown player identity and unsupported mode preserve the current session', async t => {
  const h = harness({ selected: ['ARAM_Deft'], owned: ['3031'] });
  t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' });
  const before = structuredClone(h.state);
  h.shot([], game('FutureUnknownChampion'));
  const wrongMode = game(); wrongMode.gameData.gameMode = 'CLASSIC';
  h.shot([], wrongMode);
  const ambiguous = game(); ambiguous.allPlayers.push({ ...ambiguous.allPlayers[1] });
  h.shot([], ambiguous);
  assert.deepEqual(h.state, before);
  assert.equal(h.controller.snapshot().gameConnected, false);
  assert.equal(h.commits.length, 0);
});

test('syncItems false keeps manually entered equipment and gold while still identifying the champion', async t => {
  const h = harness({ owned: ['3031'], gold: 2600 });
  t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42', syncItems: false });
  h.shot([], game('Ashe', { items: ['3006'], gold: 50 }));
  assert.deepEqual(h.state.owned, ['3031']);
  assert.equal(h.state.gold, 2600);
  assert.equal(h.controller.snapshot().gameConnected, true);
  assert.equal(h.commits.length, 0);
});

test('first exact frame previews names; stable full-client OCR publishes scores and the real engine next item', async t => {
  const h = harness();
  t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' });
  h.shot(names, game(), 90);
  assert.equal(h.controller.snapshot().fresh, false);
  assert.equal(h.controller.snapshot().phase, 'preview');
  assert.deepEqual(h.overlays.at(-1).cards.map(c => c.name), names);
  assert.ok(h.overlays.at(-1).cards.every(c => c.score === null && c.pending && !c.actionable));
  h.shot(names, game(), 90);
  assert.equal(h.controller.snapshot().fresh, true);
  assert.equal(h.controller.snapshot().phase, 'confirmed');
  assert.deepEqual(h.state.candidates, ids);
  const ranking = rankCandidates(h.state, db);
  const payload = h.overlays.at(-1);
  assert.deepEqual(payload.cards.map(c => [c.name, c.slot]), names.map((name, i) => [name, i]));
  for (const card of payload.cards) assert.equal(card.score, ranking.find(r => r.augment.id === ids[card.slot]).score);
  assert.equal(payload.cards.find(c => c.best).slot, ids.indexOf(ranking[0].augment.id));
  const next = recommendBuilds(h.state, db)[0].next;
  assert.equal(payload.next, `${next.name} · ${next.cost} 金币`);
  assert.deepEqual(h.toasts, []);
  const count = h.commits.length;
  h.shot(names, game(), 90);
  assert.equal(h.controller.snapshot().fresh, true);
  assert.equal(h.commits.length, count); // Tracker's unchanged evidence remains fresh without another commit.
});

test('reroll immediately removes prior overlay scores until the replacement trio stabilizes', async t => {
  const h = harness();
  t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' });
  h.shot(); h.shot();
  const reroll = ['尖端发明家', '循环往复', '易损'];
  h.shot(reroll);
  assert.equal(h.controller.snapshot().fresh, false);
  assert.equal(h.controller.snapshot().phase, 'preview');
  assert.deepEqual(h.overlays.at(-1).cards.map(c => c.name), reroll);
  assert.ok(h.overlays.at(-1).cards.every(c => c.score === null && c.statistics === null));
  assert.deepEqual(h.state.candidates, ids); // Keep historical display data, not live scores.
  h.shot(reroll);
  assert.equal(h.controller.snapshot().fresh, true);
  assert.deepEqual(h.overlays.at(-1).cards.map(c => c.name), reroll);
});

test('a single unreadable frame keeps gray review cards without permitting selection or erasing history', async t => {
  const h = harness({ selected: ['ARAM_Deft'], history: [{ label: '已有记录', time: '' }] });
  t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' });
  h.shot(); h.shot();
  const before = structuredClone(h.state);
  h.shot(['无法识别']);
  assert.equal(h.controller.snapshot().fresh, false);
  assert.equal(h.controller.snapshot().phase, 'review');
  assert.deepEqual(h.overlays.at(-1).cards.map(c => c.id), ids);
  assert.ok(h.overlays.at(-1).cards.every(c => Number.isFinite(c.score) && c.pending && !c.actionable));
  h.record(0);
  assert.deepEqual(h.state, before);
  h.shot();
  assert.equal(h.controller.snapshot().fresh, false);
  h.shot();
  assert.equal(h.controller.snapshot().fresh, true);
  h.emit({ error: '游戏窗口不在前台', frame: null, game: null });
  assert.equal(h.controller.snapshot().fresh, false);
  assert.equal(h.controller.snapshot().error, '游戏窗口不在前台');
  assert.equal(h.controller.snapshot().phase, 'suspended');
  assert.deepEqual(h.overlays.at(-1).cards, []);
  assert.deepEqual(h.state, before);
});

test('hotkeys record the physical slot only with recent stable evidence; lingering selected panels cannot return', async t => {
  const h = harness();
  t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' });
  h.shot(); h.shot(); h.record(1);
  assert.deepEqual(h.state.selected, ['CriticalRhythm']);
  assert.deepEqual(h.state.candidates, [null, null, null]);
  assert.equal(h.controller.snapshot().fresh, false);
  assert.equal(h.state.history.length, 1);
  h.shot(); h.shot(); // Game still showing the menu must not restore an already selected candidate.
  assert.deepEqual(h.state.candidates, [null, null, null]);
  assert.equal(h.controller.snapshot().fresh, false);
  h.record(2);
  assert.deepEqual(h.state.selected, ['CriticalRhythm']);
  assert.deepEqual(h.overlays.at(-1).cards, []);
});

test('expired evidence or manual candidate edits cannot authorize hotkey selection or overlay scores', async t => {
  const h = harness();
  t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' });
  h.shot(); h.shot(); h.advance(8001);
  assert.equal(h.controller.snapshot().fresh, false);
  assert.deepEqual(h.controller.publish().cards, []);
  h.record(0);
  assert.deepEqual(h.state.selected, []);
  h.shot();
  assert.equal(h.controller.snapshot().fresh, true);
  h.setState({ ...h.state, candidates: ['ARAM_ApexInventor', ids[1], ids[2]] });
  assert.equal(h.controller.snapshot().fresh, false);
  assert.deepEqual(h.controller.publish().cards, []);
  h.record(0);
  assert.deepEqual(h.state.selected, []);
});

test('live OCR cannot silently use a demonstration hero when the local API is unavailable', async t => {
  const h = harness({ demo: true });
  t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' });
  h.shot(); h.shot();
  assert.equal(h.controller.snapshot().fresh, false);
  assert.deepEqual(h.state.candidates, [null, null, null]);
  h.shot(names, game()); h.shot(names, game());
  assert.equal(h.state.demo, false);
  assert.equal(h.controller.snapshot().fresh, true);
});

test('manual hero selection after OCR without an active hero can begin a new stabilization streak', async t => {
  const h = harness({ championId: null });
  t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' });
  h.shot(); h.shot();
  assert.equal(h.controller.snapshot().fresh, false);
  h.setState({ ...h.state, championId: 'Ashe' });
  h.shot();
  assert.equal(h.controller.snapshot().fresh, false);
  h.shot();
  assert.equal(h.controller.snapshot().fresh, true);
  assert.deepEqual(h.state.candidates, ids);
});

test('reset invalidates evidence and stop rejects callbacks retained from an older run', async t => {
  const h = harness();
  t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' });
  h.shot(); h.shot();
  const before = structuredClone(h.state);
  h.controller.reset();
  assert.equal(h.controller.snapshot().fresh, false);
  assert.deepEqual(h.state, before);
  h.shot(); assert.equal(h.controller.snapshot().fresh, false);
  const staleCapture = [...h.captureListeners][0], staleRecord = [...h.recordListeners][0];
  await h.controller.stop();
  await h.controller.start({ windowId: '42' });
  staleCapture({ frame: frame(), game: game('Garen'), timestamp: 100000 });
  staleRecord(0);
  assert.deepEqual(h.state, before);
  assert.equal(h.captureListeners.size, 1);
  assert.equal(h.recordListeners.size, 1);
});

test('new listeners reject old queued frames and frames belonging to another capture window', async t => {
  const h = harness();
  t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' });
  const before = structuredClone(h.state);
  h.emit({ frame: frame(), timestamp: 99999, game: game('Garen') });
  h.emit({ frame: { ...frame(), windowId: '99' }, game: game('Garen') });
  assert.deepEqual(h.state, before);
  assert.equal(h.controller.snapshot().lastFrameAt, null);
  assert.equal(h.controller.snapshot().fresh, false);
});

test('stop during an unresolved start keeps capture inactive and native lifecycle commands ordered', async () => {
  let completeStart;
  const calls = [];
  const h = harness({}, {
    captureStart() { calls.push('start'); return new Promise(resolve => { completeStart = resolve; }); },
    async captureStop() { calls.push('stop'); },
  });
  const starting = h.controller.start({ windowId: '42' });
  await Promise.resolve();
  const stopping = h.controller.stop();
  completeStart({ window: { title: 'Old window' } });
  assert.equal(await starting, null);
  await stopping;
  assert.deepEqual(calls, ['start', 'stop']);
  assert.equal(h.controller.snapshot().active, false);
  assert.equal(h.controller.snapshot().busy, false);
  assert.equal(h.captureListeners.size, 0);
});

test('start failures are visible and remove event subscriptions', async () => {
  const h = harness({}, { async captureStart() { throw new Error('缺少中文 OCR 语言包'); } });
  await assert.rejects(h.controller.start({ windowId: '42' }), /中文 OCR/);
  assert.equal(h.controller.snapshot().active, false);
  assert.equal(h.controller.snapshot().busy, false);
  assert.match(h.controller.snapshot().error, /中文 OCR/);
  assert.equal(h.captureListeners.size, 0);
  assert.equal(h.recordListeners.size, 0);
  assert.deepEqual(h.toasts, []);
});

test('review grace is bounded to 1.5 seconds and repeated misses cannot renew it', async t => {
  const h = harness(); t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' }); h.shot(); h.shot();
  const before = structuredClone(h.state);
  h.emit({ error: { code: 'OCR_BUSY', message: '识别引擎暂时忙碌', transient: true } });
  assert.equal(h.controller.snapshot().phase, 'review');
  assert.equal(h.controller.snapshot().actionable, false);
  assert.match(h.controller.snapshot().status, /识别引擎暂时忙碌/);
  h.advance(1000);
  h.emit({ error: { code: 'OCR_BUSY', message: '识别引擎暂时忙碌', transient: true } });
  assert.equal(h.controller.snapshot().display, true);
  h.advance(501);
  assert.equal(h.controller.snapshot().display, false);
  assert.deepEqual(h.controller.publish().cards, []);
  h.record(0);
  assert.deepEqual(h.state, before);
});

test('an empty capture retains review cards and only fresh OCR restores recording', async t => {
  const h = harness(); t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' }); h.shot(); h.shot();
  assert.equal(h.controller.snapshot().actionable, true);
  const selected = [...h.state.selected];
  h.emit({ error: { code: 'FRAME_EMPTY', message: '游戏截图未包含有效像素，正在等待下一帧',
    transient: true, category: 'capture-unavailable' }, frame: null });
  assert.equal(h.controller.snapshot().phase, 'review');
  assert.equal(h.controller.snapshot().display, true);
  assert.equal(h.controller.snapshot().actionable, false);
  assert.deepEqual(h.overlays.at(-1).cards.map(card => card.name), names);
  assert.equal(h.overlays.at(-1).phase, 'review');
  h.record(0);
  assert.deepEqual(h.state.selected, selected, 'an empty screenshot must not leave stale choices recordable');
  h.advance(200); h.shot();
  assert.equal(h.controller.snapshot().phase, 'review');
  assert.equal(h.controller.snapshot().actionable, false);
  h.advance(200); h.shot();
  assert.equal(h.controller.snapshot().phase, 'confirmed');
  assert.equal(h.controller.snapshot().actionable, true);
  assert.deepEqual(h.state.selected, selected);
});

test('explicit panel disappearance or two absent OCR frames clear display without guessing a selection', async t => {
  const h = harness(); t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' }); h.shot(); h.shot();
  h.shot([]);
  assert.equal(h.controller.snapshot().phase, 'review');
  h.shot([]);
  assert.equal(h.controller.snapshot().display, false);
  assert.deepEqual(h.state.selected, []);
  h.shot(); h.shot();
  h.emit({ type: 'panel-gone' });
  assert.equal(h.controller.snapshot().display, false);
  assert.deepEqual(h.overlays.at(-1).cards, []);
  assert.deepEqual(h.state.selected, []);
});

test('heartbeats cannot cast OCR votes; a confirmed same-source fingerprint extends freshness only', async t => {
  const h = harness(); t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' }); h.shot();
  const metadata = { windowId: '42', width: 1920, height: 1080, fingerprint: 'panel-a' };
  h.emit({ type: 'heartbeat', frame: metadata });
  h.emit({ type: 'heartbeat', frame: metadata });
  assert.equal(h.controller.snapshot().phase, 'preview');
  assert.equal(h.controller.snapshot().actionable, false);
  assert.deepEqual(h.state.candidates, [null, null, null]);
  h.shot();
  const acceptedAt = h.controller.snapshot().lastAcceptedAt;
  h.advance(7000);
  h.emit({ type: 'heartbeat', frame: { ...metadata, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } } });
  h.advance(7000);
  assert.equal(h.controller.snapshot().actionable, true);
  assert.equal(h.controller.snapshot().lastAcceptedAt, acceptedAt);
  assert.equal(h.controller.publish().layout.bounds.x, -1920);
  h.emit({ type: 'heartbeat', frame: { ...metadata, width: 2560 } });
  h.emit({ type: 'heartbeat', frame: { ...metadata, fingerprint: 'different' } });
  h.emit({ type: 'heartbeat', frame: { ...metadata, windowId: '99' } });
  h.advance(1001);
  assert.equal(h.controller.snapshot().actionable, false);
});

test('frame-changed disables action immediately and heartbeat cannot restore it before fresh OCR', async t => {
  const h = harness(); t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' }); h.shot(); h.shot();
  h.emit({ type: 'frame-changed', frame: { windowId: '42', width: 1920, height: 1080, fingerprint: 'panel-b' } });
  assert.equal(h.controller.snapshot().phase, 'review');
  assert.equal(h.controller.snapshot().actionable, false);
  h.emit({ type: 'heartbeat', frame: { windowId: '42', width: 1920, height: 1080, fingerprint: 'panel-a' } });
  assert.equal(h.controller.snapshot().actionable, false);
  h.record(0); assert.deepEqual(h.state.selected, []);
  const reroll = ['尖端发明家', '循环往复', '易损'];
  h.shot(reroll);
  assert.equal(h.controller.snapshot().phase, 'preview');
  assert.ok(h.overlays.at(-1).cards.every(card => card.score === null));
  h.shot(reroll);
  assert.equal(h.controller.snapshot().actionable, true);
});

test('independent game events update equipment without erasing OCR votes or stable display', async t => {
  const h = harness(); t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' }); h.shot();
  h.emit({ type: 'game', game: game('Ashe', { gold: 2000 }) });
  assert.equal(h.controller.snapshot().phase, 'preview');
  h.shot();
  const acceptedAt = h.controller.snapshot().lastAcceptedAt;
  h.advance(100);
  h.emit({ type: 'game', game: game('Ashe', { gold: 2200, items: ['3006', '3031'] }) });
  assert.equal(h.controller.snapshot().actionable, true);
  assert.equal(h.controller.snapshot().lastAcceptedAt, acceptedAt);
  assert.deepEqual(h.state.owned, ['3006', '3031']);
  assert.equal(h.state.gold, 2200);
  h.emit({ type: 'game', game: null });
  assert.equal(h.controller.snapshot().actionable, true);
  assert.equal(h.controller.snapshot().gameConnected, false);
});

test('foreground loss suspends and hides immediately; recovery needs new OCR instead of old heartbeats', async t => {
  const h = harness(); t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' }); h.shot(); h.shot();
  h.emit({ type: 'window-state', foreground: false, windowState: { message: '游戏窗口已最小化' } });
  assert.equal(h.controller.snapshot().phase, 'suspended');
  assert.equal(h.controller.snapshot().display, false);
  assert.match(h.controller.snapshot().status, /已最小化/);
  h.shot(); h.record(0); assert.deepEqual(h.state.selected, []);
  h.emit({ type: 'window-state', foreground: true });
  h.emit({ type: 'heartbeat', frame: { windowId: '42', width: 1920, height: 1080, fingerprint: 'panel-a' } });
  assert.equal(h.controller.snapshot().display, false);
  h.shot(); assert.equal(h.controller.snapshot().actionable, false);
  h.shot(); assert.equal(h.controller.snapshot().actionable, true);
  h.emit({ error: { code: 'WINDOW_NOT_FOREGROUND', message: '请切回英雄联盟窗口', transient: true } });
  assert.equal(h.controller.snapshot().phase, 'suspended');
  assert.equal(h.controller.snapshot().display, false);
  assert.match(h.controller.snapshot().status, /请切回英雄联盟窗口/);
});

test('2560 by 1440 full-client boxes and physical desktop bounds pass through without double scaling', async t => {
  const h = harness(); t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' });
  const full = () => ({ ...frame(), width: 2560, height: 1440,
    bounds: { x: 2560, y: 120, width: 2560, height: 1440 }, crop: { x: 200, y: 500, width: 2100, height: 150 }, scale: 2,
    lines: names.map((text, slot) => ({ text, x: 400 + slot * 700, y: 620, width: 200, height: 40 })) });
  h.emit({ frame: full() });
  assert.equal(h.controller.snapshot().phase, 'preview');
  let layout = h.controller.publish().layout;
  assert.deepEqual(layout.bounds, { x: 2560, y: 120, width: 2560, height: 1440 });
  assert.deepEqual(layout.boxes.map(box => [box.x, box.y]), [[400, 620], [1100, 620], [1800, 620]]);
  h.emit({ frame: full() });
  layout = h.controller.publish().layout;
  assert.equal(layout.width, 2560); assert.equal(layout.height, 1440);
  assert.equal(h.controller.snapshot().actionable, true);
  await h.controller.stop();
  assert.equal(h.controller.snapshot().layout, null);
  assert.equal(h.controller.snapshot().lastAcceptedAt, null);
  assert.equal(h.controller.snapshot().frameText, '');
});

test('a single generic long-title OCR substitution requires three frames and never publishes a guessed score early', async t => {
  const h = harness(); t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' });
  const titles = ['升级: 无尽之丸', '轻拍背部', '捐赠'];
  h.shot(titles); h.shot(titles);
  assert.equal(h.controller.snapshot().actionable, false);
  assert.deepEqual(h.overlays.at(-1).cards, []);
  h.shot(titles);
  assert.equal(h.controller.snapshot().actionable, true);
  assert.deepEqual(h.state.candidates, ['ARAM_Upgrade_IE', 'PatOnTheBack', 'Donation']);
});

test('overlay carries the actual per-hero statistics, reasons and warnings in physical slot order', async t => {
  const dataset = JSON.parse(await readFile(new URL('../app/data/augment-stats.json', import.meta.url), 'utf8'));
  const statsDb = { ...db, meta: { ...db.meta, now: '2026-11-17T00:00:00+08:00' }, augmentStats: dataset };
  const h = harness({ championId: 'Yasuo' }, {}, statsDb); t.after(() => h.controller.stop());
  await h.controller.start({ windowId: '42' }); h.shot(); h.shot();
  const ranked = rankCandidates(h.state, statsDb), cards = h.controller.publish().cards;
  assert.ok(cards.some(card => card.statistics?.games > 0));
  for (const card of cards) {
    const expected = ranked.find(row => row.augment.id === ids[card.slot]);
    assert.deepEqual(card.statistics, expected.statistics || null);
    assert.equal(card.reason, expected.reasons.slice(0, 2).join(' '));
    assert.equal(card.warning, expected.warnings.slice(0, 2).join(' '));
  }
});
