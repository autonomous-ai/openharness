#!/usr/bin/env python3
"""Compare the retained update archive with every owned file in the actual ISO.

This is a read-only artifact check. It neither installs nor rebuilds the package.
The receipt identifies the observer separately from the package/image producer.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time


def identity(path):
    with path.open('rb') as handle:
        value = hashlib.file_digest(handle, 'sha256').hexdigest()
    return {'bytes': path.stat().st_size, 'sha256': value}


def tool_version(tool):
    result = subprocess.run([tool, '-version'], capture_output=True, text=True, timeout=10)
    value = (result.stdout + result.stderr).strip()
    # SquashFS 4.6.1 prints the version then exits 1 without a filesystem
    # argument. This applies only to its identification command; every actual
    # listing/extraction below still requires exit 0.
    allowed = {0, 1} if tool == 'unsquashfs' else {0}
    prefix = r'^unsquashfs version \d+\.' if tool == 'unsquashfs' else r'^xorriso \d+\.'
    if result.returncode not in allowed or not re.search(prefix, value):
        raise ValueError(f'Cannot identify extraction tool: {tool} (exit {result.returncode}): {value}')
    return {'version': value, 'version_exit_code': result.returncode}


def safe_path(value):
    path = PurePosixPath(value)
    # These are OS-owned paths, not arbitrary user filenames. In particular,
    # reject controls and the listing format's symlink separator as ambiguous.
    if (not re.fullmatch(r'[A-Za-z0-9_+.@/-]+', value) or path.is_absolute()
            or '..' in path.parts or not path.parts or str(path) != value.rstrip('/')):
        raise ValueError('Unsafe or ambiguous archive path: ' + value)
    return str(path)


def archive_inventory(package, expected_version):
    rows = {}
    with tarfile.open(package, 'r:gz') as archive:
        for member in archive:
            name = safe_path(member.name)
            if name in rows:
                raise ValueError('Duplicate archive path: ' + name)
            if not (member.isfile() or member.isdir() or member.issym()):
                raise ValueError('Unsupported archive member: ' + name)
            if member.uid != 0 or member.gid != 0:
                raise ValueError('Archive member is not root-owned: ' + name)
            if name != '.PKGINFO' and PurePosixPath(name).parts[0] not in {'etc', 'usr'}:
                raise ValueError('Unexpected OS package path: ' + name)
            row = dict(name=name, mode=member.mode, uid=member.uid, gid=member.gid)
            if member.isfile():
                handle = archive.extractfile(member)
                row.update(type='file', bytes=member.size,
                           sha256=hashlib.file_digest(handle, 'sha256').hexdigest())
            elif member.issym():
                safe_path(member.linkname)
                row.update(type='symlink', target=member.linkname)
            else:
                row['type'] = 'directory'
            rows[name] = row
        for name in rows:
            for parent in PurePosixPath(name).parents:
                if str(parent) in rows and rows[str(parent)]['type'] != 'directory':
                    raise ValueError('Archive path traverses a non-directory: ' + name)
        metadata = rows.get('.PKGINFO', {})
        if metadata.get('type') != 'file' or metadata['bytes'] > 65536:
            raise ValueError('Missing or invalid package metadata')
        fields = {}
        for line in archive.extractfile('.PKGINFO').read().decode().splitlines():
            if ' = ' in line:
                key, value = line.split(' = ', 1)
                fields.setdefault(key, []).append(value)
        for key, value in [('pkgname', 'harness-os'), ('pkgver', expected_version), ('arch', 'x86_64')]:
            if fields.get(key) != [value]:
                raise ValueError('Package metadata mismatch: ' + key)
    return [rows[name] for name in sorted(rows)
            if name != '.PKGINFO' and rows[name]['type'] != 'directory']


def parse_listing(text):
    entries = {}
    for line in text.splitlines():
        fields = line.split(maxsplit=5)
        if len(fields) != 6 or not re.fullmatch(r'\d+/\d+', fields[1]):
            continue
        mode, owner, size, _date, _time, name = fields
        if not name.startswith('squashfs-root/'):
            continue
        target = None
        if mode.startswith('l'):
            name, separator, target = name.partition(' -> ')
            if not separator:
                raise ValueError('Unparseable SquashFS symlink')
        name = name.removeprefix('squashfs-root/')
        if name in entries:
            raise ValueError('Duplicate SquashFS listing path: ' + name)
        uid, gid = map(int, owner.split('/'))
        entries[name] = {'mode_string': mode, 'uid': uid, 'gid': gid,
                         'bytes': int(size) if size.isdigit() else None, 'target': target}
    if not entries:
        raise ValueError('SquashFS listing was empty or unrecognized')
    return entries


def compare_members(rows, listing, read):
    compared = []
    for row in rows:
        name = row['name']
        actual = listing.get(name)
        if actual is None:
            raise ValueError('Package member missing from ISO: ' + name)
        kind = stat.S_IFREG if row['type'] == 'file' else stat.S_IFLNK
        if (actual['mode_string'] != stat.filemode(kind | row['mode'])
                or (actual['uid'], actual['gid']) != (row['uid'], row['gid'])):
            raise ValueError('Package/ISO mode or ownership mismatch: ' + name)
        if row['type'] == 'file':
            data = read(name)
            observed = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
            if observed != {key: row[key] for key in ('bytes', 'sha256')} or actual['bytes'] != len(data):
                raise ValueError('Package/ISO file mismatch: ' + name)
        else:
            observed = {'target': actual['target']}
            if actual['target'] != row['target']:
                raise ValueError('Package/ISO link mismatch: ' + name)
        compared.append({'archive': row, 'iso': {**actual, **observed}, 'equal': True})
    if not compared:
        raise ValueError('No owned package files were compared')
    return compared


def verify_owned_paths(rows, package_database):
    blocks = {}
    for block in package_database.strip().split('\n\n'):
        lines = block.splitlines()
        if lines:
            blocks[lines[0]] = lines[1:]
    paths = [path for path in blocks.get('%FILES%', []) if not path.endswith('/')]
    expected = {row['name'] for row in rows}
    if len(paths) != len(set(paths)) or set(paths) != expected:
        raise ValueError('ISO package ownership list differs from archive members')


def validate_inputs(iso, bundle):
    image_path, package_path = iso.with_name('manifest.json'), bundle / 'package-manifest.json'
    image, manifest = [json.loads(path.read_text()) for path in (image_path, package_path)]
    source = image.get('source_commit', '')
    if not re.fullmatch(r'[a-f0-9]{40}', source) or source != manifest.get('source_commit'):
        raise ValueError('Image and package sources differ')
    if (image.get('architecture') != 'x86_64' or manifest.get('architecture') != 'x86_64'
            or manifest.get('schema') != 1 or manifest.get('kind') != 'harness-os-package'):
        raise ValueError('Expected x86-64 Harness image and package manifests')
    for key, other in [('version', 'requires_os_version'), ('arch_snapshot', 'arch_snapshot'),
                       ('package_version', None), ('harness_inputs', 'runtime')]:
        expected = manifest['package']['version'] if other is None else manifest.get(other)
        if image.get(key) != expected:
            raise ValueError('Image/package manifest mismatch: ' + key)
    runtime = manifest['runtime']
    if (runtime.get('source_commit') != source or runtime.get('dirty') is not False
            or runtime.get('target') != 'x86_64-unknown-linux-musl'
            or set(runtime.get('files', {})) != {'harness-tui', 'cli.mjs', 'notify.mjs'}):
        raise ValueError('Expected a complete clean runtime from the image producer')
    package = manifest['package']
    name = package.get('name', '')
    version = package.get('version', '')
    if not re.fullmatch(r'[0-9A-Za-z.+_-]+', version) or name != f'harness-os-{version}-x86_64.pkg.tar.gz':
        raise ValueError('Invalid package filename')
    package_file = bundle / name
    for path, declared in [(iso, image['iso']), (package_file, package)]:
        if path.is_symlink() or not path.is_file() or path.name != declared['name']:
            raise ValueError('Artifact path does not match its manifest')
        if identity(path) != {key: declared[key] for key in ('bytes', 'sha256')}:
            raise ValueError('Artifact hash or size mismatch: ' + path.name)
    return image, manifest, package_file


def bind(iso, bundle, output):
    if output.exists():
        raise ValueError('Use a fresh receipt path')
    source = Path(__file__).resolve().parents[2]
    started = time.monotonic()
    record = {'schema': 1, 'status': 'running', 'started_at': datetime.now(timezone.utc).isoformat(),
              'overrides': [], 'limitations': ['Artifact equality only; not installation, update, boot or hardware acceptance.']}
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        record['observer'] = {
            'source_commit': subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip(),
            'source_dirty': bool(subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain'], text=True).strip()),
            'inputs': {str(Path(__file__).relative_to(source)): identity(Path(__file__))},
            'invocation': ['--iso', str(iso), '--bundle', str(bundle), '--output', str(output)]}
        if record['observer']['source_dirty']:
            raise ValueError('Commit the observer before accepting native artifact evidence')
        image, manifest, package = validate_inputs(iso, bundle)
        rows = archive_inventory(package, manifest['package']['version'])
        record.update(source_commit=image['source_commit'], image=identity(iso),
                      image_manifest=identity(iso.with_name('manifest.json')),
                      package={'name': package.name, **identity(package)},
                      package_manifest=identity(bundle / 'package-manifest.json'),
                      runtime=manifest['runtime'], package_version=manifest['package']['version'])
        record['tools'] = {'python': {'version': sys.version, 'path': sys.executable,
                                     **identity(Path(sys.executable))}}
        for tool in ('xorriso', 'unsquashfs'):
            version = tool_version(tool)
            executable = Path(shutil.which(tool)).resolve()
            record['tools'][tool] = {**version, 'path': str(executable), **identity(executable)}
        with tempfile.TemporaryDirectory(prefix='harness-package-image-') as temporary:
            payload = Path(temporary) / 'airootfs.sfs'
            subprocess.run(['xorriso', '-no_rc', '-osirrox', 'on', '-indev', str(iso), '-extract',
                            '/arch/x86_64/airootfs.sfs', str(payload)], check=True, timeout=180)
            record['payload'] = identity(payload)
            listing = parse_listing(subprocess.check_output(['unsquashfs', '-lln', str(payload)], text=True, timeout=60))

            def read(name):
                return subprocess.check_output(['unsquashfs', '-cat', str(payload), name], timeout=30)

            record['members'] = compare_members(rows, listing, read)
            verify_owned_paths(rows, read('var/lib/pacman/local/harness-os-' +
                                         manifest['package']['version'] + '/files').decode())
            if json.loads(read('usr/share/harness-os/runtime.json')) != manifest['runtime']:
                raise ValueError('ISO runtime identity differs from the package manifest')
            for name, expected in manifest['runtime']['files'].items():
                data = read('usr/lib/harness/' + name)
                if expected != {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}:
                    raise ValueError('Runtime byte identity differs: ' + name)
            lock = json.loads(read('usr/share/harness-os/lock.json'))
            if (lock['version'], lock['arch_snapshot']) != (image['version'], image['arch_snapshot']):
                raise ValueError('ISO lock identity differs')
            inventory = dict(line.split(maxsplit=1) for line in read('usr/share/harness-os/packages.txt').decode().splitlines())
            if inventory.get('harness-os') != manifest['package']['version']:
                raise ValueError('Installed image inventory differs from the update package')
        record['status'] = 'passed'
    except Exception as error:
        record.update(status='failed', error=f'{type(error).__name__}: {error}')
        raise
    finally:
        record['exit_code'] = 0 if record['status'] == 'passed' else 1
        record['finished_at'] = datetime.now(timezone.utc).isoformat()
        record['duration_seconds'] = round(time.monotonic() - started, 3)
        output.write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({'status': record['status'], 'members': len(record['members']), 'receipt': str(output)}))
    return record


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    bind(args.iso.absolute(), args.bundle.absolute(), args.output.absolute())
