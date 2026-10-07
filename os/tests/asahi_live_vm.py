#!/usr/bin/env python3
"""Boot actual private UEFI media, install offline, and boot the encrypted target.

Only fresh regular test disks are writable. QEMU supplies a firmware device-tree
ESP identity; it does not emulate Apple's boot policy or physical hardware.
"""
import argparse
import json
from pathlib import Path
import platform
import select
import shutil
import subprocess
import threading
import time

from arm_boot import digest
from arm_session import fixture_identity
from asahi_encryption_vm import MaintenanceVM, unlock
from asahi_firstboot_vm import ImageVM, PASSWORD, evidence, type_line
from asahi_install_vm import stage, inspect
from asahi_startup_vm import installed
from asahi_target_vm import guest as target_guest
from session_vm import put

ROOT = Path(__file__).resolve().parents[1]
ESP = 'e51d26b0-4c8f-41fb-9d83-a0fdd62327c0'


class MediaVM(ImageVM):
    def __init__(self, folder, disk, iso):
        super().__init__(folder, disk, None)
        self.iso = iso

    def start(self):
        firmware = json.loads(Path('/opt/homebrew/share/qemu/firmware/60-edk2-aarch64.json').read_text())['mapping']
        variables = self.folder / 'uefi-vars.fd'
        shutil.copyfile(firmware['nvram-template']['filename'], variables)
        dtb = self.folder / 'firmware.dtb'
        command = ['qemu-system-aarch64', '-machine', 'virt,gic-version=3,acpi=off', '-accel', 'hvf',
            '-cpu', 'host', '-smp', '2', '-m', '3072', '-nodefaults', '-display', 'none', '-no-reboot',
            '-drive', f'if=pflash,format=raw,readonly=on,file={firmware["executable"]["filename"]}',
            '-drive', f'if=pflash,format=raw,file={variables}',
            '-drive', f'file={self.iso},format=raw,if=none,id=media,readonly=on',
            '-device', 'virtio-blk-pci,drive=media,serial=HARNESS_INSTALL_MEDIA,bootindex=1',
            '-drive', f'file={self.disk},format=raw,if=none,id=target',
            '-device', 'virtio-blk-pci,drive=target,serial=HARNESS_ENCRYPT_TEST,logical_block_size=4096,physical_block_size=4096',
            '-device', 'virtio-gpu-pci', '-device', 'virtio-keyboard-pci', '-device', 'virtio-tablet-pci']
        dump = list(command)
        dump[2] += ',dumpdtb=' + str(dtb)
        subprocess.run(dump, stdout=self.stderr, stderr=self.stderr, check=True, timeout=30)
        subprocess.run(['fdtput', '-t', 's', str(dtb), '/chosen', 'asahi,efi-system-partition', ESP],
                       check=True, timeout=10)
        command += ['-dtb', str(dtb),
            '-serial', f'unix:{self.control_path / "serial.sock"},server=on,wait=off',
            '-qmp', f'unix:{self.control_path / "qmp.sock"},server=on,wait=off']
        (self.folder / 'command.json').write_text(json.dumps(command, indent=2) + '\n')
        self.started = time.monotonic()
        self.process = subprocess.Popen(command, stdout=self.stderr, stderr=self.stderr)
        self.serial = self.connect('serial.sock')
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


