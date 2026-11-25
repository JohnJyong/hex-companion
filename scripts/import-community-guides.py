#!/usr/bin/env python3
"""Import attributed Mayhem guide *indexes*, never third-party guide prose.

Explicit developer action. JSON facts are CC BY 4.0; combination prerequisites,
item builds and individual guide patch dates are not present in this export.
Use --offline to rebuild from .cache/references/arammayhem after review.
"""
import argparse
from collections import Counter, defaultdict
from datetime import date
import hashlib
import json
from pathlib import Path
import re
import unicodedata
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://arammayhem.com'
DATA = BASE + '/data/v1/latest/'
DEFAULT_RELEASE = 'website:20261117_104116:1cab57535c99'
REVIEWED_HASHES = {
    'combos.json': '710355abf7b91df296a5518966bdfdeee5a51cd415b6626df5fe52ef118b2375',
    'augments.json': '739898ebc97e561738f2257d72f5082f9fa3be473fdc980f90dd4c818a32a3c0',
    'index.json': 'a86689f84f4860e8ae809a08161295ca5e61ee32340e2a769d8d69f73a737eba',
}
TAGS = {'trap': '慎选反例', 'bug': '异常机制待核实', 'entertainment': '娱乐玩法',
        'god': '来源标为强势', 'strong': '来源标为较强', 'blackTech': '特殊搭配'}


def normalize(value):
    """Punctuation-only normalization; no fuzzy or substring name matching."""
    return ''.join(c.casefold() for c in unicodedata.normalize('NFKC', value) if c.isalnum())


def name_key(value):
    # Some upstream names retain the literal quest prefix removed by the client.
    value = re.sub(r'^(?:Quest\s*[:：]|任务\s*[:：])\s*', '', value, flags=re.I)
    return normalize(value)


def validate_wrapper(data, release):
    if (not isinstance(data, dict) or data.get('schemaVersion') != 1 or data.get('source') != BASE + '/data/'
            or data.get('licenseUrl') != 'https://creativecommons.org/licenses/by/4.0/'
            or not isinstance(data.get('license'), str) or not data['license'].startswith('CC BY 4.0:')
            or not isinstance(data.get('dataSource'), str) or not data['dataSource'].startswith('ARAM: Mayhem ')
            or not isinstance(data.get('meta'), dict) or data['meta'].get('releaseId') != release
            or not isinstance(data.get('rows'), list)):
        raise ValueError('Unexpected source, mode, license, schema or release; review before importing')


def augment_mapping(catalog, upstream):
    by_name = defaultdict(set)
    local = {a['id']: a for a in catalog['augments']}
    for a in local.values():
        for name in [a['name'], a['en']]:
            by_name[name_key(name)].add(a['id'])
    mapping = {}
    for a in upstream:
        names = a.get('name', {})
        if not isinstance(names, dict):
            continue
        matches = set()
        for lang in ['zh-CN', 'en']:
            name = names.get(lang)
            if isinstance(name, str):
                matches.update(by_name.get(name_key(name), set()))
        if len(matches) != 1 or a.get('retiredPatch') is not None:
            continue
        identifier = next(iter(matches))
        if local[identifier]['tier'] != a.get('rarity'):
            continue
        # Internal IDs alone do not prove an old augment has unchanged mechanics:
        # e.g. DoubleDefense now has the displayed name Bolstered. Do not alias it.
        mapping[a['augmentId']] = identifier
    return mapping


