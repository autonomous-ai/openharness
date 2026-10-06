#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

out, root = map(Path, sys.argv[1:])
lock = json.loads((Path(__file__).resolve().parents[1] / 'lock.json').read_text())
isos = list(out.glob('*.iso'))
if len(isos) != 1:
    raise SystemExit('Expected exactly one ISO')
iso = isos[0]
with iso.open('rb') as handle:
    digest = hashlib.file_digest(handle, 'sha256').hexdigest()
(out / (iso.name + '.sha256')).write_text(f'{digest}  {iso.name}\n')
packages = (root / 'usr/share/harness-os/packages.txt').read_text()
(out / 'packages.txt').write_text(packages)
capabilities = []
if (root / 'usr/lib/systemd/user/harness-install.service').is_file():
    capabilities.append('install-first')
if all((root / path).is_file() for path in [
        'usr/lib/harness-os/live_update.py',
        'usr/lib/systemd/user/harness-update.timer']):
    capabilities.append('runtime-updates')
if (root / 'usr/lib/harness-os/release_update.py').is_file():
    capabilities.append('system-updates')
if (root / 'etc/sudoers.d/30-harness-updates').is_file():
    capabilities.append('single-action-updates')
hardware = {}
platform = json.loads((root / 'etc/harness-platform.json').read_text())['id']
if platform == 'apple-t2':
    capabilities.extend(['t2-kernel', 'apple-firmware-preservation'])
    hardware['apple-t2'] = json.loads((root / 'usr/share/harness-os/apple-t2/manifest.json').read_text())
for driver in ['broadcom', 'nvidia']:
    path = root / f'usr/share/harness-os/hardware/{driver}/manifest.json'
    if path.is_file():
        capabilities.append(driver + '-offline')
        hardware[driver] = json.loads(path.read_text())
manifest = {
    'version': lock['version'], 'architecture': 'x86_64',
    'platform': platform,
    'source_commit': os.environ.get('HARNESS_OS_SOURCE_SHA') or subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'built_at_unix': int(time.time()), 'arch_snapshot': lock['arch_snapshot'],
    'iso': {'name': iso.name, 'bytes': iso.stat().st_size, 'sha256': digest},
    'capabilities': capabilities,
    'package_version': dict(row.split(maxsplit=1) for row in packages.splitlines())['harness-os'],
    'harness_inputs': json.loads((root / 'usr/share/harness-os/runtime.json').read_text()), 'validation': 'pending',
    'compositor': json.loads((root / 'usr/share/harness-os/compositor.json').read_text()),
    'hardware': hardware,
}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
