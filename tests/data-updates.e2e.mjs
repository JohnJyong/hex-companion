// Opt-in public-channel smoke test. Requires a published data revision newer than the offline seed.
import {manualDataProfile} from './fixtures/manual-data-profile.mjs';
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';

const root = path.resolve(import.meta.dirname,'..');
const entry = path.resolve(process.argv[2] || root);
const profile = await mkdtemp(path.join(tmpdir(),'hex-online-update-'));
const artifacts = path.join(root,'artifacts');
await manualDataProfile(profile);
await mkdir(artifacts,{recursive:true});
let app;
async function launch(offline = false) {
  app = await electron.launch({cwd:root, args:[...(offline ? ['--proxy-server=http://127.0.0.1:9'] : []), entry],
    env:{...process.env, HEX_COMPANION_TEST_USER_DATA:profile}});
  const page = await app.firstWindow();
  await page.locator('.candidate').first().waitFor();
  return page;
}
const settings = page => page.locator('[data-action="page"][data-page="settings"]').first().click();
const data = page => page.evaluate(async () => {
  const {status, tables, iconBase} = await window.desktop.loadData();
  return {status, iconBase, augments:tables.catalog.augments.length, valid:tables['champion-stats'].meta.matches.valid,
    teemo:tables['champion-stats'].heroes['17'], exampleItem:tables.catalog.items[0].icon};
});
try {
  let page = await launch();
  await page.locator('[data-action="choose"][data-id="ARAM_Firebrand"]').click();
  const saved = await page.evaluate(()=>localStorage.getItem('hex-companion.session.v1'));
  await settings(page);
  const before = await data(page);
  assert.equal(before.status.active.source,'bundled');
  await page.locator('[data-action="check-data"]').click();
  await page.waitForFunction(() => document.querySelector('[data-action="apply-data"]') ||
    /更新源暂不可用|无法获取更新|校验失败|已是当前发布版本/.test(document.querySelector('#data-updates')?.innerText || ''),{},{timeout:210000});
  const staged = await data(page);
  assert.ok(staged.status.pending,JSON.stringify(staged.status));
  assert.deepEqual(before.status.active,staged.status.active);
  await page.locator('[data-action="apply-data"]').click();
  await page.waitForFunction(()=>document.querySelector('#data-updates')?.textContent.includes('已下载到本机'));
  const active = await data(page);
  assert.equal(active.status.active.revision,staged.status.pending.revision);
  assert.equal(await page.evaluate(()=>localStorage.getItem('hex-companion.session.v1')),saved);
  await page.locator('#auto-data-updates').check();
  await page.waitForFunction(()=>document.querySelector('#data-updates .update-toggle')?.textContent.includes('已开启'));
  await page.locator('#data-updates').screenshot({path:path.join(artifacts,'data-updates.png')});
  await page.locator('[data-action="page"][data-page="stats"]').first().click();
  assert.match(await page.locator('.stats-summary').innerText(),new RegExp(active.valid.toLocaleString('en-US')));
  await page.locator('#stats-search').fill('提莫');
  assert.ok((await page.locator('#stats-results').innerText()).includes((active.teemo.win_rate*100).toFixed(1)+'%'));
  await page.locator('#stats-results img').first().evaluate(img => img.decode());
  if (active.iconBase) assert.ok((await page.locator('#stats-results img').first().getAttribute('src')).startsWith(active.iconBase));
  const dimensions = await page.evaluate(async src => { const img = new Image(); img.src=src; await img.decode(); return [img.naturalWidth,img.naturalHeight]; },
    active.iconBase+active.exampleItem);
  assert.ok(dimensions.every(n => n>0));
  console.log('Public-channel update', {from:before.status.active.revision,to:active.status.active.revision,
    patch:active.status.active.patch,validMatches:active.valid,augments:active.augments,teemo:active.teemo.win_rate});
  await app.close(); app = null;
  page = await launch(true); await settings(page);
  const cached = await data(page);
  assert.deepEqual(cached.status.active, active.status.active);
  await page.locator('[data-action="check-data"]').click();
  await page.waitForFunction(()=>/无法获取更新|更新源暂不可用/.test(document.querySelector('#data-updates')?.innerText || ''),{},{timeout:30000});
  assert.deepEqual((await data(page)).status.active,active.status.active);
  assert.equal(await page.evaluate(()=>localStorage.getItem('hex-companion.session.v1')), saved);
  console.log('Offline relaunch preserved the active data and saved match.');
} finally {
  if (app) await app.close();
  await rm(profile,{recursive:true,force:true});
}
