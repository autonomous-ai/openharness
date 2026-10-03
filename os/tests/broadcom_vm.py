#!/usr/bin/env python3
"""Build/load wl and verify its offline closure; this does not test a Mac radio."""
import argparse
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
from vm import VM, check_graphical_keyboard


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


class UserView:
    """Run shared graphical acceptance as the live session owner, not root."""
    def __init__(self, vm):
        self.vm = vm

    def __getattr__(self, name):
        return getattr(self.vm, name)

    def command(self, command, **kwargs):
        return self.vm.command('runuser -u me -- env XDG_RUNTIME_DIR=/run/user/1000 '
                               'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus sh -c ' +
                               shlex.quote(command), **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('os/test-results/broadcom'))
    args = parser.parse_args()
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        parser.error('Native x86 KVM is required')
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    assert digest(iso) == manifest['iso']['sha256']
    folder = args.output.resolve()
    folder.mkdir(parents=True, exist_ok=False)
    artifacts = folder / 'bundle'
    artifacts.mkdir()
    (artifacts / 'broadcom_guest.py').write_bytes(Path(__file__).with_name('broadcom_guest.py').read_bytes())

    class Transfer(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(artifacts), **kwargs)

        def do_PUT(self):
            name = self.path.removeprefix('/')
            allowed = re.fullmatch(r'[a-zA-Z0-9_+.:\-]+\.pkg\.tar\.zst(?:\.sig)?', name)
            allowed = allowed or name in {'wl.ko', 'wl.ko.zst', 'wl.ko.xz', 'LICENSE.broadcom-wl', 'driver-receipt.json'}
            try:
                size = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                size = 0
            if not allowed or not 0 < size <= 256 * 1024 * 1024 or self.headers.get('Transfer-Encoding'):
                self.send_error(400)
                return
            target = artifacts / name
            if target.exists():
                self.send_error(409)
                return
            self.connection.settimeout(90)
            remaining = size
            with target.open('xb') as handle:
                while remaining:
                    data = self.rfile.read(min(1024 * 1024, remaining))
                    if not data:
                        raise EOFError('Incomplete guest artifact')
                    handle.write(data)
                    remaining -= len(data)
            self.send_response(201)
            self.send_header('Content-Length', '0')
            self.end_headers()

    server = ThreadingHTTPServer(('127.0.0.1', 0), Transfer)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f'http://10.0.2.2:{server.server_port}'
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    receipt = {'status': 'running', 'started_at': time.time(), 'source_commit': source,
               'image': manifest, 'scope': 'exact-kernel Broadcom module, offline closure, constrained live load',
               'limitations': ['No physical Intel Mac or Broadcom radio is available; association and suspend are unverified.']}
    vm = None
    try:
        build = folder / 'build'
        build.mkdir()
        vm = VM(build, iso, 'bios', 4096)
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ', timeout=180)
        vm.shell_ready = True
        vm.command('stty -echo')
        vm.command('nm-online -q --timeout=60 && curl --fail --silent --show-error ' +
                   shlex.quote(url + '/broadcom_guest.py') + ' -o /tmp/broadcom_guest.py')
        output, _ = vm.command('python3 /tmp/broadcom_guest.py ' + shlex.quote(url), timeout=1000)
        (build / 'build.log').write_text(output)
        result = json.loads((artifacts / 'driver-receipt.json').read_text())
        assert result['status'] == 'passed'
        for name, expected in result['files'].items():
            path = artifacts / name
            assert path.parent == artifacts
            assert path.stat().st_size == expected['bytes'] and digest(path) == expected['sha256']
        receipt['driver'] = result
        vm.stop()

        # A real USB needs the module before it has a network or build toolchain.
        # Test that path on the unmodified base with just 1 GiB RAM.
        constrained = folder / 'constrained'
        constrained.mkdir()
        vm = VM(constrained, iso, 'bios', 1024, 'usb')
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ', timeout=180)
        vm.shell_ready = True
        vm.command('stty -echo; nm-online -q --timeout=60')
        name = result['module']
        vm.command('curl --fail --silent --show-error ' + shlex.quote(url + '/' + name) + ' -o /tmp/' + shlex.quote(name))
        vm.command('test "$(sha256sum /tmp/' + name + ' | cut -d " " -f1)" = ' + shlex.quote(result['files'][name]['sha256']))
        vm.command('nmcli networking off && modprobe cfg80211 && insmod /tmp/' + shlex.quote(name))
        vm.command('test -d /sys/module/wl && ! pacman -Q dkms && ! pacman -Q gcc')
        user = UserView(vm)
        user.command('/usr/lib/harness-os/wait-runtime', timeout=160)
        receipt['constrained_keyboard'] = check_graphical_keyboard(user, 'driver-loaded')
        vm.command('rmmod wl')
        receipt['status'] = 'passed'
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
        if vm:
            try:
                vm.screenshot('failure')
                output, _ = vm.command('tail -100 /var/log/pacman.log; dkms status; dmesg | tail -100', timeout=30, check=False)
                (folder / 'failure-diagnostics.log').write_text(output)
            except Exception:
                pass
        raise
    finally:
        receipt['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        if vm:
            vm.stop()
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
