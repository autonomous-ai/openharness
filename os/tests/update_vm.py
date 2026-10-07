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
import session_update_vm


def network_state(vm, name):
    """Retain the real device state without repairing or reactivating it."""
    state = {}
    for command in [
        'nmcli general status', 'nmcli networking', 'nmcli device show',
        'nmcli -f NAME,UUID,TYPE,DEVICE,AUTOCONNECT connection show',
        'ip -details link', 'ip address', 'ip route',
        'sudo -n cat /var/lib/NetworkManager/NetworkManager.state',
        'sudo -n journalctl -b -u NetworkManager -u systemd-logind -u systemd-suspend --no-pager',
        'sudo -n journalctl -b -k --no-pager',
    ]:
        output, status = vm.command('env PAGER= LC_ALL=C ' + command, timeout=15, check=False)
        state[command] = {'status': status, 'output': output}
        (vm.folder / (name + '-network.json')).write_text(json.dumps(state, indent=2) + '\n')


def network_roundtrip(vm, url, expected):
    """Require an actual connection and exact HTTP payload, not just NM state."""
    vm.command('nm-online -q --timeout=30', timeout=35)
    vm.command('curl --fail --silent --show-error --max-time 15 ' +
               shlex.quote(url + '/package-manifest.json') +
               ' -o /tmp/harness-update-network.json', timeout=20)
    assert vm.read_file('/tmp/harness-update-network.json') == expected, 'Network payload differs'
    return {'bytes': len(expected), 'sha256': hashlib.sha256(expected).hexdigest()}


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
    manifest = json.loads((bundle / 'package-manifest.json').read_text())
    session_tools = session_update_vm.required(bundle)
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
    # Match the existing session/suspend gate. The pinned kernel's bochs driver
    # resumes this virtual display; virtio-vga can leave its scanout inactive.
    video = 'VGA' if session_tools else 'virtio-vga'
    vm = VM(folder, iso, 'uefi', 2048, video=video)
    receipt = {'status': 'running', 'started_at': time.time(), 'image': image,
               'video': video, 'checks': [],
               'limits': ['Virtual display and ACPI suspend; no physical laptop, panel, or GPU acceptance.']}
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
        if session_tools:
            receipt['session_dependencies'] = session_update_vm.prepare(vm, manifest)
        # The actual update/rollback must not require a package repository or network.
        vm.command('sudo nmcli networking off')
        output, status = vm.command('python3 /home/me/update-bundle/update_guest.py /home/me/update-bundle', timeout=600, check=False)
        (folder / 'update.log').write_text(output)
        assert status == 0, 'Update acceptance failed; see update.log'
        marker = 'HN_UPDATE_ACCEPTANCE='
        result = json.loads(next(line.split(marker, 1)[1] for line in output.splitlines() if line.startswith(marker)))
        receipt['update'] = result
        vm.screenshot('updated-surviving-terminal')
        if session_tools:
            # The transactions above finish offline. Restore the ordinary
            # connected session before the separate reboot/suspend checks.
            vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
            vm.command('sudo -n nmcli networking on')
            network_payload = (bundle / 'package-manifest.json').read_bytes()
            receipt['network'] = {'after_offline_transactions': network_roundtrip(vm, url, network_payload)}
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        vm.login_installed(config)
        vm.command('test "$(pacman -Q harness-os)" = ' + shlex.quote('harness-os ' + manifest['package']['version']))
        vm.command('test -s ~/projects/update-survivor/keep.txt')
        receipt['keyboard'] = check_graphical_keyboard(vm, 'updated')
        vm.command('hn show-options -gv status-right > /tmp/updated-footer.txt')
        bar = vm.read_file('/tmp/updated-footer.txt').decode()
        assert 'local_machine' in bar and '%H:%M' in bar and '@harness-update' not in bar, bar
        vm.keys('ctrl', 'b')
        vm.keys('c')
        time.sleep(1)
        vm.type_probe('echo updated-tab-ready')
        vm.keys('ret')
        vm.command('for n in $(seq 1 20); do hn capture-pane -p | grep -qx updated-tab-ready && exit 0; sleep .5; done; exit 1', timeout=15)
        vm.screenshot('updated-standard-footer-terminal-tab')
        vm.keys('ctrl', 'd')
        receipt['checks'].append('A rebooted upgrade preserves hn’s standard footer and Ctrl+b, c opens a real terminal tab')
        receipt['checks'].append('Updated encrypted machine reboots to hn, accepts physical-keyboard input and retains the project')
        if session_tools:
            vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
            receipt['network']['before_suspend'] = network_roundtrip(vm, url, network_payload)
            network_state(vm, 'before-session')
            session_update_vm.exercise(vm, config, receipt['session_dependencies'])
            receipt['network']['after_suspend'] = network_roundtrip(vm, url, network_payload)
            network_state(vm, 'after-session')
        if args.fast_fixture:
            vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
            from fast_update_vm import exercise
            receipt['fast_updates'] = exercise(vm, args.fast_fixture, url)
            from release_update_vm import exercise as release_exercise
            receipt['system_channel'] = release_exercise(vm, manifest, config)
            vm.command('sync')
            vm.stop()
            vm.start(live=False)
            vm.login_installed(config)
            vm.command('test ! -e /run/harness-os-restart-required; test -s ~/projects/update-survivor/keep.txt')
            from release_update_vm import finish_after_reboot
            receipt['system_channel']['checks'].append(finish_after_reboot(vm))
            receipt['system_channel']['reboot_keyboard'] = check_graphical_keyboard(vm, 'system-channel-reboot')
            receipt['checks'].append('The OS-channel update boots its rebuilt encrypted image and accepts keyboard input')
        receipt['status'] = 'passed'
    except BaseException as error:
        receipt['status'] = 'failed'
        receipt['error'] = str(error)
        try:
            vm.screenshot('failure')
            # Collect diagnostics after the failed assertion. The actual update
            # test cleared credentials; never block its error path on a prompt.
            vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
            network_state(vm, 'failure')
            output, _ = vm.command('sudo -n journalctl _UID=1000 --no-pager; '
                'sudo -n cat /var/lib/harness-os/runtime-updates/*/receipt.json; '
                'tail -n 100 /var/log/pacman.log; hn capture-pane -p -S -200 -t Updates; '
                'cat ~/.local/state/harness-os/updates/*.json; hn list-windows -a; hn list-panes -a; '
                'systemctl --user show hn-screen.service harness-apply-update.service '
                '-p Id -p LoadState -p ActiveState -p SubState -p MainPID -p ExecMainStatus; '
                'hn hn-list-clients -F "#{client_pid} #{session_id} #{client_tty}"; '
                'for hn_update_pid in $(pgrep -u 1000 -x "hn|harness-tui|foot"); do '
                'echo "client process $hn_update_pid"; '
                'readlink /proc/$hn_update_pid/exe /proc/$hn_update_pid/fd/0; '
                'cat /proc/$hn_update_pid/cgroup; done; '
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
