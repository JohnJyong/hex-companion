#!/usr/bin/env python3
"""Build an offline catalog from pinned Riot/CommunityDragon client data.

KIWI is ARAM Mayhem; CHERRY is Arena and KIWI_JADE is Classic-ish Mayhem.
We deliberately never substitute Arena numerical values into Mayhem effects.
"""
import argparse
import concurrent.futures
import html
import json
import pathlib
import re
import shutil
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--version', default='16.22.1')
parser.add_argument('--as-of', default='2026-11-17')
parser.add_argument('--display-patch', help='Public patch label, for example 26.23')
parser.add_argument('--skip-assets', action='store_true')
args = parser.parse_args()
if not re.fullmatch(r'\d+\.\d+\.\d+', args.version):
    raise SystemExit('Use a Data Dragon version such as 16.22.1')
version = args.version
patch = '.'.join(version.split('.')[:2])
display_patch = args.display_patch or f'{int(version.split(".")[0]) + 10}.{version.split(".")[1]}'
if not re.fullmatch(r'\d{1,3}\.\d{1,3}', display_patch):
    parser.error('Invalid public patch label')
rawdir = ROOT / 'data/raw' / version
rawdir.mkdir(parents=True, exist_ok=True)
base = f'https://raw.communitydragon.org/{patch}'
dd = f'https://ddragon.leagueoflegends.com/cdn/{version}'
sources = {
    'champions-full': f'{dd}/data/zh_CN/championFull.json',
    'items': f'{dd}/data/zh_CN/item.json',
    'augments': f'{base}/plugins/rcp-be-lol-game-data/global/zh_cn/v1/cherry-augments.json',
    'english-augments': f'{base}/plugins/rcp-be-lol-game-data/global/default/v1/cherry-augments.json',
    'augment-lists': f'{base}/plugins/rcp-be-lol-game-data/global/zh_cn/v1/augment-lists.json',
    'strings': f'{base}/game/zh_cn/data/menu/en_us/lol.stringtable.json',
}

def download(url, path):
    if path.exists() and path.stat().st_size:
        return True
    error = None
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'HexCompanion/0.1 (offline catalog; community tool)'})
            with urllib.request.urlopen(request, timeout=35) as response:
                data = response.read()
            path.parent.mkdir(parents=True, exist_ok=True)
            temp = path.with_suffix(path.suffix + '.tmp')
            temp.write_bytes(data)
            temp.replace(path)
            return True
        except Exception as e:
            error = e
            time.sleep(attempt + 0.2)
    print(f'Fetch failed: {url}: {error}', flush=True)
    return False

with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
    fetched = list(executor.map(lambda kv: download(kv[1], rawdir / (kv[0] + '.json')), sources.items()))
if not all(fetched):
    raise SystemExit('Source fetch incomplete; the installed catalog was not replaced.')

def read(name):
    return json.loads((rawdir / (name + '.json')).read_text(encoding='utf-8'))

strings = read('strings')['entries']

def clean(value):
    value = re.sub(r'<br\s*/?>', '\n', value, flags=re.I)
    value = re.sub(r'<[^>]*>', '', value)
    value = re.sub(r'%i:[^%]+%', '', value)
    return html.unescape(value).strip()

def expand(value, depth=0):
    if depth > 4:
        return value
    def sub(match):
        key = match[1].strip().lower()
        if key == 'spellname':
            return '对应技能'
        if key == 'item_keyword_onhit':
            return '攻击特效'
        return expand(strings.get(key, '对应效果'), depth + 1)
    return re.sub(r'\{\{\s*([^}]+)\s*\}\}', sub, value)

def qualitative(value):
    value = clean(expand(value))
    value = re.split(r'已造成|本回合|这个回合|已获得|额外伤害：|已降低|已削减|最大战神附体等级：', value)[0]
    # Client templates require runtime calculations. Omit these values explicitly,
    # rather than guessing or reusing values from the Arena dataset.
    value = re.sub(r'@[^@]+@%', '一定比例的', value)
    value = re.sub(r'@[^@]+@', '一定', value)
    value = re.sub(r'一定秒', '数秒', value)
    value = re.sub(r'一定个', '若干个', value)
    value = re.sub(r'一定次', '若干次', value)
    value = re.sub(r'一定层', '若干层', value)
    value = re.sub(r'\s+', ' ', value)
    return value.strip()

def description(api, name):
    full = api.lower()
    short = full.removeprefix('aram_')
    stems = [f'kiwi_{full}', f'kiwi_{short}', f'kiwi_augment_{short}', f'kiwi_aram_{short}', short, f'augment_{short}']
    stems += [key[:-5] for key, value in strings.items() if key.endswith('_name') and value.strip() == name and not key.startswith(('cherry_', 'item_', 'generatedtip_', 'game_'))]
    for stem in stems:
        for end in ['summary', 'description', 'desc', 'tooltip', 'tooltipdescription']:
            key = f'{stem}_{end}'
            if key in strings:
                text = qualitative(strings[key])
                if text and text != '对应效果':
                    return text, key, 'mayhem'
    # Shared effects are marked as shared; no Arena numerical values are used.
    for end in ['summary', 'tooltipdescription', 'tooltip']:
        key = f'cherry_{short}_{end}'
        if key in strings:
            return qualitative(strings[key]), key, 'shared'
    return '该符文的机制尚未完成核对，请结合游戏内说明判断。', None, 'unverified'

