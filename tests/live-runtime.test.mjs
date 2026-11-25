import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLiveRuntime, titleRegion } = require('../desktop/live-runtime.cjs');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

// An injected clock advances scheduling only; promises may deliberately remain
// pending so a slow local game API or OCR worker cannot hide concurrency bugs.
function clock() {
  let now = 10000, sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      let guard = 0;
      while (true) {
        const next = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        assert.ok(++guard < 2000, 'scheduler should not busy-loop');
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    },
    count: () => timers.size,
  };
}

const layout = (y = 820) => ({ width: 2560, height: 1440,
  bounds: { x: 100, y: 200, width: 2560, height: 1440 },
  boxes: [560, 1200, 1840].map(x => ({ x, y, width: 160, height: 40 })) });

function harness(overrides = {}) {
  const time = clock(), frames = [], records = [], toggles = [], visibility = [];
  const calls = { captures: [], keys: [], games: [], ocr: [], initialized: 0, stopped: { capture: 0, keys: 0, ocr: 0 } };
  const shot = extra => ({ imageBase64: 'private-png-bytes', width: 2560, height: 1440,
    sourceWidth: 2560, sourceHeight: 1440, bounds: layout().bounds, windowId: '123',
    foreground: true, fingerprint: 'same-pixels', capturedAt: new Date(time.now()).toISOString(), ...extra });
  const capture = {
    listWindows: overrides.listWindows || (async () => [{ id: '123', title: 'League of Legends' }]),
    capabilities: async () => ({ available: true }),
    captureWindow(id, settings) { calls.captures.push({ id, settings, at: time.now() }); return overrides.capture?.(id, settings, calls.captures.length) ?? Promise.resolve(shot()); },
    async stop() { calls.stopped.capture++; },
  };
  const hotkeys = {
    capabilities: async () => ({ available: true }),
    pollHotkeys(id) { calls.keys.push({ id, at: time.now() }); return overrides.keys?.(id, calls.keys.length) ?? Promise.resolve({ foreground: true, pressed: [] }); },
    async stop() { calls.stopped.keys++; },
  };
  const ocr = {
    async initialize() { calls.initialized++; },
    recognize(image) { calls.ocr.push(image); return overrides.ocr?.(image, calls.ocr.length) ?? Promise.resolve({ width: 2560, height: 1440, lines: [], capturedAt: image.capturedAt }); },
    async stop() { calls.stopped.ocr++; },
  };
  const runtime = createLiveRuntime({ capture, hotkeys, ocr,
    readGame() { calls.games.push(time.now()); return overrides.game?.(calls.games.length) ?? Promise.resolve({ gameData: {} }); },
    sendFrame(frame) { frames.push(frame); overrides.onFrame?.(frame, runtime); },
    sendRecord: slot => { records.push(slot); overrides.onRecord?.(slot); }, onToggle: () => toggles.push(time.now()),
    onWindowState: (visible, state) => visibility.push({ visible, state }),
    now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
  });
  return { runtime, time, frames, records, toggles, visibility, calls, shot,
    start: () => runtime.start({ windowId: '123' }) };
}

test('a pending game read and OCR job do not block 50ms hotkeys or the first screenshot', async t => {
  const game = deferred(), recognition = deferred();
  // Native poll returns press edges: keeping the chord down yields no new edge.
  const edges = [['toggle'], [], [], [], ['toggle']];
  const h = harness({ game: () => game.promise, ocr: () => recognition.promise,
    keys: (_id, call) => Promise.resolve({ foreground: true, pressed: edges[call - 1] || [] }) });
  t.after(() => h.runtime.stop()); await h.start(); await h.time.advance(200);
  assert.equal(h.calls.games.length, 1, 'the game request is still waiting');
  assert.equal(h.calls.captures.length, 1);
  assert.equal(h.calls.ocr.length, 1, 'OCR can run while game data is pending');
  assert.deepEqual(h.calls.keys.slice(0, 5).map(call => call.at), [10000, 10050, 10100, 10150, 10200]);
  assert.deepEqual(h.toggles, [10000, 10200], 'one toggle per native press edge, none during the held interval');
});