def transform(catalog, combos, augments, checked_at, release, chinese_urls=()):
    date.fromisoformat(checked_at)
    if catalog.get('meta', {}).get('mode') != 'KIWI':
        raise ValueError('Only the local KIWI catalog is eligible')
    validate_wrapper(combos, release)
    validate_wrapper(augments, release)
    if any(not isinstance(a, dict) or not isinstance(a.get('augmentId'), str) for a in augments['rows']):
        raise ValueError('Invalid upstream augment identity')
    source_ids = [a['augmentId'] for a in augments['rows']]
    if len(set(source_ids)) != len(source_ids):
        raise ValueError('Ambiguous upstream augment IDs')
    mapping = augment_mapping(catalog, augments['rows'])
    source_augments = {a['augmentId']: a for a in augments['rows']}
    heroes = {c['id']: c for c in catalog['champions']}
    local_augments = {a['id']: a for a in catalog['augments']}
    chinese_urls = set(chinese_urls)
    seen, seen_ids, results, rejected = set(), set(), [], []
    for row in combos['rows']:
        if not isinstance(row, dict):
            rejected.append({'comboId': None, 'reason': 'invalid-row'})
            continue
        identifier = row.get('comboId')
        hero_id, ids, tags = row.get('championId'), row.get('augmentIds'), row.get('types')
        slug, url = row.get('slug'), row.get('url')
        reason = None
        if type(identifier) is not int or identifier <= 0 or identifier in seen_ids:
            reason = 'invalid-or-duplicate-source-id'
        elif not isinstance(hero_id, str) or hero_id not in heroes:
            reason = 'unknown-champion'
        elif (not isinstance(ids, list) or not ids or any(not isinstance(x, str) for x in ids)
              or len(set(ids)) != len(ids)):
            reason = 'invalid-augment-list'
        elif not isinstance(tags, list) or any(not isinstance(t, str) or t not in TAGS for t in tags):
            reason = 'unknown-source-tag'
        # The export's old slug may be Chinese; its URL is the canonical route.
        # Do not synthesize links from that older slug.
        elif (not isinstance(slug, str) or not slug or not isinstance(url, str)
              or not re.fullmatch(re.escape(BASE) + r'/combo/[a-z0-9]+(?:-[a-z0-9]+)*/', url)):
            reason = 'invalid-source-url'
        elif any(a not in mapping for a in ids):
            reason = 'unmapped-or-retired-augment'
        else:
            names = row.get('augmentNames')
            if not isinstance(names, list) or len(names) != len(ids):
                reason = 'missing-source-names'
            elif any(not isinstance(name, dict) or any(
                    name.get(lang) != source_augments[a]['name'].get(lang)
                    for lang in ['en', 'zh-CN']) for a, name in zip(ids, names)):
                reason = 'source-name-conflict'
        if reason:
            rejected.append({'comboId': identifier, 'reason': reason})
            continue
        mapped = [mapping[a] for a in ids]
        # Never silently drop unknown members and manufacture a smaller combo.
        if len(set(mapped)) != len(mapped):
            rejected.append({'comboId': identifier, 'reason': 'ambiguous-local-identity'})
            continue
        signature = (hero_id, tuple(sorted(mapped)))
        if signature in seen:
            rejected.append({'comboId': identifier, 'reason': 'duplicate-relationship'})
            continue
        seen.add(signature)
        seen_ids.add(identifier)
        hero = heroes[hero_id]['name']
        names = [local_augments[a]['name'] for a in mapped]
        stance = 'caution' if set(tags) & {'trap', 'bug'} else 'entertainment' if 'entertainment' in tags else 'reference'
        label = '慎选索引' if stance == 'caution' else '娱乐索引' if stance == 'entertainment' else '社区索引'
        short = '、'.join(names[:2]) + (f'等 {len(names)} 项' if len(names) > 2 else '')
        labels = '、'.join(TAGS[t] for t in tags)
        summary = f'来源条目关联{hero}与{short}。' + (f'上游标签：{labels}。' if labels else '')
        summary += '仅为攻略检索索引；未验证触发条件、必选关系或版本时效，请查看原文。'
        zh_url = url.replace('/combo/', '/zh-cn/combo/', 1)
        localized = zh_url in chinese_urls
        results.append({
            'id': f'arammayhem-{identifier}', 'title': f'{hero} · {short} · {label}',
            'championIds': [hero_id], 'augmentIds': mapped, 'itemIds': [],
            'summary': summary, 'sourceTitle': 'ARAM Mayhem · 社区组合索引',
            'sourceUrl': zh_url if localized else url, 'sourceCanonicalUrl': url,
            'sourceLanguage': 'zh-CN' if localized else 'en',
            'patch': None, 'checkedAt': checked_at, 'kind': 'community', 'mode': 'KIWI',
            'contentType': 'index', 'relation': 'hero-augment' if len(mapped) == 1 else 'mentioned-together',
            'stance': stance, 'sourceTags': tags,
            'sourceComboId': identifier, 'sourceAugmentIds': ids, 'sourceReleaseId': release,
            'sourceDataUrl': DATA + 'combos.json',
            'sourceUrlEvidence': 'published-sitemap' if localized else 'licensed-export',
            'license': 'CC BY 4.0', 'licenseUrl': 'https://creativecommons.org/licenses/by/4.0/',
            'attribution': '数据来源：arammayhem.com', 'attributionUrl': BASE + '/data/',
        })
    return sorted(results, key=lambda r: r['sourceComboId']), rejected


