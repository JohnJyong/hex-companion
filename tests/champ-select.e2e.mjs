// Pass a 1350×757 client crop to replay gameplay, or render a synthetic roster
// from the bundled champion portraits and exercise the same OCR and overlays.
import { _electron as electron } from 'playwright';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';

const source=process.argv[2] || process.env.HEX_SELECT_REFERENCE;
const root=resolve(import.meta.dirname,'..'), profile=await mkdtemp(join(tmpdir(),'hex-select-'));
const code=process.env.HEX_SELECT_ASAR || root;
const app=await electron.launch({args:[code],cwd:root,env:{...process.env,HEX_COMPANION_TEST_USER_DATA:profile}});
try {
  const main=await app.firstWindow();
  await main.locator('.candidate.best').waitFor();
  const reference = source ? resolve(source) : join(profile, 'roster.png');
  if (!source) {
    const catalog = JSON.parse(await readFile(join(root, 'app/data/catalog.json'), 'utf8'));
    const png = await main.evaluate(async champions => {
      const canvas = document.createElement('canvas');
      canvas.width = 1350; canvas.height = 757;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#182029'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = 'bold 24px "Microsoft YaHei", "PingFang SC", sans-serif';
      ctx.fillStyle = '#e4e6e5'; ctx.fillText('可用', 436, 55);
      async function portrait(id, x, y, size) {
        const champion = champions.find(c => c.id === id);
        const image = new Image();
        image.src = champion.icon;
        await image.decode();
        const pad = Math.round(Math.min(image.width, image.height) * .055);
        ctx.drawImage(image, pad, pad, image.width - pad * 2, image.height - pad * 2, x, y, size, size);
        return champion.title;
      }
      const bench = ['Fiddlesticks','Akshan','Leblanc','Lissandra','Malphite','Ornn'];
      for (const [i, id] of bench.entries()) await portrait(id, 528 + 88 * i, 16, 72);
      const team = ['Teemo','Aurora','Pyke','Caitlyn','Khazix'];
      for (const [i, id] of team.entries()) {
        const title = await portrait(id, 86, 160 + 120 * i, 86);
        ctx.fillStyle = i === 0 ? '#ffcb49' : '#e4e6e5';
        ctx.fillText(title, 187, 200 + 120 * i);
      }
      return canvas.toDataURL().split(',')[1];
    }, catalog.champions);
    await writeFile(reference, Buffer.from(png, 'base64'));
  }
  const results=await app.evaluate(async ({BrowserWindow,screen,nativeImage},{source,code})=>{
    const load=process.getBuiltinModule('module').createRequire(code+'/package.json');
    const {createSelectVision,createChampionBank,BENCH_STRIP,TEAM_STRIP}=load('./desktop/champ-select-vision.cjs');
    const {createSelectOverlays}=load('./desktop/champ-select-overlays.cjs');
    const bank=createChampionBank(nativeImage,load('./app/data/catalog.json'),load('./app/data/champion-stats.json'),code+'/app');
    const ocr=load('./desktop/ocr.cjs').createLocalOcr();
    const reader=createSelectVision({nativeImage,ocr,getBank:()=>bank});
    const crop=nativeImage.createFromPath(source);
    const {width:iw,height:ih}=crop.getSize();
    if (iw!==1350 || ih!==757) throw new Error('Unexpected reference crop size');
    const raw=crop.toBitmap(), pixels=Buffer.alloc(1920*1080*4,0);
    for(let y=0;y<ih;y++) raw.copy(pixels,y*1920*4,y*iw*4,(y+1)*iw*4);
    // Only the known top-left part contains evidence. Opaque empty space fills
    // the unshared area, which includes the very last bench slot.
    for(let i=3;i<pixels.length;i+=4)pixels[i]=255;
    function frameAt(client,roi) {
      const {width,height}=client.getSize();
      const rect={x:Math.floor(width*roi.x),y:Math.floor(height*roi.y),width:Math.floor(width*roi.width),height:Math.floor(height*roi.height)};
      const strip=client.crop(rect);
      return {...strip.getSize(),crop:rect,sourceWidth:width,sourceHeight:height,imageBase64:strip.toPNG().toString('base64')};
    }
    const fromPixels=()=>nativeImage.createFromBitmap(pixels,{width:1920,height:1080});
    const original=fromPixels(), samples=[];
    let first;
    try {
      for (const [width,height] of [[1920,1080],[1280,720],[2560,1440],[1024,576]]) {
        const client=original.resize({width,height,quality:'best'});
        const bench=await reader.readBench(frameAt(client,BENCH_STRIP));
        if (!bench) throw new Error('Missed reference pick screen at '+width);
        const labels=await reader.readTeam(frameAt(client,TEAM_STRIP),bench);
        first ??= labels;
        samples.push({width,bench,names:labels.team.map(s=>s?.name),mine:labels.mine,teemo:labels.team[0]});
      }
      // Move one available portrait into an empty slot, leaving a hole. The
      // captured badge baked into the source remains in its old position.
      for(let y=16;y<88;y++){
        const i=(y*1920+528)*4;
        pixels.copy(pixels,i+7*88*4,i,i+72*4);
        pixels.fill(0,i,i+72*4);
      }
      const swapped=await reader.readBench(frameAt(fromPixels(),BENCH_STRIP));
      for(let y=25;y<65;y++)pixels.fill(0,(y*1920+416)*4,(y*1920+508)*4);
      const absent=await reader.readBench(frameAt(fromPixels(),BENCH_STRIP));
      const manager=createSelectOverlays({BrowserWindow,screen,htmlPath:code+'/app/champ-select.html',preloadPath:code+'/desktop/overlay-preload.cjs'});
      globalThis.__selectQa={manager,first};
      manager.draw(first,{x:0,y:0,width:1920,height:1080});
      return {samples,swapped,absent};
    } finally {await reader.stop();}
  },{source:reference,code});
  const expected=['Fiddlesticks','Akshan','Leblanc','Lissandra','Malphite','Ornn',null,null,null,null];
  for(const sample of results.samples){
    assert.deepEqual(sample.bench,expected,'bench at '+sample.width);
    assert.deepEqual(sample.names,['提莫','阿萝拉','派克','凯特琳','卡兹克'],'team at '+sample.width);
    assert.equal(sample.mine,0);assert.equal(sample.teemo.rate,'53.6%');assert.equal(sample.teemo.rankText,'第15/173');
  }
  assert.deepEqual(results.swapped,[null,...expected.slice(1,7),'Fiddlesticks',null,null]); assert.equal(results.absent,null);
  await expect.poll(()=>app.windows().filter(p=>p.url().endsWith('/champ-select.html')).length).toBe(2);
  const strips=app.windows().filter(p=>p.url().endsWith('/champ-select.html'));
  for(const p of strips) await p.locator('.chip').first().waitFor();
  await mkdir(join(root,'artifacts'),{recursive:true});
  for(const p of strips){
    const kind=await p.locator('main').getAttribute('class');
    assert.equal(await p.locator('.chip').count(),kind==='bench'?6:5);
    if (kind === 'team') {
      const mine = p.locator('.mine');
      assert.equal(await mine.locator('.rate').innerText(), '53.6%');
      assert.equal(await mine.locator('.self').innerText(), '我');
      assert.equal(await mine.locator('.place').innerText(), '第15/173');
    }
    const cropped = await p.locator('.chip').evaluateAll(chips => chips
      .filter(el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      .map(el => ({ label: el.innerText, width: el.clientWidth, contentWidth: el.scrollWidth,
        height: el.clientHeight, contentHeight: el.scrollHeight })));
    assert.deepEqual(cropped, [], kind + ' labels fit within their native surfaces');
    await p.screenshot({path:join(root,`artifacts/champ-select-${kind}.png`),scale:'css',omitBackground:true});
  }
  await app.evaluate(() => {
    const {manager,first} = globalThis.__selectQa;
    const changed = structuredClone(first);
    changed.mine = 2;
    changed.team[0] = null;
    changed.team[1] = {...changed.team[1], grade:'', rate:'暂无数据', rankText:'暂无排名'};
    changed.bench[3] = {...changed.bench[3], grade:'', rankText:'样本少'};
    manager.draw(changed, {x:0,y:0,width:1920,height:1080});
  });
  for (const p of strips) {
    if (await p.locator('main').getAttribute('class') === 'team') {
      await p.locator('.no-data').waitFor();
      assert.equal(await p.locator('.no-data .tier').count(), 0);
      assert.equal(await p.locator('.no-data .rate').innerText(), '暂无数据');
      assert.equal(await p.locator('.mine .rate').innerText(), '47.8%');
    } else {
      await p.getByLabel(/样本少/).waitFor();
      assert.equal(await p.getByLabel(/样本少/).locator('.tier').innerText(), '少');
    }
  }
  const hidden=await app.evaluate(({BrowserWindow})=>{
    globalThis.__selectQa.manager.hide();
    return BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL().endsWith('/champ-select.html')).every(w=>!w.isVisible()&&!w.isFocusable());
  });
  assert.ok(hidden);
  console.log('PASS: real local OCR and icon matches across four scales, six bench slots, five team rows, local row, swap/empty/phase changes, and two nonfocusable rendered overlays.');
} finally {
  await app.close();await rm(profile,{recursive:true,force:true});
}
