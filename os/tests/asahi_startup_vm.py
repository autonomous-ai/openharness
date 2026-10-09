#!/usr/bin/env python3
"""Fresh encrypted install -> account -> UEFI unlock -> Harness -> second boot."""
import argparse
from vm_artifacts import discard_passed_disks
import json
from pathlib import Path
import platform
import re
import subprocess
import time

from arm_boot import digest
from arm_session import fixture_identity
from asahi_encryption_vm import MaintenanceVM, unlock
from asahi_firstboot_vm import ImageVM, evidence
from asahi_target_vm import guest as target_guest
from session_vm import put

ROOT = Path(__file__).resolve().parents[1]


def enroll(vm, action, image_hash, source):
    for name in ('startup.py', 'storage.py', 'target.py'):
        put(vm, '/var/tmp/' + name, (ROOT / 'platforms/apple-silicon' / name).read_text())
    put(vm, '/var/tmp/harness-target-guest.py', Path(__file__).with_name('asahi_target_guest.py').read_text())
    put(vm, '/var/tmp/harness-startup-guest.py', Path(__file__).with_name('asahi_startup_guest.py').read_text())
    put(vm, '/var/tmp/harness-startup-input.json', json.dumps({'image_sha256': image_hash, 'source_commit': source}))
    output, code = vm.command('unshare --mount --propagation private python3 /var/tmp/harness-startup-guest.py ' + action,
                              timeout=600, check=False)
    expected = {'prepare': 78, 'account': 79, 'finish': 0}[action]
    if code != expected:
        raise RuntimeError(f'{action} exited {code}, expected {expected}: {output[-7000:]}')
    if code:
        return {'exit_code': code, 'phase': action}
    raw = vm.read_file('/var/tmp/harness-startup-result.json')
    (vm.folder / 'result.json').write_bytes(raw)
    return json.loads(raw)


