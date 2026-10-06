#!/usr/bin/env python3
"""Select the same kernel/input stack for USB and installed boot."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import shutil


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


SOURCE = Path(__file__).parents[1]
boot = module('harness_boot_profile', SOURCE / 'boot_profile.py')


def configure(folder, identity, bundle=None):
    selected = boot.profile(identity)
    root = folder / 'airootfs'
    if not root.is_dir():
        raise ValueError('Configure a fresh Archiso profile.')
    if identity == 'apple-t2':
        kernel = module('harness_t2_kernel', SOURCE / 'tools/prepare-t2-kernel.py')
        lock = json.loads(kernel.LOCK.read_text())
        if not bundle:
            raise ValueError('The T2 image requires its verified kernel bundle.')
        package = bundle / lock['package']['filename']
        verified = kernel.inspect(package, lock)
        if selected['modules'] != lock['early_modules'] or selected['parameters'] != lock['kernel_parameters']:
            raise ValueError('T2 boot profile and verified kernel requirements differ.')
        repository = folder.parent / 'repo'
        repository.mkdir(exist_ok=True)
        destination = repository / package.name
        if destination.exists():
            raise ValueError('Use a fresh kernel package repository.')
        shutil.copyfile(package, destination)
        kernel.inspect(destination, lock)
        packages = folder / 'packages.x86_64'
        lines = packages.read_text().splitlines()
        if lines.count('linux-lts') != 1:
            raise ValueError('Expected exactly one base kernel selection.')
        packages.write_text('\n'.join('linux-t2' if line == 'linux-lts' else line for line in lines) + '\n')
        config = root / 'etc/mkinitcpio.conf.d/20-harness-platform.conf'
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text('MODULES+=(' + ' '.join(selected['modules']) + ')\n')
        load = root / 'etc/modules-load.d/harness-t2.conf'
        load.parent.mkdir(parents=True, exist_ok=True)
        load.write_text('t2bce_vhci\n')
        hook = root / 'etc/pacman.d/hooks/80-harness-t2-firmware.hook'
        hook.parent.mkdir(parents=True, exist_ok=True)
        hook.write_text('[Trigger]\nOperation = Install\nOperation = Upgrade\nType = Package\n'
                        'Target = linux-firmware*\nTarget = linux-t2\n\n[Action]\n'
                        'Description = Preserving this Mac’s wireless firmware\nWhen = PostTransaction\n'
                        'Exec = /usr/bin/python3 /usr/lib/harness-os/t2_install.py restore\n')
        # kernel.json belongs to the harness-os package. Precreating it in the
        # live overlay makes pacman refuse the image with a file conflict.
        manifest = root / 'usr/share/harness-os/apple-t2/manifest.json'
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps({'kernel': lock, 'verified_files': verified}, indent=2) + '\n')
    marker = root / 'etc/harness-platform.json'
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps({'schema': 1, 'id': identity}) + '\n')
    for directory in ['syslinux', 'efiboot', 'grub']:
        for path in (folder / directory).rglob('*'):
            if not path.is_file():
                continue
            try:
                text = path.read_text()
            except UnicodeDecodeError:
                continue
            text = text.replace('vmlinuz-linux', 'vmlinuz-' + selected['kernel'])
            text = text.replace('initramfs-linux.img', 'initramfs-' + selected['kernel'] + '.img')
            text = text.replace('Arch Linux install medium', 'Install Harness')
            args = 'archisobasedir=%INSTALL_DIR% cow_spacesize=50%'
            if selected['parameters']:
                args += ' ' + ' '.join(selected['parameters'])
            text = text.replace('archisobasedir=%INSTALL_DIR%', args)
            text = re.sub(r'(?m)^timeout(?:=|\s+)\d+', lambda match: 'timeout=1' if '=' in match[0] else 'timeout 1', text)
            text = re.sub(r'(?m)^TIMEOUT\s+\d+', 'TIMEOUT 10', text)
            text = re.sub(r'(?m)^beep on$', 'beep off', text)
            text = re.sub(r'(?m)^play .*$', '', text)
            text = text.replace('MENU TITLE Arch Linux', 'MENU TITLE Harness')
            text = re.sub(r'(?m)^MENU BACKGROUND .*\n', '', text)
            path.write_text(text)
    return selected


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', type=Path, required=True)
    parser.add_argument('--platform', choices=boot.PROFILES, default='pc')
    parser.add_argument('--t2-bundle', type=Path)
    args = parser.parse_args()
    print(json.dumps(configure(args.profile, args.platform, args.t2_bundle)))
