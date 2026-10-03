#!/usr/bin/env python3
"""Discover and apply a published Harness OS package from the official channel.

The unprivileged screen may cache availability. Root independently fetches the
official metadata and verifies a private download before changing the machine.
TLS authenticates the release channel; SHA-256 verifies its published assets.
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

FEED = 'https://github.com/autonomous-ai/openharness/releases/download/os-preview-updates/metadata.json'
ASSETS = 'https://github.com/autonomous-ai/openharness/releases/download/'
LOCK = Path('/usr/share/harness-os/lock.json')


def load_runtime_updater():
    spec = importlib.util.spec_from_file_location('harness_os_runtime_update', Path(__file__).with_name('runtime_update.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fetch(url, maximum, fixture=False):
    parsed = urlparse(url)
    if parsed.username or parsed.password or not (parsed.scheme == 'https' or fixture and parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost', '::1')):
        raise ValueError('System updates require HTTPS.')
    with urlopen(Request(url, headers={'User-Agent': 'Harness-OS-Updates/1'}), timeout=30) as response:
        if not fixture and urlparse(response.url).scheme != 'https':
            raise ValueError('System update redirected away from HTTPS.')
        data = response.read(maximum + 1)
        if len(data) > maximum:
            raise ValueError('System update exceeds its size limit.')
        return data


def asset(value, maximum, fixture=False):
    if not isinstance(value, dict) or type(value.get('bytes')) is not int or not 0 < value['bytes'] <= maximum or not re.fullmatch(r'[a-f0-9]{64}', str(value.get('sha256', ''))):
        raise ValueError('Invalid system update asset.')
    url = value.get('url', '')
    if not isinstance(url, str):
        raise ValueError('Invalid system package URL.')
    parsed = urlparse(url)
    if not (url.startswith(ASSETS) or fixture and parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1')):
        raise ValueError('System packages must come from the official Harness release repository.')
    return value


def verified(value, fixture=False):
    data = fetch(value['url'], value['bytes'], fixture)
    if len(data) != value['bytes'] or hashlib.sha256(data).hexdigest() != value['sha256']:
        raise ValueError('System update download failed its checksum or size check.')
    return data


def discover(feed=FEED):
    fixture = feed != FEED
    try:
        metadata = json.loads(fetch(feed, 65536, fixture))
    except HTTPError as error:
        if error.code == 404:
            return None
        raise
    if not isinstance(metadata, dict) or metadata.get('schema') != 1 or metadata.get('channel') != 'preview' or metadata.get('architecture') != 'x86_64':
        raise ValueError('Invalid Harness OS update channel.')
    asset(metadata.get('manifest'), 1024 * 1024, fixture)
    asset(metadata.get('package'), 128 * 1024 * 1024, fixture)
    manifest = json.loads(verified(metadata['manifest'], fixture))
    if not isinstance(manifest, dict):
        raise ValueError('Invalid system package manifest.')
    package = manifest.get('package', {})
    if not isinstance(package, dict) or any(package.get(key) != metadata['package'][key] for key in ['bytes', 'sha256']):
        raise ValueError('System package and channel identity differ.')
    value = package.get('version', '')
    if not isinstance(value, str) or not re.fullmatch(r'[0-9A-Za-z.+_-]+', value):
        raise ValueError('Invalid system package version.')
    base = json.loads(LOCK.read_text())
    load_runtime_updater().validate_base(manifest, base)
    current = subprocess.check_output(['pacman', '-Q', 'harness-os'], text=True).strip().split()
    if len(current) != 2 or current[0] != 'harness-os' or not re.fullmatch(r'[0-9A-Za-z.+_-]+', current[1]):
        raise ValueError('Cannot identify the installed Harness system package.')
    newer = int(subprocess.check_output(['vercmp', value, current[1]], text=True)) > 0
    return {'available': newer, 'version': value, 'manifest': manifest, 'assets': metadata, 'feed': feed}


def apply(feed=FEED):
    if os.geteuid() != 0 or Path('/etc/harness-live').exists():
        raise ValueError('Use sudo on the installed Harness computer.')
    release = discover(feed)
    if not release or not release['available']:
        print('Your Harness system is up to date.')
        return
    updater = load_runtime_updater()
    system = updater.system_module()
    # Never trust the UI's user-owned download or cached availability as root.
    with tempfile.TemporaryDirectory(prefix='harness-system-update-') as temporary:
        folder = Path(temporary)
        manifest = release['manifest']
        name = manifest['package'].get('name', '')
        if not re.fullmatch(r'harness-os-[0-9A-Za-z.+_-]+-x86_64\.pkg\.tar\.gz', name):
            raise ValueError('Invalid system package filename.')
        (folder / name).write_bytes(verified(release['assets']['package'], feed != FEED))
        (folder / 'package-manifest.json').write_text(json.dumps(manifest))
        with system.operation_lock():
            installation = system.installed()
            base = json.loads(LOCK.read_text())
            updater.validate_bundle(folder, base)
            date = system.snapshot_date(manifest['arch_snapshot'])
            text = system.PACMAN_CONFIG.read_text()
            dates = set(re.findall(r'https://archive\.archlinux\.org/repos/(\d{4}/\d{2}/\d{2})/', text))
            if len(dates) != 1:
                raise ValueError('Custom repository configuration needs a manual full system upgrade.')
            current = next(iter(dates))
            if system.pending_update() or date > current:
                system.update(max(current, date))
            updater.apply(folder, system, base, installation)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'apply'])
    parser.add_argument('--feed', default=FEED, help='Explicit development feed; installed UI always uses the official channel')
    args = parser.parse_args()
    if args.action == 'check':
        print(json.dumps(discover(args.feed)))
    else:
        apply(args.feed)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        raise SystemExit('Harness system update: ' + str(error))
