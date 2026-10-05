#!/usr/bin/env python3
"""Prepare a tested OS update; advance its public feed only after asset verification."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.request import urlopen
import zipfile

REPO = 'autonomous-ai/openharness'
CHANNEL = 'os-preview-updates'


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def gh(*args):
    return subprocess.check_output(['gh', *map(str, args)], text=True, timeout=120).strip()


def validate(bundle, receipt, run):
    spec = importlib.util.spec_from_file_location('harness_runtime_update', Path(__file__).parents[1] / 'runtime_update.py')
    updater = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(updater)
    manifest = json.loads((bundle / 'package-manifest.json').read_text())
    updater.validate_bundle(bundle, {'version': manifest['requires_os_version'], 'arch_snapshot': manifest['arch_snapshot']})
    if not re.fullmatch(r'\d+\.\d+\.\d+-preview\.\d+', manifest['requires_os_version']):
        raise ValueError('Only explicitly versioned previews can use this channel.')
    versions = manifest['runtime'].get('versions', {})
    if set(versions) != {'hn', 'cli'} or any(not isinstance(value, str) or value.startswith('999.') for value in versions.values()):
        raise ValueError('The public package must contain production runtime versions, never private fixtures.')
    if run.get('conclusion') != 'success' or run.get('status') != 'completed' or run.get('path') != '.github/workflows/os.yml' or run.get('head_sha') != manifest['source_commit']:
        raise ValueError('The package must match a completed successful native update workflow.')
    if receipt.get('status') != 'passed' or receipt.get('update', {}).get('source_commit') != manifest['source_commit']:
        raise ValueError('The update receipt does not cover this package source.')
    if receipt['update'].get('candidate') != manifest['package'] or receipt.get('system_channel', {}).get('package') != manifest['package']:
        raise ValueError('The native receipt covers a different package.')
    if any(receipt.get(key, {}).get('status') != 'passed' for key in ['update', 'fast_updates', 'system_channel']):
        raise ValueError('Package, fast runtime and system-channel checks must all pass.')
    if not receipt['system_channel'].get('reboot_keyboard'):
        raise ValueError('The channel update has not passed its actual encrypted reboot and keyboard check.')
    expected = {manifest['package']['name'], 'package-manifest.json', 'apply-update.py'}
    checksums = {}
    for line in (bundle / 'SHA256SUMS').read_text().splitlines():
        checksum, name = line.split('  ', 1)
        if name not in expected or name in checksums:
            raise ValueError('Unexpected or duplicate bootstrap bundle checksum.')
        checksums[name] = checksum
    if set(checksums) != expected or any(digest(bundle / name) != checksum for name, checksum in checksums.items()):
        raise ValueError('The complete bootstrap bundle must match its checksums.')
    return manifest


def verify_public(url, expected):
    # Stream larger files; never trust GitHub's metadata in place of the bytes.
    size, checksum = 0, hashlib.sha256()
    with urlopen(url, timeout=60) as response:
        if not response.url.startswith('https://'):
            raise ValueError('Publication redirected away from HTTPS.')
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > expected['bytes']:
                raise ValueError('Published asset exceeds its recorded size.')
            checksum.update(chunk)
    if size != expected['bytes'] or checksum.hexdigest() != expected['sha256']:
        raise ValueError('Published asset verification failed: ' + url)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--run', type=int, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    run = json.loads(gh('api', f'repos/{REPO}/actions/runs/{args.run}'))
    receipt = json.loads(args.receipt.read_text())
    manifest = validate(args.bundle, receipt, run)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    tag = 'os-v' + manifest['requires_os_version']
    prefix = f'https://github.com/{REPO}/releases/download/{tag}/'
    assets = [args.bundle / manifest['package']['name'], args.bundle / 'package-manifest.json']
    bundle_name = 'harness-update-' + manifest['requires_os_version'] + '-' + manifest['source_commit'][:9] + '-x86_64.zip'
    archive = output / bundle_name
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as zipped:
        for name in [manifest['package']['name'], 'package-manifest.json', 'apply-update.py', 'SHA256SUMS']:
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.external_attr = 0o100644 << 16
            zipped.writestr(entry, (args.bundle / name).read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
    evidence = output / ('update-validation-' + manifest['source_commit'][:9] + '.json')
    evidence.write_text(json.dumps(dict(source_commit=manifest['source_commit'], run=run['html_url'], receipt=receipt), indent=2) + '\n')
    assets += [archive, evidence]
    identities = {path.name: dict(bytes=path.stat().st_size, sha256=digest(path)) for path in assets}
    metadata = dict(schema=1, channel='preview', architecture='x86_64', source_commit=manifest['source_commit'],
        version=manifest['requires_os_version'], manifest=dict(url=prefix + 'package-manifest.json', **identities['package-manifest.json']),
        package=dict(url=prefix + manifest['package']['name'], **identities[manifest['package']['name']]))
    feed = output / 'metadata.json'
    feed.write_text(json.dumps(metadata, indent=2) + '\n')
    record = {'status': 'prepared', 'tag': tag, 'source_commit': manifest['source_commit'],
              'run': run['html_url'], 'assets': identities, 'channel': CHANNEL}
    record_path = output / 'publication.json'
    record_path.write_text(json.dumps(record, indent=2) + '\n')
    if not args.publish:
        print(json.dumps(record, indent=2))
        return
    # The ISO publisher owns this versioned release. Attach immutable update
    # assets only after that release exists; never replace its ISO or manifest.
    release = json.loads(gh('api', f'repos/{REPO}/releases/tags/{tag}'))
    if release['draft']:
        raise ValueError('Publish the validated OS preview before advancing its update feed.')
    existing = {asset['name']: asset for asset in release['assets']}
    missing = []
    for path in assets:
        if path.name in existing:
            verify_public(prefix + path.name, identities[path.name])
        else:
            missing.append(path)
    if missing:
        gh('release', 'upload', tag, '--repo', REPO, *missing)
    for path in assets:
        verify_public(prefix + path.name, identities[path.name])
    # The first channel is prepared as a draft, downloaded and checked before
    # publication. On later releases a missing feed during replacement is safe:
    # clients retain their running version and retry on their next check.
    result = subprocess.run(['gh', 'api', f'repos/{REPO}/releases/tags/{CHANNEL}'], capture_output=True, text=True)
    if result.returncode:
        if '404' not in result.stderr:
            raise ValueError('Cannot read the OS channel: ' + result.stderr)
        notes = output / 'channel-notes.md'
        notes.write_text('Harness OS preview update metadata. The computer checks this channel automatically; open Updates with Super+u to install.\n')
        gh('release', 'create', CHANNEL, '--repo', REPO, '--target', manifest['source_commit'], '--draft', '--prerelease',
           '--title', 'Harness OS preview updates', '--notes-file', notes)
    gh('release', 'upload', CHANNEL, '--repo', REPO, '--clobber', feed)
    with tempfile.TemporaryDirectory(prefix='harness-channel-check-') as temporary:
        gh('release', 'download', CHANNEL, '--repo', REPO, '--pattern', 'metadata.json', '--dir', temporary)
        if (Path(temporary) / 'metadata.json').read_bytes() != feed.read_bytes():
            raise ValueError('Uploaded channel metadata differs from the prepared feed.')
    gh('release', 'edit', CHANNEL, '--repo', REPO, '--draft=false', '--latest=false')
    verify_public(f'https://github.com/{REPO}/releases/download/{CHANNEL}/metadata.json',
                  dict(bytes=feed.stat().st_size, sha256=digest(feed)))
    record.update(status='published', feed_sha256=digest(feed))
    record_path.write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record, indent=2))


if __name__ == '__main__':
    main()
