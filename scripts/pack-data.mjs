// A release contains only JSON tables and PNG images. Expose its manifest last.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFile, writeFile, mkdir, rename, rm} from 'node:fs/promises';
import {parseArgs, promisify} from 'node:util';
import {gzip, gunzip} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import format from '../desktop/data-format.cjs';

const root = path.resolve(import.meta.dirname,'..');

export async function buildDataPackage(appRoot, revision, previous, out) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('请指定正整数数据版本，例如 --revision 2');
  const tables = await format.readTables(appRoot);
  const manifest = {schema:1, revision, patch:tables.catalog.meta.patch, statsAsOf:tables['champion-stats'].meta.asOf, bundles:{}};
  const paths = format.validateTables(tables,manifest);
  const icons = Object.fromEntries(await Promise.all([...paths].sort().map(async key =>
    [key,(await readFile(path.join(appRoot,key))).toString('base64')])));
  format.decodeIcons(icons,paths);
  const files = new Map();
  for (const [key, contents] of Object.entries({tables,icons})) {
    const raw = Buffer.from(JSON.stringify(contents));
    if (raw.length > format.MAX_EXPANDED) throw new Error('数据超过客户端解压上限');
    const old = previous?.bundles[key];
    if (old) {
      const archived = await readFile(path.join(out,format.filename(key,old)));
      if (old.bytes !== archived.length || format.hash(archived) !== old.sha256) throw new Error('上次发布的数据包不完整');
      // Different zlib builds can encode identical content differently.
      if (raw.equals(await promisify(gunzip)(archived,{maxOutputLength:format.MAX_EXPANDED}))) {
        manifest.bundles[key] = old;
        continue;
      }
    }
    const bytes = await promisify(gzip)(raw,{level:9});
    const part = {bytes:bytes.length,sha256:format.hash(bytes)};
    manifest.bundles[key] = part;
    files.set(format.filename(key,part),bytes);
  }
  format.validateManifest(manifest);
  return {manifest,files};
}

async function atomicWrite(dest, bytes) {
  const temp = dest+'.'+randomUUID()+'.tmp';
  try { await writeFile(temp,bytes); await rename(temp,dest); }
  finally { await rm(temp,{force:true}); }
}

async function main() {
  const {values} = parseArgs({options:{
    source:{type:'string',default:path.join(root,'app')}, out:{type:'string',default:path.join(root,'release/data-v1')},
    revision:{type:'string'}, bundled:{type:'boolean',default:false},
  }});
  const appRoot = path.resolve(values.source), out = path.resolve(values.out), revision = Number(values.revision);
  let previous;
  try { previous = format.validateManifest(JSON.parse(await readFile(path.join(out,'manifest.json'),'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const {manifest,files} = await buildDataPackage(appRoot,revision,previous,out);
  if (previous && (previous.revision > revision || previous.revision === revision && JSON.stringify(previous) !== JSON.stringify(manifest))) {
    throw new Error('数据内容变更时，请递增 --revision');
  }
  await mkdir(out,{recursive:true});
  for (const [name,bytes] of files) await atomicWrite(path.join(out,name),bytes);
  const text = JSON.stringify(manifest,null,2)+'\n';
  await atomicWrite(path.join(out,'manifest.json'),text);
  if (values.bundled) await atomicWrite(path.join(appRoot,'data/bundled-snapshot.json'),text);
  console.log(`数据 #${revision} · ${manifest.patch} · ${manifest.statsAsOf}\n${out}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
