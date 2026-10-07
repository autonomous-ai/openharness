"""Stage a release-pinned T2 kernel and retain the old package for offline rollback."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import time
from urllib.request import Request, urlopen

PIN = Path('usr/share/harness-os/apple-t2/kernel.json')
CACHE = Path('/var/cache/pacman/pkg')
UPSTREAM = 'https://github.com/NoaHimesaka1873/linux-t2-arch/releases/download/'


def inspector():
    path = Path(__file__).with_name('t2_kernel.py')
    if not path.is_file():
        path = Path(__file__).parent / 'tools/prepare-t2-kernel.py'
    spec = importlib.util.spec_from_file_location('harness_t2_kernel', path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


# A rollback may remove these helpers from the filesystem. Keep the complete
# verifier loaded before pacman changes the installed Harness package.
KERNEL = inspector()


def validate_pin(pin):
    if (not isinstance(pin, dict) or type(pin.get('schema')) is not int or pin['schema'] != 1
            or pin.get('platform') != 'apple-t2' or pin.get('architecture') != 'x86_64'
            or pin.get('pkgbase') != 'linux-t2'
            or not re.fullmatch(r'[0-9A-Za-z.+_-]{1,128}', str(pin.get('kernel_release', '')))):
        raise ValueError('Invalid T2 kernel identity.')
    package = pin.get('package', {})
    if (not isinstance(package, dict) or package.get('name') != 'linux-t2'
            or not isinstance(package.get('version'), str)
            or not re.fullmatch(r'[0-9A-Za-z.+_-]{1,80}', str(package.get('version', '')))
            or package.get('filename') != 'linux-t2-' + package['version'] + '-x86_64.pkg.tar.zst'
            or type(package.get('bytes')) is not int or not 0 < package['bytes'] <= 256 * 1024 * 1024
            or not re.fullmatch(r'[a-f0-9]{64}', str(package.get('sha256', '')))):
        raise ValueError('Invalid T2 kernel package identity.')
    url = package.get('url', '')
    suffix = url.removeprefix(UPSTREAM) if isinstance(url, str) else ''
    if (not isinstance(url, str) or not url.startswith(UPSTREAM)
            or not re.fullmatch(r'v[0-9A-Za-z.+_-]+/' + re.escape(package['filename']), suffix)):
        raise ValueError('T2 kernel must use its pinned upstream release URL.')
    modules = pin.get('required_modules')
    early = pin.get('early_modules')
    if (not isinstance(modules, list) or not 1 <= len(modules) <= 64
            or any(not isinstance(x, str) or not re.fullmatch(r'[a-z0-9_]{1,64}', x) for x in modules)
            or len(set(modules)) != len(modules) or not isinstance(early, list)
            or early != ['t2bce_dma', 't2bce_core', 't2bce_vhci']
            or not set(early) <= set(modules)
            or pin.get('kernel_parameters') != ['intel_iommu=on', 'iommu=pt', 'pm_async=off']):
        raise ValueError('T2 update changes the required boot platform.')
    return pin


def package_pin(package):
    with tarfile.open(package, 'r:gz') as archive:
        matches = [entry for entry in archive if entry.name == str(PIN)]
        if len(matches) != 1 or not matches[0].isfile() or matches[0].size > 65536:
            raise ValueError('Missing or ambiguous T2 kernel pin.')
        return validate_pin(json.load(archive.extractfile(matches[0])))


def download(pin, target):
    """Stream a bounded, immutable package; never resolve an upstream 'latest'."""
    expected = pin['package']
    deadline = time.monotonic() + 180
    size, checksum = 0, hashlib.sha256()
    created = False
    try:
        with urlopen(Request(expected['url'], headers={'User-Agent': 'Harness-T2-Updates/1'}), timeout=30) as response:
            if not response.url.startswith('https://'):
                raise ValueError('T2 kernel download redirected away from HTTPS.')
            with target.open('xb') as output:
                created = True
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > expected['bytes'] or time.monotonic() > deadline:
                        raise ValueError('T2 kernel download exceeded its size or time limit.')
                    output.write(chunk)
                    checksum.update(chunk)
        if size != expected['bytes'] or checksum.hexdigest() != expected['sha256']:
            raise ValueError('T2 kernel download failed verification.')
    except BaseException:
        if created:
            target.unlink(missing_ok=True)
        raise


def stage(pin, source, destination):
    expected = pin['package']
    name = expected['filename']
    target = destination / name
    supplied = source / name
    cached = CACHE / name
    if supplied.exists() or supplied.is_symlink():
        # A malformed explicitly supplied package is an error, not a reason to
        # ignore the owner's offline bundle and silently go to the network.
        KERNEL.inspect(supplied, pin)
        shutil.copyfile(supplied, target)
    elif cached.is_file() and not cached.is_symlink() and KERNEL.identity(cached) == {
            key: expected[key] for key in ('bytes', 'sha256')}:
        shutil.copyfile(cached, target)
    else:
        download(pin, target)
    selected = KERNEL.inspect(target, pin)
    target.chmod(0o600)
    return selected


def prepare(requested, source, destination, root=Path('/')):
    current = validate_pin(json.loads((root / PIN).read_text()))
    requested = validate_pin(requested)
    if requested == current:
        return None
    old, new = current['package'], requested['package']
    if (int(subprocess.check_output(['vercmp', new['version'], old['version']], text=True)) <= 0
            or requested['kernel_release'] == current['kernel_release']):
        raise ValueError('T2 kernel updates must advance the pinned version and kernel release; use rollback to go back.')
    installed = subprocess.check_output(['pacman', '-Q', 'linux-t2'], text=True).strip().split()
    if installed != ['linux-t2', old['version']]:
        raise ValueError('Installed T2 kernel differs from its release pin; repair it before updating.')
    # Both downloads and complete archive inspections finish before a checkpoint
    # or package mutation. The original package remains available without Wi-Fi.
    previous_files = stage(current, source, destination)
    candidate_files = stage(requested, source, destination)
    return {'previous': current, 'candidate': requested,
            'previous_files': previous_files, 'candidate_files': candidate_files}


def retain(change, incoming, saved):
    old = change['previous']
    target = saved / 'previous-kernel.pkg.tar.zst'
    shutil.copyfile(incoming / old['package']['filename'], target)
    target.chmod(0o600)
    KERNEL.inspect(target, old)
    with target.open('rb') as handle:
        os.fsync(handle.fileno())


def rollback(change, saved, package):
    old = validate_pin(change['previous'])
    if package_pin(package) != old:
        raise ValueError('Harness rollback and retained T2 kernel differ.')
    kernel = saved / 'previous-kernel.pkg.tar.zst'
    if KERNEL.inspect(kernel, old) != change['previous_files']:
        raise ValueError('Retained T2 kernel differs from the update checkpoint.')
    return kernel


def verify(pin, selected, root=Path('/')):
    """Read back the installed kernel, required modules and generated initramfs."""
    version = subprocess.check_output(['pacman', '-Q', 'linux-t2'], text=True).strip().split()
    if version != ['linux-t2', pin['package']['version']] or json.loads((root / PIN).read_text()) != pin:
        raise ValueError('Installed T2 kernel and Harness pin differ.')
    for name, info in selected.items():
        if name == '.PKGINFO':
            continue
        path = root / info['path']
        if path.is_symlink() or not path.is_file() or KERNEL.identity(path) != {
                key: info[key] for key in ('bytes', 'sha256')}:
            raise ValueError('Installed T2 kernel/module failed readback: ' + name)
    if KERNEL.identity(root / 'boot/vmlinuz-linux-t2') != {
            key: selected['vmlinuz'][key] for key in ('bytes', 'sha256')}:
        raise ValueError('T2 boot kernel differs from the installed package.')
    release = pin['kernel_release']
    for module in pin['required_modules']:
        value = subprocess.check_output(['modinfo', '-k', release, '-F', 'vermagic', module], text=True).strip()
        if not value.startswith(release + ' '):
            raise ValueError('T2 module belongs to another kernel: ' + module)
    image = root / 'boot/initramfs-linux-t2.img'
    files = subprocess.check_output(['lsinitcpio', '--list', str(image)], text=True)
    for module in pin['early_modules']:
        if not re.search(r'/' + re.escape(module).replace('_', '[-_]') + r'\.ko(?:\.(?:zst|xz|gz))?(?:\n|$)', files):
            raise ValueError('T2 unlock input module missing from initramfs: ' + module)
    config = (root / 'boot/grub/grub.cfg').read_text()
    if any(value not in config for value in pin['kernel_parameters']) or 'vmlinuz-linux-t2' not in config:
        raise ValueError('T2 boot configuration omitted its kernel or required parameters.')