pool = next(x['augmentList'] for x in read('augment-lists') if x['modeName'] == 'KIWI')
lookup = {x['augmentNameId']: x for x in read('augments')}
english = {x['augmentNameId']: x['nameTRA'] for x in read('english-augments')}
augments = []
jobs = []
for path in pool:
    key = path.split('/')[-1]
    a = lookup.get(key)
    if not a or not a['nameTRA'].strip():
        continue
    desc, source_key, scope = description(key, a['nameTRA'])
    img = a['augmentSmallIconPath'].replace('/lol-game-data/assets/', '').lower()
    augments.append({
        'id': key, 'gameId': a['id'], 'name': a['nameTRA'], 'en': english.get(key, key),
        'tier': {'kSilver': 'silver', 'kGold': 'gold', 'kPrismatic': 'prismatic'}[a['rarity']],
        'description': desc, 'descriptionKey': source_key, 'descriptionScope': scope,
        'abilitySpecific': '对应技能' in desc, 'icon': f'assets/augments/{a["id"]}.png',
    })
    jobs.append((f'{base}/plugins/rcp-be-lol-game-data/global/default/{img}', ROOT / f'app/assets/augments/{a["id"]}.png'))

champions = []
for key, c in read('champions-full')['data'].items():
    champions.append({
        # Data Dragon zh_CN stores the epithet in name and the personal name in title.
        'id': key, 'gameId': int(c['key']), 'name': c['title'], 'title': c['name'],
        'roles': c['tags'], 'resource': c['partype'], 'stats': c['stats'],
        'spells': [{'name': x['name'], 'description': clean(x['description'])} for x in c['spells']],
        'passive': {'name': c['passive']['name'], 'description': clean(c['passive']['description'])},
        'icon': f'assets/champions/{key}.png',
    })
    jobs.append((f'{dd}/img/champion/{key}.png', ROOT / f'app/assets/champions/{key}.png'))

items = []
for key, item in read('items')['data'].items():
    # Only normal purchasable finished ARAM items and boots. Exclude mode variants,
    # Ornn upgrades, quest rewards, components, and summoner-rift-only items.
    if not item.get('maps', {}).get('12') or not item['gold'].get('purchasable'):
        continue
    if item['gold']['total'] < 1800 and not ('Boots' in item.get('tags', []) and item['gold']['total'] >= 900):
        continue
    if (int(key) >= 10000 and key not in ['123430', '124011', '126697']) or item.get('requiredAlly') or item.get('requiredChampion'):
        continue
    if item.get('into') and 'Boots' not in item.get('tags', []):
        continue
    items.append({
        'id': key, 'name': item['name'], 'description': clean(item['description']),
        'cost': item['gold']['total'], 'tags': item.get('tags', []), 'stats': item.get('stats', {}),
        'icon': f'assets/items/{key}.png', 'from': item.get('from', []),
    })
    jobs.append((f'{dd}/img/item/{key}.png', ROOT / f'app/assets/items/{key}.png'))

if not args.skip_assets:
    # The same icon filename can contain different art in a later game patch.
    cached_jobs = [(url, rawdir / dest.relative_to(ROOT / 'app')) for url, dest in jobs]
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        results = list(executor.map(lambda job: download(*job), cached_jobs))
    print(f'Offline images: {sum(results)}/{len(results)}', flush=True)
    if not all(results):
        raise SystemExit('Asset fetch incomplete. Retry; already-downloaded assets are cached.')
    for (_, cached), (_, dest) in zip(cached_jobs, jobs):
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(cached, dest)

catalog = {
    'meta': {
        'schema': 1, 'patch': display_patch, 'dataDragonVersion': version,
        'asOf': args.as_of, 'mode': 'KIWI', 'modeName': '海克斯大乱斗',
        'note': '客户端符文池快照；服务器热更新及国服开放情况以实际对局为准。动态数值已省略，推荐为机制规则评分。',
        'sources': [
            {'name': 'Riot Data Dragon · 英雄与装备', 'url': 'https://developer.riotgames.com/docs/lol#data-dragon'},
            {'name': 'CommunityDragon · 中文客户端数据', 'url': f'{base}/plugins/rcp-be-lol-game-data/global/zh_cn/v1/augment-lists.json'},
            {'name': f'Riot Games · {display_patch} 版本说明', 'url': f'https://www.leagueoflegends.com/en-us/news/game-updates/league-of-legends-patch-{display_patch.replace(".", "-")}-notes/'},
            {'name': 'Riot Games · 模式规则', 'url': 'https://support.riotgames.com/en-us/league-of-legends/events/league-of-legends-aram-mayhem-game-mode'},
        ],
    },
    'champions': champions, 'augments': augments, 'items': items,
}
target = ROOT / 'app/data/catalog.json'
temp = target.with_suffix('.tmp')
temp.write_text(json.dumps(catalog, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
temp.replace(target)
print(f'Catalog: {len(champions)} champions, {len(augments)} augments, {len(items)} items', flush=True)
print('Unverified effects:', ', '.join(x['name'] for x in augments if x['descriptionScope'] == 'unverified') or 'none')
