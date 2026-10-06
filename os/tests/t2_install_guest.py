#!/usr/bin/env python3
"""Guest-side T2 preservation evidence using invented firmware bytes only."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile


def module(name):
    spec = importlib.util.spec_from_file_location(name, '/usr/lib/harness-os/' + name + '.py')
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def verify():
    t2, system, boot = module('t2_install'), module('system'), module('boot_profile')
    assert boot.selected()['id'] == 'apple-t2'
    saved = t2.retained()
    manifest, files = t2.helper().verify(saved['bundle'], saved['manifest']['model'])
    boot_bundle = Path('/boot/harness-apple-firmware.tar')
    assert boot_bundle.read_bytes() == saved['bundle'].read_bytes()
    for name, expected in files.items():
        path = Path('/usr/lib/firmware/brcm') / name
        assert not path.is_symlink() and path.read_bytes() == expected, name
    record = {'model': manifest['model'], 'files': len(files),
              'firmware_sha256': hashlib.sha256(saved['bundle'].read_bytes()).hexdigest(),
              'boot_sha256': system.boot_hashes(Path('/boot'))}
    system.validate_checkpoint({'platform': 'apple-t2', **system.installed(), 'boot_sha256': record['boot_sha256']},
                               system.installed()['root_uuid'])
    return record


def package():
    verify()
    t2 = module('t2_install')
    saved = t2.retained()
    _, files = t2.helper().verify(saved['bundle'], saved['manifest']['model'])
    # The deliberate overwrite is restricted to one synthetic fixture file in
    # this VM. No live Apple firmware or user data participates in CI.
    name = next(iter(sorted(files)))
    path = 'usr/lib/firmware/brcm/' + name
    process = subprocess.check_output(['pgrep', '-xo', 'hn|harness-tui'], text=True).strip()
    with tempfile.TemporaryDirectory(prefix='t2-update-fixture-') as temp:
        archive = Path(temp) / 'linux-firmware-harness-fixture-1-1-any.pkg.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            entries = {'.PKGINFO': b'pkgname = linux-firmware-harness-fixture\npkgver = 1-1\narch = any\n',
                       path: b'package fallback fixture'}
            for name, data in entries.items():
                entry = tarfile.TarInfo(name)
                entry.size, entry.mode = len(data), 0o644
                output.addfile(entry, io.BytesIO(data))
        # Pacman splits --overwrite on commas, including the comma in Apple's
        # board filenames. This archive contains exactly one firmware member;
        # match that separator with one glob character rather than two patterns.
        overwrite = path.replace(',', '?')
        subprocess.run(['pacman', '--noconfirm', '--overwrite', overwrite, '-U', str(archive)], check=True, timeout=150)
    assert subprocess.check_output(['pgrep', '-xo', 'hn|harness-tui'], text=True).strip() == process
    return verify()


def fingerprint():
    assert subprocess.check_output(['lsblk', '-dn', '-o', 'SERIAL', '/dev/vda'], text=True).strip() == 'HN_OS_TEST'
    digest = hashlib.sha256()
    with Path('/dev/vda').open('rb', buffering=0) as handle:
        digest.update(handle.read(1048576))
        handle.seek(-1048576, os.SEEK_END)
        digest.update(handle.read(1048576))
    with Path('/dev/vda1').open('rb', buffering=0) as handle:
        for data in iter(lambda: handle.read(1048576), b''):
            digest.update(data)
    return {'sha256': digest.hexdigest()}


if __name__ == '__main__':
    result = {'verify': verify, 'package': package, 'fingerprint': fingerprint}[sys.argv[1]]()
    print('T2_RESULT=' + json.dumps(result))
