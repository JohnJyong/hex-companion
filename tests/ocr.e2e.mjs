// Real offline WASM OCR over a synthetic title image. This is not a Windows
// capture test or evidence of accuracy on live League of Legends screenshots.
import { _electron as electron } from 'playwright';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRecognitionTracker } from '../app/core/recognition.mjs';
const require = createRequire(import.meta.url);
const { createLocalOcr } = require('../desktop/ocr.cjs');
const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'hex-ocr-test-'));
await mkdir(resolve(root, 'artifacts'), { recursive: true });
await writeFile(join(temp, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:1920,height:1080,show:false,webPreferences:{sandbox:true}});w.loadURL('about:blank')});app.on('window-all-closed',()=>app.quit());`);
const app = await electron.launch({ args: [join(temp, 'main.cjs')], cwd: root });
let png;
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.setContent(`<style>body{margin:0;background:#101820;color:#f5e2b8;font-family:"Microsoft YaHei","PingFang SC",sans-serif}.titles{position:absolute;top:400px;left:260px;display:flex;gap:60px}h2{width:400px;text-align:center;font-size:38px;font-weight:600;margin:0;padding:26px 0;background:#182734;border:1px solid #685c43}</style><div class="titles"><h2>火上浇油</h2><h2>暴击律动</h2><h2>神射法师</h2></div>`);
  png = await page.screenshot({ path: resolve(root, 'artifacts/ocr-fixture.png') });
} finally { await app.close(); await rm(temp, { recursive: true, force: true }); }
const ocr = createLocalOcr();
const catalog = JSON.parse(await readFile(resolve(root, 'app/data/catalog.json'), 'utf8'));
try {
  await ocr.initialize();
  const frame = await ocr.recognize({ imageBase64: png.toString('base64'), width:1920,height:1080,sourceWidth:1920,sourceHeight:1080,windowId:'test',capturedAt:new Date().toISOString() });
  console.log('OCR text:', frame.text.trim());
  assert.ok(frame.lines.length >= 3);
  assert.equal(frame.imageBase64, undefined);
  const tracker = createRecognitionTracker(catalog);
  const first = tracker.ingest({ ...frame, captureId:1 });
  const stable = tracker.ingest({ ...frame, captureId:2 });
  assert.equal(first.status, 'stabilizing', JSON.stringify(first));
  assert.equal(stable.status, 'stable', JSON.stringify(stable));
  assert.deepEqual(stable.candidates, ['ARAM_Firebrand','CriticalRhythm','ARAM_Marksmage']);
  console.log('PASS: bundled offline OCR recognizes three Chinese titles and feeds the geometry/stability matcher');
} finally { await ocr.stop(); }
