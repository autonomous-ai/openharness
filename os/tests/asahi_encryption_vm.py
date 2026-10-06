#!/usr/bin/env python3
"""Private encrypted-root acceptance on a disposable produced Asahi image.

The maintenance VM sees only regular cloned image files. This does not install
on a Mac, publish a password-bearing image, or claim physical keyboard support.
"""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import re
import shlex
import subprocess
import time

from arm_boot import digest
from arm_session import SessionVM, fixture_identity
from asahi_firstboot_vm import ImageVM, PASSWORD, evidence, setup_screen, type_line
from asahi_encryption_guest import PROJECT, PROJECT_TEXT
from session_vm import put


class MaintenanceVM(SessionVM):
    def __init__(self, folder, disk, kernel, target):
        super().__init__(folder, disk, kernel)
        if not target.is_file() or target.is_symlink():
            raise ValueError('The encryption target must be a cloned regular file.')
        self.target = target

    def start(self, offline=False):
        self.started = time.monotonic()
        args = ['qemu-system-aarch64', '-machine', 'virt,gic-version=3', '-accel', 'hvf',
                '-cpu', 'host', '-smp', '2', '-m', '3072', '-nodefaults', '-display', 'none', '-no-reboot',
                '-kernel', str(self.kernel), '-append', 'root=/dev/vda rw console=tty0 console=ttyAMA0 loglevel=3 panic=1',
                '-drive', f'file={self.disk},format=raw,if=none,id=root',
                '-device', 'virtio-blk-pci,drive=root,serial=HARNESS_ARM_TEST',
                '-drive', f'file={self.target},format=raw,if=none,id=target',
                '-device', 'virtio-blk-pci,drive=target,serial=HARNESS_ENCRYPT_TEST,logical_block_size=4096,physical_block_size=4096',
                '-device', 'virtio-gpu-pci', '-device', 'virtio-keyboard-pci', '-device', 'virtio-tablet-pci',
                '-netdev', 'user,id=net', '-device', 'virtio-net-pci,netdev=net,id=hnnet,romfile=',
                '-serial', f'unix:{self.control_path / "serial.sock"},server=on,wait=off',
                '-qmp', f'unix:{self.control_path / "qmp.sock"},server=on,wait=off']
        (self.folder / 'command.json').write_text(json.dumps(args, indent=2) + '\n')
        self.process = subprocess.Popen(args, stdout=self.stderr, stderr=self.stderr)
        self.serial = self.connect('serial.sock')
        self.qmp = self.connect('qmp.sock')
        self.qmp.settimeout(10)
        self.qmp_file = self.qmp.makefile('rb', buffering=0)
        json.loads(self.qmp_file.readline())
        self.monitor('qmp_capabilities')
        if offline:
            self.monitor('set_link', name='hnnet', up=False)
        self.wait('HARNESS_ARM_CONSOLE> ', timeout=180)
        self.command('stty -echo')
        self.command('test "$(getconf PAGESIZE)" = 16384 && test "$(uname -m)" = aarch64')
        self.shell_ready = True


def maintenance_phase(vm, phase, source):
    script = Path(__file__).with_name('asahi_encryption_guest.py')
    put(vm, '/var/tmp/harness-encryption-guest.py', script.read_text())
    try:
        vm.command('unshare --mount --propagation private python3 /var/tmp/harness-encryption-guest.py '
                   + phase + ' --source ' + shlex.quote(source), timeout=600)
    except BaseException as error:
        try:
            raw = vm.read_file('/var/tmp/harness-encryption-' + phase + '.json')
            (vm.folder / (phase + '.json')).write_bytes(raw)
        except Exception as diagnostic:
            error.add_note('Could not collect the partial phase receipt: ' + str(diagnostic))
        raise
    else:
        raw = vm.read_file('/var/tmp/harness-encryption-' + phase + '.json')
        (vm.folder / (phase + '.json')).write_bytes(raw)
    result = json.loads(raw)
    assert result['status'] == 'passed' and result['mounts_isolated'] and result['mapping_closed']
    vm.command('test ! -e /dev/mapper/harness-encryption-test && '
               'test -z "$(findmnt -rn --mountpoint /mnt/harness-encryption-test)"')
    return result