test('tracking ROI follows full-client title coordinates at any vertical position', async t => {
  const h = harness(); t.after(() => h.runtime.stop()); await h.start();
  const low = layout(1080), high = layout(500);
  const lowRegion = titleRegion(low), highRegion = titleRegion(high);
  assert.ok(lowRegion.y > .7);
  assert.ok(highRegion.y < .4);
  assert.ok(Math.abs((lowRegion.y - highRegion.y) - 580 / 1440) < 1e-10);
  h.runtime.acceptLayout({ phase: 'preview', display: true, layout: low });
  await h.time.advance(40);
  assert.ok(h.calls.captures[0].settings.roi.y > .7, 'must not revert to a fixed middle-of-screen crop');
  assert.equal(h.calls.captures[0].settings.skipUnchanged, false, 'a preview still requires a genuinely new OCR read');
});

test('only confirmed titles may use unchanged-frame heartbeats, which contain no PNG', async t => {
  let h;
  h = harness({ capture: (_id, settings, call) => Promise.resolve(h.shot({ unchanged: call > 1 && settings.skipUnchanged })),
    onFrame: (event, runtime) => { if (event.frame && !event.type) runtime.acceptLayout({ phase: 'confirmed', actionable: true, layout: layout(), evidenceId:event.evidenceId }); } });
  t.after(() => h.runtime.stop()); await h.start();
  // First read discovers the title band; the second establishes its fingerprint.
  await h.time.advance(550);
  const heartbeat = h.frames.find(frame => frame.type === 'heartbeat');
  assert.ok(heartbeat);
  assert.equal(heartbeat.metrics.cached, true);
  assert.equal(heartbeat.frame.width, 2560);
  assert.ok(!JSON.stringify(heartbeat).includes('private-png-bytes'));
  assert.ok(!Object.hasOwn(heartbeat.frame, 'imageBase64'));
  const previousOcr = h.calls.ocr.length;
  h.runtime.acceptLayout({ phase: 'preview', display: true, layout: layout() });
  await h.time.advance(250);
  assert.equal(h.calls.captures.at(-1).settings.skipUnchanged, false);
  assert.equal(h.calls.ocr.length, previousOcr + 1);
  h.runtime.acceptLayout({ phase: 'review', display: true, layout: layout() });
  await h.time.advance(250);
  assert.equal(h.calls.captures.at(-1).settings.skipUnchanged, false);
});

test('foreground loss while OCR is pending suppresses its late recommendation', async t => {
  const recognition = deferred();
  const h = harness({ ocr: () => recognition.promise,
    keys: (_id, call) => Promise.resolve({ foreground: call === 1, pressed: [] }) });
  t.after(() => h.runtime.stop()); await h.start(); await h.time.advance(50);
  assert.equal(h.calls.ocr.length, 1);
  recognition.resolve({ text: 'obsolete after alt-tab', lines: [] }); await flush();
  assert.ok(!h.frames.some(event => event.frame?.text === 'obsolete after alt-tab'));
  assert.equal(h.visibility.at(-1).visible, false);
});

test('a late positive screenshot cannot overwrite a newer negative hotkey foreground check', async t => {
  const capture = deferred();
  let h;
  h = harness({ capture: () => capture.promise,
    keys: (_id, call) => Promise.resolve({ foreground: call === 1, pressed: [] }) });
  t.after(() => h.runtime.stop()); await h.start(); await h.time.advance(50);
  capture.resolve(h.shot({ foreground: true })); await flush();
  assert.equal(h.calls.ocr.length, 0);
  assert.equal(h.visibility.at(-1).visible, false);
});

