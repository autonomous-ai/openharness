#!/usr/bin/env python3
"""Private native recovery acceptance on clones of an installed Asahi VM.

Exercises real signed offline RPM installation, deliberate boot damage, and
process interruption after each durable recovery phase across cold VM boots.
It does not rebuild the shared runtime or publish an image. The fixed test disk
layout and public test password are deliberately unsuitable for real hardware.
"""
import argparse
import json
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import time

from arm_boot import digest
from arm_session import fixture_identity
from asahi_encryption_vm import MaintenanceVM, unlock
from asahi_firstboot_vm import ImageVM
from session_vm import put

ROOT = Path(__file__).resolve().parents[2]
GUEST = Path(__file__).with_name('fedora_recovery_guest.py')
CORE = ROOT / 'os/platforms/apple-silicon'
REMOTE = '/var/tmp/harness-recovery-guest.py'
RESULT = '/var/tmp/harness-recovery-result.json'
PHASES = ('evidence', 'candidate', 'boot', 'efi', 'root-moved', 'complete')


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def files():
    helpers = ('fedora_recovery_guest.py', 'fedora_recovery_vm.py', 'asahi_encryption_vm.py',
               'asahi_encryption_guest.py', 'asahi_firstboot_vm.py', 'arm_boot.py',
               'arm_session.py', 'fedora_session_vm.py', 'session_vm.py', 'vm.py')
    paths = [GUEST.with_name(name) for name in helpers]
    paths += [CORE / name for name in ('recovery.py', 'storage.py', 'target.py')]
    # arm_session imports the packaging helper; retain its imported source too.
    paths += sorted((ROOT / 'os/tools').glob('*.py'))
    return {str(path.relative_to(ROOT)): digest(path) for path in paths}


def stage(vm, *, maintenance=False):
    put(vm, REMOTE, GUEST.read_text())
    vm.command('chmod 0600 ' + REMOTE)
    if maintenance:
        vm.command('install -d -m 0700 /var/tmp/harness-recovery-code')
        for name in ('recovery.py', 'storage.py', 'target.py'):
            destination = '/var/tmp/harness-recovery-code/' + name
            put(vm, destination, (CORE / name).read_text())
            vm.command('chmod 0600 ' + shlex.quote(destination))


