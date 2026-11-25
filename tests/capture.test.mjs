import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { createCaptureService, validateWindowId, validateRoi } = require('../desktop/capture.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function mockWorkers(handleRequest) {
  const workers = [];
  const spawns = [];
  const spawnImpl = (...args) => {
    spawns.push(args);
    const worker = new EventEmitter();
    worker.stdin = new EventEmitter();
    worker.stdout = new PassThrough();
    worker.stderr = new PassThrough();
    worker.requests = [];
    worker.killed = false;
    worker.stdin.end = () => {};
    worker.kill = () => { worker.killed = true; queueMicrotask(() => worker.emit('exit', 0)); };
    worker.reply = (request, result, error) => worker.stdout.write(JSON.stringify({ id: request.id, ok: !error, result, error }) + '\n');
    worker.stdin.write = (line, encoding, callback) => {
      const request = JSON.parse(line);
      worker.requests.push(request);
      callback?.();
      handleRequest?.(worker, request, workers.length);
      return true;
    };
    workers.push(worker);
    return worker;
  };
  return { workers, spawns, spawnImpl };
}

test('non-Windows reports the requirement and never starts a helper', async () => {
  const mock = mockWorkers();
  const service = createCaptureService({ platform: 'darwin', spawnImpl: mock.spawnImpl });
  const result = await service.capabilities();
  assert.equal(result.available, false);
  assert.equal(result.code, 'WINDOWS_REQUIRED');
  assert.equal(result.engine, 'GDI');
  await assert.rejects(service.listWindows(), { code: 'WINDOWS_REQUIRED' });
  await assert.rejects(service.captureWindow('123'), { code: 'WINDOWS_REQUIRED' });
  assert.equal(mock.workers.length, 0);
});

