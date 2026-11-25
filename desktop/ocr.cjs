'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const unpack = value => value.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function geometry(item, transform) {
  const b = item?.bbox;
  if (!b || ![b.x0, b.y0, b.x1, b.y1].every(Number.isFinite) || b.x1 <= b.x0 || b.y1 <= b.y0) return null;
  return { text: String(item.text || '').trim(), x: transform.x + b.x0 * transform.sx, y: transform.y + b.y0 * transform.sy,
    width: (b.x1 - b.x0) * transform.sx, height: (b.y1 - b.y0) * transform.sy,
    confidence: Number.isFinite(item.confidence) ? item.confidence : null };
}

function toFrame(data, shot) {
  const lines = [];
  const width = shot.sourceWidth || shot.width, height = shot.sourceHeight || shot.height;
  const crop = shot.crop || { x: 0, y: 0, width, height };
  const transform = { x: crop.x, y: crop.y, sx: crop.width / shot.width, sy: crop.height / shot.height };
  for (const block of data.blocks || []) for (const paragraph of block.paragraphs || []) for (const line of paragraph.lines || []) {
    const box = geometry(line, transform);
    if (box?.text) lines.push({ ...box, words: (line.words || []).map(word => geometry(word, transform)).filter(Boolean) });
  }
  // Do not forward image bytes to the UI, persist them, or upload them.
  return { text: String(data.text || '').slice(0, 30000), lines, width, height,
    imageWidth: shot.width, imageHeight: shot.height, sourceWidth: width, sourceHeight: height, windowId: shot.windowId,
    capturedAt: shot.capturedAt, timestamp: shot.timestamp, crop, bounds: shot.bounds, clientBounds: shot.clientBounds || shot.bounds,
    foreground: shot.foreground, fingerprint: shot.fingerprint, timings: { ...shot.timings, ocrMs: data.ocrMs },
    engine: 'Tesseract.js 7 / local WASM', language: 'chi_sim' };
}

function createLocalOcr({ langPath = unpack(path.join(__dirname, '../app/data/ocr')), timeoutMs = 20000 } = {}) {
  let worker = null, initializing = null, ready = false, generation = 0, nextId = 0;
  const pending = new Map();
  const retiring = new Set();
  const capabilities = () => ({ available: true, engine: 'Tesseract.js 7', languages: ['chi_sim'] });

  // Own the outer thread from its creation, before Tesseract returns its async
  // worker handle. Terminating this thread also terminates its nested workers.
  function closeWorker(instance, error) {
    if (!instance) return;
    if (worker === instance) { worker = null; initializing = null; ready = false; generation++; }
    for (const [id, request] of pending) {
      if (request.worker !== instance) continue;
      pending.delete(id); clearTimeout(request.timer); request.reject(error);
    }
    const termination = Promise.resolve().then(() => instance.terminate()).catch(() => {});
    retiring.add(termination);
    termination.finally(() => retiring.delete(termination));
  }

  function ensureWorker() {
    if (worker) return worker;
    const instance = new Worker(unpack(path.join(__dirname, 'ocr-worker.cjs')), { workerData: { langPath } });
    worker = instance;
    instance.on('message', message => {
      if (worker !== instance) return;
      if (message?.type === 'fatal') {
        closeWorker(instance, new Error(String(message.message || '本地 OCR 引擎异常')));
        return;
      }
      const request = pending.get(message?.id);
      if (!request || request.worker !== instance) return;
      if (message.ok !== true) {
        closeWorker(instance, new Error(String(message.error || '本地 OCR 处理失败')));
        return;
      }
      pending.delete(message.id); clearTimeout(request.timer); request.resolve(message.result);
    });
    instance.on('error', error => { if (worker === instance) closeWorker(instance, new Error(`本地 OCR 线程异常：${error.message}`)); });
    instance.on('exit', () => { if (worker === instance) closeWorker(instance, new Error('本地 OCR 线程意外退出，请重新开启识别')); });
    return instance;
  }

  function request(instance, action, fields = {}) {
    if (worker !== instance) return Promise.reject(new Error('本地识别已停止'));
    if (pending.size >= 4) return Promise.reject(new Error('本地 OCR 正忙，请稍后重试'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const label = action === 'initialize' ? '初始化本地 OCR' : '本地 OCR';
      const timer = setTimeout(() => closeWorker(instance, new Error(`${label}超时，请停止后重新启动识别`)), timeoutMs);
      pending.set(id, { worker: instance, resolve, reject, timer });
      try { instance.postMessage({ id, action, ...fields }); }
      catch (error) { closeWorker(instance, error); }
    });
  }

  function initialize() {
    if (worker && ready) return Promise.resolve(capabilities());
    if (initializing) return initializing;
    let instance;
    try { instance = ensureWorker(); } catch (error) { return Promise.reject(error); }
    const token = generation;
    const job = request(instance, 'initialize').then(() => {
      if (worker !== instance || token !== generation) throw new Error('本地识别已停止');
      ready = true;
      return capabilities();
    });
    const tracked = job.finally(() => { if (initializing === tracked) initializing = null; });
    initializing = tracked;
    return tracked;
  }

  async function recognize(shot) {
    if (!shot || typeof shot.imageBase64 !== 'string' || shot.imageBase64.length > 32 * 1024 * 1024
      || ![shot.width, shot.height].every(n => Number.isInteger(n) && n > 0 && n <= 8192)) throw new Error('截图格式无效');
    const bytes = Buffer.from(shot.imageBase64, 'base64');
    if (bytes.length < 8 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('截图不是有效的 PNG');
    const token = generation;
    await initialize();
    if (token !== generation || !worker || !ready) throw new Error('本地识别已停止');
    const result = await request(worker, 'recognize', { image: bytes });
    if (token !== generation) throw new Error('本地识别已停止');
    return toFrame(result, shot);
  }

  function stop() {
    if (worker) closeWorker(worker, new Error('本地识别已停止'));
    else generation++;
    // State cancellation is synchronous. Tests/shutdown callers may also await
    // this promise to verify both the host and nested Tesseract threads exited.
    return Promise.all([...retiring]).then(() => {});
  }
  return { initialize, recognize, stop };
}

module.exports = { createLocalOcr, toFrame };