test('hotkey worker errors hide the UI and prevent pending OCR from publishing', async t => {
  const recognition = deferred();
  const h = harness({ ocr: () => recognition.promise,
    keys: (_id, call) => call === 1 ? Promise.resolve({ foreground: true, pressed: [] }) : Promise.reject(new Error('key worker disconnected')) });
  t.after(() => h.runtime.stop()); await h.start(); await h.time.advance(50);
  recognition.resolve({ text: 'unsafe after key error', lines: [] }); await flush();
  assert.equal(h.visibility.at(-1).visible, false);
  assert.ok(h.frames.some(event => event.component === 'hotkeys'));
  assert.ok(!h.frames.some(event => event.frame?.text === 'unsafe after key error'));
});

test('stop and restart discard every old game, OCR and hotkey completion', async t => {
  const oldGame = deferred(), oldOcr = deferred(), oldKeys = deferred();
  const h = harness({ game: call => call === 1 ? oldGame.promise : Promise.resolve({ current: true }),
    ocr: (_shot, call) => call === 1 ? oldOcr.promise : Promise.resolve({ text: 'new-session', lines: [] }),
    keys: (_id, call) => call === 1 ? oldKeys.promise : Promise.resolve({ foreground: true, pressed: [] }) });
  t.after(() => h.runtime.stop()); await h.start(); await h.time.advance(40);
  assert.equal(h.calls.ocr.length, 1);
  await h.runtime.stop(); await h.start(); await h.time.advance(40);
  const frames = h.frames.length, toggles = h.toggles.length, visible = h.visibility.length;
  oldGame.resolve({ obsolete: true }); oldOcr.resolve({ text: 'old-session', lines: [] });
  oldKeys.resolve({ foreground: false, pressed: ['toggle', 'slot-1'] }); await flush();
  assert.equal(h.frames.length, frames);
  assert.equal(h.toggles.length, toggles);
  assert.equal(h.visibility.length, visible);
  assert.equal(h.records.length, 0);
  assert.ok(h.frames.some(event => event.frame?.text === 'new-session'));
});

test('invalid selected windows clean up and never initialize OCR or schedule loops', async () => {
  const h = harness({ listWindows: async () => [] });
  await assert.rejects(h.start(), /窗口/);
  assert.equal(h.runtime.isRunning(), false);
  assert.equal(h.calls.initialized, 0);
  assert.equal(h.time.count(), 0);
  assert.ok(h.calls.stopped.capture >= 2);
  assert.ok(h.calls.stopped.keys >= 2);
  assert.ok(h.calls.stopped.ocr >= 2);
});

test('cancelled window discovery cannot later initialize orphan OCR resources', async () => {
  const discovery = deferred();
  const h = harness({ listWindows: () => discovery.promise });
  const starting = h.start(); const rejected = assert.rejects(starting, /取消|停止/);
  await flush(); await h.runtime.stop();
  discovery.resolve([{ id: '123' }]); await rejected;
  assert.equal(h.calls.initialized, 0, 'cancellation must be checked before launching worker initialization');
  assert.equal(h.runtime.isRunning(), false);
  assert.equal(h.time.count(), 0);
});

