import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createLiveController } from '../app/core/live-controller.mjs';
import { indexCatalog } from '../app/core/engine.mjs';
import { emptySession } from '../app/core/session.mjs';

const require = createRequire(import.meta.url);
const { createLiveRuntime, titleRegion } = require('../desktop/live-runtime.cjs');
const db = indexCatalog(JSON.parse(await readFile(new URL('../app/data/catalog.json', import.meta.url), 'utf8')));
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const full = { x: 0, y: 0, width: 1, height: 1 };
const exact = ['火上浇油', '暴击律动', '神射法师'];
const reroll = [...db.augmentMap.values()].filter(a => a.tier === db.augmentMap.get('ARAM_Firebrand').tier && !exact.includes(a.name) && a.name.length >= 4 && a.name.length <= 7).slice(0, 3).map(a => a.name);

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
        assert.ok(++guard < 3000, 'no runaway capture timers');
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    },
  };
}

// Uses observed title coordinates and the generic one-character OCR error from
// the user's screenshot; simulated OCR durations below are scheduler fixtures.
function recognized(shot, titleHeight = 40) {
  const titles = shot.panel === 'none' ? [] : shot.panel === 'fuzzy'
    ? ['升级: 无尽之丸', '轻拍背部', '捐赠'] : shot.panel === 'reroll' ? reroll : exact;
  return { width: shot.sourceWidth, height: shot.sourceHeight, windowId: shot.windowId,
    bounds: shot.bounds, fingerprint: shot.fingerprint, capturedAt: shot.capturedAt,
    text: titles.join('\n'), lines: titles.map((text, i) => ({ text,
      x: [228, 1022, 1801][i], y: 512, width: [286, 164, 79][i], height: i === 0 ? titleHeight : 40 })) };
}

function harness(options = {}) {
  const time = clock(), captures = [], events = [], overlays = [], records = [], notices = [];
  let state = { ...emptySession(), championId: 'Ashe', ...options.state };
  let panel = options.panel || 'exact', revision = 1, foreground = true, key = null;
  let width = 2189, height = 1123, emptyResizeReply = false;
  let receive, record, activeOcr = 0, maxActiveOcr = 0, ocrCount = 0;
  const capture = {
    listWindows: async () => [{ id: '123', title: 'League of Legends' }],
    capabilities: async () => ({ available: true }), stop: async () => {},
    async captureWindow(windowId, settings) {
      const fingerprint = `${revision}:${width}x${height}:${JSON.stringify(settings.roi)}`;
      const unchanged = emptyResizeReply || (settings.skipUnchanged && settings.previousFingerprint === fingerprint);
      const shot = { imageBase64: unchanged ? undefined : 'test-png', width, height,
        sourceWidth: width, sourceHeight: height, windowId, foreground, fingerprint: emptyResizeReply ? settings.previousFingerprint : fingerprint,
        unchanged, capturedAt: new Date(time.now()).toISOString(), bounds: { x: 0, y: 0, width, height }, panel, roi: settings.roi };
      emptyResizeReply = false;
      captures.push({ at: time.now(), settings, shot }); return shot;
    },
  };
  const hotkeys = { capabilities: async () => ({ available: true }), stop: async () => {},
    async pollHotkeys() { const pressed = key ? [key] : []; key = null; return { foreground, pressed }; } };
  const ocr = { initialize: async () => {}, stop: async () => {},
    recognize(shot) {
      assert.ok(shot.imageBase64, 'metadata-only native reply must never enter OCR');
      const call = ++ocrCount; activeOcr++; maxActiveOcr = Math.max(maxActiveOcr, activeOcr);
      const duration = shot.roi.height === 1 ? options.fullMs ?? 20 : options.bandMs ?? 20;
      return new Promise(resolve => time.setTimer(() => { activeOcr--; resolve(recognized(shot, options.heightFor?.(call) ?? 40)); }, duration));
    },
  };
  const runtime = createLiveRuntime({ capture, hotkeys, ocr, readGame: async () => null,
    now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    sendFrame: event => { events.push({ ...event, at: time.now() }); receive(event); },
    sendRecord: slot => { records.push(slot); record(slot); }, onToggle: () => {},
  });
  const controller = createLiveController({ db, now: time.now, getState: () => state,
    commit: next => { state = next; }, toast: text => notices.push(text),
    desktop: { onCapture: callback => { receive = callback; return () => {}; },
      onRecord: callback => { record = callback; return () => {}; },
      captureStart: config => runtime.start(config), captureStop: () => runtime.stop(),
      updateOverlay: payload => {
        overlays.push({ at: time.now(), payload: structuredClone(payload) });
        // Electron's renderer acknowledgement arrives after captureTick finally.
        time.setTimer(() => runtime.acceptLayout(payload), options.ackMs ?? 20);
      },
    },
  });
  return { time, runtime, controller, captures, events, overlays, records, notices,
    get state() { return state; }, get ocrCount() { return ocrCount; }, get maxActiveOcr() { return maxActiveOcr; },
    setPanel(next) { panel = next; revision++; }, setForeground(value) { foreground = value; }, press(slot) { key = `slot-${slot}`; },
    resize(w, h) { width = w; height = h; emptyResizeReply = true; },
    start: () => controller.start({ windowId: '123' }), stop: () => controller.stop(),
  };
}