def installed(vm):
    script = '''import json,pathlib,subprocess
def run(*args): return subprocess.check_output(args,text=True).strip()
assert run('getenforce')=='Enforcing'
assert run('getconf','PAGESIZE')=='16384'
assert run('findmnt','-no','SOURCE','/')=='/dev/mapper/harness-root[/root]'
assert run('findmnt','-no','SOURCE','/home')=='/dev/mapper/harness-root[/home]'
assert '/dev/vda6' in run('cryptsetup','status','harness-root')
assert run('findmnt','-no','SOURCE','/boot')=='/dev/vda5'
assert run('findmnt','-no','SOURCE','/boot/efi')=='/dev/vda2'
assert run('systemctl','--failed','--no-pager','--no-legend')==''
boot_labels=['/boot/grub2/grub.cfg',*[str(p) for p in pathlib.Path('/boot/loader/entries').glob('*.conf')]]
assert len(boot_labels)>1
subprocess.run(['matchpathcon','-V','/etc/passwd','/etc/shadow','/etc/group','/etc/gshadow',
 '/etc/greetd/harness.toml','/home','/home/me',*boot_labels],check=True)
record={'kernel':run('uname','-r'),'root':run('findmnt','-no','SOURCE','/'),
 'selinux':run('getenforce'),'boot_labels_verified':boot_labels,'failed_units':[],
 'journal':run('journalctl','-b','--no-pager','-o','cat','-u','systemd-cryptsetup@harness\\\\x2droot.service')}
pathlib.Path('/tmp/harness-startup-installed.json').write_text(json.dumps(record,indent=2)+'\\n')
'''
    put(vm, '/tmp/harness-startup-installed.py', script)
    vm.command('python3 /tmp/harness-startup-installed.py')
    raw = vm.read_file('/tmp/harness-startup-installed.json')
    (vm.folder / 'installed.json').write_bytes(raw)
    return json.loads(raw)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('fixture', 'image', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    for name in ('fixture-source', 'image-source', 'sha256'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    if (platform.system(), platform.machine()) != ('Darwin', 'arm64'):
        parser.error('Use the native Apple Silicon observer.')
    if not re.fullmatch('[a-f0-9]{40}', args.image_source) or not re.fullmatch('[a-f0-9]{64}', args.sha256):
        parser.error('Use full immutable image and source identities.')
    source = args.image.resolve()
    if args.image.is_symlink() or not source.is_file() or digest(source) != args.sha256:
        parser.error('Use the verified regular source image.')
    info = fixture_identity(args.fixture, args.fixture_source)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    maintenance, disk = output / 'maintenance.raw', output / 'target.raw'
    with disk.open('xb') as handle:
        handle.truncate(24 * 1024**3)
    subprocess.run(['zstd', '-d', '--sparse', args.fixture / 'guest.raw.zst', '-o', maintenance], check=True, timeout=120)
    assert digest(maintenance) == info['raw_disk']['sha256']
    paths = [ROOT / 'platforms/apple-silicon' / name for name in ('target.py', 'storage.py', 'startup.py')]
    paths += [Path(__file__).with_name(name) for name in ('asahi_startup_vm.py', 'asahi_startup_guest.py',
        'asahi_target_vm.py', 'asahi_target_guest.py', 'asahi_encryption_vm.py', 'asahi_encryption_guest.py',
        'asahi_firstboot_vm.py', 'arm_boot.py', 'arm_session.py', 'fedora_session_vm.py', 'session_vm.py', 'vm.py')]
    receipt = {'status': 'running', 'started_at': time.time(), 'publication': False,
        'image_sha256': args.sha256, 'image_source': args.image_source, 'fixture_source': args.fixture_source,
        'fixture_sha256': digest(args.fixture / 'manifest.json'),
        'inputs': {str(p.relative_to(ROOT)): digest(p) for p in paths}, 'shutdowns': [],
        'limitations': ['QEMU UEFI, not Apple firmware/m1n1 handoff or physical hardware acceptance.',
                        'Known public password; never publish this installed test disk.',
                        'Observer adds its serial/graphical console and virtio input driver.',
                        'Existing protected macOS/recovery partitions contain sentinel data.']}
    vm = None
    try:
        vm = MaintenanceVM(output / 'prepare', maintenance, args.fixture / 'Image', disk, source=source)
        vm.start()
        vm.command('dnf5 install -y --setopt=install_weak_deps=False --setopt=gpgcheck=True gdisk dosfstools cryptsetup btrfs-progs e2fsprogs rsync', timeout=180)
        receipt['initialize'] = target_guest(vm, 'initialize', output)
        receipt['boot_interruption'] = enroll(vm, 'prepare', args.sha256, args.image_source)
        receipt['shutdowns'].append(vm.poweroff())
        vm.close()
        vm = MaintenanceVM(output / 'account', maintenance, args.fixture / 'Image', disk, source=source)
        vm.start(offline=True)
        receipt['account_interruption'] = enroll(vm, 'account', args.sha256, args.image_source)
        receipt['shutdowns'].append(vm.poweroff())
        vm.close()
        vm = MaintenanceVM(output / 'finish', maintenance, args.fixture / 'Image', disk, source=source)
        vm.start(offline=True)
        receipt['enrollment'] = enroll(vm, 'finish', args.sha256, args.image_source)
        receipt['shutdowns'].append(vm.poweroff())
        vm.close()
        print('Encrypted copy, boot/account enrollment and offline interrupted resumes passed.', flush=True)
        vm = ImageVM(output / 'first-boot', disk, None)
        vm.start()
        unlock(vm, reject_wrong=True)
        vm.frame('04-workspace', ['opencode', 'Ask anything'], seconds=150, absent=['Set your password', 'panic'])
        vm.authenticate()
        receipt['first_boot'] = installed(vm)
        assert 'Failed to activate with specified passphrase.' in receipt['first_boot']['journal']
        first_account = evidence(vm, vm.folder)
        vm.wait_user('pgrep -u 1000 -x opencode >/dev/null && test "$(hn list-panes -F "#{pane_id}" | wc -l)" -eq 3')
        vm.user('mkdir -p ~/projects/startup-check && printf %s preserved > ~/projects/startup-check/result.txt')
        assert vm.read_file('/home/me/projects/startup-check/result.txt') == b'preserved'
        receipt['shutdowns'].append(vm.poweroff())
        vm.close()
        vm = ImageVM(output / 'second-boot', disk, None)
        vm.start()
        unlock(vm)
        # Observe the real terminal before sending hn commands. The CLI can
        # start a headless server itself; probing it before hn-screen starts
        # changes the startup under test instead of observing restored panes.
        vm.frame('04-restored-workspace', 'me@harness', seconds=90)
        vm.authenticate()
        vm.wait_user('systemctl --user is-active --quiet hn-screen')
        receipt['second_boot'] = installed(vm)
        assert evidence(vm, vm.folder) == first_account
        assert vm.read_file('/home/me/projects/startup-check/result.txt') == b'preserved'
        vm.wait_user('test "$(hn list-panes -F "#{pane_id}" | wc -l)" -eq 3')
        receipt['same_account_and_project'] = True
        receipt['shutdowns'].append(vm.poweroff())
        receipt['status'] = 'passed'
        print('Fresh installed root unlocks straight into Harness and survives a second boot.', flush=True)
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
        if vm:
            try:
                vm.screenshot('failure')
                if vm.shell_ready:
                    logs, _ = vm.command('journalctl -b --no-pager -n 100 _UID=1000; '
                                         'systemctl --failed --no-pager', check=False, timeout=30)
                    (vm.folder / 'diagnosis.txt').write_text(logs)
            except Exception as diagnostic:
                receipt['diagnostic_error'] = str(diagnostic)
        raise
    finally:
        try:
            if vm:
                vm.close()
        except BaseException as error:
            receipt.update(status='failed', cleanup_error=str(error))
            raise
        finally:
            receipt.update(finished_at=time.time(), original_source_unchanged=digest(source) == args.sha256)
            if not receipt['original_source_unchanged']:
                receipt.update(status='failed', error='The source image changed.')
            (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
            discard_passed_disks(output, receipt, maintenance, disk)
    if receipt['status'] != 'passed':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
