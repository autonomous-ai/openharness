#!/usr/bin/env python3
"""Prepare the pinned T2 kernel for an isolated image build; never install it."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile

LOCK = Path(__file__).resolve().parents[1] / 'platforms/apple-t2/kernel.json'


def identity(path):
    with path.open('rb') as handle:
        return {'bytes': path.stat().st_size, 'sha256': hashlib.file_digest(handle, 'sha256').hexdigest()}


def inspect(package, lock):
    if (lock.get('schema') != 1 or lock.get('platform') != 'apple-t2'
            or lock.get('architecture') != 'x86_64' or lock.get('pkgbase') != 'linux-t2'
            or not re.fullmatch(r'[0-9A-Za-z.+_-]+', lock.get('kernel_release', ''))):
        raise ValueError('Invalid T2 kernel lock.')
    expected = lock['package']
    if package.is_symlink() or not package.is_file() or identity(package) != {
            key: expected[key] for key in ('bytes', 'sha256')}:
        raise ValueError('T2 kernel package differs from the pinned artifact.')
    modules = lock['required_modules']
    if (not modules or len(set(modules)) != len(modules)
            or any(not re.fullmatch(r'[a-z0-9_]+', name) for name in modules)
            or not set(lock['early_modules']) <= set(modules)):
        raise ValueError('Invalid T2 module requirements.')
    prefix = 'usr/lib/modules/' + lock['kernel_release'] + '/'
    selected = {}
    seen = set()
    # The package checksum is checked before invoking any archive tool. Spool
    # to a temporary file so no package path is ever extracted onto the host.
    with tempfile.TemporaryFile() as raw:
        subprocess.run(['zstd', '--quiet', '--decompress', '--stdout', '--', str(package)],
                       stdout=raw, stderr=subprocess.PIPE, check=True, timeout=45)
        if raw.tell() > 512 * 1024 * 1024:
            raise ValueError('Unexpectedly large T2 kernel payload.')
        raw.seek(0)
        with tarfile.open(fileobj=raw, mode='r:') as archive:
            for member in archive:
                name = member.name.rstrip('/')
                path = PurePosixPath(name)
                if (not name or path.is_absolute() or '..' in path.parts or str(path) != name
                        or name in seen or any(ord(char) < 32 for char in name)):
                    raise ValueError('Unsafe or duplicate T2 package path.')
                seen.add(name)
                if not (member.isfile() or member.isdir() or member.issym()):
                    raise ValueError('Unexpected T2 package member type.')
                if (member.uid, member.gid) != (0, 0):
                    raise ValueError('T2 kernel package must be root-owned.')
                if name.startswith('usr/lib/modules/') and not member.isdir() and not name.startswith(prefix):
                    raise ValueError('T2 package contains another kernel release.')
                module = path.name.removesuffix('.ko.zst').replace('-', '_') if name.endswith('.ko.zst') else None
                if name in {'.PKGINFO', prefix + 'pkgbase', prefix + 'vmlinuz'} or module in modules:
                    if not member.isfile() or member.size > 64 * 1024 * 1024:
                        raise ValueError('Expected a regular T2 kernel/module file.')
                    data = archive.extractfile(member).read()
                    key = module if module in modules else path.name
                    if key in selected:
                        raise ValueError('Duplicate T2 kernel/module identity.')
                    selected[key] = {'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                    if name == '.PKGINFO':
                        fields = {}
                        for line in data.decode().splitlines():
                            if ' = ' in line:
                                field, value = line.split(' = ', 1)
                                fields.setdefault(field, []).append(value)
                        for field, value in [('pkgname', expected['name']), ('pkgver', expected['version']),
                                             ('arch', 'x86_64'), ('pkgbase', 'linux-t2')]:
                            if fields.get(field) != [value]:
                                raise ValueError('T2 package metadata mismatch: ' + field)
                    elif name == prefix + 'pkgbase' and data.strip() != b'linux-t2':
                        raise ValueError('T2 kernel has a different package base.')
                    elif name == prefix + 'vmlinuz' and data[0x202:0x206] != b'HdrS':
                        raise ValueError('T2 boot image is not an x86 Linux kernel.')
    if set(selected) != {'.PKGINFO', 'pkgbase', 'vmlinuz', *modules}:
        raise ValueError('T2 package omits a required kernel or module file.')
    return selected


def prepare(package, output, lock_path=LOCK):
    if output.exists():
        raise ValueError('Use a fresh T2 bundle directory.')
    lock = json.loads(lock_path.read_text())
    selected = inspect(package, lock)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.harness-t2-', dir=output.parent) as temporary:
        folder = Path(temporary)
        target = folder / lock['package']['filename']
        shutil.copyfile(package, target)
        if identity(target) != {key: lock['package'][key] for key in ('bytes', 'sha256')}:
            raise ValueError('T2 kernel changed during preparation.')
        manifest = {'schema': 1, 'platform': 'apple-t2', 'kernel': lock,
                    'verified_files': selected, 'lock': identity(lock_path),
                    'validation': 'archive verified; native boot and physical hardware unverified'}
        (folder / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        folder.rename(output)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = prepare(args.package.resolve(), args.output.absolute())
    print(json.dumps({'kernel': result['kernel']['kernel_release'], 'files': len(result['verified_files']),
                      'output': str(args.output)}))
