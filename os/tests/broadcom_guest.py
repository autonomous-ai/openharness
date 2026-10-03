#!/usr/bin/env python3
"""Probe a signed, snapshot-matched Broadcom driver in a disposable live guest."""
import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time
from urllib.request import Request, urlopen


def run(*args):
    return subprocess.check_output(args, text=True, timeout=420).strip()


def packages():
    return dict(line.split(' ', 1) for line in run('pacman', '-Q').splitlines())


def identity(path):
    with path.open('rb') as handle:
        digest = hashlib.file_digest(handle, 'sha256').hexdigest()
    return {'bytes': path.stat().st_size, 'sha256': digest}


def main():
    assert Path('/etc/harness-live').is_file(), 'Disposable live guest only'
    url = sys.argv[1]
    assert url.startswith('http://10.0.2.2:'), 'Private QEMU host only'
    started = time.time()
    root = Path('/root/broadcom-probe')
    root.mkdir()
    kernel = run('uname', '-r')
    baseline = packages()
    run('systemctl', 'start', 'harness-keyring.service')
    run('nm-online', '-q', '--timeout=60')
    # The image already carries databases for its complete dated repository.
    # Do not refresh one repository or upgrade this base during the experiment.
    build_started = time.monotonic()
    run('pacman', '-S', '--needed', '--noconfirm', 'broadcom-wl-dkms', 'linux-lts-headers')
    build_seconds = time.monotonic() - build_started
    after = packages()
    assert all(after.get(name) == version for name, version in baseline.items())
    added = {name: version for name, version in after.items() if name not in baseline}
    assert {'broadcom-wl-dkms', 'linux-lts-headers', 'dkms'}.issubset(added)
    module = Path(run('modinfo', '-n', 'wl'))
    vermagic = run('modinfo', '-F', 'vermagic', str(module))
    assert vermagic.split()[0] == kernel, (vermagic, kernel)
    run('modprobe', 'wl')
    assert Path('/sys/module/wl').is_dir()
    run('modprobe', '-r', 'wl')
    shutil.copyfile(module, root / module.name)
    shutil.copyfile('/usr/share/licenses/broadcom-wl-dkms/LICENSE', root / 'LICENSE.broadcom-wl')

    # Retain the signed package closure needed on this exact base. Independently
    # verify detached signatures before considering the offline bundle usable.
    descriptions = {}
    for database in Path('/var/lib/pacman/sync').glob('*.db'):
        with tarfile.open(database) as archive:
            for member in archive:
                if not member.name.endswith('/desc'):
                    continue
                blocks = archive.extractfile(member).read().decode().split('\n\n')
                fields = {lines[0]: lines[1:] for block in blocks if (lines := block.strip().splitlines())}
                name = fields.get('%NAME%', [''])[0]
                if name in added:
                    descriptions[name] = fields
    archives = []
    for name, version in sorted(added.items()):
        fields = descriptions[name]
        assert fields['%VERSION%'] == [version]
        filename = fields['%FILENAME%'][0]
        source = Path('/var/cache/pacman/pkg') / filename
        assert identity(source)['sha256'] == fields['%SHA256SUM%'][0]
        target = root / filename
        shutil.copyfile(source, target)
        signature = target.with_name(target.name + '.sig')
        signature.write_bytes(base64.b64decode(fields['%PGPSIG%'][0], validate=True))
        run('pacman-key', '--verify', str(signature), str(target))
        archives.append(target)

    # Remove exactly the newly added packages, then repeat with networking off.
    # This checks the closure rather than counting a cached successful build.
    run('pacman', '-R', '--noconfirm', *sorted(added))
    assert packages() == baseline
    run('nmcli', 'networking', 'off')
    config = root / 'pacman-signed.conf'
    config.write_text(Path('/etc/pacman.conf').read_text().replace(
        'LocalFileSigLevel = Optional', 'LocalFileSigLevel = Required'))
    assert 'LocalFileSigLevel = Required' in config.read_text()
    offline_started = time.monotonic()
    run('pacman', '--config', str(config), '-U', '--noconfirm', *map(str, archives))
    offline_seconds = time.monotonic() - offline_started
    assert packages() == after
    run('modprobe', 'wl')
    assert Path('/sys/module/wl').is_dir()
    run('modprobe', '-r', 'wl')
    config.unlink()
    receipt = {'status': 'passed', 'scope': 'kernel module and offline package closure; no physical radio',
               'started_at': started, 'finished_at': time.time(), 'kernel': kernel,
               'vermagic': vermagic, 'module': module.name,
               'arch_snapshot': json.loads(Path('/usr/share/harness-os/lock.json').read_text())['arch_snapshot'],
               'package_versions': added, 'online_install_and_build_seconds': round(build_seconds, 3),
               'offline_install_and_build_seconds': round(offline_seconds, 3),
               'blacklist_packaged_by_upstream': Path('/usr/lib/modprobe.d/broadcom-wl-dkms.conf').read_text(),
               'files': {p.name: identity(p) for p in sorted(root.iterdir())}}
    (root / 'driver-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    run('nmcli', 'networking', 'on')
    run('nm-online', '-q', '--timeout=60')
    for path in sorted(root.iterdir()):
        request = Request(url + '/' + path.name, data=path.read_bytes(), method='PUT')
        with urlopen(request, timeout=90) as response:
            assert response.status == 201
    print('HN_BROADCOM_PROBE=' + json.dumps(receipt))


if __name__ == '__main__':
    main()
