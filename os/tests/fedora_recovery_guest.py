#!/usr/bin/env python3
"""VM-only recovery fixture: real RPM state and newer work across cold recovery."""
import argparse
import base64
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import sqlite3
import stat
import subprocess
import sys
import tomllib
import traceback

DISK = '/dev/vdb'
ESP_UUID = 'e51d26b0-4c8f-41fb-9d83-a0fdd62327c0'
ESP = Path('/mnt/harness-recovery-esp')
VIEW = Path('/mnt/harness-recovery-view')
BOOT = Path('/mnt/harness-recovery-boot')
MAPPER = '/dev/mapper/harness-recovery-native'
PLAN = ESP / 'asahi/harness-install/target.json'
GENERATION = 'fa' * 16
OUT = Path('/var/tmp/harness-recovery-native')
WORK = Path('/var/lib/harness-recovery-native')
PROJECT = Path('/home/me/projects/recovery-proof')
CONFIG = Path('/etc/harness-recovery-native')
RESULT = Path('/var/tmp/harness-recovery-result.json')
CODE = Path('/var/tmp/harness-recovery-code')
PASSWORD = 'firstboot-local-42'  # Public fixture password; never publish test disks.
STATE = Path('/usr/lib/sysimage/libdnf5/offline')
DEST = Path('/var/lib/dnf/offline')
MUTABLE_BOOT = {'grub2/grubenv', 'efi/loader/random-seed'}
EVIDENCE = {}
QF = '%{NAME}\t%{EPOCH}\t%{VERSION}\t%{RELEASE}\t%{ARCH}\n'


