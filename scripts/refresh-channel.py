#!/usr/bin/env python3
"""Refresh an existing data-v1 checkout from a tagged normal-mode snapshot and reviewed guides."""
import argparse
import base64
from datetime import date
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = 'https://raw.githubusercontent.com/czgreat/aramhex-data'
VERSIONS = 'https://ddragon.leagueoflegends.com/api/versions.json'
CURATED = ('editorial-guides', 'community-guides', 'recommendation-rules')


def get_json(url):
    with urlopen(url, timeout=45) as response:
        return json.loads(response.read(2 * 1024 * 1024))


def read_bundle(channel, manifest, key):
    descriptor = manifest['bundles'][key]
    digest = descriptor['sha256']
    if not re.fullmatch('[0-9a-f]{64}', digest):
        raise ValueError('Invalid bundle digest')
    file = channel / f'{key}-{digest}.json.gz'
    if not 0 < file.stat().st_size == descriptor['bytes'] <= 32 * 1024 * 1024:
        raise ValueError(f'Invalid {key} size')
    if hashlib.sha256(file.read_bytes()).hexdigest() != digest:
        raise ValueError(f'Invalid {key} checksum')
    with gzip.open(file) as stream:
        raw = stream.read(64 * 1024 * 1024 + 1)
    if len(raw) > 64 * 1024 * 1024:
        raise ValueError('Expanded bundle is too large')
    return json.loads(raw)


def refresh(channel):
    manifest = json.loads((channel / 'manifest.json').read_bytes())
    if manifest['schema'] != 1:
        raise ValueError('Unsupported channel schema')
    tables = read_bundle(channel, manifest, 'tables')
    current = tables['champion-stats']['meta']
    latest = get_json(UPSTREAM + '/main/latest.json')
    if (latest['schema_version'] != 1 or latest['mode'] != 'normal'
            or type(latest['seq']) is not int or latest['seq'] < current['source']['seq']
            or not re.fullmatch(r'\d+\.\d+', latest['patch'])):
        raise ValueError('Incompatible or older upstream manifest')
    patch = latest['patch']
    version = next((v for v in get_json(VERSIONS) if re.fullmatch(re.escape(patch) + r'\.\d+', v)), None)
    if not version:
        raise ValueError(f'No Data Dragon catalog for {patch}')
    curated = {name: json.loads((ROOT / 'app/data' / (name + '.json')).read_bytes()) for name in CURATED}
    new_catalog = version != tables['catalog']['meta']['dataDragonVersion']
    new_stats = latest['seq'] != current['source']['seq']
    if not new_catalog and not new_stats and all(tables.get(k) == curated[k] for k in CURATED):
        print(f"Data #{manifest['revision']} already includes {version} and data-v{latest['seq']}.")
        return

    with TemporaryDirectory(prefix='hex-publish-') as tmp:
        work = Path(tmp)
        data = work / 'app/data'
        data.mkdir(parents=True)
        (work / 'scripts').mkdir()
        for name in ('update-data.py', 'update-stats.py'):
            shutil.copyfile(ROOT / 'scripts' / name, work / 'scripts' / name)
        for name, value in {**tables, **curated}.items():
            if name not in ('catalog', 'champion-stats', 'augment-stats', 'item-stats', *CURATED):
                raise ValueError('Unknown dataset')
            (data / (name + '.json')).write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        if new_catalog:
            subprocess.run([sys.executable, str(work / 'scripts/update-data.py'), '--version', version,
                            '--as-of', date.today().isoformat()], check=True)
        else:
            for icon, encoded in read_bundle(channel, manifest, 'icons').items():
                if not re.fullmatch(r'assets/(champions|augments|items)/[A-Za-z0-9_-]+\.png', icon):
                    raise ValueError('Unexpected icon path')
                target = work / 'app' / icon
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(base64.b64decode(encoded, validate=True))
        if new_stats:
            subprocess.run([sys.executable, str(work / 'scripts/update-stats.py'), '--ref', f"data-v{latest['seq']}"], check=True)
            imported = json.loads((data / 'champion-stats.json').read_bytes())['meta']
            if (imported['asOf'], imported['patch'], imported['source']['seq']) != (latest['snapshot_at'], patch, latest['seq']):
                raise ValueError('Tagged snapshot differs from the upstream index')
        subprocess.run(['node', str(ROOT / 'scripts/pack-data.mjs'), '--source', str(work / 'app'),
                        '--out', str(channel), '--revision', str(manifest['revision'] + 1)], check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('channel', type=Path, help='Existing data-v1 branch checkout')
    refresh(parser.parse_args().channel.resolve())
