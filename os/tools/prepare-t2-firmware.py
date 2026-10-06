#!/usr/bin/env python3
"""Export and verify a Mac's own wireless firmware, without changing its disks."""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile


CONVERTER = Path(__file__).with_name('firmware_names.py')
if not CONVERTER.is_file():
    CONVERTER = Path(__file__).parents[1] / 'platforms/apple-t2/firmware_names.py'
spec = importlib.util.spec_from_file_location('harness_apple_firmware_names', CONVERTER)
names = importlib.util.module_from_spec(spec)
spec.loader.exec_module(names)

MODELS = {'MacBookAir8,1', 'MacBookAir8,2', 'MacBookAir9,1',
          'MacBookPro15,1', 'MacBookPro15,2', 'MacBookPro15,3', 'MacBookPro15,4',
          'MacBookPro16,1', 'MacBookPro16,2', 'MacBookPro16,3', 'MacBookPro16,4',
          'Macmini8,1', 'MacPro7,1', 'iMacPro1,1', 'iMac20,1', 'iMac20,2'}
BT_MODELS = {'MacBookAir9,1', 'MacBookPro15,4', 'MacBookPro16,3'}
MAX_FILE = 16 * 1024**2
MAX_TOTAL = 128 * 1024**2
MAX_FILES = 4096
MAX_MANIFEST = 2 * 1024**2
MAX_ARCHIVE = MAX_TOTAL + MAX_FILES * 1024 + MAX_MANIFEST
SOURCE_NAME = re.compile(r'[A-Za-z0-9_,.+-]{1,180}')
WIFI_NAME = re.compile(r'brcmfmac(4355c1|4364b2|4364b3|4377b3)-pcie\.apple(?:,[A-Za-z0-9,.+-]+)?\.(bin|txt|clm_blob|txcap_blob)')
BT_NAME = re.compile(r'brcmbt4377[a-z][0-9]-apple,[a-z0-9]+(?:-[mu])?\.(bin|ptb)')
IMAC_FILES = {'brcmfmac4364b2-pcie.txt', 'brcmfmac4364b2-pcie.txcap_blob'}


def identity(data):
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def check_model(model):
    if model not in MODELS:
        raise ValueError('This firmware export requires an Intel Mac with a T2 chip.')