def fetch(url, limit=16 * 1024 * 1024):
    if urlparse(url).scheme != 'https' or urlparse(url).netloc != 'arammayhem.com':
        raise ValueError('Only the reviewed public source host is allowed')
    with urlopen(Request(url, headers={'User-Agent': 'HexCompanion/0.4 (public CC-BY data import)'}), timeout=40) as response:
        raw = response.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('Source exceeds maximum size')
    return raw


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', default=DEFAULT_RELEASE, help='Expected release, fail closed on source changes')
    parser.add_argument('--checked-at', default=date.today().isoformat())
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    cache = ROOT / '.cache/references/arammayhem'
    cache.mkdir(parents=True, exist_ok=True)
    files = {'combos.json': DATA + 'combos.json', 'augments.json': DATA + 'augments.json',
             'index.json': BASE + '/data/v1/index.json', 'sitemap-0.xml': BASE + '/sitemap-0.xml'}
    raw = {}
    for name, url in files.items():
        raw[name] = (cache / name).read_bytes() if args.offline else fetch(url)
        if (args.release == DEFAULT_RELEASE and name in REVIEWED_HASHES
                and hashlib.sha256(raw[name]).hexdigest() != REVIEWED_HASHES[name]):
            raise ValueError(f'{name} changed within the reviewed release; review source corrections first')
        if not args.offline:
            (cache / name).write_bytes(raw[name])
    index = json.loads(raw['index.json'])
    if index.get('releaseId') != args.release or index.get('license', {}).get('name') != 'CC BY 4.0':
        raise ValueError('Review changed source release/license before importing')
    sitemap = ElementTree.fromstring(raw['sitemap-0.xml'])
    chinese_urls = [el.text for el in sitemap.iter('{http://www.sitemaps.org/schemas/sitemap/0.9}loc')]
    catalog = json.loads((ROOT / 'app/data/catalog.json').read_text())
    guides, rejected = transform(catalog, json.loads(raw['combos.json']), json.loads(raw['augments.json']),
                                 args.checked_at, args.release, chinese_urls)
    if not guides:
        raise ValueError('No verified entries: leave the previous dataset unchanged')
    report = {'release': args.release, 'checkedAt': args.checked_at,
              'imported': len(guides), 'champions': len({c for g in guides for c in g['championIds']}),
              'sourceSha256': {name: hashlib.sha256(value).hexdigest() for name, value in raw.items()},
              'rejected': rejected, 'rejectionCounts': dict(Counter(r['reason'] for r in rejected))}
    target = ROOT / 'app/data/community-guides.json'
    temporary = target.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(guides, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(target)
    (cache / 'import-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k not in ['rejected', 'sourceSha256']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
