import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createLocalOcr, toFrame } = require('../desktop/ocr.cjs');
const sourcePath = fileURLToPath(new URL('../desktop/ocr.cjs', import.meta.url));
const source = await readFile(sourcePath, 'utf8');
const validModels = fileURLToPath(new URL('../app/data/ocr/', import.meta.url));
const tick = () => new Promise(resolve => setImmediate(resolve));
const fakeShot = () => ({ imageBase64: Buffer.from([137,80,78,71,13,10,26,10]).toString('base64'), width: 100, height: 100, windowId: '123' });

test('narrow and scaled OCR rectangles map lines and words back to full-client coordinates', () => {
  const data = { text: '捐赠', ocrMs: 50, blocks: [{ paragraphs: [{ lines: [{ text: '捐赠', confidence: 93,
    bbox: { x0: 20, y0: 10, x1: 80, y1: 30 }, words: [{ text: '捐赠', bbox: { x0: 20, y0: 10, x1: 80, y1: 30 } }] }] }] }] };
  const bounds = { x: -2560, y: 0, width: 2560, height: 1440 };
  const frame = toFrame(data, { width: 1000, height: 60, sourceWidth: 2560, sourceHeight: 1440,
    crop: { x: 200, y: 600, width: 2000, height: 120 }, bounds, foreground: true, fingerprint: 'fresh' });
  assert.equal(frame.width, 2560); assert.equal(frame.height, 1440);
  assert.equal(frame.imageHeight, 60);
  assert.deepEqual(frame.lines[0], { text: '捐赠', confidence: 93, x: 240, y: 620, width: 120, height: 40,
    words: [{ text: '捐赠', confidence: null, x: 240, y: 620, width: 120, height: 40 }] });
  assert.deepEqual(frame.bounds, bounds);
  assert.equal(frame.fingerprint, 'fresh');
  assert.equal(frame.foreground, true);
  assert.equal(frame.timings.ocrMs, 50);
});

function fakeService(handle, options = {}) {
  const workers = [];
  class FakeWorker extends EventEmitter {
    constructor(path, settings) { super(); this.path = path; this.settings = settings; this.requests = []; this.terminated = false; workers.push(this); }
    postMessage(message) { this.requests.push(message); handle?.(this, message, workers.length); }
    reply(message, result = true) { this.emit('message', { id: message.id, ok: true, result }); }
    terminate() { this.terminated = true; queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1); }
  }
  const fakeRequire = spec => spec === 'node:worker_threads' ? { Worker: FakeWorker } : require(spec);
  const context = { require: fakeRequire, module: { exports: {} }, __dirname: dirname(sourcePath), Buffer, setTimeout, clearTimeout };
  vm.runInNewContext(source, context, { filename: sourcePath });
  return { service: context.module.exports.createLocalOcr(options), workers };
}

test('initialization shares one owned host and stop kills it even before readiness', async () => {
  const { service, workers } = fakeService();
  const first = service.initialize();
  const second = service.initialize();
  assert.equal(first, second);
  const stopped = assert.rejects(first, /已停止/);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].requests[0].action, 'initialize');
  await service.stop();
  await stopped;
  assert.equal(workers[0].terminated, true);
});

test('a canceled initialization cannot stop or reset an immediately restarted host', async t => {
  const { service, workers } = fakeService((worker, message, number) => { if (number > 1) worker.reply(message); });
  t.after(() => service.stop());
  const first = service.initialize();
  const stopped = assert.rejects(first, /已停止/);
  const termination = service.stop();
  const restarted = service.initialize();
  assert.equal((await restarted).available, true);
  await termination; await stopped;
  assert.equal(workers.length, 2);
  assert.equal(workers[1].terminated, false);
  workers[0].emit('message', { type: 'fatal', message: 'late obsolete failure' });
  workers[0].reply(workers[0].requests[0]);
  assert.equal((await service.initialize()).available, true);
  assert.equal(workers.length, 2);
});