def run(*args, input=None, timeout=90, check=True):
    result = subprocess.run(list(map(str, args)), input=input, text=True,
                            capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f'{args[0]} failed ({result.returncode}): {result.stderr[-1500:]}')
    return result.stdout.strip() if check else {
        'code': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def save(path, value):
    with path.open('w') as stream:
        stream.write(json.dumps(value, indent=2) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def empty(path):
    return not os.path.lexists(path) or (path.is_dir() and not path.is_symlink() and not any(path.iterdir()))


def rooted(root, path):
    return root / str(path).lstrip('/')


def inventory():
    return sorted(run('/usr/bin/rpm', '-qa', '--qf', QF).splitlines())


def operations(packages, repo_key):
    def nevra(value):
        nvr, arch = value.rsplit('.', 1)
        name, version, release = nvr.rsplit('-', 2)
        epoch, version = version.split(':', 1) if ':' in version else ('0', version)
        assert epoch.isdecimal() and all((name, version, release, arch))
        return name, int(epoch), version, release, arch
    return sorted((nevra(p['nevra']), p['action'], p['reason'], p[repo_key]) for p in packages)


def history(root, *args):
    # Execute only maintenance DNF, never target programs/plugins. Its documented
    # installroot behavior reads the target history; logs remain in maintenance.
    return json.loads(run('/usr/bin/dnf5', '--installroot=' + str(root), '--use-host-config',
                          '--no-plugins', '--releasever=44', '--disable-repo=*',
                          '--setopt=logdir=/var/tmp/harness-recovery-dnf', 'history', *args, '--json'))


def tree(root, *, sparse=False, ignore=()):
    """Observe bytes, link targets, owners, ACLs and raw xattrs, without mtime noise."""
    entries, inodes = {}, {}
    for parent, directories, files in os.walk(root, followlinks=False):
        for name in sorted(directories + files):
            path = Path(parent) / name
            relative = path.relative_to(root).as_posix()
            if relative in ignore:
                continue
            info = path.lstat()
            value = {'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid,
                     'xattrs': {key: base64.b64encode(os.getxattr(path, key, follow_symlinks=False)).decode()
                               for key in sorted(os.listxattr(path, follow_symlinks=False))}}
            if stat.S_ISREG(info.st_mode):
                value.update(kind='file', size=info.st_size, sha256=digest(path))
                if sparse:
                    value['blocks'] = info.st_blocks
                inodes.setdefault((info.st_dev, info.st_ino), []).append(relative)
            elif stat.S_ISLNK(info.st_mode):
                value.update(kind='link', target=os.readlink(path))
            elif stat.S_ISDIR(info.st_mode):
                value['kind'] = 'directory'
            else:
                raise AssertionError('Unexpected special fixture file: ' + str(path))
            entries[relative] = value
    return {'entries': entries, 'hardlinks': sorted(sorted(paths) for paths in inodes.values() if len(paths) > 1)}


def work(root=Path('/')):
    return {'project': tree(rooted(root, PROJECT)), 'var': tree(rooted(root, WORK), sparse=True)}


def boot_tree():
    return tree(Path('/boot'), ignore=MUTABLE_BOOT)


def installed_guard():
    assert os.geteuid() == 0 and run('uname', '-m') == 'aarch64'
    assert run('getconf', 'PAGESIZE') == '16384'
    # The virtio ID field exposes the first 20 bytes of ImageVM's serial.
    assert run('lsblk', '-ndo', 'SERIAL', '/dev/vda') == 'HARNESS_ASAHI_FIRSTB'
    assert run('findmnt', '-no', 'SOURCE', '/') == '/dev/mapper/harness-root[/root]'
    assert run('getenforce') == 'Enforcing'
    assert run('systemctl', '--failed', '--no-pager', '--no-legend') == ''
    assert run('rpm', '-V', 'harness-os-session') == ''


def seed():
    installed_guard()
    assert not os.path.lexists('/system-update')
    assert not STATE.exists() or not any(STATE.iterdir())
    for path in (OUT, WORK, PROJECT):
        path.mkdir(parents=True, exist_ok=False)
    user = pwd.getpwnam('me')
    os.chown(PROJECT, user.pw_uid, user.pw_gid)
    (PROJECT / 'notes.txt').write_text('Work before checkpoint.\n')
    os.chown(PROJECT / 'notes.txt', user.pw_uid, user.pw_gid)
    volume = WORK / 'volume.txt'
    volume.write_text('Container volume before checkpoint.\n')
    os.link(volume, WORK / 'volume-link.txt')
    os.setxattr(volume, 'user.harness-proof', b'before-checkpoint')
    run('setfacl', '-m', f'u:{user.pw_uid}:rw', volume)
    disk = WORK / 'virtual-disk.img'
    with disk.open('xb') as stream:
        stream.truncate(64 * 1024**2)
        stream.seek(1024**2)
        stream.write(b'Before checkpoint')
    assert disk.stat().st_blocks * 512 < disk.stat().st_size // 8
    with sqlite3.connect(WORK / 'data.sqlite') as database:
        database.execute('CREATE TABLE work (id INTEGER PRIMARY KEY, note TEXT NOT NULL)')
        database.execute('INSERT INTO work(note) VALUES (?)', ('before checkpoint',))
    CONFIG.write_text('System before checkpoint.\n')
    run('restorecon', '-RF', OUT, WORK, PROJECT, CONFIG)
    # Keep a deliberately explicit MCS range, not merely the policy default.
    run('chcon', '-l', 's0:c7,c9', disk)
    assert b':s0:c7,c9' in os.getxattr(disk, 'security.selinux')
    baseline = {'packages': inventory(), 'boot': boot_tree(), 'work': work(),
                'history': json.loads(run('dnf5', 'history', 'list', '--json')),
                'config': CONFIG.read_text(), 'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    assert run('rpm', '-q', 'hello', check=False)['code'] == 1
    baseline['prepare'] = run('dnf5', '-y', '--setopt=gpgcheck=True', '--setopt=install_weak_deps=False',
                              'install', '--offline', 'hello', timeout=240)
    assert inventory() == baseline['packages'] and boot_tree() == baseline['boot']
    assert json.loads(run('dnf5', 'history', 'list', '--json')) == baseline['history']
    transaction = json.loads((STATE / 'transaction.json').read_text())
    assert len(transaction['rpms']) == 1 and transaction['rpms'][0]['action'] == 'Install'
    package = Path(transaction['rpms'][0]['package_path'])
    assert package.parent == DEST / 'packages' and package.is_file() and not package.is_symlink()
    assert run('rpm', '-qp', '--qf', '%{NAME}', package) == 'hello'
    baseline['signature'] = run('rpmkeys', '--checksig', package)
    baseline['package'] = {'sha256': digest(package), 'identity': run('rpm', '-qp', '--qf', QF, package)}
    run('env', 'DNF_SYSTEM_UPGRADE_NO_REBOOT=1', 'dnf5', '--assumeyes', 'offline', 'reboot', '--poweroff')
    assert Path('/system-update').is_symlink() and os.readlink('/system-update') == str(STATE)
    baseline['prepared_state'] = {p.name: p.read_text() for p in STATE.iterdir() if p.is_file()}
    save(OUT / 'baseline.json', baseline)
    save(RESULT, {'status': 'passed', 'phase': 'seed', 'baseline': baseline,
                  'pending_transaction': 'signed hello; armed before cold checkpoint'})


def module():
    spec = importlib.util.spec_from_file_location('harness_recovery', CODE / 'recovery.py')
    value = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = value
    spec.loader.exec_module(value)
    return value


def maintenance_guard():
    assert os.geteuid() == 0 and run('uname', '-m') == 'aarch64'
    assert run('getconf', 'PAGESIZE') == '16384'
    assert run('findmnt', '-no', 'SOURCE', '/') == '/dev/vda'
    assert run('lsblk', '-ndo', 'SERIAL', DISK) == 'HARNESS_ENCRYPT_TEST'
    assert run('blockdev', '--getss', DISK) == '4096'
    assert run('blockdev', '--getsize64', DISK) == str(24 * 1024**3)
    assert os.readlink('/proc/self/ns/mnt') != os.readlink('/proc/1/ns/mnt')
    assert run('findmnt', '-nro', 'PROPAGATION', '/') == 'private'
    assert run('getenforce') == 'Disabled'  # Preserve stored raw target labels without policy translation.
    assert run('blkid', '-s', 'PARTUUID', '-o', 'value', DISK + '2') == ESP_UUID
    assert not os.path.exists(MAPPER)
    for path in (ESP, VIEW, BOOT):
        path.mkdir(exist_ok=True)


@contextlib.contextmanager
def target_open():
    maintenance_guard()
    run('mount', '-t', 'vfat', '-o', 'rw,noatime,uid=0,gid=0,fmask=0177,dmask=0077', DISK + '2', ESP)
    opened = False
    try:
        plan = json.loads(PLAN.read_text())
        additions = plan['additions']
        roots = [p for p in additions if p['name'] == 'Harness root']
        boots = [p for p in additions if p['name'] == 'Harness boot']
        assert len(roots) == len(boots) == 1
        root_device = '/dev/disk/by-partuuid/' + roots[0]['uuid']
        boot_device = '/dev/disk/by-partuuid/' + boots[0]['uuid']
        assert run('lsblk', '-ndo', 'PKNAME', Path(root_device).resolve()) == Path(DISK).name
        assert run('lsblk', '-ndo', 'PKNAME', Path(boot_device).resolve()) == Path(DISK).name
        run('cryptsetup', 'open', '--key-file', '-', root_device, Path(MAPPER).name, input=PASSWORD)
        opened = True
        yield boot_device
    finally:
        try:
            if opened:
                run('cryptsetup', 'close', Path(MAPPER).name)
        finally:
            run('umount', ESP)


@contextlib.contextmanager
def view(boot_device=None):
    run('mount', '-t', 'btrfs', '-o', 'rw,noatime,subvolid=5', MAPPER, VIEW)
    boot_mounted = False
    try:
        if boot_device:
            run('mount', '-t', 'ext4', '-o', 'rw,noatime', boot_device, BOOT)
            boot_mounted = True
        yield VIEW / 'root'
    finally:
        try:
            if boot_mounted:
                run('umount', BOOT)
        finally:
            run('umount', VIEW)


def protected():
    return {'partitions': {str(n): digest(DISK + str(n)) for n in (1, 3, 4)},
            'firmware': {name: digest(ESP / name) for name in ('vendorfw/fixture.bin', 'asahi/stub_info.json')},
            'esp_uuid': run('blkid', '-s', 'UUID', '-o', 'value', DISK + '2')}


def checkpoint():
    with target_open():
        before = protected()
        recovery = module()
        # Only the absent Apple firmware handoff is substituted, after strict VM/device guards.
        recovery.target.platform_esp = lambda: ESP_UUID
        with recovery.installation(PLAN, MAPPER) as engine:
            result = engine.checkpoint(GENERATION)
        assert protected() == before
        with view() as root:
            folder = VIEW / '.harness-recovery' / GENERATION
            manifest = json.loads((folder / 'checkpoint.json').read_text())
            assert manifest['phase'] == 'complete'
            save(rooted(root, OUT) / 'protected.json', before)
        save(RESULT, {'status': 'passed', 'phase': 'checkpoint', 'manifest': manifest, 'result': result,
                      'protected_unchanged': True})


def damage():
    with target_open() as boot_device:
        before = protected()
        with view(boot_device) as root:
            out = rooted(root, OUT)
            baseline = json.loads((out / 'baseline.json').read_text())
            assert run('rpm', '--root', root, '-q', '--qf', QF, 'hello') == baseline['package']['identity']
            assert sorted(run('rpm', '--root', root, '-qa', '--qf', QF).splitlines()) == sorted(
                baseline['packages'] + [baseline['package']['identity']])
            rows = history(root, 'list')
            old_ids = {row['id'] for row in baseline['history']}
            added = [row for row in rows if row['id'] not in old_ids]
            EVIDENCE['history_list'] = rows
            assert len(added) == 1
            details = history(root, 'info', str(added[0]['id']))
            EVIDENCE['history_info'] = details
            saved = tomllib.loads(baseline['prepared_state']['offline-transaction-state.toml'])['offline-transaction-state']
            transaction = json.loads(baseline['prepared_state']['transaction.json'])
            assert len(details) == 1 and details[0]['id'] == added[0]['id'] and details[0]['status'] == 'Ok'
            assert details[0]['description'] == saved['cmd_line'] and details[0]['releasever'] == '44'
            assert details[0]['rpmdb_version_begin'] == saved['rpmdb_cookie']
            assert details[0]['groups'] == [] and details[0]['environments'] == []
            assert details[0]['end_time'] >= details[0]['start_time'] > 0
            assert operations(details[0]['packages'], 'repository') == operations(transaction['rpms'], 'repo_id')
            journal = run('journalctl', '--directory', rooted(root, Path('/var/log/journal')),
                          '--no-pager', '--all', '-o', 'json', '-u', 'dnf5-offline-transaction.service',
                          '-u', 'dnf5-offline-transaction-cleanup.service')
            events = [json.loads(line) for line in journal.splitlines()]
            EVIDENCE['dnf_events'] = events
            started = [event for event in events if event.get('MESSAGE_ID') == '3e0a5636d16b4ca4bbe5321d06c6aa62']
            finished = [event for event in events if event.get('MESSAGE_ID') == '8cec00a1566f4d3594f116450395f06c']
            assert len(started) == len(finished) == 1
            applied_boot = finished[0]['_BOOT_ID']
            applied = [event for event in events if event.get('_BOOT_ID') == applied_boot]
            assert started[0]['_BOOT_ID'] == applied_boot != baseline['boot_id'].replace('-', '')
            assert started[0]['_SYSTEMD_UNIT'] == finished[0]['_SYSTEMD_UNIT'] == 'dnf5-offline-transaction.service'
            assert started[0]['_SYSTEMD_INVOCATION_ID'] == finished[0]['_SYSTEMD_INVOCATION_ID']
            assert int(started[0]['__MONOTONIC_TIMESTAMP']) < int(finished[0]['__MONOTONIC_TIMESTAMP'])
            def manager(event):
                return (event.get('_PID') == '1' and event.get('UNIT') == 'dnf5-offline-transaction.service'
                        and event.get('_BOOT_ID') == applied_boot
                        and event.get('INVOCATION_ID') == started[0]['_SYSTEMD_INVOCATION_ID'])
            completed = [event for event in applied if manager(event)
                         and event.get('MESSAGE_ID') == '39f53479d3a045ac8e11786248231fbf'
                         and event.get('JOB_TYPE') == 'start' and event.get('JOB_RESULT') == 'done']
            deactivated = [event for event in applied if manager(event)
                           and event.get('MESSAGE_ID') == '7ad2d189f7e94e70a38c781354912448']
            stopped = [event for event in applied if manager(event)
                       and event.get('MESSAGE_ID') == '9d1aaa27d60140bd96365438aad20286'
                       and event.get('JOB_TYPE') == 'stop' and event.get('JOB_RESULT') == 'done']
            finish_time = int(finished[0]['__MONOTONIC_TIMESTAMP'])
            if completed:
                assert len(completed) == 1 and int(completed[0]['__MONOTONIC_TIMESTAMP']) >= finish_time
            else:
                assert len(deactivated) == len(stopped) == 1
                assert finish_time <= int(deactivated[0]['__MONOTONIC_TIMESTAMP']) <= int(stopped[0]['__MONOTONIC_TIMESTAMP'])
            assert not any(event.get('MESSAGE_ID') in ('be02cf6855d2428ba40df7e9d022f03d', 'd9b373ed55a64feb8242e02dbe79a49c')
                           or ('JOB_RESULT' in event and event['JOB_RESULT'] != 'done')
                           or ('UNIT_RESULT' in event and event['UNIT_RESULT'] != 'success')
                           or (event.get('MESSAGE_ID') == '98e322203f7a4ed290d09fe03c09fe15'
                               and (event.get('EXIT_CODE') != 'exited' or event.get('EXIT_STATUS') != '0'))
                           or event.get('UNIT') == 'dnf5-offline-transaction-cleanup.service'
                           or event.get('_SYSTEMD_UNIT') == 'dnf5-offline-transaction-cleanup.service'
                           for event in applied)
            save(out / 'applied.json', applied)
            work_root = rooted(root, WORK)
            project = VIEW / 'home/me/projects/recovery-proof'
            # /home is a separate subvolume, deliberately never copied by root recovery.
            assert project.is_dir()
            (project / 'notes.txt').write_text('New project work after checkpoint.\n')
            newer = project / 'new.txt'
            newer.write_text('Created after checkpoint.\n')
            owner = (project / 'notes.txt').stat()
            os.chown(newer, owner.st_uid, owner.st_gid)
            for key in os.listxattr(project / 'notes.txt'):
                os.setxattr(newer, key, os.getxattr(project / 'notes.txt', key))
            (work_root / 'volume.txt').write_text('New container-volume work after checkpoint.\n')
            os.setxattr(work_root / 'volume.txt', 'user.harness-proof', b'after-checkpoint')
            with (work_root / 'virtual-disk.img').open('r+b') as stream:
                stream.seek(2 * 1024**2)
                stream.write(b'New virtual-machine work after checkpoint')
            with sqlite3.connect(work_root / 'data.sqlite') as database:
                database.execute('INSERT INTO work(note) VALUES (?)', ('after checkpoint',))
            rooted(root, CONFIG).write_text('Changed system after checkpoint.\n')
            # Deliberately make the installed boot path unusable; maintenance remains independent.
            (BOOT / 'grub2/grub.cfg').write_text('Harness recovery fixture: damaged GRUB configuration\n')
            loader = ESP / 'EFI/BOOT/BOOTAA64.EFI'
            assert loader.is_file() and loader.stat().st_size > 100
            loader.write_bytes(b'Harness recovery fixture: damaged EFI loader\n')
            latest = {'project': tree(project), 'var': tree(work_root, sparse=True)}
            assert latest['project'] != baseline['work']['project'] and latest['var'] != baseline['work']['var']
            save(out / 'latest-work.json', latest)
            save(out / 'damaged.json', {'grub': digest(BOOT / 'grub2/grub.cfg'), 'efi': digest(loader),
                                      'config': rooted(root, CONFIG).read_text()})
        assert protected() == before
        save(RESULT, {'status': 'passed', 'phase': 'damage', 'latest_work': latest,
                      'protected_unchanged': True, 'actual_package_installed': 'hello',
                      'actual_offline_boot': applied_boot, 'dnf_events': applied, 'history': details})


def recover(stop=None):
    with target_open():
        before = protected()
        recovery = module()
        recovery.target.platform_esp = lambda: ESP_UUID
        advance = recovery.Engine.advance
        def interrupt(self, folder, state, phase):
            result = advance(self, folder, state, phase)
            if phase == stop:
                save(RESULT, {'status': 'interrupted after durable phase', 'phase': phase, 'state': state})
                os._exit(77)
            return result
        recovery.Engine.advance = interrupt
        with recovery.installation(PLAN, MAPPER) as engine:
            result = engine.recover(GENERATION)
        assert stop is None, 'Requested recovery interruption was not exercised: ' + str(stop)
        assert protected() == before
        with view() as root:
            folder = VIEW / '.harness-recovery' / GENERATION
            receipt = json.loads((folder / 'recovery.json').read_text())
            assert receipt['phase'] == 'complete'
            assert (folder / 'failed-root').is_dir() and (folder / 'replaced-root').is_dir()
            out = rooted(root, OUT)
            damaged = json.loads((out / 'damaged.json').read_text())
            assert digest(folder / 'failed-boot/grub2/grub.cfg') == damaged['grub']
            assert digest(folder / 'failed-efi/EFI/BOOT/BOOTAA64.EFI') == damaged['efi']
            assert rooted(folder / 'failed-root', CONFIG).read_text() == damaged['config']
            assert not os.path.lexists(rooted(root, Path('/system-update')))
            assert empty(rooted(root, STATE)) and empty(rooted(root, DEST))
            assert protected() == json.loads((out / 'protected.json').read_text())
        save(RESULT, {'status': 'passed', 'phase': 'recover', 'receipt': receipt, 'result': result,
                      'protected_unchanged': True, 'failed_generation_readable': True})


def verify():
    installed_guard()
    baseline = json.loads((OUT / 'baseline.json').read_text())
    latest = json.loads((OUT / 'latest-work.json').read_text())
    assert inventory() == baseline['packages']
    assert run('rpm', '-q', 'hello', check=False)['code'] == 1
    assert json.loads(run('dnf5', 'history', 'list', '--json')) == baseline['history']
    assert boot_tree() == baseline['boot']
    assert CONFIG.read_text() == baseline['config']
    assert work() == latest
    assert not os.path.lexists('/system-update')
    assert empty(STATE) and empty(DEST)
    with sqlite3.connect('file:' + str(WORK / 'data.sqlite') + '?mode=ro', uri=True) as database:
        assert database.execute('PRAGMA integrity_check').fetchone() == ('ok',)
        rows = database.execute('SELECT note FROM work ORDER BY id').fetchall()
        assert rows == [('before checkpoint',), ('after checkpoint',)]
    assert run('runuser', '-u', 'me', '--', 'env', 'XDG_RUNTIME_DIR=/run/user/1000',
               'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
               'systemctl', '--user', 'is-active', 'hn-screen') == 'active'
    save(RESULT, {'status': 'passed', 'phase': 'verify', 'selinux': 'Enforcing',
                  'packages_restored': True, 'boot_and_efi_restored': True, 'work_preserved': True,
                  'database_rows': rows, 'raw_metadata_preserved': True, 'screen': 'active',
                  'stale_transaction_absent': True})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['seed', 'checkpoint', 'damage', 'recover', 'verify'])
    parser.add_argument('--stop', choices=['evidence', 'candidate', 'boot', 'efi', 'root-moved', 'complete'])
    args = parser.parse_args()
    RESULT.unlink(missing_ok=True)
    try:
        if args.phase == 'recover':
            recover(args.stop)
        else:
            assert args.stop is None
            globals()[args.phase]()
    except BaseException as error:
        save(RESULT, {'status': 'failed', 'phase': args.phase, 'stop': args.stop,
                      'error': str(error), 'traceback': traceback.format_exc(), 'observed': EVIDENCE})
        raise


if __name__ == '__main__':
    main()