test('late renderer preview advances the single next timer; confirmation restores normal cadence and cache', async t => {
  const h = harness(); t.after(h.stop); await h.start(); await h.time.advance(80);
  assert.equal(h.controller.snapshot().phase, 'preview');
  assert.equal(h.controller.snapshot().confirmationPending, true);
  assert.equal(h.captures.length, 1);
  await h.time.advance(110);
  assert.deepEqual(h.captures.map(c => c.at), [10040, 10140]);
  assert.equal(h.controller.snapshot().phase, 'confirmed');
  assert.equal(h.controller.snapshot().confirmationPending, false);
  const accepted = h.overlays.at(-1).payload;
  h.runtime.acceptLayout(accepted); h.runtime.acceptLayout(accepted);
  await h.time.advance(199); assert.equal(h.captures.length, 2);
  await h.time.advance(1);
  assert.equal(h.captures[2].at, 10390);
  assert.equal(h.events.at(-1).type, 'heartbeat');
  assert.equal(h.ocrCount, 2);
  assert.equal(h.maxActiveOcr, 1);
});

test('first fuzzy row narrows OCR without cards, cache votes, or record authority; three independent frames remain required', async t => {
  const h = harness({ panel: 'fuzzy', fullMs: 699, bandMs: 70 }); t.after(h.stop); await h.start();
  await h.time.advance(760);
  assert.equal(h.controller.snapshot().display, false);
  assert.equal(h.controller.snapshot().roiHint.boxes.length, 3);
  assert.equal(h.controller.snapshot().actionable, false);
  assert.deepEqual(h.state.candidates, [null, null, null]);
  h.press(0); await h.time.advance(105);
  assert.equal(h.ocrCount, 2); assert.equal(h.controller.snapshot().actionable, false);
  assert.deepEqual(h.records, []);
  await h.time.advance(145);
  assert.deepEqual(h.state.candidates, ['ARAM_Upgrade_IE', 'PatOnTheBack', 'Donation']);
  assert.equal(h.controller.snapshot().actionable, true);
  assert.deepEqual(h.captures.slice(0, 3).map(c => c.at), [10040, 10774, 10899]);
  assert.ok(h.captures.slice(0, 3).every(c => c.settings.skipUnchanged === false));
  assert.equal(h.maxActiveOcr, 1);
  const fraction = h.captures[1].settings.roi.width * h.captures[1].settings.roi.height;
  assert.ok(fraction < .075 && fraction > .07);
  const confirmedAt = h.overlays.find(entry => entry.payload.actionable).at;
  t.diagnostic(`Synthetic timing with full OCR 699 ms / band OCR 70 ms: confirmed in ${confirmedAt - h.captures[0].at} ms from first capture; title band ${(fraction * 100).toFixed(2)}% of full area. Not a Windows live benchmark.`);
});

test('missing or demonstration hero can narrow the region but never enables perpetual 100 ms confirmation', async t => {
  for (const state of [{ championId: null }, { demo: true }]) {
    const h = harness({ state }); t.after(h.stop); await h.start(); await h.time.advance(600);
    assert.deepEqual(h.captures.map(c => c.at), [10040, 10290, 10540]);
    assert.ok(h.captures[1].settings.roi.height < .1);
    assert.equal(h.controller.snapshot().confirmationPending, false);
    assert.equal(h.controller.snapshot().actionable, false);
    assert.deepEqual(h.state.candidates, [null, null, null]);
  }
});

