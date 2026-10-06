"""Preserve a T2 Mac's wireless firmware before a whole-disk installation."""
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def helper():
    path = Path(__file__).with_name('t2_firmware.py')
    if not path.is_file():
        path = Path(__file__).parent / 'tools/prepare-t2-firmware.py'
    spec = importlib.util.spec_from_file_location('harness_t2_firmware', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def model(sysfs=Path('/sys')):
    value = (sysfs / 'class/dmi/id/product_name').read_text().strip()
    helper().check_model(value)
    return value


def run(*args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, timeout=20, **kwargs)


def partitions(disk):
    data = json.loads(run('lsblk', '--json', '--paths', '--output', 'NAME,TYPE,FSTYPE', disk,
                          stdout=subprocess.PIPE, text=True).stdout)
    devices = data.get('blockdevices', [])
    if len(devices) != 1 or devices[0].get('name') != disk or devices[0].get('type') != 'disk':
        raise ValueError('Cannot identify the Mac disk before firmware preservation.')
    result = []
    for child in devices[0].get('children', []):
        name = child.get('name', '')
        if child.get('type') != 'part' or not re.fullmatch(r'/dev/[a-zA-Z0-9_-]+', name):
            raise ValueError('Unexpected Mac disk partition.')
        if child.get('fstype') in {'vfat', 'apfs'}:
            result.append((name, child['fstype']))
    return result


@contextmanager
def mounted(device, kind, folder, volume=None):
    options = 'ro,nosuid,nodev,noexec'
    if volume is not None:
        options += ',vol=' + str(volume)
    run('mount', '-t', kind, '-o', options, device, folder, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        yield folder
    finally:
        # Never erase or clean a still-mounted macOS filesystem. A failure here
        # propagates out of preparation, before the installer can partition.
        run('umount', folder)


def find_bundle(disk, work, expected_model, exports=None):
    firmware = helper()
    # A preserved export on the live medium is read as data, never as a script.
    # An already installed system can supply its own private preserved bundle.
    if exports is None:
        exports = [Path('/run/archiso/bootmnt/harness-apple-firmware.tar'),
                   Path('/var/lib/harness-os/apple-firmware.tar')]
    for path in exports:
        if path.exists():
            firmware.verify(path, expected_model)
            return path
    failures = []
    mountpoint = work / 'source'
    mountpoint.mkdir()
    for device, kind in partitions(disk):
        for volume in (range(6) if kind == 'apfs' else (None,)):
            # Failed mounts are expected when probing APFS volume slots. A
            # failed unmount is never swallowed; the caller must not erase.
            try:
                context = mounted(device, kind, mountpoint, volume)
                context.__enter__()
            except subprocess.SubprocessError:
                if mountpoint.is_mount():
                    raise ValueError('A macOS volume is still mounted. No disk has been erased.')
                continue
            try:
                bundle = mountpoint / 'harness-apple-firmware.tar'
                if kind == 'vfat' and bundle.is_file():
                    firmware.verify(bundle, expected_model)
                    destination = work / 'preserved.tar'
                    shutil.copyfile(bundle, destination)
                    firmware.verify(destination, expected_model)
                    return destination
                source = mountpoint / 'usr/share/firmware'
                if kind == 'apfs' and source.is_dir() and expected_model != 'iMacPro1,1':
                    destination = work / 'preserved.tar'
                    firmware.prepare(source, destination, expected_model)
                    return destination
            except (OSError, ValueError) as error:
                failures.append(str(error))
                (work / 'preserved.tar').unlink(missing_ok=True)
            finally:
                context.__exit__(None, None, None)
    message = 'Preserve this Mac’s Wi-Fi firmware from macOS before installing Harness. No disk has been erased.'
    if failures:
        message += ' ' + failures[-1]
    raise ValueError(message)


@contextmanager
def preserve(disk, expected_model=None, *, runtime=Path('/run')):
    expected_model = expected_model or model()
    helper().check_model(expected_model)
    # /run is RAM-backed on the live system. Nothing here depends on a disk
    # that is about to be erased, or on the user's projects/home directory.
    work = Path(tempfile.mkdtemp(prefix='harness-apple-', dir=runtime))
    prepared = succeeded = False
    try:
        bundle = find_bundle(disk, work, expected_model)
        private = work / 'verified.tar'
        shutil.copyfile(bundle, private)
        manifest, _ = helper().verify(private, expected_model)
        helper().stage(private, work / 'verified', expected_model)
        prepared = True
        yield {'bundle': private, 'manifest': manifest}
        succeeded = True
    except BaseException as error:
        if prepared:
            error.add_note('The verified Mac firmware remains in ' + str(work / 'verified.tar'))
        raise
    finally:
        if (work / 'source').is_mount():
            raise ValueError('A macOS volume could not be unmounted. Preserved files remain in ' + str(work))
        if not prepared or succeeded:
            shutil.rmtree(work)


def persist_boot(device, preserved):
    """Retain a verified reinstall copy on the freshly formatted boot partition."""
    firmware = helper()
    firmware.verify(preserved['bundle'], preserved['manifest']['model'])
    folder = Path(tempfile.mkdtemp(prefix='harness-apple-boot-', dir='/run'))
    mounted = False
    try:
        run('mount', '-t', 'vfat', '-o', 'rw,nosuid,nodev,noexec', device, folder)
        mounted = True
        target = folder / 'harness-apple-firmware.tar'
        with target.open('xb') as output, preserved['bundle'].open('rb') as source:
            shutil.copyfileobj(source, output)
            output.flush()
            os.fsync(output.fileno())
        manifest, _ = firmware.verify(target, preserved['manifest']['model'])
        if manifest != preserved['manifest']:
            raise ValueError('The boot partition firmware copy failed verification.')
    finally:
        if mounted:
            run('umount', folder)
        # Never recurse into a still-mounted boot volume after an error.
        if not folder.is_mount():
            folder.rmdir()


def restore(target, preserved):
    """Copy only validated wireless data into a new image or managed root."""
    firmware = helper()
    manifest, files = firmware.verify(preserved['bundle'], preserved['manifest']['model'])
    if manifest != preserved['manifest']:
        raise ValueError('Preserved Apple firmware changed before restoration.')
    folder = target / 'usr/lib/firmware/brcm'
    for path in [target / 'usr', target / 'usr/lib', target / 'usr/lib/firmware', folder]:
        if path.is_symlink():
            raise ValueError('Firmware restoration requires real system directories.')
        path.mkdir(exist_ok=True)
    for name, data in files.items():
        path = folder / name
        # These exact files are model data selected before erasure. Replace a
        # package's fallback link/file without ever following its destination.
        temporary = folder / ('.harness-' + name)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        try:
            with os.fdopen(fd, 'wb') as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
        if firmware.identity(firmware.regular_bytes(path, firmware.MAX_FILE)) != manifest['files'][name]:
            raise ValueError('Installed Apple firmware failed its readback check.')
    state = target / 'var/lib/harness-os'
    for path in [target / 'var', target / 'var/lib', state]:
        if path.is_symlink():
            raise ValueError('Firmware state requires real system directories.')
        path.mkdir(exist_ok=True)
    saved = state / 'apple-firmware.tar'
    if saved != preserved['bundle']:
        if saved.is_symlink():
            raise ValueError('Preserved firmware state must not be a symbolic link.')
        shutil.copyfile(preserved['bundle'], saved)
        saved.chmod(0o600)
    firmware.verify(saved, manifest['model'])
    return {'model': manifest['model'], 'files': len(files),
            'sha256': hashlib.sha256(saved.read_bytes()).hexdigest()}


def retained(root=Path('/')):
    bundle = root / 'var/lib/harness-os/apple-firmware.tar'
    # The model is recorded when installation succeeds. Do not guess from the
    # recovery computer's hardware, which may be a different machine.
    info = json.loads((root / 'var/lib/harness-os/install.json').read_text())
    expected = info['apple_firmware']
    manifest, _ = helper().verify(bundle, expected['model'])
    if hashlib.sha256(bundle.read_bytes()).hexdigest() != expected['sha256']:
        raise ValueError('The saved Mac firmware failed verification.')
    return {'bundle': bundle, 'manifest': manifest}


if __name__ == '__main__':
    if sys.argv[1:] != ['restore'] or os.geteuid() != 0:
        raise SystemExit('Use the installed system’s firmware update hook.')
    # Initial image assembly has no machine-specific export or installation.
    if Path('/var/lib/harness-os/install.json').is_file():
        try:
            restore(Path('/'), retained())
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise SystemExit('Mac firmware restoration failed: ' + str(error))
