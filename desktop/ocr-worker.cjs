'use strict';

// Runs in a parent-owned thread, so failed or stalled Tesseract initialization
// can be terminated even before createWorker() has yielded its own handle.
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { createWorker, PSM, OEM } = require('tesseract.js');
const unpack = value => value.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
let engine = null;
let failed = false;
let queue = Promise.resolve();

function fatal(error) {
  if (failed) return;
  failed = true;
  parentPort.postMessage({ type: 'fatal', message: `本地 OCR 引擎：${error instanceof Error ? error.message : String(error)}` });
}

async function initialize() {
  if (engine) return;
  const manifest = JSON.parse(await fs.readFile(path.join(workerData.langPath, 'manifest.json'), 'utf8'));
  const record = Array.isArray(manifest.files) && manifest.files.find(file => file.file === 'chi_sim.traineddata');
  const bytes = await fs.readFile(path.join(workerData.langPath, 'chi_sim.traineddata'));
  if (!record || createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw new Error('本地 OCR 模型不完整，请重新解压软件完整文件夹');
  engine = await createWorker(['chi_sim'], OEM.LSTM_ONLY, {
    workerPath: unpack(require.resolve('tesseract.js/src/worker-script/node/index.js')),
    langPath: workerData.langPath, gzip: false, cacheMethod: 'none', logger: () => {}, errorHandler: fatal,
  });
  await engine.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '1', user_defined_dpi: '150' });
}

parentPort.on('message', message => {
  queue = queue.then(async () => {
    if (failed) return;
    try {
      if (message.action === 'initialize') {
        await initialize();
        if (!failed) parentPort.postMessage({ id: message.id, ok: true, result: true });
      } else if (message.action === 'recognize' && engine) {
        const started = Date.now();
        const result = await engine.recognize(Buffer.from(message.image), {}, { text: true, blocks: true });
        // Images and binary buffers stay inside the workers and main process.
        if (!failed) parentPort.postMessage({ id: message.id, ok: true, result: { text: result.data.text, blocks: result.data.blocks, ocrMs: Date.now() - started } });
      } else {
        throw new Error('本地 OCR 尚未就绪或请求无效');
      }
    } catch (error) { fatal(error); }
  });
});
