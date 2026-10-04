#!/usr/bin/env python3
"""Native offline NVIDIA package installation and generic encrypted-boot checks."""
import argparse
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import threading
import time
from footprint_vm import copy_file
from vm import VM, check_graphical_keyboard


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', required=True, type=Path)
    parser.add_argument('--candidate-bundle', type=Path, help='Focused candidate test on an older reference ISO; not release acceptance')
    parser.add_argument('--output', type=Path, default=Path('os/test-results/nvidia-install'))
    args = parser.parse_args()
    assert os.access('/dev/kvm', os.R_OK | os.W_OK), 'Native x86 KVM is required'
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    assert digest(iso) == manifest['iso']['sha256'] and iso.stat().st_size == manifest['iso']['bytes']
    assert args.candidate_bundle or 'nvidia-offline' in manifest['capabilities']
    folder = args.output.resolve()
    folder.mkdir(parents=True, exist_ok=False)
    served = folder / 'served'
    served.mkdir()
    (served / 'browser.html').write_text('<!doctype html><html lang="en"><title>Harness check</title>'
        '<style>body{font:32px monospace;margin:3rem}</style>'
        '<h1>Offline driver check</h1><p>Harness preview is visible.</p></html>')
    if args.candidate_bundle:
        (served / 'bundle.tar').symlink_to(args.candidate_bundle.resolve())
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(served)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    vm = VM(folder, iso, 'uefi', 2048, 'usb')
    config = dict(username='me', password='test-password-123', encrypt=True)
    receipt = dict(status='running', started_at=time.time(), iso_sha256=manifest['iso']['sha256'],
                   image_source_commit=manifest['source_commit'],
                   test_source_commit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                   memory_mib=2048, firmware='uefi', live_transport='usb', candidate_injected=bool(args.candidate_bundle),
                   physical_gpu_validation='unavailable: no GPU passthrough')
    try:
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ', timeout=180)
        vm.shell_ready = True
        vm.command('stty -echo')
        if args.candidate_bundle:
            source = Path(__file__).resolve().parents[1]
            receipt['candidate_sha256'] = {}
            for local, guest in [('hardware.py', 'hardware.py'), ('installer.py', 'install.py')]:
                copy_file(vm, (source / local).read_bytes(), '/usr/lib/harness-os/' + guest)
                receipt['candidate_sha256'][local] = digest(source / local)
            # Stream once into the writable overlay; never store a second 325 MiB copy.
            vm.command('nm-online -q --timeout=60 && mkdir -p /usr/share/harness-os/hardware/nvidia && '
                'curl --fail --silent --show-error ' + shlex.quote(f'http://10.0.2.2:{server.server_port}/bundle.tar') +
                ' | tar -xf - -C /usr/share/harness-os/hardware/nvidia', timeout=180)
        vm.command('nmcli networking off')
        script = Path(__file__).with_name('nvidia_install_guest.py')
        copy_file(vm, script.read_bytes(), '/run/nvidia-test.py')
        receipt['guest_fixture_sha256'] = digest(script)
        output, _ = vm.command('python3 /run/nvidia-test.py', timeout=1200)
        (folder / 'installation.log').write_text(output)
        match = re.search(r'HN_NVIDIA_RESULT=(\{[^\r\n]+\})', output)
        assert match, 'Offline NVIDIA acceptance receipt is missing'
        receipt['installation'] = json.loads(match.group(1))
        assert receipt['installation']['status'] == 'passed'
        vm.screenshot('01-live-install-complete')
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        vm.login_installed(config)
        receipt['keyboard'] = check_graphical_keyboard(vm, 'nvidia-installed')
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S true')
        vm.command('test ! -e /usr/share/harness-os/hardware/nvidia && test ! -e /etc/harness-live')
        output, _ = vm.command('sudo -n lsinitcpio /boot/initramfs-linux-lts.img')
        (folder / 'initramfs-files.txt').write_text(output)
        for module in ['nvidia', 'nvidia_modeset', 'nvidia_drm']:
            filename = module.replace('_', '[-_]')
            assert re.search(r'/' + filename + r'\.ko(?:\.(?:zst|xz|gz))?(?:\s|$)', output), module
        firmware, _ = vm.command('modinfo -F firmware nvidia')
        # Serial shell-integration escapes may precede the first output line.
        names = re.findall(r'nvidia/[A-Za-z0-9._/-]+', firmware)
        assert names and all(name in output for name in names), 'GSP firmware missing from initramfs'
        receipt['early_display_modules_and_firmware'] = 'passed'
        output, status = vm.command('nvidia-smi', check=False)
        assert status != 0, 'This fixture must not claim a physical GPU'
        receipt['nvidia_smi'] = {'exit_code': status, 'output': output, 'physical_gpu_available': False}
        output, _ = vm.command('pacman -Q nvidia-open-lts nvidia-utils; harness hardware; '
            'cat /var/lib/harness-os/hardware.json')
        (folder / 'installed-hardware.txt').write_text(output)
        vm.command('sudo -n nmcli networking on; nm-online -q --timeout=60')
        vm.command('hn-browser ' + shlex.quote(f'http://10.0.2.2:{server.server_port}/browser.html'))
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            vm.screenshot('02-browser-after-driver-install')
            visible = subprocess.check_output(['tesseract', str(folder / '02-browser-after-driver-install.png'),
                'stdout', '--psm', '11'], text=True, stderr=subprocess.DEVNULL, timeout=10)
            (folder / 'browser.txt').write_text(visible)
            if 'Harness preview is visible.' in visible:
                break
            time.sleep(1)
        else:
            raise AssertionError('Chromium did not render the page after NVIDIA package installation')
        vm.keys('meta_l', 'b')
        receipt['return_keyboard'] = check_graphical_keyboard(vm, 'nvidia-browser-return')
        receipt['generic_browser_after_driver_reboot'] = 'passed'
        receipt['status'] = 'passed'
    except BaseException as error:
        receipt.update(status='failed', error=repr(error))
        try:
            vm.screenshot('failure')
        except Exception:
            pass
        raise
    finally:
        receipt['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        vm.stop()
        server.shutdown()
        server.server_close()
        vm.log.close()
        vm.stderr.close()
        vm.control.cleanup()


if __name__ == '__main__':
    main()
