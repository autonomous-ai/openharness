#!/usr/bin/env python3
"""Prepare signed, snapshot-matched NVIDIA packages outside the minimal image."""
import argparse
import base64
from html.parser import HTMLParser
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil

spec = importlib.util.spec_from_file_location('hardware_builder', Path(__file__).with_name('build-hardware.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
run, identity = builder.run, builder.identity


class CurrentGPUs(HTMLParser):
    """Only the driver's Current table; legacy tables contain unsupported IDs."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.current = self.table = self.cell = self.done = False
        self.cells = []
        self.text = ''
        self.devices = {}

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == 'a' and attributes.get('id') == 'Current' and not self.done:
            self.current = True
        elif tag == 'table' and self.current:
            self.table = True
        elif tag == 'tr' and self.table:
            self.cells = []
        elif tag == 'td' and self.table:
            self.cell, self.text = True, ''

    def handle_data(self, data):
        if self.cell:
            self.text += data

    def handle_endtag(self, tag):
        if tag == 'td' and self.cell:
            self.cells.append(' '.join(self.text.split()))
            self.cell = False
        elif tag == 'tr' and self.table and self.cells:
            if len(self.cells) < 2 or not self.cells[0] or not re.fullmatch(
                    r'[0-9A-Fa-f]{4}(?: [0-9A-Fa-f]{4} [0-9A-Fa-f]{4})?', self.cells[1]):
                raise ValueError('Malformed current NVIDIA GPU row.')
            key = '10de:' + self.cells[1].split()[0].lower()
            self.devices.setdefault(key, set()).add(self.cells[0])
        elif tag == 'table' and self.table:
            self.current = self.table = False
            self.done = True


def supported_devices(contents, version):
    # Since 590 the main driver has dropped pre-Turing hardware. Older release
    # tables include devices that the open kernel module cannot drive.
    if not re.fullmatch(r'\d+\.\d+\.\d+', version) or int(version.split('.')[0]) < 590:
        raise ValueError('Reassess open-kernel support for this NVIDIA driver.')
    parser = CurrentGPUs()
    parser.feed(contents)
    parser.close()
    if not parser.done or not parser.devices:
        raise ValueError('Missing current NVIDIA GPU support table.')
    return {key: sorted(value) for key, value in sorted(parser.devices.items())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--base-packages', type=Path, help='Verified existing image inventory for a focused native check')
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
    for folder in [cache, database, root, database / 'local']:
        folder.mkdir()
    config = work / 'pacman.conf'
    config.write_text(args.config.read_text().replace('[options]', '[options]\nCacheDir = ' + str(cache)))
    pacman = ['pacman', '--config', config, '--dbpath', database, '--cachedir', cache]
    run(*pacman, '-Sy', '--noconfirm')

    def resolve(names):
        text = run(*pacman, '-Sp', '--noconfirm', '--print-format', 'HN_PACKAGE\t%n\t%v', *names, capture=True)
        result = dict(line.split('\t')[1:] for line in text.splitlines() if line.startswith('HN_PACKAGE\t'))
        if not set(names).issubset(result):
            raise ValueError('Package resolution omitted an explicit target.')
        return result

    if args.base_packages:
        base = dict(line.split(' ', 1) for line in args.base_packages.read_text().splitlines())
    else:
        base = resolve([line.strip() for line in (source / 'packages.x86_64').read_text().splitlines()
                        if line.strip() and not line.startswith('#')])
    drivers = resolve(['linux-lts', 'nvidia-open-lts', 'nvidia-utils'])
    extra = {name: version for name, version in drivers.items() if name not in base}
    shared = {name: version for name, version in drivers.items() if name in base}
    if any(base[name] != version for name, version in shared.items()):
        raise ValueError('NVIDIA and image dependencies do not use the same snapshot.')
    if not {'nvidia-open-lts', 'nvidia-utils'} <= extra.keys() or set(extra) & {'gcc', 'make', 'dkms', 'linux-lts-headers'}:
        raise ValueError('NVIDIA preparation must use prebuilt modules outside the base image.')
    run(*pacman, '-Sw', '--noconfirm', *drivers)
    run('pacstrap', '-C', config, '-c', root, 'base', 'linux-lts', 'nvidia-open-lts', 'nvidia-utils')
    kernels = [path.parent.name for path in (root / 'usr/lib/modules').glob('*/pkgbase')
               if path.read_text().strip() == 'linux-lts']
    if len(kernels) != 1:
        raise ValueError('Expected one LTS kernel in the NVIDIA preparation root.')
    kernel = kernels[0]
    version = run('arch-chroot', root, 'modinfo', '-k', kernel, '-F', 'version', 'nvidia', capture=True)
    modules = {}
    for module in ['nvidia', 'nvidia_modeset', 'nvidia_uvm', 'nvidia_drm']:
        magic = run('arch-chroot', root, 'modinfo', '-k', kernel, '-F', 'vermagic', module, capture=True)
        actual = run('arch-chroot', root, 'modinfo', '-k', kernel, '-F', 'version', module, capture=True)
        if magic.split()[0] != kernel or actual != version:
            raise ValueError('NVIDIA kernel modules do not match.')
        modules[module] = {'version': actual, 'vermagic': magic}
    if run('arch-chroot', root, 'modinfo', '-k', kernel, '-F', 'license', 'nvidia', capture=True) != 'Dual MIT/GPL':
        raise ValueError('Expected the open NVIDIA kernel driver.')
    files = run('arch-chroot', root, 'pacman', '-Qlq', 'nvidia-utils', capture=True).splitlines()
    support = next(root / path.lstrip('/') for path in files if path.endswith('/html/supportedchips.html'))
    devices = supported_devices(support.read_text(), version)
    targets = ['GeForce RTX 4090', 'GeForce RTX 5090', 'RTX 6000 Ada Generation', 'RTX PRO 6000 Blackwell']
    if not all(any(target in name for names in devices.values() for name in names) for target in targets):
        raise ValueError('A target GPU is absent from the current support table.')
    shutil.copyfile(support, output / 'supportedchips.html')
    package_dir = output / 'packages'
    package_dir.mkdir()
    descriptions = builder.descriptions(database)
    packages = {}
    for name, release in sorted(extra.items()):
        fields = descriptions[name]
        if fields['%VERSION%'] != [release]:
            raise ValueError('Package changed during NVIDIA preparation: ' + name)
        filename = fields['%FILENAME%'][0]
        if not re.fullmatch(r'[a-zA-Z0-9_+.:\-]+\.pkg\.tar\.zst', filename):
            raise ValueError('Invalid NVIDIA package filename.')
        archive = cache / filename
        if identity(archive)['sha256'] != fields['%SHA256SUM%'][0]:
            raise ValueError('NVIDIA package checksum mismatch: ' + filename)
        target = package_dir / filename
        shutil.copyfile(archive, target)
        signature = target.with_name(target.name + '.sig')
        signature.write_bytes(base64.b64decode(fields['%PGPSIG%'][0], validate=True))
        run('pacman-key', '--verify', signature, target)
        packages[filename] = {'name': name, 'version': release}
    manifest = {'schema': 1, 'driver': 'nvidia-open', 'architecture': 'x86_64',
                'arch_snapshot': lock['arch_snapshot'], 'kernel': kernel, 'driver_version': version,
                'modules': modules, 'supported_devices': devices, 'base_packages': shared, 'packages': packages,
                'files': {str(path.relative_to(output)): identity(path) for path in sorted(output.rglob('*')) if path.is_file()}}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'driver': version, 'kernel': kernel, 'supported_ids': len(devices),
                      'offline_package_bytes': sum(path.stat().st_size for path in package_dir.glob('*.pkg.tar.zst'))}, indent=2))
    shutil.rmtree(root)
    shutil.rmtree(cache)


if __name__ == '__main__':
    main()