def observer_console(vm):
    """Only after validating the actual install, add QEMU's login/input paths."""
    script = '''import importlib.util,json,pathlib
spec=importlib.util.spec_from_file_location('ui','/var/tmp/install.py')
ui=importlib.util.module_from_spec(spec);spec.loader.exec_module(ui)
storage,startup=ui.storage,ui.startup
esp=pathlib.Path('/mnt/harness-observer-esp');esp.mkdir()
with storage.mounted('/dev/vdb2',esp/'mounted','ro,noatime,uid=0,gid=0,fmask=0177,dmask=0077') as boot:
 plan=ui.target.load_plan(boot/'asahi/harness-install/target.json')
 state=json.loads((boot/'asahi/harness-install/storage.json').read_text())
 with storage.encrypted_root('/dev/vdb6',state,b'firstboot-local-42') as mapper:
  with storage.mounted(mapper,esp/'root','rw,subvol=root') as root:
   with startup.mount_at('/dev/vdb5',root/'boot','rw,noatime'):
    for name in ('etc/kernel/cmdline','etc/default/grub'):
     path=root/name;old=path.read_text()
     text=old.rstrip()+' console=ttyAMA0 console=tty0\\n' if name.endswith('cmdline') else old.replace('=harness-root"','=harness-root console=ttyAMA0 console=tty0"')
     path.write_text(text)
    (root/'etc/dracut.conf.d/99-harness-qemu-observer.conf').write_text('force_drivers+=" virtio_input "\\n')
    with startup.offline(root):
     storage.run('chroot',root,'grubby','--update-kernel=ALL','--args=console=ttyAMA0 console=tty0')
     storage.run('chroot',root,'dracut','--regenerate-all','--force','--no-hostonly',timeout=180)
     storage.run('chroot',root,'grub2-mkconfig','-o','/boot/grub2/grub.cfg')
     configs=['/etc/kernel/cmdline','/etc/default/grub','/etc/dracut.conf.d/99-harness-qemu-observer.conf']
     startup.label_files(root,'/boot',*configs)
     boot_files=['/boot/grub2/grub.cfg',*('/'+str(p.relative_to(root)) for p in (root/'boot/loader/entries').glob('*.conf')),
                 *('/'+str(p.relative_to(root)) for p in (root/'boot').glob('initramfs-*.img'))]
    # Verify with the installed policy after removing the maintenance kernel's
    # virtual filesystems. With them mounted, its disabled SELinux can
    # canonicalize every expected context to the literal "kernel".
    storage.run('chroot',root,'/usr/sbin/matchpathcon','-V',*configs,*boot_files)
'''
    put(vm, '/var/tmp/harness-media-observer.py', script)
    vm.command('unshare --mount --propagation private python3 /var/tmp/harness-media-observer.py', timeout=240)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('iso', 'media-receipt', 'image', 'fixture', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--fixture-source', required=True)
    args = parser.parse_args()
    if (platform.system(), platform.machine()) != ('Darwin', 'arm64'):
        parser.error('Use the native Apple Silicon observer.')
    media = json.loads(args.media_receipt.read_text())
    if media.get('status') != 'passed' or media.get('media', {}).get('kind') != 'harness-asahi-installer-media':
        parser.error('Use an inspected private installer ISO.')
    for file, expected in ((args.iso, media['artifact']), (args.image, media['media']['payload'])):
        if file.is_symlink() or not file.is_file() or file.stat().st_size != expected['bytes'] or digest(file) != expected['sha256']:
            parser.error('Use exact, verified regular image files.')
    for name, checksum in media['media']['installer'].items():
        if digest(ROOT / 'platforms/apple-silicon' / name) != checksum:
            parser.error('The media installer source differs from this checkout.')
    info = fixture_identity(args.fixture, args.fixture_source)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    maintenance, disk = output / 'maintenance.raw', output / 'target.raw'
    with disk.open('xb') as file:
        file.truncate(24 * 1024**3)
    subprocess.run(['zstd', '-d', '--sparse', args.fixture / 'guest.raw.zst', '-o', maintenance], check=True, timeout=120)
    assert digest(maintenance) == info['raw_disk']['sha256']
    paths = [ROOT / 'platforms/apple-silicon' / name for name in media['media']['installer']]
    paths += [Path(__file__).with_name(name) for name in ('asahi_live_vm.py', 'asahi_install_vm.py',
        'asahi_install_guest.py', 'asahi_startup_vm.py', 'asahi_target_vm.py', 'asahi_target_guest.py',
        'asahi_encryption_vm.py', 'asahi_encryption_guest.py', 'asahi_firstboot_vm.py',
        'arm_boot.py', 'arm_session.py', 'fedora_session_vm.py', 'session_vm.py', 'vm.py')]
    receipt = {'status': 'running', 'started_at': time.time(), 'publication': False,
        'media_receipt_sha256': digest(args.media_receipt), 'media': media['artifact'],
        'media_source': media['media']['source_commit'], 'payload': media['media']['payload'],
        'fixture_source': args.fixture_source, 'fixture_manifest_sha256': digest(args.fixture / 'manifest.json'),
        'inputs': {str(path.relative_to(ROOT)): digest(path) for path in paths}, 'shutdowns': [],
        'limitations': ['QEMU firmware/ESP property, not physical Apple boot policy or m1n1 acceptance.',
                       'Protected partitions contain sentinel bytes, not actual macOS filesystems.',
                       'Known fixture password: never publish maintenance or installed target disks.',
                       'After inspecting the completed install, adds only QEMU console and input configuration.']}
    vm = None
    try:
        vm = MaintenanceVM(output / 'prepare', maintenance, args.fixture / 'Image', disk, source=args.image)
        vm.start()
        vm.command('dnf5 install -y --setopt=install_weak_deps=False --setopt=gpgcheck=True gdisk dosfstools cryptsetup btrfs-progs e2fsprogs rsync', timeout=180)
        target_guest(vm, 'initialize', output)
        stage(vm)
        receipt['before'] = inspect(vm, 'reset-plan')
        receipt['shutdowns'].append(vm.poweroff())
        vm.close()
        vm = MediaVM(output / 'media-boot', disk, args.iso)
        vm.start()
        vm.frame('01-install', ['Disk', 'Encryption', 'Repeat password', 'Install Harness'], seconds=150)
        receipt['media_boot_seconds'] = round(time.monotonic() - vm.started, 3)
        type_line(vm, PASSWORD)
        type_line(vm, PASSWORD)
        vm.frame('02-ready', ['Install Harness'], absent=[PASSWORD])
        started = time.monotonic()
        vm.keys('ret')
        vm.frame('03-progress', 'Checking installation files', seconds=60)
        vm.frame('04-complete', ['Harness is installed', 'Shut down'], seconds=480,
                 fatal=['Installation stopped'])
        receipt['install_seconds'] = round(time.monotonic() - started, 3)
        vm.stop_drain()
        vm.keys('ret')
        receipt['shutdowns'].append(vm.poweroff(request=False))
        vm.close()
        print('The actual installer ISO completed an offline encrypted installation.', flush=True)
        vm = MaintenanceVM(output / 'inspect', maintenance, args.fixture / 'Image', disk, source=args.image)
        vm.start(offline=True)
        stage(vm)
        receipt['after'] = inspect(vm)
        assert receipt['after']['protected'] == receipt['before']['protected']
        assert receipt['after']['storage']['phase'] == 'copied'
        assert receipt['after']['startup']['phase'] == 'complete'
        assert not receipt['after']['remaining']
        observer_console(vm)
        receipt['shutdowns'].append(vm.poweroff())
        vm.close()
        vm = ImageVM(output / 'installed', disk, None)
        vm.start()
        unlock(vm, reject_wrong=True)
        vm.frame('04-workspace', ['opencode', 'Ask anything'], seconds=150, absent=['Set your password', 'panic'])
        vm.authenticate()
        receipt['installed'] = installed(vm)
        assert 'Failed to activate with specified passphrase.' in receipt['installed']['journal']
        receipt['account'] = evidence(vm, vm.folder)
        vm.wait_user('pgrep -u 1000 -x opencode >/dev/null && test "$(hn list-panes -F "#{pane_id}" | wc -l)" -eq 3')
        receipt['shutdowns'].append(vm.poweroff())
        receipt['status'] = 'passed'
        print('The media-installed system unlocked into the frozen Harness workspace.', flush=True)
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
        if vm:
            try:
                vm.screenshot('failure')
            except Exception as diagnostic:
                receipt['diagnostic_error'] = str(diagnostic)
        raise
    finally:
        try:
            if vm:
                vm.close()
        finally:
            receipt.update(finished_at=time.time(), original_media_unchanged=digest(args.iso) == media['artifact']['sha256'],
                           original_payload_unchanged=digest(args.image) == media['media']['payload']['sha256'])
            if not receipt['original_media_unchanged'] or not receipt['original_payload_unchanged']:
                receipt.update(status='failed', error='An original input image changed.')
            (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    main()
