#!/usr/bin/env python3
"""Private diagnostic on the unchanged public ISO, never a physical NIC claim."""
import argparse
import base64
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import subprocess
import threading
import time
from unittest.mock import patch

from update_vm import network_state
from vm import VM


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--nic', choices=['virtio-net-pci', 'e1000e'], required=True)
    args = parser.parse_args()
    assert os.access('/dev/kvm', os.R_OK | os.W_OK)
    iso = args.iso.resolve()
    assert iso.stat().st_size == 2007023616
    assert hashlib.file_digest(iso.open('rb'), 'sha256').hexdigest() == 'fa4f282644ac81e9e3b7de55276edd7dc08405e50875da544dc7f9fd6d50ba12'
    folder = Path('os/test-results/network-suspend-' + args.nic).resolve()
    folder.mkdir(parents=True, exist_ok=False)
    (folder / 'network-proof.txt').write_text('harness-network-proof\n')
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(folder)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    vm = VM(folder, iso, 'uefi', 2048, video='VGA')
    result = dict(status='running', started_at=time.time(), nic=args.nic,
                  image='public preview14, no OS package or runtime changed', checks={},
                  limits=['QEMU devices only; link cycling and explicit connection below are diagnostic interventions.'])
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123', encrypt=True, serial_console=True)
    popen = subprocess.Popen

    def start(live):
        def configured(argv, *a, **kw):
            # Change only the explicitly declared virtual NIC for this matrix.
            argv = list(argv)
            index = argv.index('virtio-net-pci,netdev=net,id=hnnet')
            argv[index] = args.nic + ',netdev=net,id=hnnet'
            return popen(argv, *a, **kw)
        with patch('subprocess.Popen', side_effect=configured):
            vm.start(live)

    def login():
        vm.login_installed(config)
        vm.command('export PAGER= LC_ALL=C')
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
        vm.command('sudo nmcli general logging level DEBUG domains ALL')

    def connected(name):
        _, status = vm.command('nm-online -q --timeout=30', timeout=35, check=False)
        if not status:
            _, status = vm.command('test "$(curl --noproxy "*" -fsS --max-time 10 http://10.0.2.2:' +
                                   str(server.server_port) + '/network-proof.txt)" = harness-network-proof',
                                   timeout=15, check=False)
        result['checks'][name] = status == 0
        network_state(vm, name)
        result.setdefault('qemu_network', {})[name] = vm.monitor('human-monitor-command', **{'command-line': 'info network'})
        return status == 0

    def suspend(name):
        vm.command('sudo systemctl suspend --no-block')
        deadline = time.monotonic() + 30
        while vm.monitor('query-status')['status'] != 'suspended':
            assert time.monotonic() < deadline, 'No ACPI suspend'
            time.sleep(.2)
        vm.monitor('system_wakeup')
        deadline = time.monotonic() + 30
        while True:
            vm.send('\n')
            try:
                vm.wait(r'\[me@harness [^\r\n]*\]\$ ', timeout=2)
                break
            except TimeoutError:
                assert time.monotonic() < deadline, 'Serial did not resume'
        vm.command('true')
        vm.screenshot(name)

    try:
        start(True)
        vm.wait(r'root@[^\r\n]*[#] ', timeout=180)
        vm.shell_ready = True
        vm.command('stty -echo; export PAGER= LC_ALL=C')
        encoded = base64.b64encode(json.dumps(config).encode()).decode()
        vm.command('printf %s ' + encoded + ' | base64 -d > /tmp/install-config.json')
        vm.command('nmcli networking off')
        vm.command('harness install --config /tmp/install-config.json --yes-erase-disk', timeout=360)
        vm.command('sync')
        vm.stop()
        start(False)
        login()
        assert connected('initial-boot'), 'Baseline must connect before any suspend'
        vm.command('sudo nmcli networking off')
        vm.command('sudo nmcli networking on')
        assert connected('off-on-without-suspend'), 'Control failed without sleep'
        suspend('online-wake')
        connected('online-after-suspend')
        vm.command('sudo nmcli networking off; sync')
        vm.stop()
        start(False)
        login()
        network_state(vm, 'disabled-boot-before-suspend')
        suspend('disabled-wake')
        vm.command('sudo nmcli networking on')
        if not connected('disabled-boot-after-suspend'):
            vm.monitor('set_link', name='hnnet', up=False)
            time.sleep(1)
            vm.monitor('set_link', name='hnnet', up=True)
            connected('after-explicit-virtual-cable-cycle')
            vm.command('sudo nmcli --wait 30 device connect ens5', timeout=35, check=False)
            connected('after-explicit-device-connect')
        result['status'] = 'passed' if all(result['checks'].values()) else 'failed'
    except BaseException as error:
        result.update(status='failed', error=str(error))
        raise
    finally:
        result['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
        vm.stop()
        server.shutdown()
        server.server_close()
    if result['status'] != 'passed':
        raise SystemExit('Network resume failed; diagnostic observations retained.')


if __name__ == '__main__':
    main()
