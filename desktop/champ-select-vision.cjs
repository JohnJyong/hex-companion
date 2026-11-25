'use strict';

const {createHash} = require('node:crypto');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {normalizeOcrText} = require('../app/core/recognition.mjs');
const {lookupChampionStats, formatWinRate} = require('../app/core/champion-stats.mjs');

// The League desktop client's 16:9 pick screen scales independently of the game.
const REFERENCE = {width:1920,height:1080};
const normalized = (x,y,width,height) => ({x:x/1920,y:y/1080,width:width/1920,height:height/1080});
const BENCH_STRIP = normalized(404, 4, 1008, 91);
const TEAM_STRIP = normalized(77, 149, 253, 586);
const TEAM_SLOTS = 5, BENCH_SLOTS = 10;

function cropReference(image, shot, x, y, width, height) {
  const crop = shot.crop;
  const pixelX = ref => Math.round((ref * shot.sourceWidth / REFERENCE.width - crop.x) * shot.width / crop.width);
  const pixelY = ref => Math.round((ref * shot.sourceHeight / REFERENCE.height - crop.y) * shot.height / crop.height);
  const left = pixelX(x), top = pixelY(y);
  const rect = {x:left, y:top, width:pixelX(x+width)-left, height:pixelY(y+height)-top};
  if (left < 0 || top < 0 || left+rect.width > shot.width || top+rect.height > shot.height) throw new Error('选人窗口尺寸已变化');
  return image.crop(rect);
}

// Compare the centre of each portrait. This excludes swap buttons, rings and
// corners. Centering each colour channel tolerates dimmed unavailable picks.
function portraitSignature(image) {
  const pixels = image.resize({width:16,height:16,quality:'best'}).toBitmap();
  const values = [];
  const means = [0,0,0];
  for (let y=0; y<16; y++) for (let x=0; x<16; x++) {
    if ((x-7.5)**2+(y-7.5)**2 >= 6.2**2) continue;
    const offset = (y*16+x)*4;
    for (let channel=0; channel<3; channel++) {
      means[channel] += pixels[offset+channel];
      values.push(pixels[offset+channel]);
    }
  }
  let energy = 0;
  for (let i=0; i<values.length; i++) {
    values[i] -= means[i%3] / (values.length/3);
    energy += values[i]**2;
  }
  if (energy < values.length*3**2) return null;
  const length = Math.sqrt(energy);
  return Float32Array.from(values, value => value/length);
}

function createChampionBank(nativeImage, catalog, dataset, appRoot, icons = null) {
  const portraits = [], titles = new Map(), statistics = new Map();
  const total = catalog.champions.filter(c => lookupChampionStats(dataset,c,catalog.meta)?.rank).length;
  for (const champion of catalog.champions) {
    const image = nativeImage.createFromBuffer(icons ? icons.get(champion.icon) : readFileSync(path.join(appRoot, champion.icon)));
    if (!image.isEmpty()) {
      const {width,height} = image.getSize();
      const pad = Math.round(Math.min(width,height)*.055);
      const signature = portraitSignature(image.crop({x:pad,y:pad,width:width-pad*2,height:height-pad*2}));
      if (signature) portraits.push({id:champion.id, signature});
    }
    for (const label of [champion.name,champion.title]) {
      const key = normalizeOcrText(label);
      if (!key) continue;
      const previous = titles.get(key);
      titles.set(key, previous === undefined || previous === champion.id ? champion.id : null);
    }
    const row = lookupChampionStats(dataset,champion,catalog.meta);
    const hasRank = Boolean(row?.rank && total && row.rank<=total && !row.lowSample);
    const fraction = hasRank ? row.rank/total : null;
    const grade = !hasRank ? '' : fraction<=.1?'S':fraction<=.3?'A':fraction<=.6?'B':fraction<=.85?'C':'D';
    statistics.set(champion.id,{name:champion.name, rate:formatWinRate(row?.winRate), grade,
      rankText:hasRank?`第${row.rank}/${total}`:row?.lowSample?'样本少':'暂无排名'});
  }
  return {portraits,titles,statistics,patch:dataset.meta.displayPatch};
}

function matchPortrait(image, bank) {
  const signature = portraitSignature(image);
  if (!signature) return null;
  let best = -1, second = -1, id = null;
  for (const portrait of bank.portraits) {
    let score = 0;
    for (let j=0;j<signature.length;j++) score += signature[j]*portrait.signature[j];
    if (score>best) { second=best; best=score; id=portrait.id; }
    else if (score>second) second=score;
  }
  return best>=.76 && best-second>=.105 ? id : null;
}

