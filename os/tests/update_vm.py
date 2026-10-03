#!/usr/bin/env python3
"""Apply and roll back a small package on the previously published ISO in native KVM."""
import argparse
import base64
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import threading
import time
from vm import VM, check_graphical_keyboard


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--fast-fixture', type=Path)
    parser.add_argument('--output', type=Path, default=Path('os/test-results/runtime-update'))
    args = parser.parse_args()
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        parser.error('This acceptance run requires native x86 KVM.')
    iso, bundle, folder = args.iso.resolve(), args.bundle.resolve(), args.output.resolve()
    image = json.loads(iso.with_name('manifest.json').read_text())
    with iso.open('rb') as handle:
        assert hashlib.file_digest(handle, 'sha256').hexdigest() == image['iso']['sha256']
    folder.mkdir(parents=True, exist_ok=False)
    # Only the private disposable guest receives these files. No host disk devices.
    served = folder / 'served'
    shutil.copytree(bundle, served)
    shutil.copyfile(Path(__file__).with_name('update_guest.py'), served / 'update_guest.py')
    if args.fast_fixture:
        shutil.copytree(args.fast_fixture, served / 'fast')
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(served)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    vm = VM(folder, iso, 'uefi', 2048)
    receipt = {'status': 'running', 'started_at': time.time(), 'image': image, 'checks': []}
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123', encrypt=True, serial_console=True)
    try:
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ', timeout=180)
        vm.shell_ready = True
        vm.command('stty -echo')
        encoded = base64.b64encode(json.dumps(config).encode()).decode()
        vm.command('printf %s ' + encoded + ' | base64 -d > /tmp/install-config.json')
        vm.command('nmcli networking off')
        output, _ = vm.command('harness install --config /tmp/install-config.json --yes-erase-disk', timeout=360)
        (folder / 'install.log').write_text(output)
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        vm.login_installed(config)
        receipt['checks'].append('Published ' + image['version'] + ' installs offline and boots from its encrypted internal disk')
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
        # Reuse the exact bundle after encrypted reboot; /tmp is intentionally
        # volatile on the installed system.
        vm.command('mkdir /home/me/update-bundle')
        url = f'http://10.0.2.2:{server.server_port}'
        for name in [p.name for p in served.iterdir() if p.is_file()]:
            vm.command('curl --fail --silent --show-error --max-time 90 ' + shlex.quote(url + '/' + name) +
                       ' -o ' + shlex.quote('/home/me/update-bundle/' + name), timeout=100)
        vm.command('cd /home/me/update-bundle && sha256sum -c SHA256SUMS')
        # The actual update/rollback must not require a package repository or network.
        vm.command('sudo nmcli networking off')
        output, status = vm.command('python3 /home/me/update-bundle/update_guest.py /home/me/update-bundle', timeout=600, check=False)
        (folder / 'update.log').write_text(output)
        assert status == 0, 'Update acceptance failed; see update.log'
        marker = 'HN_UPDATE_ACCEPTANCE='
        result = json.loads(next(line.split(marker, 1)[1] for line in output.splitlines() if line.startswith(marker)))
        receipt['update'] = result
        vm.screenshot('updated-surviving-terminal')
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        vm.login_installed(config)
        manifest = json.loads((bundle / 'package-manifest.json').read_text())
        vm.command('test "$(pacman -Q harness-os)" = ' + shlex.quote('harness-os ' + manifest['package']['version']))
        vm.command('test -s ~/Projects/update-survivor/keep.txt')
        receipt['keyboard'] = check_graphical_keyboard(vm, 'updated')
        receipt['checks'].append('Updated encrypted machine reboots to hn, accepts physical-keyboard input and retains the project')
        if args.fast_fixture:
            vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
            from fast_update_vm import exercise
            receipt['fast_updates'] = exercise(vm, args.fast_fixture, url)
            from release_update_vm import exercise as release_exercise
            receipt['system_channel'] = release_exercise(vm, manifest)
            vm.command('sync')
            vm.stop()
            vm.start(live=False)
            vm.login_installed(config)
            vm.command('test ! -e /run/harness-os-restart-required; test -s ~/Projects/update-survivor/keep.txt')
            receipt['system_channel']['reboot_keyboard'] = check_graphical_keyboard(vm, 'system-channel-reboot')
            receipt['checks'].append('The OS-channel update boots its rebuilt encrypted image and accepts keyboard input')
        receipt['status'] = 'passed'
    except BaseException as error:
        receipt['status'] = 'failed'
        receipt['error'] = str(error)
        try:
            vm.screenshot('failure')
            output, _ = vm.command('sudo journalctl _UID=1000 --no-pager; '
                'cat ~/.local/state/harness-os/updates/*.json; hn list-windows -a; hn list-panes -a; '
                'ps -u 1000 -o pid,ppid,args --width 200', timeout=30, check=False)
            (folder / 'update-diagnostics.log').write_text(output)
        except Exception:
            pass
        raise
    finally:
        receipt['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        vm.stop()
        server.shutdown()
        server.server_close()
        # The uploaded evidence omits VM disks and repeated package copies.
        shutil.rmtree(served)


if __name__ == '__main__':
    main()
