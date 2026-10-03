#!/usr/bin/env python3
"""Validate optional hardware packages on the actual ISO and installed system."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time
from vm import VM, check_graphical_keyboard


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', required=True, type=Path)
    parser.add_argument('--output', type=Path, default=Path('os/test-results/hardware-install'))
    args = parser.parse_args()
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        parser.error('Native x86 KVM is required')
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    assert digest(iso) == manifest['iso']['sha256']
    assert 'broadcom-offline' in manifest['capabilities']
    folder = args.output.resolve()
    folder.mkdir(parents=True, exist_ok=False)
    config = dict(username='me', password='test-password-123', encrypt=True)
    receipt = dict(status='running', started_at=time.time(), iso_sha256=manifest['iso']['sha256'],
                   image_source_commit=manifest['source_commit'],
                   test_source_commit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                   memory_mib=1024, firmware='uefi', live_transport='usb',
                   limitations=['Synthetic PCI selection; physical Wi-Fi association and Mac sleep/wake remain unverified.'])
    vm = VM(folder, iso, 'uefi', 1024, 'usb')
    try:
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ', timeout=180)
        vm.shell_ready = True
        vm.command('stty -echo; nmcli networking off')
        script = Path(__file__).with_name('hardware_install_guest.py')
        encoded = base64.b64encode(script.read_bytes()).decode()
        vm.command('umask 077; : > /run/hardware-test.b64')
        # Serial canonical mode caps each line; no network is needed to stage it.
        for offset in range(0, len(encoded), 2400):
            vm.command('printf %s ' + shlex.quote(encoded[offset:offset + 2400]) + ' >> /run/hardware-test.b64')
        vm.command('base64 -d /run/hardware-test.b64 > /run/hardware-test.py')
        receipt['guest_fixture_sha256'] = digest(script)
        output, _ = vm.command('python3 /run/hardware-test.py', timeout=1200)
        (folder / 'installation.log').write_text(output)
        match = re.search(r'HN_HARDWARE_RESULT=(\{[^\r\n]+\})', output)
        assert match, 'Offline hardware acceptance receipt is missing'
        receipt['installation'] = json.loads(match.group(1))
        assert receipt['installation']['status'] == 'passed'
        vm.screenshot('01-live-install-complete')
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        vm.login_installed(config)
        receipt['keyboard'] = check_graphical_keyboard(vm, 'optional-wifi-installed')
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S true')
        vm.command('sudo nmcli networking off')
        vm.command('test ! -e /usr/share/harness-os/hardware/broadcom && test ! -e /etc/harness-live')
        output, _ = vm.command('pacman -Q broadcom-wl-dkms dkms gcc linux-lts-headers; dkms status; harness hardware')
        (folder / 'installed-hardware.txt').write_text(output)
        source = "$(find /usr/src -maxdepth 1 -type d -name 'broadcom-wl-*' -printf '%f\\n')"
        command = 'version=' + source + '; version=${version#broadcom-wl-}; test -n "$version" && '
        command += 'sudo dkms build --force -m broadcom-wl -v "$version" -k "$(uname -r)" && '
        command += 'sudo dkms install --force -m broadcom-wl -v "$version" -k "$(uname -r)" && '
        command += 'sudo modprobe wl && test -d /sys/module/wl && sudo modprobe -r wl'
        started = time.monotonic()
        output, _ = vm.command(command, timeout=600)
        (folder / 'installed-rebuild.log').write_text(output)
        receipt['installed_offline_rebuild_seconds'] = round(time.monotonic() - started, 3)
        receipt['post_rebuild_keyboard'] = check_graphical_keyboard(vm, 'driver-rebuilt')
        vm.screenshot('02-installed-driver-rebuilt')
        receipt['status'] = 'passed'
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
        try:
            vm.screenshot('failure')
            output, _ = vm.command('tail -100 /var/log/pacman.log; dkms status; systemctl --failed --no-pager', timeout=30, check=False)
            (folder / 'failure-diagnostics.log').write_text(output)
        except Exception:
            pass
        raise
    finally:
        receipt['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        vm.stop()


if __name__ == '__main__':
    main()