test('two distinct negative OCR verdicts return to wide discovery; idle band scans never reuse candidate evidence', async t => {
  const h = harness(); t.after(h.stop); await h.start(); await h.time.advance(190);
  h.setPanel('none'); await h.time.advance(250);
  const firstMiss = h.overlays.at(-1).payload;
  assert.equal(firstMiss.phase, 'review');
  h.runtime.acceptLayout(firstMiss); h.runtime.acceptLayout(firstMiss);
  await h.time.advance(250);
  assert.equal(h.captures.at(-1).settings.roi.height < 1, true, 'duplicate ack is not a second missing frame');
  assert.equal(h.controller.snapshot().display, false);
  assert.ok(h.overlays.at(-1).payload.evidenceId, 'clearing old display still acknowledges this negative OCR result');
  await h.time.advance(500);
  assert.equal(h.captures.find(c => c.at === 10890).settings.roi.height, 1);
  assert.ok(h.captures.find(c => c.at === 11140).settings.roi.height < .1);
  assert.equal(h.controller.snapshot().actionable, false);
  assert.ok(h.captures.slice(3).every(c => c.settings.skipUnchanged === false));
  h.setPanel('reroll'); await h.time.advance(230);
  assert.equal(h.controller.snapshot().phase, 'preview');
  assert.ok(h.overlays.at(-1).payload.cards.every(card => card.score === null));
  await h.time.advance(100);
  assert.equal(h.controller.snapshot().phase, 'confirmed');
  assert.deepEqual(h.state.candidates.map(id => db.augmentMap.get(id).name), reroll);
});

test('old positive acknowledgements neither retarget a new row nor revoke its record permission', async t => {
  const h = harness(); t.after(h.stop); await h.start(); await h.time.advance(190);
  const old = structuredClone(h.overlays.at(-1).payload);
  h.setPanel('reroll'); await h.time.advance(350);
  assert.equal(h.controller.snapshot().phase, 'confirmed');
  old.layout.boxes.forEach(box => { box.y = 50; });
  h.runtime.acceptLayout(old); h.press(1); await h.time.advance(10);
  assert.deepEqual(h.records, [1]);
  assert.deepEqual(h.state.selected.map(id => db.augmentMap.get(id).name), [reroll[1]]);
  await h.time.advance(700);
  assert.equal(h.controller.snapshot().actionable, false);
  assert.equal(h.controller.snapshot().confirmationPending, false);
  assert.equal(h.captures.at(-1).settings.roi.height, 1, 'already recorded panel also supplies negative scheduler verdicts');
});

test('foreground out-and-back rejects old ROI hints and begins with an uncached wide capture', async t => {
  const h = harness(); t.after(h.stop); await h.start(); await h.time.advance(190);
  const old = structuredClone(h.overlays.at(-1).payload);
  h.setForeground(false); await h.time.advance(10);
  assert.equal(h.controller.snapshot().phase, 'suspended');
  h.setForeground(true); await h.time.advance(50);
  h.runtime.acceptLayout(old); h.press(0); await h.time.advance(140);
  assert.equal(h.captures.at(-1).at, 10390);
  assert.deepEqual(h.captures.at(-1).settings.roi, full);
  assert.equal(h.captures.at(-1).settings.skipUnchanged, false);
  assert.deepEqual(h.records, []);
});

test('resize invalidates cache immediately and never sends metadata-only screenshot replies into OCR', async t => {
  const h = harness(); t.after(h.stop); await h.start(); await h.time.advance(190);
  const before = h.ocrCount;
  h.resize(2560, 1440); await h.time.advance(200);
  assert.equal(h.ocrCount, before);
  assert.equal(h.controller.snapshot().display, false);
  h.press(0); await h.time.advance(250);
  assert.deepEqual(h.records, []);
  assert.deepEqual(h.captures.at(-1).settings.roi, full);
  assert.equal(h.captures.at(-1).settings.skipUnchanged, false);
});

test('40/65 pixel OCR box jitter expands a title band once, retains it, and then permits unchanged-image heartbeats', async t => {
  const h = harness({ heightFor: call => call % 2 ? 40 : 65 }); t.after(h.stop); await h.start(); await h.time.advance(1500);
  assert.equal(h.ocrCount, 3, 'a shrinking OCR box must not churn ROI fingerprints forever');
  assert.ok(h.events.filter(e => e.type === 'heartbeat').length >= 3);
  assert.ok(h.captures[2].settings.roi.height > h.captures[1].settings.roi.height);
  assert.deepEqual(h.captures[2].settings.roi, h.captures[3].settings.roi);
  assert.equal(h.maxActiveOcr, 1);
  const region = titleRegion({ width: 2560, height: 1440, boxes: [500, 1200, 2000].map(x => ({ x, y: 820, width: 60, height: 40 })) });
  assert.equal(region.x, 0); assert.equal(region.width, 1, 'long rerolled names cannot fall outside a previous short-name horizontal crop');
});
