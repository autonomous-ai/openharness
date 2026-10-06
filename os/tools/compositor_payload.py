"""Validate and stage the compositor within the existing OS package transaction."""
import hashlib
import json
from pathlib import Path
import re
import shutil


def identity(path):
    with path.open('rb') as handle:
        return {'bytes': path.stat().st_size, 'sha256': hashlib.file_digest(handle, 'sha256').hexdigest()}


def validate(source, folder, commit):
    record = json.loads((folder / 'manifest.json').read_text())
    recipe = source / 'os/packaging/labwc'
    pin = json.loads((recipe / 'source.json').read_text())
    if (record.get('schema') != 1 or record.get('kind') != 'harness-compositor'
            or record.get('architecture') != 'x86_64' or record.get('source_commit') != commit
            or record.get('upstream') != pin
            or '-Dxwayland=enabled' not in record.get('build_options', [])):
        raise ValueError('Compositor must use this source, recipe, architecture and Xwayland support.')
    expected = record.get('binary', {})
    binary = folder / 'labwc'
    if (expected.get('name') != 'labwc' or binary.is_symlink() or not binary.is_file()
            or identity(binary) != {k: expected.get(k) for k in ('bytes', 'sha256')}):
        raise ValueError('Compositor binary checksum mismatch.')
    with binary.open('rb') as handle:
        header = handle.read(64)
    if (len(header) < 64 or header[:7] != b'\x7fELF\x02\x01\x01'
            or int.from_bytes(header[18:20], 'little') != 62):
        raise ValueError('Compositor must be an x86-64 Linux executable.')
    dependencies = record.get('runtime_dependencies')
    if (not isinstance(dependencies, list) or len(dependencies) > 40
            or any(not isinstance(name, str) or not re.fullmatch(r'[a-z0-9][a-z0-9@._+-]*', name)
                   for name in dependencies)
            or not {'glibc', 'wayland', 'wlroots0.20'} <= set(dependencies)):
        raise ValueError('Invalid compositor runtime dependencies.')
    originals = {'source.json': recipe / 'source.json',
                 'session-lock-presentation.patch': recipe / pin['patch'],
                 'rebuild.sh': recipe / 'rebuild.sh',
                 'build-compositor.py': source / 'os/tools/build-compositor.py',
                 'lock_presentation_policy.c': source / 'os/tests/lock_presentation_policy.c'}
    correspondence = record.get('corresponding_source', {})
    if set(correspondence) != {*originals, 'source.tar.gz', 'LICENSE'}:
        raise ValueError('Missing corresponding compositor source or license.')
    for name, expected in correspondence.items():
        path = folder / name
        if path.is_symlink() or not path.is_file() or identity(path) != expected:
            raise ValueError('Compositor source checksum mismatch: ' + name)
        if name in originals and identity(originals[name]) != expected:
            raise ValueError('Compositor source differs from this checkout: ' + name)
    if correspondence['source.tar.gz'] != {k: pin[k] for k in ('bytes', 'sha256')}:
        raise ValueError('Compositor upstream archive differs from the pin.')
    return record


def stage(source, folder, destination, commit):
    record = validate(source, folder, commit)
    target = destination / 'usr/lib/harness-os/labwc'
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(folder / 'labwc', target)
    target.chmod(0o755)
    license_dir = destination / 'usr/share/licenses/harness-os/labwc'
    license_dir.mkdir(parents=True)
    for name in record['corresponding_source']:
        shutil.copyfile(folder / name, license_dir / name)
        (license_dir / name).chmod(0o644)
    installed = destination / 'usr/share/harness-os/compositor.json'
    installed.write_text(json.dumps(record, indent=2) + '\n')
    installed.chmod(0o644)
    return record