test('an initialization hang times out, terminates the host, and allows retry', async t => {
  const { service, workers } = fakeService((worker, message, number) => { if (number > 1) worker.reply(message); }, { timeoutMs: 15 });
  t.after(() => service.stop());
  await assert.rejects(service.initialize(), /超时/);
  await tick();
  assert.equal(workers[0].terminated, true);
  assert.equal((await service.initialize()).available, true);
  assert.equal(workers.length, 2);
});

test('Tesseract fatal initialization errors terminate the host before its handle is ready', async t => {
  const { service, workers } = fakeService((worker, message, number) => {
    if (number === 1) queueMicrotask(() => worker.emit('message', { type: 'fatal', message: 'bad traineddata' }));
    else worker.reply(message);
  });
  t.after(() => service.stop());
  await assert.rejects(service.initialize(), /bad traineddata/);
  await tick();
  assert.equal(workers[0].terminated, true);
  assert.equal((await service.initialize()).available, true);
});

test('worker error events and early exits become recoverable initialization failures', async t => {
  const { service, workers } = fakeService((worker, message, number) => {
    if (number === 1) queueMicrotask(() => worker.emit('error', new Error('module load failure')));
    else if (number === 2) queueMicrotask(() => worker.emit('exit', 1));
    else worker.reply(message);
  });
  t.after(() => service.stop());
  await assert.rejects(service.initialize(), /module load failure/);
  await assert.rejects(service.initialize(), /意外退出/);
  assert.equal((await service.initialize()).available, true);
  assert.equal(workers.length, 3);
});

test('stop cancels an in-flight recognition and ignores its late image result', async () => {
  const { service, workers } = fakeService((worker, message) => { if (message.action === 'initialize') worker.reply(message); });
  await service.initialize();
  const result = service.recognize(fakeShot());
  const stopped = assert.rejects(result, /已停止/);
  await tick();
  const request = workers[0].requests.at(-1);
  assert.equal(request.action, 'recognize');
  await service.stop();
  workers[0].reply(request, { text: 'late text', blocks: [] });
  await stopped;
  assert.equal(workers[0].terminated, true);
});

test('real missing model files reject and leave no worker behind', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hex-ocr-missing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = createLocalOcr({ langPath: directory });
  await assert.rejects(service.initialize(), /ENOENT/);
  await service.stop();
  assert.equal(process.report.getReport().workers.length, 0);
});

test('real Tesseract initialization failure kills nested workers and can retry corrected models', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hex-ocr-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('invalid traineddata used to test failed Tesseract initialization');
  await writeFile(join(directory, 'chi_sim.traineddata'), bytes);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ files: [{ file: 'chi_sim.traineddata', sha256: createHash('sha256').update(bytes).digest('hex') }] }));
  const service = createLocalOcr({ langPath: directory });
  t.after(() => service.stop());
  await assert.rejects(service.initialize(), /本地 OCR 引擎/);
  await service.stop();
  assert.equal(process.report.getReport().workers.length, 0, 'failed initialization must not retain the outer or nested Tesseract worker');
  await copyFile(join(validModels, 'manifest.json'), join(directory, 'manifest.json'));
  await copyFile(join(validModels, 'chi_sim.traineddata'), join(directory, 'chi_sim.traineddata'));
  assert.equal((await service.initialize()).available, true);
  const live = process.report.getReport().workers;
  assert.equal(live.length, 1, 'one parent-owned OCR host');
  assert.equal(live[0].workers.length, 1, 'one real Tesseract child thread inside the host');
  await service.stop();
  assert.equal(process.report.getReport().workers.length, 0, 'awaited stop must destroy both threads');
});

test('real initialization can be stopped immediately without leaving an owned worker', async () => {
  const service = createLocalOcr();
  const pending = service.initialize();
  const stopped = assert.rejects(pending, /已停止/);
  await service.stop(); await stopped;
  assert.equal(process.report.getReport().workers.length, 0);
});
