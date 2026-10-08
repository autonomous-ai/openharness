#!/usr/bin/env python3
"""Observe first boot on a disposable copy of the actual private Asahi image.

This native Apple Silicon-host VM checks the image, not physical Apple hardware.
It never opens a host disk and never modifies the declared source image.
"""
import argparse
from vm_artifacts import discard_passed_disks
import json
from pathlib import Path
import platform
import select
import shutil
import subprocess
import sys
import threading
import time

from arm_boot import digest
from arm_session import SessionVM
from fedora_session_vm import LOGIN_PROBE
from session_vm import put


PASSWORD = 'firstboot-local-42'  # Public fixture credential, never a real user's password.


class ImageVM(SessionVM):
    def start(self):
        firmware = json.loads(Path('/opt/homebrew/share/qemu/firmware/60-edk2-aarch64.json').read_text())['mapping']
        variables = self.folder / 'uefi-vars.fd'
        shutil.copyfile(firmware['nvram-template']['filename'], variables)
        self.started = time.monotonic()
        command = ['qemu-system-aarch64', '-machine', 'virt,gic-version=3', '-accel', 'hvf',
            '-cpu', 'host', '-rtc', 'base=localtime', '-smp', '2', '-m', '3072',
            '-nodefaults', '-display', 'none', '-no-reboot',
            '-drive', f'if=pflash,format=raw,readonly=on,file={firmware["executable"]["filename"]}',
            '-drive', f'if=pflash,format=raw,file={variables}',
            '-drive', f'file={self.disk},format=raw,if=none,id=root',
            '-device', 'virtio-blk-pci,drive=root,serial=HARNESS_ASAHI_FIRSTBOOT,logical_block_size=4096,physical_block_size=4096,bootindex=1',
            '-device', 'virtio-gpu-pci', '-device', 'virtio-keyboard-pci', '-device', 'virtio-tablet-pci',
            '-netdev', 'user,id=net', '-device', 'virtio-net-pci,netdev=net,id=hnnet,romfile=',
            '-serial', f'unix:{self.control_path / "serial.sock"},server=on,wait=off',
            '-qmp', f'unix:{self.control_path / "qmp.sock"},server=on,wait=off']
        (self.folder / 'command.json').write_text(json.dumps(command, indent=2) + '\n')
        self.process = subprocess.Popen(command, stdout=self.stderr, stderr=self.stderr)
        self.serial = self.connect('serial.sock')
        # Firmware and kernel console writes can block QEMU's main loop if the
        # observer only takes screenshots. Drain boot output while no login
        # command is using the console, retaining all bytes in serial.log.
        self.drain_stop = threading.Event()
        def drain():
            while not self.drain_stop.is_set():
                if select.select([self.serial], [], [], .1)[0]:
                    data = self.serial.recv(65536)
                    if not data:
                        return
                    self.log.write(data)
        self.drain_thread = threading.Thread(target=drain, daemon=True)
        self.drain_thread.start()
        self.qmp = self.connect('qmp.sock')
        self.qmp.settimeout(10)
        self.qmp_file = self.qmp.makefile('rb', buffering=0)
        json.loads(self.qmp_file.readline())
        self.monitor('qmp_capabilities')

    def stop_drain(self):
        if hasattr(self, 'drain_stop'):
            self.drain_stop.set()
            self.drain_thread.join(timeout=2)
            if self.drain_thread.is_alive():
                raise RuntimeError('The boot console observer did not stop.')

    def close(self):
        self.stop_drain()
        super().close()

    def authenticate(self):
        self.stop_drain()
        self.send('\n')  # Ask the existing getty to repeat its consumed prompt.
        self.wait('login:', timeout=120)
        self.send('me\n')
        self.wait('Password:', timeout=30)
        self.send(PASSWORD + '\n')
        self.wait(r'\[me@[^\r\n]*\]\$ ', timeout=30)
        self.send('sudo /bin/bash --noprofile --norc -i\n')
        self.wait('password for me:', timeout=30)
        self.send(PASSWORD + '\n')
        self.wait(r'bash-[^\r\n]*# ', timeout=30)
        self.send("stty -echo; export PS1='HARNESS_ARM_CONSOLE> '\n")
        self.wait('HARNESS_ARM_CONSOLE> ', timeout=30)
        self.shell_ready = True


