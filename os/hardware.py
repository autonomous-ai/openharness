#!/usr/bin/env python3
"""Small, on-demand hardware diagnosis and selected Broadcom Wi-Fi preparation."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


# These older Mac radio families need firmware/driver support beyond the stock
# brcmfmac path. Never treat every Broadcom device as a wl device. In particular,
# BCM43602 (43ba/43bb/43bc) must keep its native driver.
# https://wireless.docs.kernel.org/en/latest/en/users/drivers/b43.html
BROADCOM_IDS = {'14e4:4331': 'BCM4331', '14e4:43a0': 'BCM4360'}
BUNDLE = Path('/usr/share/harness-os/hardware/broadcom')
PCI_NAME = re.compile(r'[0-9a-f]{4,8}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]')


def read(path):
    try:
        return path.read_text().strip()
    except (OSError, UnicodeError):
        return ''


def run(*args, capture=False, timeout=180):
    result = subprocess.run(list(map(str, args)), check=True, text=True, timeout=timeout,
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else None


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def pci_devices(sysfs=Path('/sys')):
    devices = []
    for path in sorted((sysfs / 'bus/pci/devices').glob('*')):
        if not PCI_NAME.fullmatch(path.name):
            continue
        vendor, device, kind = (read(path / name).removeprefix('0x') for name in ['vendor', 'device', 'class'])
        if not re.fullmatch(r'[0-9a-f]{4}', vendor) or not re.fullmatch(r'[0-9a-f]{4}', device):
            continue
        interfaces = []
        for interface in (sysfs / 'class/net').glob('*'):
            if (interface / 'device').is_symlink() and (interface / 'device').resolve().is_relative_to(path.resolve()):
                interfaces.append({'name': interface.name, 'wireless': (interface / 'wireless').is_dir() or (interface / 'phy80211').exists()})
        driver = (path / 'driver').resolve().name if (path / 'driver').is_symlink() else None
        devices.append({'address': path.name, 'id': vendor + ':' + device,
                        'class': kind, 'driver': driver, 'interfaces': interfaces})
    return devices


def needs_broadcom(device):
    return device['id'] in BROADCOM_IDS and device['class'] == '028000' and (
        device['driver'] == 'wl' or not any(i['wireless'] for i in device['interfaces']))


def report(sysfs=Path('/sys'), proc=Path('/proc')):
    fields = {}
    for line in read(proc / 'cpuinfo').splitlines():
        if ':' in line:
            key, value = line.split(':', 1)
            fields.setdefault(key.strip(), value.strip())
    flags = fields.get('flags')
    return {'architecture': os.uname().machine, 'kernel': os.uname().release,
            'computer': {'vendor': read(sysfs / 'class/dmi/id/sys_vendor') or None,
                         'model': read(sysfs / 'class/dmi/id/product_name') or None},
            'efi_bits': read(sysfs / 'firmware/efi/fw_platform_size') or None,
            'opencode_cpu': {'required_x86_feature': 'sse4_2',
                             'available': 'sse4_2' in flags.split() if flags is not None else None},
            'pci': pci_devices(sysfs),
            'backlights': [p.name for p in sorted((sysfs / 'class/backlight').glob('*'))],
            'broadcom_bundle_available': (BUNDLE / 'manifest.json').is_file()}


def bundle_manifest(folder, all_files=False):
    manifest = json.loads((folder / 'manifest.json').read_text())
    if manifest.get('schema') != 1 or manifest.get('driver') != 'broadcom-wl' or manifest.get('architecture') != 'x86_64':
        raise ValueError('Unsupported Wi-Fi bundle.')
    module = manifest.get('module', '')
    if module not in {'wl.ko', 'wl.ko.zst', 'wl.ko.xz'} or module not in manifest.get('files', {}):
        raise ValueError('Wi-Fi module is missing from its manifest.')
    for name, expected in manifest['files'].items():
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts or len(relative.parts) > 2:
            raise ValueError('Invalid Wi-Fi bundle path.')
        path = folder / name
        if path.is_symlink() or not path.resolve().is_relative_to(folder.resolve()):
            raise ValueError('Wi-Fi bundle files must stay inside their directory.')
        if all_files or name == module:
            if not path.is_file() or path.stat().st_size != expected['bytes'] or digest(path) != expected['sha256']:
                raise ValueError('Wi-Fi bundle checksum mismatch: ' + name)
    return manifest


def activate(address, sysfs=Path('/sys'), bundle=BUNDLE):
    if not PCI_NAME.fullmatch(address):
        raise ValueError('Invalid PCI address.')
    devices = pci_devices(sysfs)
    device = next((d for d in devices if d['address'] == address), None)
    if not device or not needs_broadcom(device) or device['driver'] == 'wl':
        return {'status': 'unchanged', 'address': address}
    if device['driver'] not in {None, 'bcma-pci-bridge', 'ssb'}:
        return {'status': 'unchanged', 'address': address, 'reason': 'Keep an existing driver.'}
    # Verify availability before changing a binding. The live image carries only
    # a prebuilt module here; installed machines use the ordinary DKMS package.
    if (bundle / 'manifest.json').is_file():
        manifest = bundle_manifest(bundle)
        if manifest['kernel'] != os.uname().release:
            raise ValueError('The Wi-Fi bundle is for a different kernel.')
        loader = ['insmod', str(bundle / manifest['module'])]
    else:
        run('modinfo', 'wl', capture=True)
        loader = ['modprobe', 'wl']
    path = sysfs / 'bus/pci/devices' / address
    previous = read(path / 'driver_override')
    previous = '' if previous == '(null)' else previous
    try:
        (path / 'driver_override').write_text('wl\n')
        if device['driver']:
            (path / 'driver/unbind').write_text(address + '\n')
        run('modprobe', 'cfg80211')
        if not (sysfs / 'module/wl').is_dir():
            run(*loader)
        if not (path / 'driver').is_symlink():
            (sysfs / 'bus/pci/drivers_probe').write_text(address + '\n')
        if not (path / 'driver').is_symlink() or (path / 'driver').resolve().name != 'wl':
            raise RuntimeError('Wi-Fi driver did not bind to ' + address)
        return {'status': 'activated', 'address': address, 'driver': 'wl'}
    except BaseException:
        (path / 'driver_override').write_text(previous + '\n')
        if not (path / 'driver').is_symlink():
            (sysfs / 'bus/pci/drivers_probe').write_text(address + '\n')
        raise


def configure_install(target, devices=None):
    target = target.resolve()
    # Only the offline installer's mounted, still-marked image may use this path.
    # It must never install a compiler into the running live overlay by mistake.
    if target == Path('/') or not target.is_mount() or not (target / 'etc/harness-live').is_file():
        raise ValueError('Wi-Fi preparation requires the mounted installation image.')
    selected = [d for d in (pci_devices() if devices is None else devices) if needs_broadcom(d)]
    folder = target / BUNDLE.relative_to('/')
    result = {'drivers': [], 'devices': [d['id'] for d in selected]}
    if selected:
        manifest = bundle_manifest(folder, all_files=True)
        lock = json.loads((target / 'usr/share/harness-os/lock.json').read_text())
        if manifest['arch_snapshot'] != lock['arch_snapshot']:
            raise ValueError('Wi-Fi bundle and installed package snapshot differ.')
        output = run('arch-chroot', target, 'pacman', '-Q', *manifest['base_packages'], capture=True)
        actual = dict(line.split(' ', 1) for line in output.splitlines())
        if actual != manifest['base_packages']:
            raise ValueError('Wi-Fi dependencies differ from the validated base.')
        names = sorted(manifest['packages'])
        if not names or any(not re.fullmatch(r'[a-zA-Z0-9_+.:\-]+\.pkg\.tar\.zst', name) for name in names):
            raise ValueError('Invalid offline Wi-Fi package list.')
        for name in names:
            if 'packages/' + name not in manifest['files'] or 'packages/' + name + '.sig' not in manifest['files']:
                raise ValueError('Offline Wi-Fi packages require signatures.')
        # No repositories: this operation either succeeds from signed local
        # packages or fails. It cannot quietly turn into an online installation.
        with tempfile.TemporaryDirectory(prefix='harness-driver-', dir=target / 'var/tmp') as temporary:
            config = Path(temporary) / 'pacman.conf'
            config.write_text('[options]\nArchitecture = auto\nCheckSpace\nSigLevel = Required\nLocalFileSigLevel = Required\n')
            config.chmod(0o600)
            run('arch-chroot', target, 'pacman', '--config', '/' + str(config.relative_to(target)),
                '-U', '--needed', '--noconfirm', *[str(BUNDLE / 'packages' / name) for name in names], timeout=600)
        run('arch-chroot', target, 'modinfo', '-k', manifest['kernel'], 'wl', capture=True)
        result.update(drivers=['broadcom-wl-dkms'], kernel=manifest['kernel'], packages=manifest['packages'])
    # The USB keeps the offline cache; the installed computer does not. Unrelated
    # machines receive neither wl nor its compiler/kernel-header dependencies.
    shutil.rmtree(folder, ignore_errors=False)
    state = target / 'var/lib/harness-os/hardware.json'
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command')
    sub.add_parser('report')
    activation = sub.add_parser('activate')
    activation.add_argument('address')
    installation = sub.add_parser('configure-install')
    installation.add_argument('target', type=Path)
    args = parser.parse_args()
    if args.command in {'activate', 'configure-install'} and os.geteuid() != 0:
        parser.error('This operation requires root.')
    if args.command == 'activate':
        # Multiple matching PCI add events must not race the module load.
        descriptor = os.open('/run/lock/harness-broadcom.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'r+') as lock:
            stat = os.fstat(lock.fileno())
            if stat.st_uid != 0 or stat.st_mode & 0o022:
                raise ValueError('Wi-Fi activation lock is not root-owned and private.')
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            result = activate(args.address)
    elif args.command == 'configure-install':
        result = configure_install(args.target)
    else:
        result = report()
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
