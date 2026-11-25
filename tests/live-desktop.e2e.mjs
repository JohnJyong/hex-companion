// Real Electron renderer/preload/controller with a simulated capture IPC source.
// This verifies UI integration; it does not validate Windows pixels or OCR accuracy.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { indexCatalog, recommendBuilds } from '../app/core/engine.mjs';

const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'hex-companion-live-e2e-'));
await mkdir(resolve(root, 'artifacts'), { recursive: true });
const db = indexCatalog(JSON.parse(await readFile(resolve(root, 'app/data/catalog.json'), 'utf8')));
db.augmentStats = JSON.parse(await readFile(resolve(root, 'app/data/augment-stats.json'), 'utf8'));
db.itemStats = JSON.parse(await readFile(resolve(root, 'app/data/item-stats.json'), 'utf8'));
const app = await electron.launch({ args: ['.'], cwd: root,
  env: { ...process.env, HEX_COMPANION_TEST_USER_DATA: join(temp, 'profile') }, timeout: 30000 });
const page = await app.firstWindow();
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(`page: ${error.message}`));
page.on('console', event => { if (event.type() === 'error') errors.push(`console: ${event.text()}`); });
const action = (name, extra = '') => page.locator(`[data-action="${name}"]${extra}`);
const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('hex-companion.session.v1')));
const lastOverlay = () => app.evaluate(() => globalThis.__liveE2e.overlays.at(-1));
async function until(predicate, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(30); }
  throw new Error(`Timed out: ${label}`);
}
let sequence = 0;
async function sendFrame(titles, championId = 'Jinx') {
  await app.evaluate(({ BrowserWindow }, { titles, championId, sequence }) => {
    const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    main.webContents.send('capture:frame', {
      timestamp: Date.now(), error: null,
      frame: {
        width: 1920, height: 1080, windowId: '42', captureId: sequence,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        text: titles.join('\n'),
        lines: titles.map((text, slot) => ({ text, x: 440 + slot * 460, y: 400, width: 120, height: 28 })),
      },
      game: {
        activePlayer: { riotId: 'Player#CN', currentGold: 2400 },
        allPlayers: [
          { riotId: 'Other#CN', rawChampionName: 'game_character_displayname_Garen', items: [] },
          { riotId: 'Player#CN', rawChampionName: `game_character_displayname_${championId}`, items: [{ itemID: 3006 }] },
        ],
        gameData: { gameMode: 'ARAM', gameTime: 380 + sequence },
      },
    });
  }, { titles, championId, sequence: ++sequence });
}