test('rejects command-like window IDs and invalid crop geometry before spawning', async () => {
  const mock = mockWorkers();
  const service = createCaptureService({ platform: 'win32', spawnImpl: mock.spawnImpl });
  for (const id of ['123; exit', '-1', '0', '1\n2', '9223372036854775808', 123]) {
    await assert.rejects(service.captureWindow(id), { code: 'INVALID_WINDOW' });
  }
  for (const roi of [{ x: 0, y: 0, width: Infinity, height: 1 }, { x: .5, y: 0, width: .6, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, []]) {
    await assert.rejects(service.captureWindow('123', { roi }), { code: 'INVALID_ROI' });
  }
  assert.equal(validateWindowId('9223372036854775807'), '9223372036854775807');
  assert.deepEqual(validateRoi({ x: .2, y: .1, width: .6, height: .8, extra: 'discarded' }), { x: .2, y: .1, width: .6, height: .8 });
  assert.equal(mock.workers.length, 0);
});

test('uses one persistent helper and serializes concurrent requests', async t => {
  const mock = mockWorkers();
  const service = createCaptureService({ platform: 'win32', spawnImpl: mock.spawnImpl, scriptPath: 'C:\\App Files\\recognize.ps1' });
  t.after(() => service.stop());
  const listing = service.listWindows();
  const shot = service.captureWindow('123', { roi: { x: .1, y: .2, width: .8, height: .6 } });
  await tick();
  assert.equal(mock.workers.length, 1);
  const worker = mock.workers[0];
  assert.equal(worker.requests.length, 1);
  assert.equal(worker.requests[0].action, 'listWindows');
  worker.reply(worker.requests[0], [{ id: '123', title: '英雄联盟' }]);
  assert.deepEqual(await listing, [{ id: '123', title: '英雄联盟' }]);
  await tick();
  assert.equal(worker.requests.length, 2);
  assert.equal(worker.requests[1].action, 'capturePixels');
  assert.deepEqual(worker.requests[1].roi, { x: .1, y: .2, width: .8, height: .6 });
  const frame = { imageBase64: 'iVBORw0KGgo=', width: 1920, height: 1080, sourceWidth: 1920, sourceHeight: 1080,
    windowId: '123', capturedAt: '2026-11-17T10:00:00.000Z', crop: { x: 0, y: 0, width: 1920, height: 1080 }, engine: 'GDI' };
  worker.reply(worker.requests[1], frame);
  assert.deepEqual(await shot, frame);
  assert.equal(mock.spawns[0][2].shell, false);
  assert.equal(mock.spawns[0][2].windowsHide, true);
  assert.equal(mock.spawns[0][1].at(-1), 'C:\\App Files\\recognize.ps1');
  assert.ok(!mock.spawns[0][1].includes('123'));
});

test('preserves UTF-8 titles when the protocol splits a Chinese character between chunks', async t => {
  const mock = mockWorkers((worker, request) => {
    const bytes = Buffer.from(JSON.stringify({ id: request.id, ok: true, result: [{ id: '123', title: '英雄联盟' }] }) + '\n');
    const split = bytes.indexOf(Buffer.from('英')) + 1;
    worker.stdout.write(bytes.subarray(0, split));
    worker.stdout.write(bytes.subarray(split));
  });
  const service = createCaptureService({ platform: 'win32', spawnImpl: mock.spawnImpl });
  t.after(() => service.stop());
  assert.deepEqual(await service.listWindows(), [{ id: '123', title: '英雄联盟' }]);
});

test('restarts an unexpectedly exited helper once, preserving the request', async t => {
  const mock = mockWorkers((worker, request, number) => {
    if (number === 1) queueMicrotask(() => worker.emit('exit', 1));
    else worker.reply(request, [{ id: '123' }]);
  });
  const service = createCaptureService({ platform: 'win32', spawnImpl: mock.spawnImpl });
  t.after(() => service.stop());
  assert.deepEqual(await service.listWindows(), [{ id: '123' }]);
  assert.equal(mock.workers.length, 2);
  assert.equal(mock.workers[0].killed, true);
  assert.equal(mock.workers[1].requests[0].action, 'listWindows');
});

test('stop cancels pending and queued requests; a later explicit request may restart', async t => {
  const mock = mockWorkers();
  const service = createCaptureService({ platform: 'win32', spawnImpl: mock.spawnImpl });
  t.after(() => service.stop());
  const first = service.captureWindow('123');
  const second = service.captureWindow('123');
  const settled = Promise.allSettled([first, second]);
  await tick();
  service.stop();
  const results = await settled;
  assert.deepEqual(results.map(result => result.reason.code), ['CAPTURE_STOPPED', 'CAPTURE_STOPPED']);
  assert.equal(mock.workers.length, 1);
  assert.equal(mock.workers[0].killed, true);
  const restart = service.listWindows();
  await tick();
  assert.equal(mock.workers.length, 2);
  const worker = mock.workers[1];
  worker.reply(worker.requests[0], []);
  assert.deepEqual(await restart, []);
});

test('timeouts terminate the helper and release the queue', async t => {
  const mock = mockWorkers();
  const service = createCaptureService({ platform: 'win32', spawnImpl: mock.spawnImpl, timeoutMs: 15 });
  t.after(() => service.stop());
  await assert.rejects(service.captureWindow('123'), { code: 'CAPTURE_TIMEOUT', transient: true, category: 'error' });
  assert.equal(mock.workers.length, 1);
  assert.equal(mock.workers[0].killed, true);
  const restart = service.listWindows();
  await tick();
  mock.workers[1].reply(mock.workers[1].requests[0], []);
  assert.deepEqual(await restart, []);
});

test('structured helper errors retain actionable codes without restarting', async t => {
  const mock = mockWorkers((worker, request) => worker.reply(request, undefined, { code: 'WINDOW_NOT_FOREGROUND', message: '等待游戏回到前台',
    transient: true, category: 'paused', windowState: { windowId: '123', valid: true, foreground: false, minimized: false } }));
  const service = createCaptureService({ platform: 'win32', spawnImpl: mock.spawnImpl });
  t.after(() => service.stop());
  await assert.rejects(service.captureWindow('123'), error => error.code === 'WINDOW_NOT_FOREGROUND' && error.message === '等待游戏回到前台'
    && error.transient && error.category === 'paused' && error.windowState.foreground === false);
  assert.equal(mock.workers.length, 1);
});

test('temporary GDI failures remain retryable without being mistaken for foreground pauses', async t => {
  const responses = [
    { code: 'FRAME_EMPTY', message: '游戏截图未包含有效像素，正在等待下一帧', transient: true, category: 'capture-unavailable' },
    { code: 'CAPTURE_ERROR', message: 'GDI 暂时不可用', transient: true, category: 'error' },
    { code: 'WINDOW_CLOSED', message: '窗口已关闭', transient: false, category: 'invalid-window' },
    { code: 'WINDOWS_COMPONENT_MISSING', message: '截图组件无法初始化', transient: false, category: 'error' },
  ];
  const mock = mockWorkers((worker, request) => worker.reply(request, undefined, responses.shift()));
  const service = createCaptureService({ platform: 'win32', spawnImpl: mock.spawnImpl });
  t.after(() => service.stop());
  await assert.rejects(service.captureWindow('123'), { code: 'FRAME_EMPTY', transient: true, category: 'capture-unavailable' });
  await assert.rejects(service.captureWindow('123'), { code: 'CAPTURE_ERROR', transient: true, category: 'error' });
  await assert.rejects(service.captureWindow('123'), { code: 'WINDOW_CLOSED', transient: false, category: 'invalid-window' });
  await assert.rejects(service.captureWindow('123'), { code: 'WINDOWS_COMPONENT_MISSING', transient: false, category: 'error' });
  assert.equal(mock.workers.length, 1, 'GDI application errors do not restart the helper');
});

test('exhausted helper IO and exit retries retain a recoverable classification', async t => {
  for (const event of ['error', 'exit']) {
    const mock = mockWorkers(worker => queueMicrotask(() => worker.emit(event, event === 'error' ? new Error('pipe failed') : 1)));
    const service = createCaptureService({ platform: 'win32', spawnImpl: mock.spawnImpl });
    t.after(() => service.stop());
    await assert.rejects(service.captureWindow('123'), { code: event === 'error' ? 'HELPER_IO' : 'HELPER_EXIT', transient: true, category: 'error' });
    assert.equal(mock.workers.length, 2);
  }
});

test('window inspection and native hotkey polling do not request screenshots', async t => {
  const bounds = { x: -2560, y: 0, width: 2560, height: 1440 };
  const state = { windowId: '123', valid: true, visible: true, foreground: true, minimized: false, bounds };
  const mock = mockWorkers((worker, request) => worker.reply(request,
    request.action === 'inspectWindow' ? state : { pressed: ['toggle'], focused: true, foreground: true, windowState: state, bounds }));
  const service = createCaptureService({ platform: 'win32', spawnImpl: mock.spawnImpl });
  t.after(() => service.stop());
  assert.deepEqual(await service.inspectWindow('123'), state);
  assert.deepEqual((await service.pollHotkeys('123')).pressed, ['toggle']);
  assert.deepEqual(mock.workers[0].requests.map(request => request.action), ['inspectWindow', 'pollHotkeys']);
  await assert.rejects(service.pollHotkeys('123;anything'), { code: 'INVALID_WINDOW' });
});

test('unchanged frames retain fresh metadata without image bytes and require explicit caching', async t => {
  const fingerprint = '2200x100:' + 'A'.repeat(64);
  const bounds = { x: 0, y: 0, width: 2560, height: 1440 };
  const mock = mockWorkers((worker, request) => worker.reply(request, { unchanged: true, fingerprint, timestamp: 12345,
    bounds, foreground: true, width: 2200, height: 100, sourceWidth: 2560, sourceHeight: 1440 }));
  const service = createCaptureService({ platform: 'win32', spawnImpl: mock.spawnImpl });
  t.after(() => service.stop());
  await service.captureWindow('123', { previousFingerprint: fingerprint });
  assert.equal(mock.workers[0].requests[0].skipUnchanged, false, 'the second stabilization frame must still run OCR unless caller confirms caching');
  const shot = await service.captureWindow('123', { previousFingerprint: fingerprint, skipUnchanged: true });
  assert.equal(mock.workers[0].requests[1].skipUnchanged, true);
  assert.equal(shot.imageBase64, undefined);
  assert.deepEqual(shot.bounds, bounds);
  assert.equal(shot.timestamp, 12345);
  assert.equal(shot.foreground, true);
  await service.captureWindow('123', { previousFingerprint: 'malformed', skipUnchanged: true });
  assert.equal(mock.workers[0].requests[2].skipUnchanged, false);
});

test('malformed helper protocol fails cleanly and cannot crash the host', async t => {
  const mock = mockWorkers(worker => worker.stdout.write('null\n'));
  const service = createCaptureService({ platform: 'win32', spawnImpl: mock.spawnImpl });
  t.after(() => service.stop());
  await assert.rejects(service.listWindows(), { code: 'HELPER_PROTOCOL' });
  assert.equal(mock.workers[0].killed, true);
});

test('capabilities report GDI capture readiness without language requirements', async t => {
  const capabilities = { available: true, platform: 'win32', engine: 'GDI', message: '本地截图已就绪' };
  const mock = mockWorkers((worker, request) => {
    assert.equal(request.action, 'capabilities');
    worker.reply(request, capabilities);
  });
  const service = createCaptureService({ platform: 'win32', spawnImpl: mock.spawnImpl });
  t.after(() => service.stop());
  assert.deepEqual(await service.capabilities(), capabilities);
});

test('large in-memory image responses can exceed the former four MiB limit', async t => {
  const imageBase64 = 'A'.repeat(5 * 1024 * 1024);
  const mock = mockWorkers((worker, request) => {
    const response = JSON.stringify({ id: request.id, ok: true, result: { imageBase64, width: 2560, height: 1440, engine: 'GDI' } }) + '\n';
    for (let offset = 0; offset < response.length; offset += 65536) worker.stdout.write(response.slice(offset, offset + 65536));
  });
  const service = createCaptureService({ platform: 'win32', spawnImpl: mock.spawnImpl });
  t.after(() => service.stop());
  const frame = await service.captureWindow('123');
  assert.equal(frame.imageBase64.length, imageBase64.length);
  assert.equal(frame.engine, 'GDI');
});

test('image responses above the 32 MiB protocol limit terminate the helper', async t => {
  const mock = mockWorkers(worker => {
    for (let i = 0; i < 33; i++) worker.stdout.write('A'.repeat(1024 * 1024));
  });
  const service = createCaptureService({ platform: 'win32', spawnImpl: mock.spawnImpl });
  t.after(() => service.stop());
  await assert.rejects(service.captureWindow('123'), { code: 'HELPER_PROTOCOL' });
  assert.equal(mock.workers[0].killed, true);
});

test('PowerShell script has the BOM Windows PowerShell 5.1 needs for Chinese strings', async () => {
  const bytes = await readFile(new URL('../desktop/recognize.ps1', import.meta.url));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const source = bytes.toString('utf8');
  assert.ok(source.includes("$request.action -eq 'capturePixels'"));
  assert.ok(source.includes('[System.Drawing.Imaging.ImageFormat]::Png'));
  assert.ok(!/WindowsRuntime|Windows\.Media|OcrEngine/.test(source));
});
