import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// Keep ordinary desktop regression tests on the bundled snapshot, even online.
export async function manualDataProfile(profile) {
  const directory = join(profile,'data-updates','v1');
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'preferences.json'),JSON.stringify({automatic:false}));
  return profile;
}
