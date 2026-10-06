#!/usr/bin/env python3
"""Private changed-kernel gate. Never run outside the disposable HN_OS_TEST VM."""
import argparse
import base64
from datetime import datetime
import gzip
import hashlib
import importlib.util
import json
import lzma
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import time
from urllib.request import urlopen

SYSTEM = Path('/usr/lib/harness-os/system.py')
PROJECT = Path('/home/me/projects/kernel-update-survivor')
NVIDIA = ('nvidia', 'nvidia_modeset', 'nvidia_uvm', 'nvidia_drm')
EARLY = ('nvidia', 'nvidia_modeset', 'nvidia_drm')
MASKS = ('harness-update.timer', 'harness-update.service')


def digest(path):
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def run(*args, timeout=90):
    return subprocess.check_output([str(arg) for arg in args], text=True, timeout=timeout).strip()


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + '\n')


def validate_lock(lock):
    assert lock['schema'] == 1
    old, new = lock['baseline'], lock['candidate']
    assert old['kernel'] != new['kernel'], 'This gate requires a different kernel ABI'
    assert old['snapshot'] < new['snapshot']
    assert old['kernel'] == old['packages']['linux-lts'] + '-lts'
    assert old['packages']['linux-lts'] == old['packages']['linux-lts-headers']
    assert new['kernel'] == new['packages']['linux-lts']['version'] + '-lts'
    assert new['packages']['linux-lts']['version'] == new['packages']['linux-lts-headers']['version']
    assert set(new['repositories']) == {'core', 'extra'}
    assert set(old['runtime_files']) == {'harness-tui', 'cli.mjs', 'notify.mjs'}
    for name, row in new['repositories'].items():
        assert row['url'] == f'https://archive.archlinux.org/repos/{new["snapshot"]}/{name}/os/x86_64/{name}.db'
        assert re.fullmatch(r'[0-9a-f]{64}', row['sha256']) and row['bytes'] > 0
    for row in new['packages'].values():
        assert row['repository'] in new['repositories']
        assert Path(row['filename']).name == row['filename']
        assert re.fullmatch(r'[0-9a-f]{64}', row['sha256']) and row['bytes'] > 0


def inventory():
    return dict(line.split(' ', 1) for line in run('pacman', '-Q').splitlines())


def assert_versions(packages, expected):
    for name, version in expected.items():
        assert packages.get(name) == version, (name, packages.get(name), version)


def expected_versions(lock, candidate):
    versions = dict(lock['baseline']['packages'])
    if candidate:
        versions.update({name: row['version'] for name, row in lock['candidate']['packages'].items()})
    return versions


def runtime(lock):
    result = {'files': {}, 'package': inventory()['harness-os'], 'runtime_json_sha256': digest('/usr/share/harness-os/runtime.json')}
    assert result['package'] == lock['baseline']['packages']['harness-os']
    for name, expected in lock['baseline']['runtime_files'].items():
        path = Path('/usr/lib/harness') / name
        actual = {'bytes': path.stat().st_size, 'sha256': digest(path)}
        assert actual == expected, ('Frozen Harness runtime changed', name, actual)
        result['files'][name] = actual
    info = json.loads(Path('/usr/share/harness-os/runtime.json').read_text())
    assert info['source_commit'] == lock['baseline']['source_commit']
    assert info['files'] == lock['baseline']['runtime_files']
    # A selected per-user binary must not silently replace the packaged one.
    updates = Path('/home/me/.local/state/harness-os/updates/current')
    result['user_update_directory_exists'] = updates.exists()
    assert not updates.exists() and not updates.is_symlink(), 'Unexpected per-user runtime update state'
    for name in MASKS:
        assert os.readlink('/etc/systemd/user/' + name) == '/dev/null'
    return result