def phase(vm, name, *, stop=None, maintenance=False):
    command = ('unshare --mount --propagation private ' if maintenance else '')
    command += 'python3 -I ' + REMOTE + ' ' + name
    if stop:
        command += ' --stop ' + stop
    started = time.monotonic()
    output, code = vm.command(command, timeout=600, check=False)
    (vm.folder / 'phase.log').write_text(output)
    raw = vm.read_file(RESULT)
    (vm.folder / 'result.json').write_bytes(raw)
    result = json.loads(raw)
    if stop:
        assert code == 77 and result['status'] == 'interrupted after durable phase', (code, result)
        assert result['phase'] == stop and result['state']['phase'] == stop
    else:
        assert code == 0 and result['status'] == 'passed' and result['phase'] == name, (code, result)
    return {'phase': name, 'stop': stop, 'exit_code': code,
            'seconds': round(time.monotonic() - started, 3), 'result_sha256': digest(vm.folder / 'result.json')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', type=Path, required=True, help='The verified installed-media target, never a host device.')
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--source-receipt', type=Path, required=True)
    parser.add_argument('--source-receipt-sha256', required=True)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--fixture-source', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if (platform.system(), platform.machine()) != ('Darwin', 'arm64'):
        parser.error('Use the native Apple Silicon host observer.')
    if not all(re.fullmatch('[a-f0-9]{64}', value) for value in (args.sha256, args.source_receipt_sha256)):
        parser.error('Supply complete image and producer receipt SHA-256 identities.')
    source = args.image.resolve()
    if (args.image.is_symlink() or not source.is_file() or source.stat().st_size != 24 * 1024**3
            or digest(source) != args.sha256):
        parser.error('Use the regular, verified 24 GiB installed-media fixture.')
    if (args.source_receipt.is_symlink() or not args.source_receipt.is_file()
            or digest(args.source_receipt) != args.source_receipt_sha256):
        parser.error('The producer receipt is missing or changed.')
    producer = json.loads(args.source_receipt.read_text())
    if (producer.get('status') != 'passed' or not producer.get('original_media_unchanged')
            or not producer.get('original_payload_unchanged') or producer.get('installed', {}).get('selinux') != 'Enforcing'):
        parser.error('Use the completed encrypted installer acceptance target.')
    assert subprocess.run(['lsof', str(source)], capture_output=True, timeout=30).returncode == 1
    fixture = fixture_identity(args.fixture, args.fixture_source)
    output = args.output.resolve()
    if shutil.disk_usage(output.parent).free < 7 * 1024**3:
        parser.error('Keep at least 7 GiB free before creating the private clones.')
    output.mkdir(parents=True, exist_ok=False)
    disk, maintenance = output / 'target.raw', output / 'maintenance.raw'
    receipt = {'status': 'running', 'started_at': time.time(), 'source': str(source),
               'source_sha256': args.sha256, 'source_receipt_sha256': args.source_receipt_sha256,
               'producer': {'media_source': producer['media_source'], 'payload': producer['payload']},
               'fixture_source': args.fixture_source, 'fixture_manifest_sha256': digest(args.fixture / 'manifest.json'),
               'files': files(), 'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
               'scope': 'Native ARM 16 KiB encrypted VM; signed hello update; cold recovery of system, boot and EFI with current work',
               'publication': False, 'phases': [], 'shutdowns': [],
               'limitations': ['Not physical Apple hardware acceptance', 'Public fixture password; never publish these disks',
                               'Process interruption at durable boundaries is not arbitrary power-loss or kernel-transaction coverage',
                               'Private maintenance engine; no normal updater integration is enabled']}
    vm = None
    try:
        subprocess.run(['cp', '-c', source, disk], check=True, timeout=60)
        assert disk.stat().st_ino != source.stat().st_ino
        subprocess.run(['zstd', '-d', '--sparse', args.fixture / 'guest.raw.zst', '-o', maintenance], check=True, timeout=120)
        assert maintenance.stat().st_size == fixture['raw_disk']['bytes'] and digest(maintenance) == fixture['raw_disk']['sha256']
        vm = MaintenanceVM(output / '00-maintenance-tools', maintenance, args.fixture / 'Image', disk)
        vm.start()
        log, _ = vm.command('dnf5 install -y --setopt=gpgcheck=True --setopt=install_weak_deps=False cryptsetup btrfs-progs rsync', timeout=240)
        (vm.folder / 'packages.log').write_text(log)
        stage(vm, maintenance=True)
        probe = '''import hashlib,json,os,pathlib,subprocess
tools={name:'/usr/bin/'+name for name in ('btrfs','findmnt','mount','umount','lsblk','rsync','sync')}
tools.update({name:'/usr/sbin/'+name for name in ('blkid','blockdev','cryptsetup','sfdisk')})
result={}
for name,path in tools.items():
 assert os.access(path,os.X_OK),path
 result[name]={'path':path,'resolved':str(pathlib.Path(path).resolve()),'sha256':hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()}
result['packages']=sorted(set(subprocess.check_output(['rpm','-qf',*[str(pathlib.Path(path).resolve()) for path in tools.values()]],text=True).splitlines()))
result['kernel']=subprocess.check_output(['uname','-r'],text=True).strip()
pathlib.Path('/var/tmp/harness-recovery-tools.json').write_text(json.dumps(result,indent=2)+'\\n')
'''
        put(vm, '/var/tmp/harness-recovery-tools.py', probe)
        vm.command('python3 -I /var/tmp/harness-recovery-tools.py')
        (vm.folder / 'tools.json').write_bytes(vm.read_file('/var/tmp/harness-recovery-tools.json'))
        receipt['shutdowns'].append(vm.poweroff())
        vm.close()
        vm = None
        print('Maintenance clone prepared; exact fixed tool paths recorded.', flush=True)

        vm = ImageVM(output / '01-seed', disk, None)
        vm.start()
        unlock(vm)
        vm.authenticate()
        stage(vm)
        receipt['phases'].append(phase(vm, 'seed'))
        receipt['shutdowns'].append(vm.poweroff())
        vm.close()
        vm = None
        print('Committed work seeded; signed package staged and armed without changing installed packages.', flush=True)

        def cold(name, action, stop=None):
            nonlocal vm
            assert files() == receipt['files'], 'Recovery or observer source changed during acceptance.'
            vm = MaintenanceVM(output / name, maintenance, args.fixture / 'Image', disk)
            vm.start(offline=True)
            receipt['phases'].append(phase(vm, action, stop=stop, maintenance=True))
            receipt['shutdowns'].append(vm.poweroff())
            vm.close()
            vm = None
            save(output / 'receipt.json', receipt)
            print(name + ' completed and maintenance shut down cleanly.', flush=True)

        cold('02-checkpoint', 'checkpoint')
        vm = ImageVM(output / '03-offline-apply', disk, None)
        vm.start()
        vm.monitor('set_link', name='hnnet', up=False)
        unlock(vm)
        vm.stop_drain()
        receipt['shutdowns'].append(vm.poweroff(timeout=180, request=False))
        vm.close()
        vm = None
        print('Actual stock offline DNF update completed with networking disconnected.', flush=True)
        cold('04-damage', 'damage')
        for index, stop in enumerate(PHASES, 5):
            cold(f'{index:02d}-interrupt-{stop}', 'recover', stop)
        cold('11-recover-complete', 'recover')

        vm = ImageVM(output / '12-recovered-boot', disk, None)
        vm.start()
        vm.monitor('set_link', name='hnnet', up=False)
        unlock(vm)
        vm.authenticate()
        receipt['phases'].append(phase(vm, 'verify'))
        vm.wait_user('systemctl --user is-active --quiet hn-screen && pgrep -u 1000 -x opencode >/dev/null && test "$(hn list-panes -F "#{pane_id}" | wc -l)" -eq 3')
        vm.frame('recovered-workspace', ['OpenCode', 'Ask anything'], absent=['Bun has crashed', 'panic'])
        receipt['shutdowns'].append(vm.poweroff())
        vm.close()
        vm = None
        receipt['status'] = 'passed'
        print('Recovered RPM/system/boot/EFI; newer project, database, sparse VM data and metadata survived; Harness booted with Enforcing SELinux.', flush=True)
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
        if vm:
            if vm.shell_ready:
                try:
                    (vm.folder / 'failure-result.json').write_bytes(vm.read_file(RESULT, timeout=20))
                except Exception as diagnostic:
                    receipt['result_collection_error'] = str(diagnostic)
            try:
                vm.screenshot('failure')
                if vm.shell_ready:
                    output_text, _ = vm.command('journalctl -b --no-pager -n 80; findmnt; systemctl --failed --no-pager', check=False, timeout=30)
                    (vm.folder / 'failure.txt').write_text(output_text)
            except Exception as diagnostic:
                receipt['diagnostic_error'] = str(diagnostic)
        raise
    finally:
        try:
            if vm:
                vm.close()
        finally:
            receipt.update(finished_at=time.time(), source_unchanged=digest(source) == args.sha256,
                           observer_unchanged=files() == receipt['files'])
            if not receipt['source_unchanged'] or not receipt['observer_unchanged']:
                receipt.update(status='failed', identity_error='The immutable source or observer changed during acceptance.')
            save(output / 'receipt.json', receipt)
    if receipt['status'] != 'passed':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
