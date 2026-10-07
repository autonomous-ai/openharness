#!/usr/bin/env python3
"""Observe unsupported-platform refusal without changing a private VM's disk."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import time
from footprint_vm import copy_file
from hardware_install_vm import candidate_record, digest
from session_vm import screen_text
from vm import VM


def user(command):
    return ('runuser -u me -- env XDG_RUNTIME_DIR=/run/user/1000 '
            'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus ' + command)


def wait_screen(vm, name, words, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        text = screen_text(vm, name)
        if all(word in text for word in words):
            return text
        time.sleep(.5)
    raise TimeoutError('Missing visible screen: ' + name)


def compare_disk(vm, baseline):
    command = ['qemu-img', 'compare', '-f', 'qcow2', '-F', 'qcow2', str(baseline), str(vm.disk)]
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
    return {'command': command, 'status': result.returncode, 'output': result.stdout.strip(),
            'logical_disk_bytes_unchanged': result.returncode == 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('os/test-results/install-preflight'))
    args = parser.parse_args()
    assert os.access('/dev/kvm', os.R_OK | os.W_OK), 'Native x86 KVM is required'
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    assert digest(iso) == manifest['iso']['sha256'] and iso.stat().st_size == manifest['iso']['bytes']
    folder = args.output.resolve()
    folder.mkdir(parents=True, exist_ok=False)
    (folder / 'image-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    root = Path(__file__).resolve().parents[1]
    candidates = {'hardware': root / 'hardware.py', 'installer': root / 'installer.py',
                  'boot_profile': root / 'boot_profile.py'}
    scripts = ['platform_preflight_vm.py', 'platform_preflight_guest.py', 'vm.py',
               'footprint_vm.py', 'hardware_install_vm.py', 'session_vm.py']
    receipt = dict(status='running', started_at=time.time(), image_source_commit=manifest['source_commit'],
                   iso_sha256=manifest['iso']['sha256'], memory_mib=1024, firmware='uefi', live_transport='cdrom',
                   candidates={name: candidate_record(path) for name, path in candidates.items()},
                   test_inputs={name: candidate_record(Path(__file__).with_name(name)) for name in scripts},
                   limitations=['Synthetic BCE PCI detection, not a physical T2 Mac boot or driver test.',
                                'No T2 input, Wi-Fi, audio, storage or suspend support is established.',
                                'Non-T2 form is observed; unchanged full installation and driver checks are not repeated.'])
    vm = VM(folder, iso, 'uefi', 1024)
    baseline = folder / 'baseline.qcow2'
    try:
        size = json.loads(subprocess.check_output(['qemu-img', 'info', '--output=json', str(vm.disk)]))['virtual-size']
        # Preserve distinctive data where partitioning would normally overwrite
        # the disk, then compare the entire logical disk after all three paths.
        sentinels = [(0, 1048576, '0x5a'), (size - 1048576, 1048576, '0xa5')]
        for offset, length, pattern in sentinels:
            subprocess.run(['qemu-io', '-f', 'qcow2', '-c', f'write -P {pattern} {offset} {length}', str(vm.disk)],
                           check=True, timeout=30)
        shutil.copyfile(vm.disk, baseline)
        receipt['disk'] = dict(virtual_bytes=size, sentinels=sentinels, baseline_file_sha256=digest(baseline))
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ', timeout=180)
        vm.shell_ready = True
        vm.command('stty -echo; nmcli networking off; umask 077')
        vm.command('timeout 30 sh -c \'until test -S /run/user/1000/bus && pgrep -x labwc >/dev/null; do sleep .25; done\'')
        vm.command(user('systemctl --user stop harness-install.service'))
        vm.command('test ! -e /mnt/harness-os && test "$(id -u me)" = 1000')
        receipt['original_image_files'] = {}
        for name, source in candidates.items():
            destination = '/usr/lib/harness-os/' + ('install.py' if name == 'installer' else name + '.py')
            _, exists = vm.command('test -f ' + shlex.quote(destination), check=False)
            if exists:
                assert exists == 1 and name == 'boot_profile', 'Unexpected missing baseline file: ' + name
                receipt['original_image_files'][name] = None  # Published PC image predates this helper.
            else:
                receipt['original_image_files'][name] = hashlib.sha256(vm.read_file(destination)).hexdigest()
            copy_file(vm, source.read_bytes(), destination)
            actual = hashlib.sha256(vm.read_file(destination)).hexdigest()
            assert actual == receipt['candidates'][name]['sha256']
        script = Path(__file__).with_name('platform_preflight_guest.py')
        copy_file(vm, script.read_bytes(), '/run/platform-preflight-guest.py')
        command = 'timeout 30 unshare --mount --propagation private python3 /run/platform-preflight-guest.py check'
        output, _ = vm.command(command, timeout=40)
        (folder / 'refusal.log').write_text(output)
        match = re.search(r'HN_PLATFORM_RESULT=(\{[^\r\n]+\})', output)
        assert match, 'Missing guest platform refusal receipt'
        receipt['refusal'] = json.loads(match.group(1))
        for name in candidates:
            assert receipt['refusal'][name + '_sha256'] == receipt['candidates'][name]['sha256']

        # Show the actual boot installer error through its normal foot service.
        override = '/home/me/.config/systemd/user/harness-install.service.d/preflight-test.conf'
        vm.command(user('mkdir -p ' + shlex.quote(str(Path(override).parent))))
        unit = ('[Service]\nExecStart=\nExecStart=/usr/bin/foot --config=/usr/share/harness-os/foot.ini '
                '/usr/bin/sudo /usr/bin/unshare --mount --propagation private '
                '/usr/bin/python3 /run/platform-preflight-guest.py ui\n')
        copy_file(vm, unit.encode(), override)
        vm.command('chown me:me ' + shlex.quote(override))
        vm.command(user('systemctl --user daemon-reload'))
        vm.command(user('systemctl --user start harness-install.service'))
        receipt['visible_refusal'] = wait_screen(vm, '01-t2-refusal', ['installation stopped', 'apple t2 macs yet'])
        vm.command(user('systemctl --user stop harness-install.service'))
        vm.command('rm ' + shlex.quote(override))
        vm.command(user('systemctl --user daemon-reload'))
        # Namespace teardown restores genuine generic hardware automatically.
        output, _ = vm.command('python3 /usr/lib/harness-os/hardware.py')
        (folder / 'generic-hardware.log').write_text(output)
        assert '"installation_blocker": null' in output
        vm.command(user('systemctl --user start harness-install.service'))
        receipt['visible_generic_form'] = wait_screen(vm, '02-generic-form', ['disk', 'encryption', 'repeat password'])
        vm.command('sync')
        vm.stop()
        receipt['disk_comparison'] = compare_disk(vm, baseline)
        assert receipt['disk_comparison']['logical_disk_bytes_unchanged'], receipt['disk_comparison']
        receipt['status'] = 'passed'
    except BaseException as error:
        receipt.update(status='failed', error=repr(error))
        if vm.process and vm.process.poll() is None:
            try:
                vm.screenshot('failure')
                output, _ = vm.command(user('journalctl --user -u harness-install.service -n 50 --no-pager'), timeout=15, check=False)
                (folder / 'failure-journal.log').write_text(output)
            except Exception:
                pass
        raise
    finally:
        vm.stop()
        if baseline.exists() and 'disk_comparison' not in receipt:
            try:
                receipt['disk_comparison'] = compare_disk(vm, baseline)
            except Exception as error:
                receipt['disk_comparison_error'] = repr(error)
        receipt['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        vm.log.close()
        vm.stderr.close()
        vm.control.cleanup()


if __name__ == '__main__':
    main()
