#!/usr/bin/env python3
"""Prepare a small live Wi-Fi module and signed offline packages in an isolated root."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile


def run(*args, capture=False):
    result = subprocess.run(list(map(str, args)), check=True, text=True,
                            stdout=subprocess.PIPE if capture else None, timeout=600)
    return result.stdout.strip() if capture else None


def identity(path):
    with path.open('rb') as handle:
        digest = hashlib.file_digest(handle, 'sha256').hexdigest()
    return {'bytes': path.stat().st_size, 'sha256': digest}


def descriptions(database):
    result = {}
    for path in (database / 'sync').glob('*.db'):
        with tarfile.open(path) as archive:
            for member in archive:
                if not member.name.endswith('/desc'):
                    continue
                blocks = archive.extractfile(member).read().decode().split('\n\n')
                fields = {lines[0]: lines[1:] for block in blocks if (lines := block.strip().splitlines())}
                if '%NAME%' in fields:
                    result[fields['%NAME%'][0]] = fields
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or os.uname().sysname != 'Linux' or os.uname().machine != 'x86_64':
        parser.error('Run in the isolated x86-64 Linux image builder as root.')
    source = Path(__file__).resolve().parents[1]
    lock = json.loads((source / 'lock.json').read_text())
    work, output = args.work.resolve(), args.output.resolve()
    work.mkdir(parents=True, exist_ok=False)
    output.mkdir(parents=True, exist_ok=False)
    cache, database, root = (work / name for name in ['cache', 'database', 'root'])
    cache.mkdir()
    database.mkdir()
    root.mkdir()
    (database / 'local').mkdir()
    config = work / 'pacman.conf'
    config.write_text(args.config.read_text().replace('[options]', '[options]\nCacheDir = ' + str(cache)))
    pacman = ['pacman', '--config', config, '--dbpath', database, '--cachedir', cache]
    run(*pacman, '-Sy', '--noconfirm')
    requested = [line.strip() for line in (source / 'packages.x86_64').read_text().splitlines()
                 if line.strip() and not line.startswith('#')]

    def resolve(names):
        output = run(*pacman, '-Sp', '--noconfirm', '--print-format', 'HN_PACKAGE\t%n\t%v', *names, capture=True)
        result = dict(line.split('\t')[1:] for line in output.splitlines() if line.startswith('HN_PACKAGE\t'))
        if not set(names).issubset(result):
            raise ValueError('Package resolution omitted an explicit target.')
        return result

    # Resolve against an empty local database, never the build host's installed
    # packages. This is the exact extra closure beyond the complete image input.
    base = resolve(requested)
    hardware = resolve(['linux-lts', 'linux-lts-headers', 'broadcom-wl-dkms'])
    extra = {name: version for name, version in hardware.items() if name not in base}
    shared = {name: version for name, version in hardware.items() if name in base}
    if any(base[name] != version for name, version in shared.items()):
        raise ValueError('Driver and image dependencies do not use the same snapshot.')
    if not {'linux-lts-headers', 'broadcom-wl-dkms', 'dkms'}.issubset(extra):
        raise ValueError('Driver build dependencies unexpectedly entered the minimal image.')
    run(*pacman, '-Sw', '--noconfirm', *hardware)
    # pacstrap/chroot keep driver compilation and package hooks outside both the
    # host system and the image being assembled. The regular base stays small.
    run('pacstrap', '-C', config, '-c', root, 'base', 'linux-lts', 'linux-lts-headers', 'broadcom-wl-dkms')
    kernels = [p.parent.name for p in (root / 'usr/lib/modules').glob('*/pkgbase')
               if p.read_text().strip() == 'linux-lts']
    if len(kernels) != 1:
        raise ValueError('Expected exactly one LTS kernel in the driver build root.')
    kernel = kernels[0]
    run('arch-chroot', root, 'dkms', 'autoinstall', '-k', kernel)
    location = run('arch-chroot', root, 'modinfo', '-k', kernel, '-n', 'wl', capture=True)
    module = root / location.lstrip('/')
    vermagic = run('arch-chroot', root, 'modinfo', '-k', kernel, '-F', 'vermagic', 'wl', capture=True)
    if vermagic.split()[0] != kernel:
        raise ValueError('Built Wi-Fi module targets a different kernel.')
    shutil.copyfile(module, output / module.name)
    shutil.copyfile(root / 'usr/share/licenses/broadcom-wl-dkms/LICENSE', output / 'LICENSE.broadcom-wl')
    package_dir = output / 'packages'
    package_dir.mkdir()
    metadata = descriptions(database)
    packages = {}
    for name, version in sorted(extra.items()):
        fields = metadata[name]
        if fields['%VERSION%'] != [version]:
            raise ValueError('Package version changed while preparing hardware: ' + name)
        filename = fields['%FILENAME%'][0]
        if not re.fullmatch(r'[a-zA-Z0-9_+.:\-]+\.pkg\.tar\.zst', filename):
            raise ValueError('Invalid repository package filename.')
        package = cache / filename
        if identity(package)['sha256'] != fields['%SHA256SUM%'][0]:
            raise ValueError('Package checksum mismatch: ' + filename)
        target = package_dir / filename
        shutil.copyfile(package, target)
        signature = target.with_name(target.name + '.sig')
        signature.write_bytes(base64.b64decode(fields['%PGPSIG%'][0], validate=True))
        run('pacman-key', '--verify', signature, target)
        packages[filename] = {'name': name, 'version': version}
    manifest = {'schema': 1, 'driver': 'broadcom-wl', 'architecture': 'x86_64',
                'arch_snapshot': lock['arch_snapshot'], 'kernel': kernel,
                'module': module.name, 'vermagic': vermagic, 'base_packages': shared,
                'packages': packages,
                'files': {str(p.relative_to(output)): identity(p) for p in sorted(output.rglob('*')) if p.is_file()}}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'driver': manifest['driver'], 'kernel': kernel,
                      'live_module_bytes': manifest['files'][module.name]['bytes'],
                      'offline_package_bytes': sum(p.stat().st_size for p in package_dir.glob('*.pkg.tar.zst'))}, indent=2))
    shutil.rmtree(root)
    shutil.rmtree(cache)


if __name__ == '__main__':
    main()
