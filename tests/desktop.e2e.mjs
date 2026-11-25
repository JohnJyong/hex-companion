import { _electron as electron } from 'playwright';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'hex-companion-e2e-'));
await mkdir(resolve(root, 'artifacts'), { recursive: true });
const app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, HEX_COMPANION_TEST_USER_DATA: join(temp, 'profile') }, timeout: 30000 });
const page = await app.firstWindow();
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const action = (name, extra = '') => page.locator(`[data-action="${name}"]${extra}`);
try {
  await page.locator('.candidate.best').waitFor();
  assert.equal(await page.locator('.candidate:not(.empty)').count(), 3);
  assert.match(await page.locator('.hero-name').innerText(), /金克丝|金克斯/);
  await page.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(root, 'artifacts/desktop.png'), fullPage: true });
  console.log('PASS: desktop renders with all local images and no horizontal overflow');

  await action('detail', '[data-id="CriticalRhythm"]').click();
  await page.locator('.breakdown').waitFor();
  assert.ok(await page.locator('.detail-section').count());
  await action('close-modal').first().click();
  await action('preview', '[data-id="ARAM_Firebrand"]').click();
  assert.match(await page.locator('.build-pills').innerText(), /火上浇油/);
  await action('choose', '[data-id="ARAM_Firebrand"]').click();
  assert.equal(await page.locator('.selected-slot:not(.empty)').count(), 2);
  assert.equal(await page.locator('.candidate.empty').count(), 3);
  await action('undo').click();
  assert.equal(await page.locator('.candidate:not(.empty)').count(), 3);
  console.log('PASS: details, candidate preview, choose and undo');

  await action('pin').click();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), true);
  await action('pin').click();
  await action('compact').click();
  await page.locator('body.compact').waitFor();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize()[0]), 480);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(root, 'artifacts/compact.png'), fullPage: true });
  await action('compact').click();
  console.log('PASS: native always-on-top and compact window');

  const exportPath = join(temp, 'session.json');
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportPath);
  await action('export').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === '对局已导出');
  const exported = JSON.parse(await readFile(exportPath, 'utf8'));
  assert.equal(exported.championId, 'Jinx');
  assert.equal(exported.selected.length, 1);
  console.log('PASS: export writes a valid session through desktop IPC');

  await action('new').click();
  await page.getByLabel('搜索英雄').fill('火男');
  await action('pick-hero', '[data-id="Brand"]').click();
  assert.equal(await page.locator('.selected-slot:not(.empty)').count(), 0);
  await action('candidates').click();
  for (const [name, id] of [['易损', 'ARAM_Vulnerability'], ['火上浇油', 'ARAM_Firebrand'], ['循环往复', 'ARAM_Recursion']]) {
    await page.getByLabel('搜索候选海克斯').fill(name);
    await action('pick-augment', `[data-id="${id}"]`).click();
  }
  await action('apply-modal').click();
  assert.equal(await page.locator('.candidate:not(.empty)').count(), 3);
  await action('detail', '[data-id="ARAM_Vulnerability"]').first().click();
  const burnGuide = page.locator('#modal [data-guide-id="note-brand-jeweled-gauntlet-658"]');
  await burnGuide.waitFor();
  assert.match(await burnGuide.innerText(), /兰德里的折磨/);
  await action('close-modal').first().click();
  await action('choose', '[data-id="ARAM_Vulnerability"]').click();
  assert.match(await page.locator('.build-name').innerText(), /灼烧暴击/);
  assert.equal(await page.locator('.build-panel [data-guide-id="note-brand-jeweled-gauntlet-658"]').count(), 1);
  await action('enemy', '[data-id="healing"]').click();
  assert.match(await page.locator('.build-notes').innerText(), /重伤/);
  await page.reload();
  await page.locator('.hero-name').waitFor();
  assert.match(await page.locator('.hero-name').innerText(), /布兰德/);
  assert.equal(await page.locator('.selected-slot:not(.empty)').count(), 1);
  console.log('PASS: hero alias search, candidate entry, dynamic build and persistence');

  await action('inventory').first().click();
  await page.getByLabel('搜索装备').fill('水银之靴');
  await action('toggle-item', '[data-id="3111"]').click();
  await action('apply-modal').click();
  assert.ok(await page.locator('.build-item.owned[data-id="3111"]').count());
  assert.equal(await page.locator('.build-items img').count(), 6);
  console.log('PASS: owned equipment is retained in dynamic plans');

  await action('page', '[data-page="settings"]').first().click();
  await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, exportPath);
  await action('import').click();
  await page.locator('.hero-name').waitFor();
  assert.match(await page.locator('.hero-name').innerText(), /金克丝|金克斯/);
  assert.equal(await page.locator('.candidate:not(.empty)').count(), 3);
  const invalidPath = join(temp, 'invalid.json');
  await writeFile(invalidPath, JSON.stringify({ ...exported, championId: 'not-a-champion' }));
  await action('page', '[data-page="settings"]').first().click();
  await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, invalidPath);
  await action('import').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('英雄不在'));
  await action('page', '[data-page="desk"]').click();
  assert.match(await page.locator('.hero-name').innerText(), /金克丝|金克斯/);
  console.log('PASS: import restores valid sessions and rejects invalid ones without data loss');

  await action('page', '[data-page="atlas"]').click();
  await page.getByLabel('搜索海克斯图鉴').fill('珠光护手');
  assert.equal(await page.locator('.atlas-card').count(), 1);
  await action('page', '[data-page="guides"]').click();
  const firstId = await page.locator('.guide-card').first().getAttribute('data-guide-id');
  await action('guide-page', '[data-value="1"]').click();
  assert.notEqual(await page.locator('.guide-card').first().getAttribute('data-guide-id'), firstId);
  await page.getByLabel('搜索攻略').fill('亚索');
  await page.getByLabel('攻略类型').selectOption('equipment');
  const shields = page.locator('[data-guide-id="note-yasuo-courage-of-the-colossus-1046"]');
  await shields.waitFor();
  await app.evaluate(({ shell }) => { shell.openExternal = async url => { globalThis.lastGuideUrl = url; }; });
  await shields.getByRole('button', { name: '阅读原文' }).click();
  await expect.poll(() => app.evaluate(() => globalThis.lastGuideUrl)).toBe('https://arammayhem.com/zh-cn/combo/yasuo-courage-of-the-colossus-1046/');
  const historical = page.locator('[data-guide-id="editorial-yasuo-critical-healing-ritual"]');
  await historical.getByRole('button', { name: '阅读原文' }).click();
  await expect.poll(() => app.evaluate(() => globalThis.lastGuideUrl)).toBe('https://dtodo.cn/zh-CN/blog/ap-yasuo-destroying-ritual-guide');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('#toast.visible').waitFor({state:'hidden'});
  await page.screenshot({ path: resolve(root, 'artifacts/guides.png') });
  await page.getByLabel('搜索攻略').fill('不存在的海克斯名称');
  assert.match(await page.locator('#guide-results').innerText(), /没有找到/);
  assert.deepEqual(errors, []);
  console.log('PASS: augment atlas and no renderer errors');
} finally {
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
