// Real local OCR benchmark. No game client, GDI capture, overlays or network.
// Input images remain local; reports contain timings/hashes/candidate IDs only.
// Example:
// node scripts/bench-recognition.mjs --image /absolute/game.png \
//   --expected ARAM_Upgrade_IE,PatOnTheBack,Donation --runs 8 --cold-runs 3 --label baseline
import { _electron as electron } from 'playwright';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

const root = resolve(import.meta.dirname, '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (key === '--help') {
    console.log('node scripts/bench-recognition.mjs --image game.png --expected ID1,ID2,ID3 [--runs 8] [--cold-runs 3] [--label baseline] [--source-root saved-source-folder]');
    console.log('Cold = fresh OCR worker/model initialization, not cleared OS disk caches. Source snapshots isolate concurrent edits. Only image OCR + title matching are timed.');
    process.exit(0);
  }
  if (!['--image', '--expected', '--runs', '--cold-runs', '--label', '--source-root'].includes(key) || !process.argv[i + 1]) throw new Error(`Unknown or missing argument: ${key}`);
  args[key.slice(2)] = process.argv[i + 1];
}
const input = args.image || process.env.HEX_OCR_BENCH_IMAGE;
if (!input) throw new Error('Supply --image with an existing local PNG; no private temporary screenshot path is assumed.');
const expected = (args.expected || 'ARAM_Upgrade_IE,PatOnTheBack,Donation').split(',');
if (expected.length !== 3 || new Set(expected).size !== 3) throw new Error('--expected must contain three distinct catalog IDs in left-to-right order');
const runs = Number(args.runs || 8), coldRuns = Number(args['cold-runs'] || 3);
if (![runs, coldRuns].every(n => Number.isInteger(n) && n >= 1 && n <= 30)) throw new Error('Run counts must be integers from 1 to 30');
const label = args.label || 'current';
if (!/^[a-zA-Z0-9_-]{1,60}$/.test(label)) throw new Error('Label must use 1–60 letters, digits, hyphens or underscores');
const source = args['source-root'] ? resolve(args['source-root']) : root;
const sha = value => createHash('sha256').update(value).digest('hex');
const round = n => Math.round(n * 100) / 100;
const bytes = await readFile(resolve(input));
if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Benchmark input must be a PNG');
const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
if (width < 100 || height < 100 || width > 8192 || height > 8192) throw new Error('Input dimensions must fit the production OCR limits');
const catalogRaw = await readFile(join(root, 'app/data/catalog.json'));
const catalog = JSON.parse(catalogRaw);
for (const id of expected) if (!catalog.augments.some(a => a.id === id)) throw new Error(`Unknown expected augment: ${id}`);
await mkdir(join(root, '.cache'), { recursive: true });
await mkdir(join(root, 'artifacts'), { recursive: true });
const temporary = await mkdtemp(join(root, '.cache/recognition-bench-'));
const snapshot = join(temporary, 'desktop');
await mkdir(snapshot);
const sourceHashes = {};
for (const file of await readdir(join(source, 'desktop'))) {
  if (!file.endsWith('.cjs')) continue;
  const raw = await readFile(join(source, 'desktop', file));
  await writeFile(join(snapshot, file), raw);
  if (['ocr.cjs', 'ocr-worker.cjs', 'live-runtime.cjs'].includes(file)) sourceHashes[file] = sha(raw);
}
const matcherPath = args['source-root'] ? join(source, 'recognition.mjs') : join(root, 'app/core/recognition.mjs');
const matcherRaw = await readFile(matcherPath);
await writeFile(join(temporary, 'recognition.mjs'), matcherRaw);
sourceHashes['recognition.mjs'] = sha(matcherRaw);
sourceHashes['catalog.json'] = sha(catalogRaw);
const require = createRequire(import.meta.url);
const { createLocalOcr } = require(join(snapshot, 'ocr.cjs'));
const { titleRegion } = require(join(snapshot, 'live-runtime.cjs'));
const { matchAugmentFrame, createRecognitionTracker } = await import(pathToFileURL(join(temporary, 'recognition.mjs')).href);
const newOcr = () => createLocalOcr({ langPath: join(root, 'app/data/ocr') });
const fullRegion = { x: 0, y: 0, width: 1, height: 1 };
let captureId = 0;
function shot(imageBase64, crop = { x: 0, y: 0, width, height }) {
  return { imageBase64, width: crop.width, height: crop.height, sourceWidth: width, sourceHeight: height,
    crop, windowId: 'offline-benchmark', foreground: true, captureId: ++captureId,
    capturedAt: new Date().toISOString(), timestamp: Date.now(), bounds: { x: 0, y: 0, width, height } };
}
const fullShot = shot(bytes.toString('base64'));
const samples = [];
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { min: round(sorted[0]), median: round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2),
    p95: round(sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)]), max: round(sorted.at(-1)) };
}
async function measured(ocr, imageShot, group, expectedIds = expected) {
  const started = performance.now();
  const frame = await ocr.recognize({ ...imageShot, captureId: ++captureId, capturedAt: new Date().toISOString() });
  const ocrMs = performance.now() - started;
  const matched = matchAugmentFrame(frame, catalog, { roi: fullRegion });
  const totalMs = performance.now() - started;
  const hit = matched.status === 'matched' && matched.candidates.join('|') === expectedIds.join('|');
  samples.push({ group, ocrWallMs: round(ocrMs), workerOcrMs: frame.timings?.ocrMs ?? null,
    matchMs: round(totalMs - ocrMs), totalMs: round(totalMs), hit,
    status: matched.status, code: matched.code, candidates: matched.candidates,
    qualities: matched.matches.map(m => m.quality) });
  return { frame, matched, hit };
}

