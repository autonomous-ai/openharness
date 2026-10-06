#!/usr/bin/env python3
"""Boot the pinned T2 kernel in an encrypted Harness VM, without claiming Mac support."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import threading
import time

from footprint_vm import copy_file
from hardware_update_vm import graceful_stop, verify_image
from vm import VM, check_graphical_keyboard

spec = importlib.util.spec_from_file_location('t2_kernel', Path(__file__).parents[1] / 'tools/prepare-t2-kernel.py')
t2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        parser.error('Native x86 KVM is required.')
    iso, bundle, folder = args.iso.resolve(), args.bundle.resolve(), args.output.absolute()
    image = verify_image(iso, json.loads(Path(__file__).with_name('hardware-update.lock.json').read_text()))
    lock = json.loads(t2.LOCK.read_text())
    package = bundle / lock['package']['filename']
    members = t2.inspect(package, lock)
    folder.mkdir(parents=True, exist_ok=False)
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip():
        parser.error('Commit the observer before native acceptance.')
    record = {'status': 'running', 'started_at': time.time(), 'observer_source': source,
              'image_source': image['source_commit'], 'image': image['iso'], 'kernel': lock,
              'verified_package_files': members, 'checks': [],
              'limits': ['Virtual PC, not a T2 Mac: physical input, graphics, radio, audio and suspend remain unverified.',
                         'Candidate kernel overlay on an installed preview 14 image; not a T2 ISO or installer acceptance.']}
    vm = VM(folder, iso, 'uefi', 2048, cpu='Haswell-noTSX')
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(bundle)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123', encrypt=True, serial_console=True)
    try:
        vm.start(live=True)
        vm.monitor('set_link', name='hnnet', up=False)
        vm.wait(r'root@[^\r\n]*[#] ')
        vm.shell_ready = True
        vm.command('stty -echo; nmcli networking off')
        copy_file(vm, json.dumps(config).encode(), '/tmp/install.json')
        output, _ = vm.command('harness install --config /tmp/install.json --yes-erase-disk', timeout=360)
        (folder / 'install.log').write_text(output)
        graceful_stop(vm, False)
        vm.start(live=False)
        vm.monitor('set_link', name='hnnet', up=False)
        vm.login_installed(config)
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
        vm.command('systemctl --user stop harness-update.timer harness-update.service')
        before = vm.read_file('/proc/sys/kernel/random/boot_id')
        vm.monitor('set_link', name='hnnet', up=True)
        vm.command('sudo -n nmcli networking on && nm-online -q --timeout=30', timeout=35)
        url = 'http://10.0.2.2:' + str(server.server_port) + '/' + package.name
        vm.command('curl --fail --silent --show-error ' + shlex.quote(url) + ' -o /tmp/t2-kernel.pkg.tar.zst', timeout=120)
        vm.command('printf %s ' + shlex.quote(lock['package']['sha256'] + '  /tmp/t2-kernel.pkg.tar.zst\n') + ' | sha256sum -c -')
        output, _ = vm.command('sudo -n pacman -U --needed --noconfirm /tmp/t2-kernel.pkg.tar.zst', timeout=240)
        (folder / 'kernel-install.log').write_text(output)
        # Only the T2 preset gets its input modules. The retained original LTS
        # kernel/preset must still build as a recovery option in this fixture.
        mkinitcpio = 'source /etc/mkinitcpio.conf\nMODULES+=(' + ' '.join(lock['early_modules']) + ')\n'
        copy_file(vm, mkinitcpio.encode(), '/tmp/mkinitcpio-t2.conf')
        vm.command('sudo -n install -m 644 /tmp/mkinitcpio-t2.conf /etc/mkinitcpio-t2.conf')
        preset = ('ALL_config="/etc/mkinitcpio-t2.conf"\nALL_kver="/boot/vmlinuz-linux-t2"\n'
                  "PRESETS=('default')\ndefault_image=\"/boot/initramfs-linux-t2.img\"\n")
        copy_file(vm, preset.encode(), '/tmp/linux-t2.preset')
        vm.command('sudo -n install -m 644 /tmp/linux-t2.preset /etc/mkinitcpio.d/linux-t2.preset && '
                   'sudo -n cp /usr/lib/modules/' + lock['kernel_release'] + '/vmlinuz /boot/vmlinuz-linux-t2 && sudo -n mkinitcpio -P', timeout=240)
        data, _ = vm.command('sudo -n lsinitcpio --list /boot/initramfs-linux-t2.img')
        (folder / 'initramfs-files.txt').write_text(data)
        for module in lock['early_modules']:
            if '/' + module + '.ko' not in data:
                raise ValueError('Early T2 input module missing from initramfs: ' + module)
        output, _ = vm.command('sudo -n lsinitcpio --config /boot/initramfs-linux-t2.img')
        (folder / 'initramfs-config.txt').write_text(output)
        for module in lock['early_modules']:
            if module not in output:
                raise ValueError('T2 input module not configured for early loading: ' + module)
        for module in lock['required_modules']:
            output, _ = vm.command('modinfo -k ' + lock['kernel_release'] + ' -F vermagic ' + module)
            if lock['kernel_release'] not in output:
                raise ValueError('T2 module targets a different kernel: ' + module)
        params = ' '.join(lock['kernel_parameters'])
        vm.command('printf %s ' + shlex.quote('\nGRUB_CMDLINE_LINUX="$GRUB_CMDLINE_LINUX ' + params + '"\n') +
                   ' | sudo -n tee -a /etc/default/grub >/dev/null && sudo -n grub-mkconfig -o /boot/grub/grub.cfg')
        record['checks'].append('Pinned kernel installs on the shipped userspace; mkinitcpio includes the three early input modules and every required module has matching vermagic.')
        graceful_stop(vm, True)
        vm.start(live=False)
        vm.login_installed(config)
        vm.command('test "$(uname -r)" = ' + shlex.quote(lock['kernel_release']))
        if vm.read_file('/proc/sys/kernel/random/boot_id') == before:
            raise ValueError('The candidate kernel was not cold booted.')
        command_line = vm.read_file('/proc/cmdline').decode()
        if not set(lock['kernel_parameters']) <= set(command_line.split()):
            raise ValueError('T2 boot parameters were not applied.')
        (folder / 'cmdline.txt').write_text(command_line)
        check_graphical_keyboard(vm, 't2-kernel-keyboard')
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
        output, _ = vm.command('sudo -n journalctl -b --no-pager')
        (folder / 'candidate-boot.log').write_text(output)
        record['checks'].append('A real cold boot runs the pinned T2 kernel, accepts the encrypted graphical unlock password and types into Harness.')
        graceful_stop(vm, True)
        record['status'] = 'passed'
    except Exception as error:
        record.update(status='failed', error=repr(error))
        if vm.process and vm.process.poll() is None:
            vm.screenshot('failure')
        raise
    finally:
        vm.stop()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        vm.log.close()
        vm.stderr.close()
        vm.control.cleanup()
        record['duration_seconds'] = round(time.time() - record['started_at'], 3)
        (folder / 'receipt.json').write_text(json.dumps(record, indent=2) + '\n')


if __name__ == '__main__':
    main()
