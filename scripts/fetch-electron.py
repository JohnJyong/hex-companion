#!/usr/bin/env python3
"""Fallback downloader for environments where Node cannot use the system proxy.
Downloads only official releases and verifies the checksums shipped by Electron.
"""
import hashlib
import json
import pathlib
import subprocess
import sys
import time
import urllib.request

root = pathlib.Path(__file__).resolve().parents[1]
version = json.loads((root / 'node_modules/electron/package.json').read_text())['version']
checksums = json.loads((root / 'node_modules/electron/checksums.json').read_text())
cache = root / '.cache/electron'
cache.mkdir(parents=True, exist_ok=True)
targets = [x for x in sys.argv[1:] if not x.startswith('--')] or ['darwin-arm64', 'win32-x64']
for target in targets:
    name = f'electron-v{version}-{target}.zip'
    if name not in checksums:
        raise SystemExit(f'Unsupported target: {target}')
    path = cache / name
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != checksums[name]:
        for attempt in range(4):
            try:
                request = urllib.request.Request(f'https://github.com/electron/electron/releases/download/v{version}/{name}', headers={'User-Agent': 'Mozilla/5.0'})
                with urllib.request.urlopen(request, timeout=35) as response, path.with_suffix('.part').open('wb') as out:
                    while chunk := response.read(1024 * 1024):
                        out.write(chunk)
                temp = path.with_suffix('.part')
                if hashlib.sha256(temp.read_bytes()).hexdigest() != checksums[name]:
                    raise RuntimeError('SHA-256 verification failed')
                temp.replace(path)
                break
            except Exception as error:
                if attempt == 3:
                    raise
                print(f'Retrying {target}: {type(error).__name__}', flush=True)
                time.sleep(1)
    print(f'Verified {name}', flush=True)
if '--install-mac' in sys.argv:
    path = cache / f'electron-v{version}-darwin-arm64.zip'
    if not path.exists():
        raise SystemExit('Download darwin-arm64 first')
    dest = root / 'node_modules/electron/dist'
    dest.mkdir(exist_ok=True)
    subprocess.run(['ditto', '-x', '-k', str(path), str(dest)], check=True)
    (root / 'node_modules/electron/path.txt').write_text('Electron.app/Contents/MacOS/Electron')
    print('Installed local macOS Electron runtime', flush=True)
