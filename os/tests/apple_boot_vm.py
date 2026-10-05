#!/usr/bin/env python3
"""Apple early-input packaging and generic encrypted-boot acceptance on native KVM."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import tarfile
import time
from footprint_vm import copy_file
from session_vm import screen_text
from vm import VM


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('os/test-results/apple-boot'))
    args = parser.parse_args()
    assert os.access('/dev/kvm', os.R_OK | os.W_OK), 'Native KVM is required'
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    with iso.open('rb') as source:
        assert hashlib.file_digest(source, 'sha256').hexdigest() == manifest['iso']['sha256']
    assert iso.stat().st_size == manifest['iso']['bytes']
    folder = args.output.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    root = Path(__file__).resolve().parents[1]
    candidate = root / 'root/etc/mkinitcpio.conf.d/20-harness-apple-keyboard.conf'
    vm = VM(folder, iso, 'uefi', 1024, cpu='Nehalem')
    result = {'status': 'running', 'image_sha256': manifest['iso']['sha256'],
              'image_source': manifest['source_commit'],
              'candidate_sha256': hashlib.sha256(candidate.read_bytes()).hexdigest(),
              'test_source': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
              'started_at_unix': time.time(), 'checks': []}
    config = {'disk': '/dev/vda', 'expected_serial': 'HN_OS_TEST', 'confirm_erase': '/dev/vda',
              'username': 'me', 'hostname': 'harness', 'password': 'test-password-123',
              'encrypt': True, 'serial_console': True}
    try:
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ')
        vm.shell_ready = True
        vm.command('stty -echo')
        copy_file(vm, json.dumps(config).encode(), '/tmp/install-config.json')
        vm.command('nmcli networking off')
        output, _ = vm.command('harness install --config /tmp/install-config.json --yes-erase-disk', timeout=360)
        (folder / 'install.log').write_text(output)
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        vm.login_installed(config)
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
        dmi_before = vm.read_file('/sys/class/dmi/id/product_name')
        copy_file(vm, candidate.read_bytes(), '/tmp/apple-candidate.conf')
        copy_file(vm, Path(__file__).with_name('apple_boot_guest.py').read_bytes(), '/tmp/apple-boot-guest.py')
        try:
            output, _ = vm.command('sudo -n unshare --mount --propagation private python3 '
                '/tmp/apple-boot-guest.py --candidate /tmp/apple-candidate.conf '
                '--output /var/tmp/harness-apple-test', timeout=600)
            (folder / 'probe.log').write_text(output)
        finally:
            vm.command('sudo -n tar -czf /tmp/apple-evidence.tar.gz -C /var/tmp/harness-apple-test '
                '--exclude=extracted . && sudo -n chmod 644 /tmp/apple-evidence.tar.gz', check=False)
            data = vm.read_file('/tmp/apple-evidence.tar.gz')
            with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                archive.extractall(folder / 'native', filter='data')
        assert vm.read_file('/sys/class/dmi/id/product_name') == dmi_before, 'DMI fixture leaked'
        record = json.loads((folder / 'native/guest.json').read_text())
        assert record['status'] == 'passed', record
        assert record['candidate_sha256'] == result['candidate_sha256']
        result['checks'].append('Actual preset builds prove baseline omission and complete early-load dependency closure for both controller families')
        result['checks'].append('All nine SPI models selected; USB-only, T2, Apple Silicon and generic fixtures preserve existing modules')
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        vm.login_installed(config)
        vm.command('hn new-window -n keyboard-check ' + shlex.quote(
            'printf "Type into Harness: "; read -r word; printf %s "$word" > /tmp/apple-terminal-word; exec sleep 600'))
        deadline = time.monotonic() + 20
        while 'type into harness' not in screen_text(vm, 'terminal-ready'):
            assert time.monotonic() < deadline
            time.sleep(.2)
        vm.type_probe('keyboard-still-works')
        vm.keys('ret')
        vm.command('timeout 10 sh -c \'until test "$(cat /tmp/apple-terminal-word 2>/dev/null)" = keyboard-still-works; do sleep .1; done\'')
        vm.screenshot('terminal-after-encrypted-reboot')
        result['checks'].append('Generic candidate initramfs boots, accepts actual graphical disk-unlock password and types into hn')
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', error=repr(error))
        if vm.process and vm.process.poll() is None:
            try:
                vm.screenshot('failure')
            except Exception:
                pass
        raise
    finally:
        result['finished_at_unix'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
        vm.stop()
        vm.log.close()
        vm.stderr.close()
        vm.control.cleanup()


if __name__ == '__main__':
    main()