const loadBefore = os.loadavg();
try {
  // Calibration is real OCR, excluded from comparison samples and identified.
  const calibration = newOcr();
  let observed;
  try {
    await calibration.initialize();
    observed = await measured(calibration, fullShot, 'calibration-full');
  } finally { await calibration.stop(); }
  if (!observed.hit) throw new Error(`Input calibration missed expected titles: ${JSON.stringify(observed.matched.candidates)}`);
  const roi = titleRegion({ width, height, boxes: observed.matched.matches.map(m => m.box) }, fullRegion);
  if (!roi) throw new Error('Production titleRegion could not derive a band');
  const x = Math.floor(roi.x * width), y = Math.floor(roi.y * height);
  // Match the Windows capture helper's Floor-based pixel rounding.
  const crop = { x, y, width: Math.min(width - x, Math.floor(roi.width * width)),
    height: Math.min(height - y, Math.floor(roi.height * height)) };

  // Image preparation is outside OCR measurements. Canvas uses original pixels;
  // the reordered version is a synthetic perturbation, not a real reroll video.
  await writeFile(join(temporary, 'prepare.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{new BrowserWindow({show:false,webPreferences:{sandbox:true}}).loadURL('about:blank')});app.on('window-all-closed',()=>app.quit());`);
  const helper = await electron.launch({ args: [join(temporary, 'prepare.cjs')], cwd: root, timeout: 30000 });
  let prepared;
  try {
    const page = await helper.firstWindow();
    prepared = await page.evaluate(async ({ base64, width, height, crop }) => {
      const sourceImage = new Image(); sourceImage.src = `data:image/png;base64,${base64}`; await sourceImage.decode();
      const reordered = document.createElement('canvas'); reordered.width = width; reordered.height = height;
      const ctx = reordered.getContext('2d');
      const edges = [0, Math.round(width / 3), Math.round(width * 2 / 3), width];
      for (const [target, from] of [[0, 1], [1, 0], [2, 2]]) {
        ctx.drawImage(sourceImage, edges[from], 0, edges[from + 1] - edges[from], height,
          edges[target], 0, edges[target + 1] - edges[target], height);
      }
      const band = document.createElement('canvas'); band.width = crop.width; band.height = crop.height;
      const bandCtx = band.getContext('2d');
      const encode = source => {
        bandCtx.clearRect(0, 0, crop.width, crop.height);
        bandCtx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
        return band.toDataURL('image/png').split(',')[1];
      };
      return { original: encode(sourceImage), reordered: encode(reordered) };
    }, { base64: fullShot.imageBase64, width, height, crop });
  } finally { await helper.close(); }
  const bandShot = shot(prepared.original, crop), rerollShot = shot(prepared.reordered, crop);
  const reorderedExpected = [expected[1], expected[0], expected[2]];
  for (let i = 0; i < coldRuns; i++) for (const [name, imageShot] of [['cold-full', fullShot], ['cold-band', bandShot]]) {
    const ocr = newOcr(), started = performance.now();
    try {
      await ocr.initialize();
      const initializeMs = performance.now() - started;
      await measured(ocr, imageShot, name);
      Object.assign(samples.at(-1), { initializeMs: round(initializeMs), readyAndFirstResultMs: round(performance.now() - started) });
    } finally { await ocr.stop(); }
  }
  const warm = newOcr();
  try {
    await warm.initialize();
    await measured(warm, fullShot, 'warmup-full');
    await measured(warm, bandShot, 'warmup-band');
    // Alternate order to reduce systematic CPU warmup/order bias.
    for (let i = 0; i < runs; i++) {
      for (const mode of i % 2 ? ['band', 'full'] : ['full', 'band']) {
        await measured(warm, mode === 'full' ? fullShot : bandShot, `hot-${mode}`);
      }
    }
    const before = createRecognitionTracker(catalog, { roi: fullRegion });
    const stillStates = [];
    for (let i = 0; i < 4; i++) {
      const result = await measured(warm, bandShot, 'static-band');
      stillStates.push(before.ingest({ ...result.frame, captureId: ++captureId }).status);
    }
    const rerollStates = [];
    for (let i = 0; i < 3; i++) {
      const result = await measured(warm, rerollShot, 'synthetic-reorder-band', reorderedExpected);
      rerollStates.push(before.ingest({ ...result.frame, captureId: ++captureId }).status);
    }
    const groups = {};
    for (const name of new Set(samples.map(s => s.group))) {
      const rows = samples.filter(s => s.group === name);
      groups[name] = { n: rows.length, hits: rows.filter(s => s.hit).length,
        ocrWallMs: summarize(rows.map(s => s.ocrWallMs)), totalMs: summarize(rows.map(s => s.totalMs)) };
      if (rows[0].initializeMs !== undefined) Object.assign(groups[name], {
        initializeMs: summarize(rows.map(s => s.initializeMs)), readyAndFirstResultMs: summarize(rows.map(s => s.readyAndFirstResultMs)) });
    }
    const report = { schema: 1, label, measuredAt: new Date().toISOString(),
      environment: { platform: process.platform, arch: process.arch, osRelease: os.release(), node: process.version,
        cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, loadBefore, loadAfter: os.loadavg() },
      image: { name: basename(input), sha256: sha(bytes), width, height, bytes: bytes.length, expected },
      titleCrop: crop, titleBandSha256: sha(Buffer.from(prepared.original, 'base64')), sourceHashes,
      model: JSON.parse(await readFile(join(root, 'app/data/ocr/manifest.json'), 'utf8')),
      groups, samples, staticTrackerStates: stillStates, syntheticReorderTrackerStates: rerollStates,
      hotMedianSpeedup: round(groups['hot-full'].ocrWallMs.median / groups['hot-band'].ocrWallMs.median),
      limitations: ['Single provided static screenshot; not live Windows capture or end-to-end game latency.',
        'Cold means a fresh OCR worker and model; OS file caches are not cleared.',
        'Image decode/crop preparation, screenshots, scheduling and overlays are excluded.',
        'Static and reordered images are deliberately re-OCRed; no runtime fingerprint-skip speedup is claimed.',
        'Reordered columns simulate a changed candidate order using source pixels, not a real reroll animation.',
        'Source code is snapshotted before measurement; concurrent machine load can affect timings.'] };
    const output = join(root, 'artifacts', `bench-recognition-${label}.json`);
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Input ${width}×${height}; title band ${crop.width}×${crop.height} at ${crop.x},${crop.y}; ${process.platform}/${process.arch}`);
    for (const [group, result] of Object.entries(groups)) {
      console.log(`${group}: hits ${result.hits}/${result.n}; OCR median ${result.ocrWallMs.median}ms p95 ${result.ocrWallMs.p95}ms`
        + (result.initializeMs ? `; init median ${result.initializeMs.median}ms; ready+first ${result.readyAndFirstResultMs.median}ms` : ''));
    }
    console.log(`Hot title/full speed ratio: ${report.hotMedianSpeedup}×; static states: ${stillStates.join('→')}; reordered: ${rerollStates.join('→')}`);
    console.log(`Report: ${output}`);
    console.log('LIMIT: one offline image on this host; not Windows capture, hotkey, reroll-animation or in-game overlay performance.');
    if (samples.some(s => !s.hit)) process.exitCode = 1;
  } finally { await warm.stop(); }
} finally { await rm(temporary, { recursive: true, force: true }); }