try {
  await page.locator('.candidate.best').waitFor();
  await app.evaluate(({ ipcMain }) => {
    globalThis.__liveE2e = { overlays: [], starts: [], stops: 0, resolveStart: null, overlayEnabled: true };
    const handlers = {
      'window:info': () => ({ platform: 'win32', version: '0.6.1', pinned: false }),
      'select:enabled': (_event, enabled) => ({enabled, status:enabled?'等待选人客户端处于前台':'已关闭选人提示'}),
      'capture:windows': () => [
        { id: '99', title: 'Notes', processName: 'notepad', width: 1000, height: 700, isGame: false },
        { id: '42', title: 'League of Legends', processName: 'League of Legends', width: 1920, height: 1080, isGame: true },
      ],
      'capture:capabilities': () => ({ available: true, engine: 'fixture', languages: ['zh-Hans', 'en-US'] }),
      'capture:start': (_event, options) => {
        globalThis.__liveE2e.starts.push(options);
        return new Promise(resolve => { globalThis.__liveE2e.resolveStart = resolve; });
      },
      'capture:stop': () => { globalThis.__liveE2e.stops++; return true; },
      'overlay:update': (_event, payload) => { globalThis.__liveE2e.overlays.push(payload); return true; },
      'overlay:toggle': event => {
        const enabled = globalThis.__liveE2e.overlayEnabled = !globalThis.__liveE2e.overlayEnabled;
        event.sender.send('overlay:visibility', { enabled, visible: enabled });
        return { enabled, visible: enabled };
      },
    };
    for (const [name, handler] of Object.entries(handlers)) { ipcMain.removeHandler(name); ipcMain.handle(name, handler); }
  });
  await page.reload();
  await page.locator('.candidate.best').waitFor();

  await action('page', '[data-page="stats"]').click();
  await page.locator('.stats-table tbody tr').first().waitFor();
  const rates = await page.locator('.stats-table tbody tr td:nth-child(3) strong').allTextContents();
  assert.equal(rates.length, db.champions.length);
  const numericRates = rates.map(parseFloat).filter(Number.isFinite);
  assert.ok(numericRates.every((rate, i) => !i || rate <= numericRates[i - 1]));
  await page.getByLabel('胜率榜排序').selectOption('games');
  const games = (await page.locator('.stats-table tbody tr td:nth-child(4)').allTextContents()).map(text => Number(text.replaceAll(',', '')));
  assert.ok(games.every((count, i) => !i || count <= games[i - 1]));
  await page.getByLabel('搜索英雄胜率').fill('火男');
  assert.equal(await action('stats-pick').count(), 1);
  assert.equal(await action('stats-pick').getAttribute('data-id'), 'Brand');
  await page.getByLabel('搜索英雄胜率').fill('');
  await page.getByLabel('胜率榜排序').selectOption('winRate');
  await page.screenshot({ path: resolve(root, 'artifacts/stats.png'), fullPage: false });
  await page.getByLabel('搜索英雄胜率').fill('火男');
  await action('stats-pick', '[data-id="Brand"]').click();
  await page.waitForFunction(() => document.querySelector('.hero-english')?.textContent === 'BRAND');
  assert.equal(await page.locator('.selected-slot:not(.empty)').count(), 0);
  console.log('PASS: champion statistics sort, alias search, and hero selection');

  await action('page', '[data-page="live"]').first().click();
  const selectSwitch=page.getByLabel('选人时显示英雄胜率');
  assert.equal(await selectSwitch.isChecked(),true);
  await selectSwitch.uncheck();
  await page.waitForFunction(()=>localStorage.getItem('hex-companion.champ-select.v1')==='false');
  await page.reload();
  await action('page', '[data-page="live"]').first().click();
  assert.equal(await selectSwitch.isChecked(),false,'champ-select opt-out survives a restart');
  await selectSwitch.check();
  await page.waitForFunction(()=>document.getElementById('champ-select-status')?.textContent.includes('等待选人客户端'));
  assert.equal(await action('live-start').isDisabled(), true);
  await action('live-refresh').click();
  await page.waitForFunction(() => document.querySelectorAll('#capture-window option').length === 3);
  assert.equal(await page.getByLabel('选择游戏窗口').inputValue(), '42');
  await page.getByLabel('选择游戏窗口').selectOption('99');
  await page.getByLabel('选择游戏窗口').selectOption('42');
  await action('live-start').click();
  await page.waitForFunction(() => document.querySelector('[data-action="live-start"]')?.textContent.includes('正在启动'));
  assert.equal(await action('live-start').isDisabled(), true);
  const options = await app.evaluate(() => globalThis.__liveE2e.starts[0]);
  assert.equal(options.windowId, '42');
  assert.equal(options.syncItems, true);
  assert.equal(options.overlay, true);
  assert.deepEqual(options.roi, { x: 0, y: 0, width: 1, height: 1 });
  await app.evaluate(() => globalThis.__liveE2e.resolveStart({
    window: { id: '42', title: 'League of Legends' }, capabilities: { available: true }, failedShortcuts: [],
  }));
  await action('live-stop').waitFor();
  assert.equal(await page.getByLabel('选择游戏窗口').isDisabled(), true);

  const initialTitles = ['火上浇油', '暴击律动', '神射法师'];
  await sendFrame(initialTitles);
  await page.waitForFunction(() => document.querySelector('.live-status')?.textContent.includes('1/2'));
  await until(async () => (await lastOverlay())?.phase === 'preview', 'first-frame title preview');
  assert.deepEqual((await lastOverlay()).cards.map(card => card.name), initialTitles);
  assert.ok((await lastOverlay()).cards.every(card => card.score === null && card.statistics === null && card.pending));
  assert.equal((await state()).championId, 'Jinx');
  await sendFrame(initialTitles);
  await page.waitForFunction(() => document.querySelector('.live-status')?.textContent.includes('已确认'));
  await until(async () => (await lastOverlay())?.cards.length === 3, 'stable overlay cards');
  let overlay = await lastOverlay();
  assert.deepEqual(overlay.cards.map(card => [card.name, card.slot]), initialTitles.map((name, slot) => [name, slot]));
  assert.ok(overlay.cards.every(card => Number.isFinite(card.score)));
  assert.equal(overlay.cards.filter(card => card.best).length, 1);
  assert.match(overlay.hero, /金克丝|金克斯/);
  assert.ok(overlay.next.length > 0);
  await action('live-toggle').click();
  await page.waitForFunction(() => document.querySelector('[data-action="live-toggle"]')?.textContent === '显示浮层');
  assert.equal(await page.locator('#live-overlay').isChecked(), false);
  await sendFrame(initialTitles);
  assert.equal(await app.evaluate(() => globalThis.__liveE2e.overlayEnabled), false);
  await action('live-toggle').click();
  await page.waitForFunction(() => document.querySelector('#live-overlay')?.checked === true);
  await page.locator('#toast.visible').waitFor({ state: 'hidden' });
  await sendFrame(initialTitles); // Keep screenshots within the eight-second evidence window.
  await page.screenshot({ path: resolve(root, 'artifacts/live.png'), fullPage: true });
  await action('page', '[data-page="desk"]').first().click();
  await page.locator('.candidate.best').waitFor();
  assert.equal(await page.locator('.candidate:not(.empty)').count(), 3);
  assert.equal(await page.locator('.selected-slot:not(.empty)').count(), 0);
  assert.equal(await page.locator('.inventory [data-id="3006"]').count(), 1);
  assert.equal(await page.locator('.augment-stat').count(), 3);
  const observed = overlay.cards.filter(card => card.statistics);
  for (const card of observed) {
    const candidate = page.locator('.candidate').filter({ has: page.locator('.candidate-title', { hasText: card.name }) });
    assert.ok((await candidate.innerText()).includes((card.statistics.winRate * 100).toFixed(1) + '%'));
    assert.ok((await candidate.innerText()).includes(card.statistics.games.toLocaleString('zh-CN')));
  }
  await page.screenshot({ path: resolve(root, 'artifacts/live-desk.png'), fullPage: true });
  console.log('PASS: live start busy state, active-player sync, two-frame OCR, physical-slot overlay and desk scores');

  const rerolledTitles = ['尖端发明家', '循环往复', '易损'];
  await sendFrame(rerolledTitles);
  await page.waitForFunction(() => document.querySelectorAll('.candidate.pending').length === 3);
  await until(async () => (await lastOverlay())?.phase === 'preview', 'reroll withdraws old scores');
  assert.deepEqual((await lastOverlay()).cards.map(card => card.name), rerolledTitles);
  assert.ok((await lastOverlay()).cards.every(card => card.score === null && card.statistics === null));
  assert.ok(await action('choose').evaluateAll(buttons => buttons.every(button => button.disabled)));
  assert.deepEqual((await state()).candidates, ['ARAM_Firebrand', 'CriticalRhythm', 'ARAM_Marksmage']);
  await sendFrame(rerolledTitles);
  await page.waitForFunction(() => document.querySelectorAll('.candidate:not(.empty)').length === 3);
  await until(async () => (await lastOverlay())?.phase === 'confirmed', 'reroll stable overlay');
  overlay = await lastOverlay();
  assert.deepEqual(overlay.cards.map(card => card.name), rerolledTitles);
  await sendFrame([]);
  await page.waitForFunction(() => document.querySelectorAll('.candidate.review').length === 3);
  assert.deepEqual((await lastOverlay()).cards.map(card => card.name), rerolledTitles);
  assert.ok(await action('choose').evaluateAll(buttons => buttons.every(button => button.disabled)));
  await sendFrame(rerolledTitles);
  await sendFrame(rerolledTitles);
  await until(async () => (await lastOverlay())?.phase === 'confirmed', 'OCR recovers after one missing frame');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).webContents.send('capture:record', 0);
  });
  await page.waitForFunction(() => document.querySelectorAll('.selected-slot:not(.empty)').length === 1);
  assert.match(await page.locator('.selected-slot:not(.empty)').innerText(), /尖端发明家/);
  assert.equal(await page.locator('.candidate.empty').count(), 3);
  const recorded = await state();
  assert.deepEqual(recorded.selected, ['ARAM_ApexInventor']);
  assert.deepEqual(recorded.candidates, [null, null, null]);
  assert.equal(recorded.history.length, 1);
  const expectedBuild = recommendBuilds(recorded, db)[0];
  assert.ok((await page.locator('.build-name').innerText()).includes(expectedBuild.name));
  assert.deepEqual(await page.locator('.build-item').evaluateAll(items => items.map(item => item.dataset.id)), expectedBuild.items.map(item => item.id));
  await until(async () => (await lastOverlay())?.cards.length === 0, 'selection clears live cards');
  assert.deepEqual((await lastOverlay()).build.selected, ['尖端发明家']);
  assert.equal((await lastOverlay()).build.purchases[0].id, expectedBuild.next.id);
  await action('show-builds').click();
  assert.ok(await page.locator('.build-panel').evaluate(panel => {
    const rect = panel.getBoundingClientRect(); return rect.top >= 0 && rect.top < innerHeight / 2;
  }), 'equipment navigation scrolls the recommendation into view');
  console.log('PASS: reroll withdraws stale scores immediately, hotkey records physical slot and updates build');

  await action('page', '[data-page="live"]').first().click();
  await action('live-stop').click();
  await action('live-start').waitFor();
  assert.equal(await page.getByLabel('选择游戏窗口').isDisabled(), false);
  assert.equal(await app.evaluate(() => globalThis.__liveE2e.stops), 1);
  assert.equal((await lastOverlay()).build, null);
  await sendFrame(initialTitles, 'Garen');
  assert.equal((await state()).championId, 'Jinx');
  assert.deepEqual((await state()).selected, ['ARAM_ApexInventor']);
  assert.deepEqual(errors, []);
  console.log('PASS: stop removes live listeners; no renderer or console errors');
} catch (error) {
  await page.screenshot({ path: resolve(root, 'artifacts/live-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