function resolveTitle(line, portrait, titles) {
  const key = normalizeOcrText(line?.text);
  if (titles.has(key)) {
    const id = titles.get(key);
    return id && (!portrait || id===portrait) ? id : null;
  }
  // One wrong Chinese glyph can be corroborated by the portrait even with a
  // low OCR score. A skin with no portrait match requires high-confidence text.
  if (key.length>=4) {
    const near = new Set();
    for (const [label,id] of titles) {
      if (!id || label.length!==key.length) continue;
      let edits = 0;
      for (let i=0;i<key.length && edits<=1;i++) if (key[i]!==label[i]) edits++;
      if (edits===1) near.add(id);
    }
    if (near.size) {
      if (portrait) return near.has(portrait) ? portrait : null;
      return near.size===1 && line.confidence>=72 ? near.values().next().value : null;
    }
  }
  return portrait;
}

const NAME_WIDTH = 284, NAME_HEIGHT = 78, ROW_HEIGHT = 100, SHEET_WIDTH = 320;

function teamNames(nativeImage, image, shot) {
  const bitmap = Buffer.alloc(SHEET_WIDTH*ROW_HEIGHT*TEAM_SLOTS*4,255);
  const tones = [];
  for (let slot=0;slot<TEAM_SLOTS;slot++) {
    const name = cropReference(image,shot,186,172+120*slot,142,39);
    const src = name.resize({width:NAME_WIDTH,height:NAME_HEIGHT,quality:'best'}).toBitmap();
    let gold=0,ink=0;
    for(let y=0;y<NAME_HEIGHT;y++) for(let x=0;x<NAME_WIDTH;x++) {
      const i=(y*NAME_WIDTH+x)*4, b=src[i], g=src[i+1], r=src[i+2];
      const warm = r>175 && g>113 && b<115 && r-b>100 && r>=g;
      const light = Math.min(r,g,b)>143 && Math.max(r,g,b)-Math.min(r,g,b)<86;
      if (!warm && !light) continue;
      const dst=((slot*ROW_HEIGHT+10+y)*SHEET_WIDTH+12+x)*4;
      bitmap[dst]=bitmap[dst+1]=bitmap[dst+2]=0;
      ink++; if(warm)gold++;
    }
    tones.push({ink:ink/(NAME_WIDTH*NAME_HEIGHT),gold:gold/(NAME_WIDTH*NAME_HEIGHT)});
  }
  return {bitmap, tones};
}

function decode(nativeImage, shot) {
  const image = nativeImage.createFromBuffer(Buffer.from(shot.imageBase64,'base64'));
  const size = image.getSize();
  if (image.isEmpty() || size.width!==shot.width || size.height!==shot.height) throw new Error('选人画面不可用');
  return image;
}

function createSelectVision({nativeImage, ocr, getBank}) {
  let markerKey, markerVisible=false, namesKey, names=[];
  async function read(image) {
    const {width,height} = image.getSize();
    return ocr.recognize({width,height,imageBase64:image.toPNG().toString('base64')});
  }
  async function readBench(shot) {
    const image = decode(nativeImage,shot);
    const marker = cropReference(image,shot,424,30,75,33).resize({width:150,height:66,quality:'best'});
    const key = createHash('sha256').update(marker.toBitmap()).digest('hex');
    if (markerKey!==key) {
      const frame = await read(marker);
      markerVisible = frame.lines.some(l => normalizeOcrText(l.text)==='可用' && l.confidence>=55);
      markerKey = key;
    }
    if (!markerVisible) { namesKey=null; return null; }
    const bank = getBank();
    return Array.from({length:BENCH_SLOTS},(_,i) => matchPortrait(cropReference(image,shot,528+i*88,16,72,72),bank));
  }
  async function readTeam(shot, bench) {
    const image=decode(nativeImage,shot), bank=getBank();
    const {bitmap,tones}=teamNames(nativeImage,image,shot);
    const key=createHash('sha256').update(bitmap).digest('hex');
    if (key!==namesKey) {
      const sheet=nativeImage.createFromBitmap(bitmap,{width:SHEET_WIDTH,height:ROW_HEIGHT*TEAM_SLOTS});
      const frame=await read(sheet);
      names=Array.from({length:TEAM_SLOTS},(_,i) => frame.lines.filter(l =>
        Math.floor((l.y+l.height/2)/ROW_HEIGHT)===i).sort((a,b) => b.confidence-a.confidence)[0]);
      namesKey=key;
    }
    const team=tones.map((tone,i) => {
      if (tone.ink<.019) return null;
      const icon=matchPortrait(cropReference(image,shot,86,160+i*120,86,86),bank);
      return resolveTitle(names[i],icon,bank.titles);
    });
    const localSlots=tones.map((tone,i)=>team[i] && tone.gold>.026 && tone.gold>tone.ink*.60 ? i : -1).filter(i=>i>=0);
    const label=id=>id?bank.statistics.get(id)||null:null;
    return {patch:bank.patch, bench:bench.map(label), team:team.map(label), mine:localSlots.length===1?localSlots[0]:null};
  }
  return {readBench,readTeam,stop:()=>ocr.stop()};
}

module.exports={BENCH_STRIP,TEAM_STRIP,createChampionBank,createSelectVision};
