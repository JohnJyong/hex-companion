#!/usr/bin/env python3
"""Import a pinned, attributed non-commercial ARAM: Mayhem statistical snapshot.

Check all raw files against the same tagged manifest before replacing the outputs.
"""
import argparse
from datetime import date
import hashlib
import json
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--ref', default='data-v18')
args = parser.parse_args()
if not re.fullmatch(r'data-v\d+|[0-9a-f]{40}', args.ref):
    parser.error('Use an immutable data-v tag or commit SHA')
BASE = f'https://raw.githubusercontent.com/czgreat/aramhex-data/{args.ref}'
CACHE = ROOT / '.cache/references/aramhex-data'
CACHE.mkdir(parents=True, exist_ok=True)

def fetch(url):
    with urllib.request.urlopen(url, timeout=45) as response:
        data = response.read(16 * 1024 * 1024 + 1)
    if len(data) > 16 * 1024 * 1024:
        raise ValueError('Statistics response exceeds size limit')
    return data

manifest = json.loads(fetch(f'{BASE}/latest.json'))
if manifest.get('schema_version') != 1 or manifest.get('mode') != 'normal':
    raise ValueError('Only schema 1 normal-rules Mayhem data is supported')
data_path = manifest['path']
if not re.fullmatch(r'patches/[0-9.]+/normal', data_path):
    raise ValueError('Unexpected snapshot path')
files = ['heroes.json', 'augments.json', 'hero_augments.json', 'meta.json',
         'core_builds.json', 'hero_item_recommendations.json',
         'hero_augment_items.json', 'equipment_recommendation_heroes.json', 'item_metadata.json']
tables = {}
for name in files:
    expected = manifest['files'][name]['sha256']
    cached = CACHE / name
    raw = cached.read_bytes() if cached.exists() else b''
    if hashlib.sha256(raw).hexdigest() != expected:
        raw = fetch(f'{BASE}/{data_path}/{name}')
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError(f'SHA-256 mismatch: {name}')
    cached.write_bytes(raw)
    tables[name] = json.loads(raw)

catalog = json.loads((ROOT / 'app/data/catalog.json').read_text(encoding='utf-8'))
raw_meta = tables['meta.json']
if (not catalog['meta']['dataDragonVersion'].startswith(manifest['patch'] + '.')
        or raw_meta['patch'] != manifest['patch'] or raw_meta['snapshot_at'] != manifest['snapshot_at']
        or raw_meta['mode'] != 'normal' or raw_meta.get('license') != 'CC BY-NC 4.0'
        or raw_meta['matches']['valid'] != manifest['matches']):
    raise ValueError('Update the matching KIWI catalog first; the three statistical tables must share one snapshot')
source = {
    'name': 'AramHex 海克斯大乱斗统计',
    'url': f'https://github.com/czgreat/aramhex-data/tree/{args.ref}/{data_path}',
    'license': 'CC BY-NC 4.0',
    'licenseUrl': 'https://github.com/czgreat/aramhex-data/blob/main/LICENSE',
    'attribution': '海克斯大乱斗统计数据（github.com/czgreat/aramhex-data），CC BY-NC 4.0',
    'nonCommercialOnly': True, 'ref': args.ref, 'seq': manifest['seq'],
    'files': {name: manifest['files'][name] for name in files},
}
meta = {
    'schema': 1, 'mode': 'KIWI', 'modeName': '海克斯大乱斗（ARAM: Mayhem）',
    'rule': 'normal', 'ruleName': '常规', 'band': 'all', 'bandName': '全体样本',
    'patch': manifest['patch'],
    'displayPatch': catalog['meta']['patch'],
    'asOf': manifest['snapshot_at'], 'window': manifest['window'],
    'matches': manifest['matches_detail'], 'lowSampleThreshold': raw_meta.get('low_sample_threshold', 3000),
    'source': source, 'limitations': raw_meta['limitations'],
}
active_augments = {str(a['gameId']): tables['augments.json'][str(a['gameId'])]
                   for a in catalog['augments'] if str(a['gameId']) in tables['augments.json']}
hero_data = {
    'meta': {**meta, 'retrievedAt': date.today().isoformat(), 'regions': raw_meta['regions'],
             'heroParticipations': raw_meta['hero_participations'],
             'source': {**source, 'dataUrl': f'https://github.com/czgreat/aramhex-data/blob/{args.ref}/{data_path}/heroes.json',
                        'manifestUrl': f'https://github.com/czgreat/aramhex-data/blob/{args.ref}/latest.json',
                        'sha256': manifest['files']['heroes.json']['sha256']}},
    'heroes': tables['heroes.json'],
}
augment_data = {
    'meta': {**meta, 'excludedAugments': raw_meta.get('excluded_augments', {}),
             'deltaDefinition': '(hero_augment_win_rate - hero_baseline_win_rate) * 100; percentage points, observational',
             'rankDefinition': 'Raw win rate within this hero and rarity; current KIWI catalog, >=3000 appearances, non-low-sample rows only',
             'gradeDefinition': 'Local percentile buckets S(top10%), A(top30%), B(top60%), C(top85%), D; not an upstream rating'},
    'heroes': tables['heroes.json'], 'augments': active_augments,
    'heroAugments': tables['hero_augments.json'],
}
item_data = {
    'meta': {**meta, 'equipment': raw_meta['equipment'], 'destiny': raw_meta['components']['destiny'],
             'evidenceNote': 'coreBuilds describes the observed first three legendary items only; any extra items or changes are rule-based'},
    'coreBuilds': tables['core_builds.json'],
    'heroItems': tables['hero_item_recommendations.json'],
    'heroAugmentItems': tables['hero_augment_items.json'],
    'equipmentHeroes': tables['equipment_recommendation_heroes.json'],
    'itemMetadata': tables['item_metadata.json'],
}
for filename, value in [('champion-stats.json', hero_data), ('augment-stats.json', augment_data), ('item-stats.json', item_data)]:
    target = ROOT / 'app/data' / filename
    temp = target.with_suffix('.json.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    temp.replace(target)
    print(f'{filename}: {target.stat().st_size:,} bytes; {meta["patch"]}, {meta["asOf"]}, CC BY-NC 4.0')