def type_line(vm, value):
    vm.type_probe(value)
    vm.keys('ret')


def setup_screen(vm):
    vm.frame('01-password', 'Set your password', seconds=120)
    type_line(vm, 'wrong')
    type_line(vm, 'mismatch')
    vm.keys('ret')
    vm.frame('02-mismatch', 'Passwords do not match')
    vm.keys('shift', 'tab')
    vm.keys('ctrl', 'u')
    vm.type_probe(PASSWORD)
    vm.keys('shift', 'tab')
    vm.keys('ctrl', 'u')
    vm.type_probe(PASSWORD)
    vm.frame('03-masked', 'Repeat password', absent=[PASSWORD])
    vm.keys('ret')
    vm.keys('ret')
    vm.keys('ret')
    vm.frame('04-workspace', ['opencode', 'Ask anything'], seconds=150,
             absent=['Bun has crashed', 'panic'])


def evidence(vm, folder):
    vm.command('test "$(getconf PAGESIZE)" = 16384 && test "$(getenforce)" = Enforcing && rpm -V harness-os-session')
    put(vm, '/tmp/harness-firstboot-login-probe.py', LOGIN_PROBE)
    vm.command('python3 /tmp/harness-firstboot-login-probe.py')
    (folder / 'login.json').write_bytes(vm.read_file('/tmp/harness-login-probe.json'))
    script = '''import hashlib,json,pathlib,subprocess
root=pathlib.Path('/')
state=json.loads((root/'var/lib/harness-os/firstboot.json').read_text())
assert state['phase']=='complete'
image=json.loads((root/'usr/share/harness-os/image.json').read_text())
assert state['source']==image['source_commit']
for name,entry in image['first_boot']['files'].items():
 assert hashlib.sha256((root/name).read_bytes()).hexdigest()==entry['sha256']
passwd=[r.split(':') for r in (root/'etc/passwd').read_text().splitlines()]
assert [r for r in passwd if 1000<=int(r[2])<65534]==[['me','x','1000','1000','me','/home/me','/bin/bash']]
shadow=[r.split(':') for r in (root/'etc/shadow').read_text().splitlines()]
assert next(r for r in shadow if r[0]=='root')[1].startswith(('!','*'))
assert next(r for r in shadow if r[0]=='me')[1].startswith('$')
assert 'wheel' in subprocess.check_output(['id','-Gn','me'],text=True).split()
record={}
for name in ['etc/passwd','etc/shadow','etc/group','etc/gshadow','etc/pam.d/greetd',
 'etc/sudoers','etc/selinux/config','var/lib/harness-os/firstboot.json',
 'var/lib/harness-os/firstboot.done','var/lib/harness-os/session-setup.json']:
 p=root/name;s=p.stat()
 record[name]={'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'mode':s.st_mode&0o7777,'uid':s.st_uid}
for name in ['var/lib/harness-os/firstboot.json','var/lib/harness-os/firstboot.done']:
 assert record[name]['mode']==0o600 and record[name]['uid']==0
pathlib.Path('/tmp/harness-firstboot-evidence.json').write_text(json.dumps(record,indent=2)+'\\n')
'''
    put(vm, '/tmp/harness-firstboot-evidence.py', script)
    vm.command('python3 /tmp/harness-firstboot-evidence.py')
    raw = vm.read_file('/tmp/harness-firstboot-evidence.json')
    (folder / 'account.json').write_bytes(raw)
    return json.loads(raw)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if (platform.system(), platform.machine()) != ('Darwin', 'arm64'):
        parser.error('Use the native Apple Silicon host observer.')
    source = args.image.resolve()
    if args.image.is_symlink() or not source.is_file() or digest(source) != args.sha256:
        parser.error('Use the regular, SHA-256-verified private image.')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    disk = output / 'guest.raw'
    subprocess.run(['cp', '-c', source, disk], check=True, timeout=60)
    receipt = {'status': 'running', 'started_at': time.time(), 'image_sha256': args.sha256,
               'scope': 'Produced image, native ARM 16 KiB UEFI VM; no physical Apple hardware claim',
               'checks': [], 'publication': False,
               'observer_files': {name: digest(Path(__file__).with_name(name)) for name in
                  ('asahi_firstboot_vm.py', 'arm_boot.py', 'arm_session.py', 'fedora_session_vm.py',
                   'session_vm.py', 'vm.py')}}
    vm = None
    try:
        vm = ImageVM(output / 'boot-01-interrupted', disk, None)
        vm.start()
        vm.frame('01-password', 'Set your password', seconds=120)
        # Deliberately cut power while setup is pending, on this copy only.
        vm.close()
        vm = ImageVM(output / 'boot-02-resumed', disk, None)
        vm.start()
        setup_screen(vm)
        vm.authenticate()
        first = evidence(vm, vm.folder)
        vm.wait_user('pgrep -u 1000 -x opencode >/dev/null')
        vm.wait_user('test "$(hn list-panes -F "#{pane_id}" | wc -l)" -eq 3')
        receipt['checks'].extend(['Password screen survives interrupted first boot',
            'Mismatch stays in masked form; valid password reaches actual three-pane workspace',
            'New me account, locked root, wheel, native greetd/PAM session and enforcing SELinux'])
        print('First boot reached the actual Harness workspace', flush=True)
        vm.keys('ctrl', 'alt', 'f2')
        vm.frame('05-recovery-login', 'login:')
        type_line(vm, 'me')
        vm.frame('06-recovery-password', 'password:')
        type_line(vm, 'incorrect-password')
        vm.frame('07-recovery-rejected', 'incorrect', seconds=30)
        vm.frame('08-recovery-retry', 'login:')
        type_line(vm, 'me')
        vm.frame('09-recovery-password', 'password:')
        type_line(vm, PASSWORD)
        vm.frame('10-recovery-shell', 'me@harness')
        vm.command('mkdir -p /var/lib/harness-test')
        type_line(vm, 'sudo -k')
        type_line(vm, 'sudo touch /var/lib/harness-test/firstboot-sudo')
        vm.frame('11-sudo-password', 'password for me')
        type_line(vm, PASSWORD)
        vm.command('for n in $(seq 1 30); do test -f /var/lib/harness-test/firstboot-sudo && exit 0; sleep .2; done; exit 1')
        receipt['checks'].append('Recovery console rejects wrong password, accepts chosen password; sudo authenticates')
        receipt['shutdown_first'] = vm.poweroff()
        vm.close()
        vm = ImageVM(output / 'boot-03-normal', disk, None)
        vm.start()
        vm.authenticate()
        vm.wait_user('systemctl --user is-active --quiet hn-screen')
        second = evidence(vm, vm.folder)
        assert first == second, 'Account, authentication or setup state changed on the second configured boot'
        vm.command('test "$(systemctl show harness-firstboot.service -p ConditionResult --value)" = no')
        vm.screenshot('01-normal-workspace')
        receipt['checks'].append('Later boot skips account setup and preserves account/authentication/setup bytes')
        receipt['shutdown_second'] = vm.poweroff()
        receipt['status'] = 'passed'
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
        if vm:
            try:
                vm.screenshot('failure')
                if vm.shell_ready:
                    logs, _ = vm.command('journalctl -b -u harness-firstboot -u greetd --no-pager; ausearch -m AVC -ts boot', check=False)
                    (vm.folder / 'diagnosis.txt').write_text(logs)
            except Exception as diagnostic:
                receipt['diagnostic_error'] = str(diagnostic)
        raise
    finally:
        if vm:
            vm.close()
        receipt['finished_at'] = time.time()
        receipt['source_unchanged'] = digest(source) == args.sha256
        if not receipt['source_unchanged']:
            receipt.update(status='failed', error='Original source image changed.')
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        discard_passed_disks(output, receipt, disk)
    if receipt['status'] != 'passed':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
