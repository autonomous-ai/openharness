#!/usr/bin/env python3
"""On-demand hardware diagnosis and selected offline Wi-Fi/GPU preparation."""
import argparse
import fcntl
import hashlib
import importlib.util
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
NVIDIA_BUNDLE = Path('/usr/share/harness-os/hardware/nvidia')
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
        override = read(path / 'driver_override')
        devices.append({'address': path.name, 'id': vendor + ':' + device,
                        'class': kind, 'driver': driver,
                        'driver_override': None if override in {'', '(null)'} else override,
                        'interfaces': interfaces})
    return devices


def installation_blocker(sysfs=Path('/sys')):
    # The T2 BCE controller identifies this platform independently of DMI names
    # and the currently bound driver. The stock image does not ship its stack.
    # https://github.com/t2linux/linux-t2-patches/blob/main/1001-Add-t2bce-driver-stack.patch
    if any(device['id'] == '106b:1801' for device in pci_devices(sysfs)):
        path = Path(__file__).with_name('boot_profile.py')
        if path.is_file():
            spec = importlib.util.spec_from_file_location('harness_boot_profile', path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            if module.selected()['id'] == 'apple-t2':
                pkgbase = Path('/usr/lib/modules') / os.uname().release / 'pkgbase'
                if read(pkgbase) == 'linux-t2':
                    return None
                return 'Boot this Mac using the Harness T2 image before installing.'
        return 'This Harness image does not support Apple T2 Macs yet.'
    return None


def needs_broadcom(device):
    if device['id'] not in BROADCOM_IDS or device['class'] != '028000':
        return False
    # A missing wireless interface does not mean the radio is available: it
    # may be assigned to a VM or explicitly disabled with driver_override.
    # Apply the same ownership policy to live activation and offline packages.
    if device.get('driver_override') not in {None, '', 'wl'}:
        return False
    if device['driver'] not in {None, 'wl', 'bcma-pci-bridge', 'ssb'}:
        return False
    return device['driver'] == 'wl' or not any(i['wireless'] for i in device['interfaces'])


def opencode_cpu_supported(proc=Path('/proc')):
    """Return None when the x86 instruction requirement cannot be determined."""
    architecture = os.uname().machine
    if architecture != 'x86_64' and not re.fullmatch(r'i[3-6]86', architecture):
        return None
    flags = []
    for line in read(proc / 'cpuinfo').splitlines():
        key, separator, value = line.partition(':')
        if separator and key.strip() == 'flags':
            flags.append(value.split())
    if not flags or any(not features for features in flags):
        return None
    return all('sse4_2' in features for features in flags)


def report(sysfs=Path('/sys'), proc=Path('/proc')):
    return {'architecture': os.uname().machine, 'kernel': os.uname().release,
            'computer': {'vendor': read(sysfs / 'class/dmi/id/sys_vendor') or None,
                         'model': read(sysfs / 'class/dmi/id/product_name') or None},
            'efi_bits': read(sysfs / 'firmware/efi/fw_platform_size') or None,
            'opencode_cpu': {'required_x86_feature': 'sse4_2',
                             'available': opencode_cpu_supported(proc)},
            'pci': pci_devices(sysfs),
            'installation_blocker': installation_blocker(sysfs),
            'backlights': [p.name for p in sorted((sysfs / 'class/backlight').glob('*'))],
            'broadcom_bundle_available': (BUNDLE / 'manifest.json').is_file(),
            'nvidia_bundle_available': (NVIDIA_BUNDLE / 'manifest.json').is_file(),
            'gpu_health': gpu_health().cached_report() if Path(__file__).with_name('gpu_health.py').is_file() else None}


def gpu_health():
    spec = importlib.util.spec_from_file_location('harness_gpu_health', Path(__file__).with_name('gpu_health.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def nvidia_bundle_manifest(folder, all_files=False):
    manifest = json.loads((folder / 'manifest.json').read_text())
    if manifest.get('schema') != 1 or manifest.get('driver') != 'nvidia-open' or manifest.get('architecture') != 'x86_64':
        raise ValueError('Unsupported NVIDIA bundle.')
    supported = manifest.get('supported_devices', {})
    if not supported or any(not re.fullmatch(r'10de:[0-9a-f]{4}', key) or not isinstance(value, list) or
                            not value or any(not isinstance(name, str) or not name for name in value)
                            for key, value in supported.items()):
        raise ValueError('Invalid NVIDIA support table.')
    if not re.fullmatch(r'\d+\.\d+\.\d+', manifest.get('driver_version', '')):
        raise ValueError('Invalid NVIDIA driver version.')
    if all_files:
        for name, expected in manifest.get('files', {}).items():
            relative = Path(name)
            if relative.is_absolute() or '..' in relative.parts or len(relative.parts) > 2:
                raise ValueError('Invalid NVIDIA bundle path.')
            path = folder / name
            if path.is_symlink() or not path.resolve().is_relative_to(folder.resolve()):
                raise ValueError('NVIDIA bundle files must stay inside their directory.')
            if not path.is_file() or path.stat().st_size != expected['bytes'] or digest(path) != expected['sha256']:
                raise ValueError('NVIDIA bundle checksum mismatch: ' + name)
    return manifest


def nvidia_selection(devices, supported):
    cards = [d for d in devices if d['id'].startswith('10de:') and d['class'] in {'030000', '030200'}]
    if not cards:
        return None
    # nvidia-utils blacklists nouveau globally. Do not break a second legacy
    # NVIDIA display, or take over a GPU explicitly assigned to passthrough.
    if any(card['id'] not in supported for card in cards):
        return {'status': 'unchanged', 'reason': 'An NVIDIA GPU needs a different driver.'}
    # An unbound GPU can still be reserved for passthrough or explicitly kept
    # on nouveau. Installing nvidia-utils would blacklist nouveau system-wide.
    if any(card['driver'] not in {None, 'nouveau', 'nvidia'} or
           card.get('driver_override') not in {None, '', 'nvidia'} for card in cards):
        return {'status': 'unchanged', 'reason': 'Keep the existing GPU assignment.'}
    return {'status': 'selected', 'devices': [card['id'] for card in cards]}


def configure_nvidia_install(target, devices, bundle=NVIDIA_BUNDLE):
    target = target.resolve()
    if target == Path('/') or not target.is_mount() or not (target / 'etc/harness-live').is_file():
        raise ValueError('GPU preparation requires the mounted installation image.')
    if not any(d['id'].startswith('10de:') and d['class'] in {'030000', '030200'} for d in devices):
        return None
    manifest = nvidia_bundle_manifest(bundle)
    selected = nvidia_selection(devices, manifest['supported_devices'])
    if selected['status'] != 'selected':
        return selected
    manifest = nvidia_bundle_manifest(bundle, all_files=True)
    lock = json.loads((target / 'usr/share/harness-os/lock.json').read_text())
    if manifest['arch_snapshot'] != lock['arch_snapshot']:
        raise ValueError('NVIDIA bundle and installed package snapshot differ.')
    output = run('arch-chroot', target, 'pacman', '-Q', *manifest['base_packages'], capture=True)
    if dict(line.split(' ', 1) for line in output.splitlines()) != manifest['base_packages']:
        raise ValueError('NVIDIA dependencies differ from the validated base.')
    names = sorted(manifest['packages'])
    if not names or any(not re.fullmatch(r'[a-zA-Z0-9_+.:\-]+\.pkg\.tar\.zst', name) for name in names):
        raise ValueError('Invalid offline NVIDIA package list.')
    for name in names:
        if 'packages/' + name not in manifest['files'] or 'packages/' + name + '.sig' not in manifest['files']:
            raise ValueError('Offline NVIDIA packages require signatures.')
    # Read directly from the live USB. Neither generic nor GPU installations
    # copy this large compressed package cache into their permanent filesystem.
    with tempfile.TemporaryDirectory(prefix='harness-gpu-', dir=target / 'var/tmp') as temporary:
        folder = Path(temporary)
        packages = folder / 'packages'
        packages.mkdir()
        config = folder / 'pacman.conf'
        config.write_text('[options]\nArchitecture = auto\nCheckSpace\nSigLevel = Required\nLocalFileSigLevel = Required\n')
        config.chmod(0o600)
        run('mount', '--bind', bundle / 'packages', packages)
        try:
            run('mount', '-o', 'remount,bind,ro', packages)
            prefix = '/' + str(packages.relative_to(target))
            run('arch-chroot', target, 'pacman', '--config', '/' + str(config.relative_to(target)),
                '-U', '--needed', '--noconfirm', *[prefix + '/' + name for name in names], timeout=600)
        finally:
            run('umount', packages)
    for module in ['nvidia', 'nvidia_modeset', 'nvidia_uvm', 'nvidia_drm']:
        magic = run('arch-chroot', target, 'modinfo', '-k', manifest['kernel'], '-F', 'vermagic', module, capture=True)
        version = run('arch-chroot', target, 'modinfo', '-k', manifest['kernel'], '-F', 'version', module, capture=True)
        if magic.split()[0] != manifest['kernel'] or version != manifest['driver_version']:
            raise ValueError('Installed NVIDIA modules do not match the kernel and userspace.')
    config = target / 'etc/mkinitcpio.conf.d/30-harness-nvidia.conf'
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text('# Display driver must be ready for disk unlock and the Harness session.\n'
                      'MODULES+=(nvidia nvidia_modeset nvidia_drm)\n')
    return dict(selected, status='installed', driver='nvidia-open-lts',
                kernel=manifest['kernel'], driver_version=manifest['driver_version'], packages=manifest['packages'])


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
    # Verify availability before changing a binding. The live image carries only
    # a prebuilt module here; installed machines use the ordinary DKMS package.
    if (bundle / 'manifest.json').is_file():
        manifest = bundle_manifest(bundle)
        if manifest['kernel'] != os.uname().release:
            raise ValueError('The Wi-Fi bundle is for a different kernel.')
        loader = ['insmod', str(bundle / manifest['module'])]
    else:
        run('modinfo', 'wl', capture=True, timeout=5)
        loader = ['modprobe', 'wl']
    path = sysfs / 'bus/pci/devices' / address
    previous = read(path / 'driver_override')
    previous = '' if previous == '(null)' else previous
    try:
        (path / 'driver_override').write_text('wl\n')
        if device['driver']:
            (path / 'driver/unbind').write_text(address + '\n')
        run('modprobe', 'cfg80211', timeout=8)
        if not (sysfs / 'module/wl').is_dir():
            run(*loader, timeout=15)
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


def configure_install(target, devices=None, bundle=BUNDLE):
    target = target.resolve()
    # Only the offline installer's mounted, still-marked image may use this path.
    # It must never install a compiler into the running live overlay by mistake.
    if target == Path('/') or not target.is_mount() or not (target / 'etc/harness-live').is_file():
        raise ValueError('Wi-Fi preparation requires the mounted installation image.')
    devices = pci_devices() if devices is None else devices
    selected = [d for d in devices if needs_broadcom(d)]
    folder = target / BUNDLE.relative_to('/')
    result = {'drivers': [], 'devices': [d['id'] for d in selected]}
    if selected:
        manifest = bundle_manifest(folder)
        cache = folder
        if not (folder / 'packages').exists():
            if bundle_manifest(bundle) != manifest:
                raise ValueError('Live Wi-Fi cache and installation image differ.')
            cache = bundle
        manifest = bundle_manifest(cache, all_files=True)
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
            packages = Path(temporary) / 'packages'
            packages.mkdir()
            config = Path(temporary) / 'pacman.conf'
            config.write_text('[options]\nArchitecture = auto\nCheckSpace\nSigLevel = Required\nLocalFileSigLevel = Required\n')
            config.chmod(0o600)
            run('mount', '--bind', cache / 'packages', packages)
            try:
                run('mount', '-o', 'remount,bind,ro', packages)
                prefix = '/' + str(packages.relative_to(target))
                run('arch-chroot', target, 'pacman', '--config', '/' + str(config.relative_to(target)),
                    '-U', '--needed', '--noconfirm', *[prefix + '/' + name for name in names], timeout=600)
            finally:
                run('umount', packages)
        run('arch-chroot', target, 'modinfo', '-k', manifest['kernel'], 'wl', capture=True)
        result.update(drivers=['broadcom-wl-dkms'], kernel=manifest['kernel'], packages=manifest['packages'])
    # The USB keeps the offline cache; the installed computer does not. Unrelated
    # machines receive neither wl nor its compiler/kernel-header dependencies.
    shutil.rmtree(folder, ignore_errors=False)
    nvidia = configure_nvidia_install(target, devices)
    if nvidia is not None:
        result['nvidia'] = nvidia
        if nvidia['status'] == 'installed':
            result['drivers'].append(nvidia['driver'])
            result['devices'].extend(nvidia['devices'])
    state = target / 'var/lib/harness-os/hardware.json'
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command')
    reporting = sub.add_parser('report')
    reporting.add_argument('--check-gpu', action='store_true', help='Repeat GPU verification as the current user')
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
        if getattr(args, 'check_gpu', False):
            if not Path(__file__).with_name('gpu_health.py').is_file():
                parser.error('GPU verification is not available in this system profile.')
            gpu_health().check(force=True)
        result = report()
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
