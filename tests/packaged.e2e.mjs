// Loads the Windows package's platform-neutral application resources with the
// local Electron runtime. It does not execute or validate the Windows EXE.
import {manualDataProfile} from './fixtures/manual-data-profile.mjs';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { extractFile } from '@electron/asar';

const root = resolve(import.meta.dirname, '..');
const resources = resolve(root, 'release/HexCompanion-win32-x64/resources');
const archive = join(resources, 'app.asar');
const unpacked = join(resources, 'app.asar.unpacked');
const packagedJson = path => JSON.parse(extractFile(archive, path).toString('utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
assert.equal(packagedJson('package.json').version, version, 'rebuild the Windows package after source changes');
for (const file of ['desktop/main.cjs', 'desktop/preload.cjs', 'desktop/capture.cjs', 'desktop/champ-select.cjs', 'desktop/champ-select-vision.cjs', 'desktop/champ-select-overlays.cjs', 'app/app.mjs', 'app/champ-select.html', 'app/champ-select.js', 'app/champ-select.css', 'desktop/live-runtime.cjs', 'desktop/discovery-scan.cjs', 'app/core/live-controller.mjs', 'app/views.mjs', 'desktop/overlays.cjs', 'app/overlay.html', 'app/overlay.js', 'app/overlay.css', 'app/overlay-theme.css',
  'app/build-overlay.html', 'app/build-overlay.js', 'app/build-overlay.css', 'app/core/engine.mjs', 'app/core/augment-rules.mjs', 'app/core/live-game.mjs', 'app/core/augment-stats.mjs', 'app/core/item-stats.mjs', 'app/core/guides.mjs', 'app/guide-views.mjs',
  'app/data/community-guides.json', 'app/data/editorial-guides.json']) {
  assert.equal(digest(extractFile(archive, file)), digest(await readFile(join(root, file))), `${file} must match the tested source`);
}
for (const name of ['champion-stats', 'augment-stats', 'item-stats']) {
  const file = `app/data/${name}.json`, bytes = extractFile(archive, file), data = JSON.parse(bytes.toString('utf8'));
  assert.equal(digest(bytes), digest(await readFile(join(root, file))), `${name} must include the complete current snapshot`);
  assert.equal(data.meta.mode, 'KIWI');
  assert.equal(data.meta.rule, 'normal');
  assert.equal(data.meta.band, 'all');
  assert.equal(data.meta.patch, '16.22');
  assert.equal(data.meta.asOf, '2026-11-15T17:00:00+08:00');
  assert.equal(data.meta.source.nonCommercialOnly, true);
  assert.equal(data.meta.source.license, 'CC BY-NC 4.0');
  if (name === 'champion-stats') assert.equal(Object.keys(data.heroes).length, 173);
  if (name === 'augment-stats') assert.ok(Object.keys(data.heroAugments['157']).length > 100, 'Yasuo hero × augment rows are included');
  if (name === 'item-stats') assert.equal(data.coreBuilds['157'][0].items.length, 3, 'Yasuo observed three-item core is included');
}
assert.equal(digest(await readFile(join(unpacked, 'desktop/recognize.ps1'))), digest(await readFile(join(root, 'desktop/recognize.ps1'))));
await access(join(unpacked, 'desktop/ocr-worker.cjs'));
const guide = await readFile(resolve(root, 'release/HexCompanion-win32-x64/使用说明.txt'), 'utf8');
for (const expected of [version, '备选席', '选人提示', 'Ctrl+Alt+H', 'F8', '三个穿透标签', '右上角', '联动理由', '游戏在前台', '每 6 小时检查']) assert.ok(guide.includes(expected), `usage guide includes ${expected}`);
await access(join(unpacked, 'node_modules/tesseract.js/src/worker-script/node/index.js'));
for (const model of packagedJson('app/data/ocr/manifest.json').files) {
  const bytes = await readFile(join(unpacked, 'app/data/ocr', model.file));
  assert.equal(bytes.length, model.bytes);
  assert.equal(digest(bytes), model.sha256, 'packaged OCR model matches the pinned official asset');
}
const temp = await mkdtemp(join(tmpdir(), 'hex-windows-resources-'));
const app = await electron.launch({ args: [archive], env: { ...process.env, HEX_COMPANION_TEST_USER_DATA: await manualDataProfile(join(temp,'profile')) }, timeout:30000 });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.candidate.best').waitFor();
  await page.waitForFunction(() => [...document.images].every(img=>img.complete&&img.naturalWidth>0));
  assert.equal(await page.locator('.candidate:not(.empty)').count(),3);
  assert.ok((await page.locator('.window-status').innerText()).includes(version));
  assert.ok(await page.locator('.candidate .stat-rate').count(), 'packaged hero × augment statistics are rendered');
  assert.match(await page.locator('.candidate .stat-rate').first().innerText(), /%[\s\S]*pp/);
  await page.locator('.build-evidence').waitFor();
  await page.getByRole('button', { name:'攻略库', exact:true }).click();
  await page.getByLabel('搜索攻略').fill('亚索');
  await page.locator('.guide-card').first().waitFor();
  assert.match(await page.locator('#guide-results').innerText(), /亚索/);
  await page.locator('[data-action="page"][data-page="stats"]').click();
  assert.equal(await page.locator('.stats-table tbody tr').count(),173);
  const hudReady = app.waitForEvent('window');
  await app.evaluate(({BrowserWindow,screen}, archivePath) => {
    const load = process.getBuiltinModule('module').createRequire(archivePath + '/package.json');
    const {createCardOverlays} = load(archivePath + '/desktop/overlays.cjs');
    globalThis.packagedHud = createCardOverlays({BrowserWindow,screen,
      preloadPath:archivePath+'/desktop/overlay-preload.cjs',htmlPath:archivePath+'/app/overlay.html'});
    globalThis.packagedHud.setGameVisible(true,{bounds:screen.getPrimaryDisplay().workArea});
    globalThis.packagedHud.update({phase:'idle',display:false,cards:[],build:{hero:'亚索',route:'暴击持续输出',
      selected:['升级：无尽之刃'],purchases:[{id:'3031',name:'无尽之刃',cost:3500}],reason:'升级：无尽之刃'}});
  }, archive);
  const hud = await hudReady;
  await hud.waitForFunction(() => document.querySelector('#item-icon')?.naturalWidth > 0);
  assert.equal(await hud.locator('#item').innerText(), '无尽之刃');
  assert.match(await hud.locator('#record').innerText(), /已记 1 枚/);
  await app.evaluate(() => globalThis.packagedHud.destroy());
  const imageBase64=(await readFile(resolve(root,'artifacts/ocr-fixture.png'))).toString('base64');
  const result = await app.evaluate(async (_electron, {archive,imageBase64}) => {
    const load = process.getBuiltinModule('module').createRequire(archive + '/package.json');
    const ocr = load(archive + '/desktop/ocr.cjs').createLocalOcr();
    try {
      await ocr.initialize();
      return await ocr.recognize({imageBase64,width:1920,height:1080,windowId:'test',capturedAt:new Date().toISOString()});
    } finally {await ocr.stop();}
  }, {archive,imageBase64});
  for(const title of ['火上浇油','暴击律动','神射法师'])assert.ok(result.text.replace(/\s/g,'').includes(title),result.text);
  assert.equal(result.imageBase64,undefined);
  assert.deepEqual(errors,[]);
  console.log(`PASS: Windows ${version} ASAR loads the equipment HUD with local item art, three statistical snapshots and the offline OCR worker, and recognizes three Chinese titles`);
  console.log('LIMIT: Windows EXE, GDI screenshot and in-game overlay still require Windows hardware testing');
} finally {await app.close();await rm(temp,{recursive:true,force:true});}