def regular_bytes(path, limit):
    """Reject links and special files before reading; never wait on a FIFO."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= limit:
            raise ValueError('Invalid firmware file size or type: ' + str(path))
        data = source.read(limit + 1)
        after = os.fstat(source.fileno())
        if len(data) != before.st_size or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError('Firmware changed while reading: ' + str(path))
        return data


def source_files(source):
    source = source.resolve(strict=True)
    result, size = {}, 0
    folders = ['wifi/' + folder for folder in sorted(names.WIFI_FOLDERS)] + ['bluetooth']
    for relative in folders:
        folder = source
        missing = False
        for part in relative.split('/'):
            folder = folder / part
            if folder.is_symlink():
                raise ValueError('Firmware directories cannot be symbolic links.')
            if not folder.exists():
                missing = True
                break
            if not folder.is_dir():
                raise ValueError('Invalid firmware directory.')
        if missing:
            continue
        for path in sorted(folder.iterdir()):
            extensions = {'.bin', '.ptb'} if relative == 'bluetooth' else {'.' + ext for ext in names.EXTENSIONS}
            if path.suffix not in extensions:
                continue
            if not SOURCE_NAME.fullmatch(path.name):
                raise ValueError('Invalid Apple firmware filename.')
            data = regular_bytes(path, MAX_FILE)
            size += len(data)
            if size > MAX_TOTAL or len(result) >= MAX_FILES:
                raise ValueError('Apple firmware exceeds the preservation budget.')
            result[relative + '/' + path.name] = data
    return result


def imac_requested_files(raw):
    """Read iMac Pro calibration filenames from IORegistry data, never shell text."""
    if len(raw) > MAX_FILE:
        raise ValueError('IORegistry output is too large.')
    candidates = set()

    def strings(value):
        if isinstance(value, str):
            yield value
        elif isinstance(value, dict):
            for child in value.values():
                yield from strings(child)
        elif isinstance(value, list):
            for child in value:
                yield from strings(child)

    def visit(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key == 'RequestedFiles':
                    for text in strings(child):
                        for match in re.finditer(r'(?:^|/)C-4364__s-B2/([A-Za-z0-9_,.+-]+\.(?:txt|txcb))(?=$|["\s])', text):
                            candidates.add('wifi/C-4364__s-B2/' + match[1])
                else:
                    visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(plistlib.loads(raw))
    if len(candidates) != 2 or {Path(name).suffix for name in candidates} != {'.txt', '.txcb'}:
        raise ValueError('Cannot identify this iMac Pro’s Wi-Fi calibration. Keep macOS until it is exported.')
    return candidates


def validate_files(files, model):
    check_model(model)
    if not files or len(files) > MAX_FILES or sum(len(data) for data in files.values()) > MAX_TOTAL:
        raise ValueError('Invalid preserved firmware inventory.')
    for name, data in files.items():
        if len(name) > 200 or not (WIFI_NAME.fullmatch(name) or BT_NAME.fullmatch(name) or
                                    model == 'iMacPro1,1' and name in IMAC_FILES):
            raise ValueError('Unexpected Linux firmware filename: ' + name)
        if not 0 < len(data) <= MAX_FILE:
            raise ValueError('Invalid preserved firmware size.')
    # These are completeness checks, not proof of radio operation. Hardware
    # acceptance must still verify brcmfmac loads the particular board variant.
    wifi = [WIFI_NAME.fullmatch(name) for name in files if WIFI_NAME.fullmatch(name)]
    chips = {match[1] for match in wifi}
    if not chips or any(not {'bin', 'txt'} <= {match[2] for match in wifi if match[1] == chip} for chip in chips):
        raise ValueError('Wi-Fi firmware is incomplete; keep macOS until it is exported.')
    if model in BT_MODELS:
        bases = {name.rsplit('.', 1)[0] for name in files if BT_NAME.fullmatch(name)}
        if not bases or any(base + '.bin' not in files or base + '.ptb' not in files for base in bases):
            raise ValueError('This Mac needs Bluetooth firmware from macOS Monterey or later.')
        if '4377b3' not in chips:
            raise ValueError('This Mac’s BCM4377 Wi-Fi firmware is missing.')
    if model == 'iMacPro1,1' and not IMAC_FILES <= files.keys():
        raise ValueError('This iMac Pro’s Wi-Fi calibration is missing.')


def prepare(source, output, model, requested_files=None):
    check_model(model)
    inputs = source_files(source)
    files = names.convert(inputs)
    if model == 'iMacPro1,1':
        for name in imac_requested_files(requested_files or b''):
            if name not in inputs:
                raise ValueError('Requested iMac Pro calibration is not present in macOS.')
            destination = 'brcmfmac4364b2-pcie.' + ('txt' if name.endswith('.txt') else 'txcap_blob')
            files[destination] = inputs[name]
    validate_files(files, model)
    manifest = {'schema': 1, 'platform': 'apple-t2', 'model': model,
                'source': 'local-macos-firmware',
                'files': {name: identity(data) for name, data in sorted(files.items())}}
    payload = {'manifest.json': (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()}
    payload.update({'brcm/' + name: data for name, data in sorted(files.items())})
    if len(payload['manifest.json']) > MAX_MANIFEST:
        raise ValueError('Firmware manifest is too large.')
    # Output is a fresh, local archive, never an EFI write or a package install.
    # Linking a completed private file makes publication create-only even if
    # another process creates the requested output while conversion is running.
    fd, temporary = tempfile.mkstemp(prefix='.harness-firmware-', dir=output.parent)
    try:
        with os.fdopen(fd, 'wb') as destination:
            with tarfile.open(fileobj=destination, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                for name, data in payload.items():
                    entry = tarfile.TarInfo(name)
                    entry.mode, entry.size = 0o644, len(data)
                    archive.addfile(entry, io.BytesIO(data))
            destination.flush()
            os.fsync(destination.fileno())
        verify(Path(temporary), model)
        os.link(temporary, output)
    finally:
        os.unlink(temporary)
    return manifest


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate firmware manifest key.')
        result[key] = value
    return result


def verify(bundle, model):
    try:
        return verify_archive(bundle, model)
    except (tarfile.TarError, UnicodeError, KeyError, TypeError) as error:
        raise ValueError('Invalid preserved firmware archive.') from error


def verify_archive(bundle, model):
    check_model(model)
    data = regular_bytes(bundle, MAX_ARCHIVE)
    files, manifest = {}, None
    size = 0
    seen = set()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        for entry in archive:
            if (entry.name in seen or len(seen) >= MAX_FILES + 1 or not entry.isreg() or
                    entry.mode != 0o644 or entry.uid != 0 or entry.gid != 0 or entry.pax_headers or
                    entry.linkname or entry.sparse is not None):
                raise ValueError('Invalid preserved firmware archive entry.')
            seen.add(entry.name)
            limit = MAX_MANIFEST if entry.name == 'manifest.json' else MAX_FILE
            if not 0 < entry.size <= limit:
                raise ValueError('Invalid preserved firmware archive size.')
            if entry.name != 'manifest.json' and (not entry.name.startswith('brcm/') or entry.name.count('/') != 1):
                raise ValueError('Unexpected preserved firmware archive path.')
            value = archive.extractfile(entry).read(limit + 1)
            if len(value) != entry.size:
                raise ValueError('Truncated preserved firmware archive.')
            if entry.name == 'manifest.json':
                manifest = json.loads(value, object_pairs_hook=unique_object)
            else:
                size += len(value)
                if size > MAX_TOTAL:
                    raise ValueError('Preserved firmware exceeds the memory budget.')
                files[entry.name.removeprefix('brcm/')] = value
    if not isinstance(manifest, dict) or set(manifest) != {'schema', 'platform', 'model', 'source', 'files'}:
        raise ValueError('Missing or invalid firmware manifest.')
    if (type(manifest['schema']) is not int or manifest['schema'] != 1 or
            manifest['platform'] != 'apple-t2' or manifest['model'] != model or
            manifest['source'] != 'local-macos-firmware'):
        raise ValueError('This firmware bundle belongs to another Mac model or format.')
    validate_files(files, model)
    if manifest['files'] != {name: identity(value) for name, value in sorted(files.items())}:
        raise ValueError('Preserved firmware checksum or inventory mismatch.')
    return manifest, files


def stage(bundle, output, model):
    """Materialize verified data in a new private directory for a future installer.

    This does not copy into a running system, mount a disk, unload a driver, or
    enable T2 installation. The eventual installer must choose a RAM-backed
    staging location before erasure and preserve this data during recovery.
    """
    manifest, files = verify(bundle, model)  # Reject everything before any write.
    output.mkdir(mode=0o700, exist_ok=False)
    try:
        (output / 'brcm').mkdir(mode=0o700)
        for name, data in files.items():
            path = output / 'brcm' / name
            with path.open('xb') as destination:
                destination.write(data)
                destination.flush()
                os.fsync(destination.fileno())
            path.chmod(0o644)
            if identity(regular_bytes(path, MAX_FILE)) != manifest['files'][name]:
                raise ValueError('Staged firmware readback differs from its manifest.')
        manifest_path = output / 'manifest.json'
        with manifest_path.open('x') as destination:
            destination.write(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
            destination.flush()
            os.fsync(destination.fileno())
        manifest_path.chmod(0o600)
    except BaseException:
        shutil.rmtree(output)
        raise
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    export = commands.add_parser('export', help='Read this Intel Mac’s own firmware from macOS.')
    export.add_argument('--output', type=Path, required=True)
    for name in ('verify', 'stage'):
        command = commands.add_parser(name)
        command.add_argument('--bundle', type=Path, required=True)
        command.add_argument('--model', required=True)
        if name == 'stage':
            command.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'export':
            if platform.system() != 'Darwin' or platform.machine() != 'x86_64':
                raise ValueError('Export firmware while running macOS on the Intel Mac that will receive Harness.')
            model = subprocess.check_output(['sysctl', '-n', 'hw.model'], timeout=10, text=True).strip()
            check_model(model)
            requested = subprocess.check_output(['ioreg', '-a', '-l'], timeout=20) if model == 'iMacPro1,1' else None
            manifest = prepare(Path('/usr/share/firmware'), args.output.absolute(), model, requested)
        elif args.command == 'stage':
            manifest = stage(args.bundle, args.output, args.model)
        else:
            manifest, _ = verify(args.bundle, args.model)
        print(json.dumps({'model': manifest['model'], 'files': len(manifest['files']),
                          'bytes': sum(entry['bytes'] for entry in manifest['files'].values()),
                          'status': 'verified'}, sort_keys=True))
    except (OSError, ValueError, tarfile.TarError, plistlib.InvalidFileException, subprocess.SubprocessError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