def initramfs_identity(listing, kernel, firmware):
    namespaces = sorted(set(re.findall(r'(?:^|/)usr/lib/modules/([^/\s]+)/', listing, re.M)))
    assert namespaces == [kernel], ('Initramfs kernel namespace', namespaces, kernel)
    modules = {}
    for name in EARLY:
        pattern = r'[^\s]*usr/lib/modules/' + re.escape(kernel) + r'/[^\s]*/' + name.replace('_', '[-_]') + r'\.ko(?:\.(?:zst|xz|gz))?(?=\s|$)'
        found = re.findall(pattern, listing)
        assert len(found) == 1, ('Missing early NVIDIA module', name, found)
        modules[name] = found[0]
    assert firmware, 'No declared NVIDIA GSP firmware'
    for name in firmware:
        found = re.findall(r'(?:^|/)usr/lib/firmware/' + re.escape(name) + r'(?:\.(?:zst|xz|gz))?(?=\s|$)', listing, re.M)
        assert len(found) == 1, ('Missing or ambiguous GSP firmware', name, found)
    return {'kernel_namespaces': namespaces, 'early_modules': modules, 'firmware': firmware}


def content_digest(path):
    """Compare payload bytes even when mkinitcpio changes their compression."""
    with Path(path).open('rb') as handle:
        magic = handle.read(6)
    if magic.startswith(b'\x28\xb5\x2f\xfd'):
        # Spool decompressed data to the guest disk, not the 2 GiB guest's RAM.
        with tempfile.TemporaryFile(dir='/var/tmp') as decoded:
            subprocess.run(['zstd', '--decompress', '--stdout', str(path)],
                           stdout=decoded, check=True, timeout=30)
            decoded.seek(0)
            return hashlib.file_digest(decoded, 'sha256').hexdigest()
    opener = gzip.open if magic.startswith(b'\x1f\x8b') else lzma.open if magic == b'\xfd7zXZ\x00' else open
    with opener(path, 'rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def payload_identity(segments, identity, modules, firmware_root=Path('/usr/lib/firmware')):
    pairs = []
    for name, relative in identity['early_modules'].items():
        found = [(segment, root / relative) for segment, root in segments.items() if (root / relative).is_file()]
        assert len(found) == 1, ('Missing or ambiguous archived module', name, found)
        segment, archived = found[0]
        pairs.append((name, segment, archived, Path(modules[name]['path'])))
    for name in identity['firmware']:
        installed = [firmware_root / (name + suffix) for suffix in ('', '.zst', '.xz', '.gz')]
        present = [path for path in installed if path.is_file()]
        assert len(present) == 1, ('Ambiguous installed GSP payload', name, present)
        archived = [(segment, root / 'usr/lib/firmware' / (name + suffix))
                    for segment, root in segments.items() for suffix in ('', '.zst', '.xz', '.gz')]
        archived = [(segment, path) for segment, path in archived if path.is_file()]
        assert len(archived) == 1, ('Missing or ambiguous archived GSP payload', name, archived)
        pairs.append((name, *archived[0], present[0]))
    result = {}
    for name, segment, archived, installed in pairs:
        root = segments[segment]
        assert archived.resolve().is_relative_to(root.resolve()), 'Initramfs link escapes its extracted payload'
        expected, actual = content_digest(installed), content_digest(archived)
        assert expected == actual, ('Initramfs contains different payload bytes', name)
        result[name] = {'segment': segment, 'archive_path': str(archived.relative_to(root)), 'installed_path': str(installed),
                        'installed_file_sha256': digest(installed), 'archive_file_sha256': digest(archived),
                        'decompressed_sha256': actual}
    return result


def module_identity(path, kernel, modules_root=Path('/usr/lib/modules')):
    """Resolve the guest's real aliases before accepting or hashing a module."""
    raw = Path(path)
    root = (modules_root / kernel).resolve(strict=True)
    resolved = raw.resolve(strict=True)
    assert raw.is_absolute() and root.is_dir() and resolved.is_file(), ('Not a regular module file', raw, resolved)
    assert resolved.is_relative_to(root), ('Module escapes expected kernel directory', raw, resolved, root)
    return {'path': str(raw), 'resolved_path': str(resolved), 'module_root': str(root), 'sha256': digest(resolved)}


def validate_probe(result, lock, candidate, running_kernel):
    expected = lock['candidate' if candidate else 'baseline']['kernel']
    assert result['running_kernel'] == running_kernel
    assert result['installed_kernel'] == expected and result['headers_kernel'] == expected
    assert_versions(result['packages'], expected_versions(lock, candidate))
    assert result['boot']['vmlinuz-linux-lts'] == result['package_kernel_sha256']
    root = Path(result['module_root'])
    assert root.is_absolute() and root.name == expected and '..' not in root.parts
    version = result['packages']['nvidia-utils'].rsplit('-', 1)[0]
    for name in ('wl',) + NVIDIA:
        row = result['modules'][name]
        assert row['vermagic'].split()[0] == expected, ('Wrong module ABI', name, row)
        # These are already resolved in the guest. Never resolve guest paths on
        # the host when replaying pure receipt assertions.
        resolved = Path(row['resolved_path'])
        assert row['module_root'] == str(root) and row['sha256']
        assert resolved.is_absolute() and '..' not in resolved.parts and resolved != root and resolved.is_relative_to(root)
        if name in NVIDIA:
            assert row['owner'] == 'nvidia-open-lts', 'NVIDIA must remain the prebuilt package, not DKMS'
            assert row['version'] == version, ('NVIDIA userspace/module mismatch', row, version)
    assert re.search(r'broadcom-wl/[^,]+, ' + re.escape(expected) + r', [^\n]+: installed', result['dkms']), 'Automatic wl DKMS install is missing'
    assert result['initramfs']['kernel_namespaces'] == [expected]
    assert set(result['initramfs']['early_modules']) == set(EARLY)


def probe(lock, candidate, running_kernel, output):
    assert not Path('/etc/harness-live').exists()
    system = load('system', SYSTEM)
    packages = inventory()
    kernel = packages['linux-lts'] + '-lts'
    result = {'running_kernel': run('uname', '-r'), 'installed_kernel': kernel, 'packages': packages,
              'headers_kernel': Path(f'/usr/lib/modules/{kernel}/build/include/config/kernel.release').read_text().strip(),
              'package_kernel_sha256': digest(f'/usr/lib/modules/{kernel}/vmlinuz'),
              'boot': system.boot_hashes(Path('/boot')), 'modules': {}, 'dkms': run('dkms', 'status'),
              'module_root': str(Path(f'/usr/lib/modules/{kernel}').resolve(strict=True)),
              'lib_alias': {'target': os.readlink('/lib') if Path('/lib').is_symlink() else None,
                            'resolved': str(Path('/lib').resolve(strict=True))},
              'runtime': runtime(lock), 'system_sha256': digest(SYSTEM),
              'pacman_config': Path('/etc/pacman.conf').read_text(), 'node': run('node', '--version'),
              'networking': run('nmcli', 'networking'),
              'install': json.loads(Path('/var/lib/harness-os/install.json').read_text())}
    partial = Path(output).with_suffix('.partial.json')
    result['probe_stage'] = 'modules'
    save(partial, result)
    for name in ('wl',) + NVIDIA:
        path = run('modinfo', '-k', kernel, '-F', 'filename', name)
        row = {key: run('modinfo', '-k', kernel, '-F', key, name) for key in ('vermagic', 'version')}
        row.update(module_identity(path, kernel))
        if name in NVIDIA:
            row['owner'] = run('pacman', '-Qqo', path)
        result['modules'][name] = row
    result['probe_stage'] = 'initramfs-listings'
    save(partial, result)
    listings = {}
    for segment, option in [('early', '--early'), ('main', '--cpio')]:
        listings[segment] = run('lsinitcpio', '--list', option, '/boot/initramfs-linux-lts.img')
        Path(output).with_suffix('.initramfs-' + segment + '.txt').write_text(listings[segment] + '\n')
    listing = '\n'.join(listings.values())
    Path(output).with_suffix('.initramfs.txt').write_text(listing + '\n')
    firmware = run('modinfo', '-k', kernel, '-F', 'firmware', 'nvidia').splitlines()
    result['initramfs'] = initramfs_identity(listing, kernel, firmware)
    result['initramfs']['segments'] = {segment: {'listing_sha256': hashlib.sha256((text + '\n').encode()).hexdigest(),
                                                'entries': len(text.splitlines())} for segment, text in listings.items()}
    # mkinitcpio 42.1 puts compressed modules/firmware in early CPIO. Inspect
    # both parts separately; matching names in both must not silently overwrite
    # one another. No build or repair command runs here.
    with tempfile.TemporaryDirectory(prefix='kernel-update-initrd-', dir='/var/tmp') as directory:
        segments = {name: Path(directory) / name for name in ('early', 'main')}
        try:
            for segment, option in [('early', '--early'), ('main', '--cpio')]:
                result['probe_stage'] = 'initramfs-extract-' + segment
                save(partial, result)
                segments[segment].mkdir()
                subprocess.run(['lsinitcpio', '--extract', option, '/boot/initramfs-linux-lts.img'],
                               cwd=segments[segment], check=True, timeout=60, stdout=subprocess.DEVNULL)
            result['probe_stage'] = 'initramfs-payload-bytes'
            result['initramfs']['payloads'] = payload_identity(segments, result['initramfs'], result['modules'])
        except Exception as error:
            result['probe_error'] = repr(error)
            raise
        finally:
            result['initramfs']['extracted_candidates'] = {
                segment: sorted(str(path.relative_to(root)) for pattern in
                                ('usr/lib/modules/**/nvidia*.ko*', 'usr/lib/firmware/nvidia/**/*')
                                for path in root.glob(pattern) if path.is_file() or path.is_symlink())
                for segment, root in segments.items()}
            save(partial, result)
    result['probe_stage'] = 'module-consistency'
    save(partial, result)
    validate_probe(result, lock, candidate, running_kernel)
    snapshot = lock['candidate' if candidate else 'baseline']['snapshot']
    assert set(re.findall(r'archive.archlinux.org/repos/(\d{4}/\d{2}/\d{2})/', result['pacman_config'])) == {snapshot}
    assert not Path('/var/lib/pacman/db.lck').exists()
    if kernel == running_kernel:
        # Real module loading, even though no physical Broadcom radio is present.
        run('modprobe', 'wl')
        assert Path('/sys/module/wl').is_dir()
        result['wl_loaded'] = True
        run('modprobe', '-r', 'wl')
    result['probe_stage'] = 'complete'
    save(partial, result)
    save(output, result)
    return result


def install(lock, candidate_path):
    assert Path('/etc/harness-live').is_file() and run('nmcli', 'networking') == 'disabled'
    hardware = load('hardware', '/usr/lib/harness-os/hardware.py')
    installer = load('installer', '/usr/lib/harness-os/install.py')
    broadcom = hardware.bundle_manifest(hardware.BUNDLE, all_files=True)
    nvidia = hardware.nvidia_bundle_manifest(hardware.NVIDIA_BUNDLE, all_files=True)
    assert broadcom['kernel'] == nvidia['kernel'] == lock['baseline']['kernel']
    gpu = next(identity for identity, names in nvidia['supported_devices'].items()
               if any('GeForce RTX 4090' in name for name in names))
    devices = [dict(address='0000:03:00.0', id='14e4:43a0', **{'class': '028000'}, driver=None, interfaces=[]),
               dict(address='0000:04:00.0', id=gpu, **{'class': '030000'}, driver='nouveau', interfaces=[])]
    result = {'devices': devices, 'image_system_sha256': digest(SYSTEM), 'candidate_system_sha256': digest(candidate_path),
              'image_hardware_sha256': digest('/usr/lib/harness-os/hardware.py'),
              'image_installer_sha256': digest('/usr/lib/harness-os/install.py')}
    original = installer.run

    def select(*args, **kwargs):
        if args[:3] != ('/usr/bin/python3', '/usr/lib/harness-os/hardware.py', 'configure-install'):
            return original(*args, **kwargs)
        target = Path(args[3])
        assert target == Path('/mnt/harness-os') and target.is_mount()
        before = dict(line.split(' ', 1) for line in hardware.run('arch-chroot', target, 'pacman', '-Q', capture=True).splitlines())
        result['selection'] = hardware.configure_install(target, devices)
        assert set(result['selection']['drivers']) == {'broadcom-wl-dkms', 'nvidia-open-lts'}
        after = dict(line.split(' ', 1) for line in hardware.run('arch-chroot', target, 'pacman', '-Q', capture=True).splitlines())
        assert all(after.get(name) == version for name, version in before.items())
        expected = {row['name']: row['version'] for bundle in (broadcom, nvidia) for row in bundle['packages'].values()}
        assert {name: version for name, version in after.items() if name not in before} == expected
        assert_versions(after, lock['baseline']['packages'])
        installed_system = target / SYSTEM.relative_to('/')
        assert digest(installed_system) == result['image_system_sha256']
        installed_system.write_bytes(candidate_path.read_bytes())
        installed_system.with_name('boot_profile.py').write_bytes(candidate_path.with_name('boot_profile.py').read_bytes())
        # Apply before the first installed boot; no public feed may replace the
        # frozen runtime. These are private fixture settings in the root snapshot.
        for name in MASKS:
            path = target / 'etc/systemd/user' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to('/dev/null')
        result['optional_packages'] = expected

    installer.run = select
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123', encrypt=True, serial_console=True)
    installer.install(config, installer.live_payload(), Path('/mnt/harness-os'))
    assert result.get('optional_packages'), 'Installer never selected the two optional stacks'
    return result


def database(path):
    packages = {}
    with tarfile.open(path) as archive:
        for entry in archive:
            if not entry.isfile() or not entry.name.endswith('/desc'):
                continue
            sections = archive.extractfile(entry).read().decode().strip().split('\n\n')
            fields = {lines[0].strip('%'): lines[1:] for lines in (section.splitlines() for section in sections)}
            packages[fields['NAME'][0]] = fields
    return packages


def verify_metadata(lock, folder, fetch):
    packages = {}
    for repo, expected in lock['candidate']['repositories'].items():
        path = folder / (repo + '.db') if fetch else Path('/var/lib/pacman/sync') / (repo + '.db')
        if fetch:
            # Two bounded reads of the exact dated metadata, with no mirror fallback.
            with urlopen(expected['url'], timeout=30) as response:
                data = response.read(expected['bytes'] + 1)
            path.write_bytes(data)
        assert path.stat().st_size == expected['bytes'] and digest(path) == expected['sha256'], ('Archive database changed', repo)
        for name, row in database(path).items():
            row['repository'] = repo
            packages[name] = row
    for name, expected in lock['candidate']['packages'].items():
        row = packages[name]
        for key, field in [('version', 'VERSION'), ('filename', 'FILENAME'), ('sha256', 'SHA256SUM'), ('bytes', 'CSIZE')]:
            assert str(expected[key]) == row[field][0], (name, field)
        assert row['PGPSIG'][0], ('Package signature absent', name)
    return packages


def verify_transaction(before, after, metadata, folder):
    changed = {name: version for name, version in after.items() if before.get(name) != version}
    assert 'linux-lts' in changed and 'linux-lts-headers' in changed and 'nvidia-open-lts' in changed
    rows = {}
    for name, version in sorted(changed.items()):
        item = metadata[name]
        assert version == item['VERSION'][0], ('Package not from the dated snapshot', name, version)
        archive = Path('/var/cache/pacman/pkg') / item['FILENAME'][0]
        assert archive.stat().st_size == int(item['CSIZE'][0]) and digest(archive) == item['SHA256SUM'][0]
        signature = folder / (archive.name + '.sig')
        signature.write_bytes(base64.b64decode(item['PGPSIG'][0], validate=True))
        verified = subprocess.run(['pacman-key', '--verify', str(signature), str(archive)],
                                  capture_output=True, text=True, timeout=30)
        assert verified.returncode == 0, (name, verified.stdout, verified.stderr)
        rows[name] = {'version': version, 'repository': item['repository'], 'filename': archive.name,
                      'bytes': archive.stat().st_size, 'sha256': digest(archive),
                      'signature_sha256': digest(signature), 'signature_base64': item['PGPSIG'][0],
                      'signature_verification': verified.stdout + verified.stderr}
    return {'changed': rows, 'removed': {name: version for name, version in before.items() if name not in after}}


def update(lock, folder, baseline):
    system = load('system', SYSTEM)
    before = inventory()
    assert before == baseline['packages']
    config = Path('/etc/pacman.conf').read_text()
    assert config == baseline['pacman_config']
    assert re.findall(r'^\[([^]]+)\]', config, re.M) == ['options', 'core', 'extra']
    policy = run('pacman-conf', 'SigLevel')
    assert 'PackageRequired' in policy and 'PackageTrustedOnly' in policy and 'TrustAll' not in policy
    assert not re.search(r'^\s*(IgnorePkg|IgnoreGroup|NoUpgrade)\s*=', config, re.M)
    verify_metadata(lock, folder, fetch=True)
    before_checkpoints = {p.parent.name for p in Path('/.snapshots').glob('*/checkpoint.json')}
    # Use the real API and every normal transaction hook. Never invoke DKMS or
    # mkinitcpio manually: repairing a hook failure would invalidate this gate.
    started = time.monotonic()
    with system.operation_lock():
        system.update(lock['candidate']['snapshot'], noninteractive=True)
    receipt = json.loads(Path('/var/lib/harness-os/update.json').read_text())
    assert receipt['exit_status'] == 0
    checkpoint = Path('/.snapshots') / receipt['checkpoint']
    assert checkpoint.name not in before_checkpoints
    assert {p.parent.name for p in Path('/.snapshots').glob('*/checkpoint.json')} - before_checkpoints == {checkpoint.name}
    meta = json.loads((checkpoint / 'checkpoint.json').read_text())
    assert meta['boot_sha256'] == baseline['boot'] and meta['reason'] == 'before-update'
    assert meta['root_uuid'] == baseline['install']['root_uuid'] and meta['boot_uuid'] == baseline['install']['boot_uuid']
    assert system.boot_hashes(checkpoint / 'boot') == baseline['boot']
    assert run('pacman-conf', 'SigLevel') == policy
    assert Path('/etc/pacman.conf').read_text() == system.advance_snapshot(config, lock['candidate']['snapshot'])
    metadata = verify_metadata(lock, folder, fetch=False)
    closure = verify_transaction(before, inventory(), metadata, folder)
    remaining = subprocess.run(['pacman', '-Qu'], capture_output=True, text=True, timeout=30)
    assert remaining.returncode in (0, 1) and not remaining.stdout.strip() and not remaining.stderr.strip(), ('Full upgrade query failed or left pending packages', remaining.stdout, remaining.stderr)
    result = {'seconds': round(time.monotonic() - started, 3), 'update_receipt': receipt,
              'checkpoint': meta, 'checkpoint_sha256': digest(checkpoint / 'checkpoint.json'),
              'signature_policy': policy, 'transaction': closure}
    save(folder / 'transaction.json', result)
    candidate = probe(lock, True, lock['baseline']['kernel'], folder / 'pre-reboot.json')
    validate_transition(baseline, candidate)
    return result


def validate_transition(before, after):
    assert before['installed_kernel'] != after['installed_kernel']
    assert before['boot']['vmlinuz-linux-lts'] != after['boot']['vmlinuz-linux-lts'], 'Kernel bytes did not change'
    assert before['boot']['initramfs-linux-lts.img'] != after['boot']['initramfs-linux-lts.img']
    assert before['runtime'] == after['runtime']
    assert before['system_sha256'] == after['system_sha256']


def process(pid):
    path = Path('/proc') / str(pid)
    fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
    executable = path / 'exe'
    info = executable.stat()
    # A full base update may unlink the running interpreter. The open inode
    # and process must survive; Linux's added " (deleted)" suffix is expected.
    return {'pid': pid, 'starttime': fields[19], 'exe': os.readlink(executable).removesuffix(' (deleted)'),
            'exe_inode': info.st_ino, 'exe_device': info.st_dev, 'exe_sha256': digest(executable)}


def start_agent(window, directory):
    directory.mkdir(parents=True, exist_ok=True)
    pid_file = Path('/tmp') / (window + '.pid')
    assert not pid_file.exists()
    run('hn', 'new-window', '-d', '-n', window,
        'echo $$ > ' + str(pid_file) + '; cd ' + str(directory) + '; exec opencode')
    deadline = time.monotonic() + 45
    pane = ''
    while time.monotonic() < deadline:
        if pid_file.exists():
            value = pid_file.read_text().strip()
            if not value.isdigit():
                time.sleep(.1)
                continue
            pid = int(value)
            comm = Path(f'/proc/{pid}/comm')
            pane = run('hn', 'capture-pane', '-p', '-t', window)
            # These ready controls are present in the retained preview14 pane;
            # a live process or healthy neighboring shell alone is insufficient.
            if comm.exists() and comm.read_text().strip() == 'opencode' and 'Ask anything' in pane and 'ctrl+p commands' in pane:
                before = process(pid)
                time.sleep(.5)
                assert process(pid) == before
                return {'process': before, 'pane': pane, 'window': window,
                        'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text(), 'kernel': run('uname', '-r')}
        time.sleep(.25)
    raise AssertionError('Fresh OpenCode pane did not reach its ready screen: ' + pane)


def live_start():
    assert os.getuid() == 1000 and Path.home() == Path('/home/me')
    PROJECT.mkdir(parents=True, exist_ok=False)
    (PROJECT / 'keep.txt').write_text('before checkpoint\n')
    (PROJECT / 'heartbeat.py').write_text('import os,time\nfrom pathlib import Path\np=Path(__file__).parent\n'
        '(p/"pid").write_text(str(os.getpid()))\nwhile True:\n'
        ' with (p/"heartbeat").open("a") as f: f.write("alive\\n")\n time.sleep(.2)\n')
    run('hn', 'new-window', '-d', '-n', 'kernel-update-survivor', 'python3 ' + str(PROJECT / 'heartbeat.py'))
    deadline = time.monotonic() + 20
    while not (PROJECT / 'heartbeat').exists():
        assert time.monotonic() < deadline, 'Survivor pane did not start'
        time.sleep(.1)
    pids = {'heartbeat': int((PROJECT / 'pid').read_text())}
    agent = start_agent('kernel-update-agent', PROJECT / 'agent')
    pids['opencode'] = agent['process']['pid']
    for name in ('hn-screen', 'harness-daemon'):
        pids[name] = int(run('systemctl', '--user', 'show', '-p', 'MainPID', '--value', name))
        assert pids[name] > 0
    clients = run('hn', 'hn-list-clients', '-F', '#{client_pid} #{session_id}').splitlines()
    assert len(clients) == 1, ('Expected one rendering hn client', clients)
    pids['hn-client'] = int(clients[0].split()[0])
    client = Path('/proc') / str(pids['hn-client'])
    assert (client / 'exe').samefile('/usr/lib/harness/harness-tui')
    assert re.fullmatch(r'/dev/pts/\d+', os.readlink(client / 'fd/0'))
    assert any(line.endswith('/hn-screen.service') for line in (client / 'cgroup').read_text().splitlines())
    return {'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text(),
            'processes': {name: process(pid) for name, pid in pids.items()},
            'client': clients[0], 'agent_pane': agent['pane'],
            'heartbeat_bytes': (PROJECT / 'heartbeat').stat().st_size}


def live_check(before):
    assert Path('/proc/sys/kernel/random/boot_id').read_text() == before['boot_id']
    for row in before['processes'].values():
        assert process(row['pid']) == row, ('Running work was replaced', row)
    assert run('hn', 'hn-list-clients', '-F', '#{client_pid} #{session_id}') == before['client']
    size = (PROJECT / 'heartbeat').stat().st_size
    assert size > before['heartbeat_bytes']
    time.sleep(.5)
    assert (PROJECT / 'heartbeat').stat().st_size > size
    assert (PROJECT / 'keep.txt').read_text() == 'before checkpoint\n'
    return {'original_processes_alive': before, 'heartbeat_bytes': (PROJECT / 'heartbeat').stat().st_size}


def project_edit(transaction):
    assert os.getuid() == 1000
    (PROJECT / 'keep.txt').write_text('edited after checkpoint ' + transaction['checkpoint']['name'] + '\n')
    (PROJECT / 'new.txt').write_text('created after checkpoint\n')
    assert min((PROJECT / name).stat().st_mtime for name in ('keep.txt', 'new.txt')) > datetime.fromisoformat(transaction['checkpoint']['created_at']).timestamp()
    return project_state()


def project_state():
    result = {}
    for name in ('keep.txt', 'new.txt'):
        path = PROJECT / name
        info = path.stat()
        assert info.st_uid == info.st_gid == 1000
        result[name] = {'sha256': digest(path), 'uid': info.st_uid, 'gid': info.st_gid, 'mtime_ns': info.st_mtime_ns}
    return result


def validate_recovery(baseline, restored, transaction, project_before, project_after):
    for name in ('packages', 'boot', 'modules', 'headers_kernel', 'package_kernel_sha256', 'runtime', 'system_sha256', 'pacman_config', 'install'):
        assert baseline[name] == restored[name], ('Recovery identity differs', name)
    assert restored['running_kernel'] == baseline['running_kernel']
    assert restored['boot'] == transaction['checkpoint']['boot_sha256']
    assert project_before == project_after, 'Post-checkpoint project edits changed during recovery'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['install', 'baseline', 'update', 'candidate', 'recovered', 'live-start', 'live-check', 'project-edit', 'project-state', 'fresh-agent'])
    parser.add_argument('--lock', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--candidate-system', type=Path)
    parser.add_argument('--before', type=Path)
    args = parser.parse_args()
    assert run('lsblk', '-ndo', 'SERIAL', '/dev/vda') == 'HN_OS_TEST'
    lock = json.loads(args.lock.read_text())
    validate_lock(lock)
    if args.phase.startswith('live-') or args.phase.startswith('project-') or args.phase == 'fresh-agent':
        assert os.getuid() == 1000 and not Path('/etc/harness-live').exists()
    else:
        assert os.geteuid() == 0
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.phase == 'install':
        result = install(lock, args.candidate_system)
    elif args.phase == 'update':
        result = update(lock, args.output.parent, json.loads(args.before.read_text()))
    elif args.phase == 'live-start':
        result = live_start()
    elif args.phase == 'live-check':
        result = live_check(json.loads(args.before.read_text()))
    elif args.phase == 'project-edit':
        result = project_edit(json.loads(args.before.read_text()))
    elif args.phase == 'project-state':
        result = project_state()
    elif args.phase == 'fresh-agent':
        identity = Path('/proc/sys/kernel/random/boot_id').read_text().strip()[:8]
        result = start_agent('kernel-update-fresh-' + identity, PROJECT / ('agent-' + identity))
    else:
        candidate = args.phase == 'candidate'
        result = probe(lock, candidate, lock['candidate' if candidate else 'baseline']['kernel'], args.output)
    save(args.output, result)
    print('HN_HARDWARE_UPDATE=' + args.phase, flush=True)


if __name__ == '__main__':
    main()