def unlock(vm, *, reject_wrong=False):
    vm.frame('01-unlock', 'passphrase', seconds=90)
    if reject_wrong:
        serial = vm.folder / 'serial.log'
        offset = serial.stat().st_size
        type_line(vm, 'incorrect-password')
        # Plymouth repeats the prompt without displaying cryptsetup's journal
        # error. Wait for that new prompt (not an old screenshot), then check
        # the actual rejection in the initrd journal after successful unlock.
        deadline = time.monotonic() + 45
        while b'\nPlease enter passphrase for disk ' not in serial.read_bytes()[offset:]:
            if vm.process.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError('Wrong graphical password did not reach a fresh unlock prompt.')
            time.sleep(.1)
        vm.frame('02-rejected', 'passphrase')
    vm.type_probe(PASSWORD)
    vm.frame('03-masked-unlock', 'passphrase', absent=[PASSWORD])
    vm.keys('ret')


def encrypted_root(vm):
    script = '''import json,pathlib,subprocess
def command(*args): return subprocess.check_output(args,text=True).strip()
assert command('getconf','PAGESIZE')=='16384'
assert command('getenforce')=='Enforcing'
assert command('findmnt','-no','SOURCE','/')=='/dev/mapper/harness-root[/root]'
assert command('findmnt','-no','SOURCE','/home')=='/dev/mapper/harness-root[/home]'
assert command('blkid','-s','TYPE','-o','value','/dev/vda3')=='crypto_LUKS'
assert command('cryptsetup','status','harness-root').find('/dev/vda3')>=0
assert command('systemctl','--failed','--no-pager','--no-legend')==''
subprocess.run(['rpm','-V','harness-os-session'],check=True)
record={'kernel':command('uname','-r'),'root':command('findmnt','-no','SOURCE','/'),
 'home':command('findmnt','-no','SOURCE','/home'),'luks_uuid':command('cryptsetup','luksUUID','/dev/vda3'),
 'selinux':command('getenforce'),'failed_units':[],
 'initrd_journal':command('journalctl','-b','--no-pager','-o','cat','-u','systemd-cryptsetup@harness\\\\x2droot.service')}
pathlib.Path('/tmp/harness-encrypted-root.json').write_text(json.dumps(record,indent=2)+'\\n')
'''
    put(vm, '/tmp/harness-encrypted-root.py', script)
    vm.command('python3 /tmp/harness-encrypted-root.py')
    raw = vm.read_file('/tmp/harness-encrypted-root.json')
    (vm.folder / 'encrypted-root.json').write_bytes(raw)
    return json.loads(raw)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--image-source', required=True)
    parser.add_argument('--fixture', type=Path, required=True, help='Verified native ARM maintenance VM fixture.')
    parser.add_argument('--fixture-source', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if (platform.system(), platform.machine()) != ('Darwin', 'arm64'):
        parser.error('Use the native Apple Silicon host observer.')
    if not re.fullmatch('[a-f0-9]{40}', args.image_source) or not re.fullmatch('[a-f0-9]{64}', args.sha256):
        parser.error('Use full source and image SHA-256 identities.')
    source = args.image.resolve()
    if args.image.is_symlink() or not source.is_file() or digest(source) != args.sha256:
        parser.error('Use the regular, SHA-256-verified private image.')
    info = fixture_identity(args.fixture, args.fixture_source)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    disk, maintenance = output / 'encrypted.raw', output / 'maintenance.raw'
    subprocess.run(['cp', '-c', source, disk], check=True, timeout=60)
    subprocess.run(['zstd', '-d', '--sparse', args.fixture / 'guest.raw.zst', '-o', maintenance],
                   check=True, timeout=120)
    assert digest(maintenance) == info['raw_disk']['sha256']
    receipt = {'status': 'running', 'started_at': time.time(), 'image_sha256': args.sha256,
               'image_source': args.image_source, 'maintenance_source': args.fixture_source,
               'maintenance_manifest_sha256': digest(args.fixture / 'manifest.json'),
               'scope': 'Native ARM 16 KiB UEFI VM, cloned produced Asahi image; no physical Apple hardware claim',
               'publication': False, 'checks': [],
               'limitations': ['Fixture conversion is not an installer or power-loss-safe enrollment flow',
                               'Public fixture password; this encrypted copy must never be published',
                               'VM consoles and virtio input differ from physical Apple hardware'],
               'observer_files': {name: digest(Path(__file__).with_name(name)) for name in
                  ('asahi_encryption_vm.py', 'asahi_encryption_guest.py', 'asahi_firstboot_vm.py',
                   'arm_boot.py', 'arm_session.py', 'fedora_session_vm.py', 'session_vm.py', 'vm.py')}}
    vm = None
    try:
        vm = MaintenanceVM(output / 'maintenance-prepare', maintenance, args.fixture / 'Image', disk)
        vm.start()
        vm.command('dnf5 install -y --setopt=install_weak_deps=False --setopt=gpgcheck=True cryptsetup btrfs-progs', timeout=240)
        receipt['prepare'] = maintenance_phase(vm, 'prepare', args.image_source)
        receipt['checks'].append('Isolated LUKS2 conversion preserves exact plaintext filesystem bytes, partition table, ESP, Harness files and Asahi initrd drivers')
        receipt['maintenance_shutdown'] = vm.poweroff()
        vm.close()
        vm = ImageVM(output / 'encrypted-firstboot', disk, None)
        vm.start()
        unlock(vm, reject_wrong=True)
        setup_screen(vm)
        vm.authenticate()
        receipt['first_root'] = encrypted_root(vm)
        assert 'Failed to activate with specified passphrase.' in receipt['first_root']['initrd_journal']
        first_account = evidence(vm, vm.folder)
        vm.wait_user('pgrep -u 1000 -x opencode >/dev/null && test "$(hn list-panes -F "#{pane_id}" | wc -l)" -eq 3')
        vm.user('mkdir -p ~/projects/encryption-check && printf %s ' + shlex.quote(PROJECT_TEXT.decode()) +
                ' > ' + shlex.quote('/' + PROJECT))
        assert vm.read_file('/' + PROJECT) == PROJECT_TEXT
        receipt['checks'].append('Graphical keyboard rejects a wrong disk password; correct masked input reaches account setup and OpenCode with two terminals; no failed services')
        receipt['first_shutdown'] = vm.poweroff()
        vm.close()
        vm = ImageVM(output / 'encrypted-reboot', disk, None)
        vm.start()
        unlock(vm)
        vm.authenticate()
        receipt['second_root'] = encrypted_root(vm)
        vm.wait_user('systemctl --user is-active --quiet hn-screen && test "$(hn list-panes -F "#{pane_id}" | wc -l)" -eq 3')
        assert evidence(vm, vm.folder) == first_account
        assert vm.read_file('/' + PROJECT) == PROJECT_TEXT
        vm.screenshot('04-restored-workspace')
        receipt['checks'].append('Subsequent graphical unlock reaches the restored three-pane workspace and preserves account and project bytes')
        receipt['second_shutdown'] = vm.poweroff()
        vm.close()
        vm = MaintenanceVM(output / 'offline-recovery', maintenance, args.fixture / 'Image', disk)
        vm.start(offline=True)
        receipt['recovery'] = maintenance_phase(vm, 'recover', args.image_source)
        receipt['recovery_shutdown'] = vm.poweroff()
        receipt['checks'].append('Offline read-only recovery rejects an incorrect password, recovers the exact project, and closes all mounts/mappings')
        receipt.update(status='passed', project_sha256=hashlib.sha256(PROJECT_TEXT).hexdigest())
        print('Encrypted root boot, account setup, reboot and offline recovery passed', flush=True)
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
        if vm:
            try:
                vm.screenshot('failure')
                if vm.shell_ready:
                    logs, _ = vm.command('journalctl -b --no-pager -n 150; systemctl --failed --no-pager', check=False, timeout=30)
                    (vm.folder / 'diagnosis.txt').write_text(logs)
            except Exception as diagnostic:
                receipt['diagnostic_error'] = str(diagnostic)
        raise
    finally:
        try:
            if vm:
                vm.close()
        except Exception as error:
            receipt.update(status='failed', cleanup_error=str(error))
            raise
        finally:
            receipt.update(finished_at=time.time(), source_unchanged=digest(source) == args.sha256)
            if not receipt['source_unchanged']:
                receipt.update(status='failed', error='Original source image changed.')
            (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    if receipt['status'] != 'passed':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