test('changed pixels lock slot recording until the exact OCR result receives a confirmed renderer ack without flashing cards', async t => {
  const { readFile } = await import('node:fs/promises');
  const { createLiveController } = await import('../app/core/live-controller.mjs');
  const { indexCatalog } = await import('../app/core/engine.mjs');
  const { emptySession } = await import('../app/core/session.mjs');
  const db = indexCatalog(JSON.parse(await readFile(new URL('../app/data/catalog.json', import.meta.url), 'utf8')));
  let state = { ...emptySession(), championId: 'Ashe' }, receive, record, nextKey = null, withheld = false, latestPayload;
  const pending = deferred(), notices = [], ids = [];
  const titles = ['火上浇油', '暴击律动', '神射法师'];
  const recognized = shot => ({ ...shot, text: titles.join('\n'),
    lines: titles.map((text, slot) => ({ text, x: 560 + slot * 640, y: 820, width: 160, height: 40 })) });
  const h = harness({
    ocr: (shot, call) => call === 3 ? pending.promise : Promise.resolve(recognized(shot)),
    keys: () => { const key = nextKey; nextKey = null; return Promise.resolve({ foreground: true, pressed: key ? [key] : [] }); },
    onFrame: event => { if (event.evidenceId) ids.push(event.evidenceId); receive(event); },
    onRecord: slot => record(slot),
  });
  const controller = createLiveController({ db, now: h.time.now, getState: () => state, commit: next => { state = next; },
    toast: text => notices.push(text), desktop: {
      onCapture: callback => { receive = callback; return () => {}; },
      onRecord: callback => { record = callback; return () => {}; },
      captureStart: options => h.runtime.start(options), captureStop: () => h.runtime.stop(),
      updateOverlay: payload => { latestPayload = payload; if (!withheld) h.runtime.acceptLayout(payload); },
    },
  });
  t.after(() => controller.stop()); await controller.start({ windowId: '123' });
  await h.time.advance(300);
  assert.equal(controller.snapshot().phase, 'confirmed');
  const oldPayload = structuredClone(latestPayload);
  withheld = true;
  await h.time.advance(240);
  assert.equal(h.calls.ocr.length, 3);
  assert.equal(controller.snapshot().phase, 'confirmed', 'the display stays green while only the runtime record gate is locked');
  nextKey = 'slot-0'; await h.time.advance(10);
  assert.deepEqual(state.selected, []);
  assert.equal(h.records.length, 0);
  assert.match(notices.at(-1), /复核/);
  assert.ok(!h.frames.some(event => event.type === 'frame-changed'));
  pending.resolve(recognized(h.calls.ocr[2])); await flush();
  assert.equal(controller.snapshot().phase, 'confirmed');
  assert.notEqual(latestPayload.evidenceId, oldPayload.evidenceId);
  assert.equal(latestPayload.evidenceId, ids.at(-1));
  // Resolving OCR, old confirmations, previews, and review verdicts cannot unlock.
  nextKey = 'slot-0'; await h.time.advance(50);
  h.runtime.acceptLayout(oldPayload);
  nextKey = 'slot-0'; await h.time.advance(50);
  h.runtime.acceptLayout({ ...latestPayload, phase: 'preview', actionable: false });
  nextKey = 'slot-0'; await h.time.advance(50);
  h.runtime.acceptLayout({ ...latestPayload, phase: 'review', actionable: false });
  assert.deepEqual(h.records, []);
  h.runtime.acceptLayout(latestPayload);
  nextKey = 'slot-0'; await h.time.advance(50);
  assert.deepEqual(h.records, [0]);
  assert.deepEqual(state.selected, ['ARAM_Firebrand']);
});

test('foreground out-and-back discards a still-pending old OCR job and cannot replay its ack', async t => {
  const pending = deferred();
  const h = harness({ ocr: () => pending.promise,
    keys: (_id, call) => Promise.resolve({ foreground: call !== 2, pressed: [] }) });
  t.after(() => h.runtime.stop()); await h.start(); await h.time.advance(100);
  assert.equal(h.visibility.at(-1).visible, true, 'game has regained foreground');
  pending.resolve({ text: 'captured-before-switch', lines: [] }); await flush();
  assert.ok(!h.frames.some(event => event.frame?.text === 'captured-before-switch'));
});

test('foreground out-and-back also discards a pending old screenshot before starting OCR', async t => {
  const pending = deferred(); let h;
  h = harness({ capture: () => pending.promise,
    keys: (_id, call) => Promise.resolve({ foreground: call !== 2, pressed: [] }) });
  t.after(() => h.runtime.stop()); await h.start(); await h.time.advance(100);
  pending.resolve(h.shot({ timestamp: 10040 })); await flush();
  assert.equal(h.calls.ocr.length, 0);
});
