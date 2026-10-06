#!/usr/bin/env python3
"""Install and recover the actual T2 image; synthetic firmware, no physical Mac claim."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time

from footprint_vm import copy_file
from hardware_update_vm import graceful_stop
from session_vm import screen_text
from test_t2_firmware import firmware, source_fixture
from vm import VM, check_graphical_keyboard


def guest_result(output):
    # Shell integration may put OSC metadata before the first output line.
    # Compare the structured evidence, never the changing shell transcript.
    matches = re.findall(r'T2_RESULT=(\{[^\r\n]+\})', output)
    if len(matches) != 1:
        raise ValueError('Expected exactly one T2 guest result.')
    return json.loads(matches[0])


def image_source_binding(root, image_source, observer_source):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
    if not re.fullmatch(r'[a-f0-9]{40}', image_source):
        raise ValueError('Invalid image source identity.')
    changed = git('diff', '--no-renames', '--name-only', image_source, observer_source).splitlines()
    workflow = '.github/workflows/os-t2.yml'
    if any(not name.startswith('os/tests/') and name != workflow for name in changed):
        raise ValueError('Image build or runtime inputs changed; build a new T2 image.')
    if workflow in changed:
        old = git('show', image_source + ':' + workflow)
        new = git('show', observer_source + ':' + workflow)
        if '\n  machine:' not in old or '\n  machine:' not in new or old.split('\n  machine:', 1)[0] != new.split('\n  machine:', 1)[0]:
            raise ValueError('Image workflow inputs changed; build a new T2 image.')
    return {'image_source': image_source, 'observer_source': observer_source,
            'changed_paths': changed, 'build_inputs_identical': True,
            'scope': 'Complete repository except OS test observers and the machine-only workflow job; image job is byte-identical.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        parser.error('Native x86 KVM is required.')
    iso, folder = args.iso.resolve(), args.output.absolute()
    image = json.loads(iso.with_name('manifest.json').read_text())
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip():
        parser.error('Commit the observer before native acceptance.')
    assert image['platform'] == 'apple-t2'
    binding = image_source_binding(Path(__file__).resolve().parents[2], image['source_commit'], source)
    assert iso.name == image['iso']['name'] and iso.stat().st_size == image['iso']['bytes']
    with iso.open('rb') as handle:
        assert hashlib.file_digest(handle, 'sha256').hexdigest() == image['iso']['sha256']
    folder.mkdir(parents=True, exist_ok=False)
    model = 'MacBookAir9,1'
    source_fixture(folder / 'synthetic-firmware')
    bundle = folder / 'harness-apple-firmware.tar'
    firmware.prepare(folder / 'synthetic-firmware', bundle, model)
    lock = json.loads((Path(__file__).parents[1] / 'platforms/apple-t2/kernel.json').read_text())
    record = {'status': 'running', 'started_at': time.time(), 'source_commit': source,
              'image_source_commit': image['source_commit'], 'source_binding': binding,
              'image': image['iso'], 'kernel': lock, 'synthetic_model': model, 'checks': [],
              'limits': ['QEMU does not emulate the T2 bridge, built-in input, radios, audio, graphics or suspend.',
                         'Firmware contains invented sentinel bytes. This tests preservation, not radio functionality.',
                         'Kernel is unchanged across this package transaction; a future T2 kernel upgrade remains a separate gate.']}
    vm = VM(folder, iso, 'uefi', 2048, cpu='Haswell-noTSX', apple_model=model)
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123', encrypt=True, serial_console=True)

    def live():
        vm.start(live=True)
        vm.monitor('set_link', name='hnnet', up=False)
        vm.wait(r'root@[^\r\n]*[#] ')
        vm.shell_ready = True
        vm.command('stty -echo; nmcli networking off')
        vm.command('test "$(uname -r)" = ' + shlex.quote(lock['kernel_release']))
        vm.command('test "$(cat /sys/class/dmi/id/product_name)" = ' + shlex.quote(model))

    def installed(label):
        vm.start(live=False)
        vm.monitor('set_link', name='hnnet', up=False)
        vm.login_installed(config)
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
        vm.command('systemctl --user stop harness-update.timer harness-update.service')
        vm.command('test "$(uname -r)" = ' + shlex.quote(lock['kernel_release']))
        vm.command('test "$(cat /usr/lib/modules/$(uname -r)/pkgbase)" = linux-t2')
        vm.command('! pacman -Q linux-lts')
        command_line = vm.read_file('/proc/cmdline').decode()
        assert set(lock['kernel_parameters']) <= set(command_line.split())
        record[label + '_boot_id'] = vm.read_file('/proc/sys/kernel/random/boot_id').decode().strip()
        # This machine stays offline: first use legitimately presents Wi-Fi.
        # Exercise the owner's normal terminal escape, without fabricating an
        # onboarded marker or treating a running process as a visible workspace.
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            text = screen_text(vm, label + '-offline-first-use')
            if 'me@harness' in re.sub(r'\s+', '', text):
                break
            if 'connect to wi-fi' in text:
                vm.keys('meta_l', 't')
                break
            time.sleep(.5)
        else:
            raise TimeoutError('The installed offline workspace did not render.')
        record[label + '_keyboard'] = check_graphical_keyboard(vm, label)
        output, _ = vm.command('sudo -n lsinitcpio --list /boot/initramfs-linux-t2.img')
        (folder / (label + '-initramfs.txt')).write_text(output)
        for module in lock['early_modules']:
            assert '/' + module + '.ko' in output, module
        output, _ = vm.command('sudo -n lsinitcpio --config /boot/initramfs-linux-t2.img')
        for module in lock['early_modules']:
            assert module in output, module
        for module in lock['required_modules']:
            output, _ = vm.command('modinfo -F vermagic ' + module)
            assert lock['kernel_release'] in output, module
        copy_file(vm, Path(__file__).with_name('t2_install_guest.py').read_bytes(), '/tmp/t2-guest.py')
        output, _ = vm.command('sudo -n python3 /tmp/t2-guest.py verify')
        (folder / (label + '-verification.log')).write_text(output)
        return guest_result(output)

    try:
        live()
        record['checks'].append('The live ISO actually boots its pinned T2 kernel and observes the synthetic Mac model.')
        vm.command('test "$(lsblk -dn -o SERIAL /dev/vda)" = HN_OS_TEST && '
                   'sgdisk --zap-all --new=1:2048:+256M --typecode=1:ef00 --new=2:0:0 --typecode=2:8300 /dev/vda && '
                   'udevadm settle && mkfs.fat -F32 /dev/vda1')
        copy_file(vm, json.dumps(config).encode(), '/tmp/install.json')
        copy_file(vm, Path(__file__).with_name('t2_install_guest.py').read_bytes(), '/tmp/t2-guest.py')
        install = 'harness install --config /tmp/install.json --yes-erase-disk'
        # Hash both GPT copies and the full export partition around refusals.
        fingerprint = 'python3 /tmp/t2-guest.py fingerprint'
        before, _ = vm.command(fingerprint)
        before = guest_result(before)
        output, status = vm.command(install, timeout=90, check=False)
        (folder / 'missing-firmware.log').write_text(output)
        assert status != 0 and 'No disk has been erased' in output
        after, _ = vm.command(fingerprint)
        after = guest_result(after)
        record['missing_firmware_disk'] = {'before': before, 'after': after}
        assert before == after, 'Missing firmware changed the disk'
        vm.command('mkdir /tmp/mac-efi && mount /dev/vda1 /tmp/mac-efi && '
                   'printf corrupt > /tmp/mac-efi/harness-apple-firmware.tar && umount /tmp/mac-efi')
        before, _ = vm.command(fingerprint)
        before = guest_result(before)
        output, status = vm.command(install, timeout=90, check=False)
        (folder / 'corrupt-firmware.log').write_text(output)
        assert status != 0 and 'No disk has been erased' in output
        after, _ = vm.command(fingerprint)
        after = guest_result(after)
        record['invalid_firmware_disk'] = {'before': before, 'after': after}
        assert before == after, 'Invalid firmware changed the disk'
        record['checks'].append('Missing and corrupt firmware both refuse installation; both GPT copies and the export partition remain byte-identical.')
        vm.command('mount /dev/vda1 /tmp/mac-efi')
        copy_file(vm, bundle.read_bytes(), '/tmp/mac-efi/harness-apple-firmware.tar')
        vm.command('sync && umount /tmp/mac-efi')
        output, _ = vm.command(install, timeout=420)
        (folder / 'install.log').write_text(output)
        record['checks'].append('The real installer preserves verified firmware from EFI before erasure and completes an encrypted offline installation.')
        graceful_stop(vm, False)
        baseline = installed('installed')
        record['installed'] = baseline
        vm.command('mkdir -p ~/projects/t2-survivor && printf before > ~/projects/t2-survivor/work.txt')
        output, _ = vm.command('sudo -n hn-os checkpoint')
        name = re.search(r'Checkpoint ([A-Za-z0-9_-]+)', output)[1]
        record['checkpoint'] = name
        # A real package transaction replaces a firmware file, runs the shipped
        # pacman hook and preserves the running terminal. The package is a fixture.
        output, _ = vm.command('sudo -n python3 /tmp/t2-guest.py package', timeout=180)
        (folder / 'firmware-package.log').write_text(output)
        output, _ = vm.command('sudo -n python3 /tmp/t2-guest.py verify')
        (folder / 'after-package.log').write_text(output)
        record['checks'].append('An actual pacman firmware transaction runs the automatic restoration hook and keeps the same Harness process alive.')
        vm.command('printf after-checkpoint >> ~/projects/t2-survivor/work.txt && '
                   'printf changed | sudo -n tee /etc/harness-t2-recovery-fixture >/dev/null && '
                   'printf changed | sudo -n tee /boot/grub/grub.cfg >/dev/null')
        graceful_stop(vm, True)
        live()
        vm.command('printf %s ' + shlex.quote(config['password']) + ' | cryptsetup open --key-file=- /dev/vda3 hn-recovery')
        output, _ = vm.command('hn-os recover /dev/mapper/hn-recovery ' + shlex.quote(name), timeout=180)
        (folder / 'recovery.log').write_text(output)
        vm.command('cryptsetup close hn-recovery')
        graceful_stop(vm, False)
        restored = installed('recovered')
        assert record['installed_boot_id'] != record['recovered_boot_id']
        assert baseline['boot_sha256'] == restored['boot_sha256']
        assert baseline['firmware_sha256'] == restored['firmware_sha256']
        vm.command('test ! -e /etc/harness-t2-recovery-fixture && ! pacman -Q linux-firmware-harness-fixture && '
                   'test "$(cat ~/projects/t2-survivor/work.txt)" = beforeafter-checkpoint')
        record['restored'] = restored
        record['checks'].append('Offline recovery restores the matching T2 root, boot files and firmware, preserves newer project work, and cold boots through graphical disk unlock into Harness.')
        graceful_stop(vm, True)
        record['status'] = 'passed'
    except Exception as error:
        record.update(status='failed', error=repr(error))
        if vm.process and vm.process.poll() is None:
            vm.screenshot('failure')
        raise
    finally:
        vm.stop()
        vm.log.close()
        vm.stderr.close()
        vm.control.cleanup()
        record['duration_seconds'] = round(time.time() - record['started_at'], 3)
        (folder / 'receipt.json').write_text(json.dumps(record, indent=2) + '\n')


if __name__ == '__main__':
    main()
