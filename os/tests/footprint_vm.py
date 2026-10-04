#!/usr/bin/env python3
"""Measure the shipped workspace, agent-free terminal and browser on one installation."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import time
from vm import VM, check_graphical_keyboard


def copy_file(vm, data, destination):
    encoded = base64.b64encode(data).decode()
    vm.command(': > /tmp/footprint-transfer.b64')
    for start in range(0, len(encoded), 2000):
        vm.command('printf %s ' + encoded[start:start+2000] + ' >> /tmp/footprint-transfer.b64')
    vm.command('base64 -d /tmp/footprint-transfer.b64 > ' + shlex.quote(destination))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--memory-mib', type=int, choices=[1024, 4096], required=True)
    args = parser.parse_args()
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        parser.error('Native x86 KVM is required')
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    with iso.open('rb') as handle:
        assert hashlib.file_digest(handle, 'sha256').hexdigest() == manifest['iso']['sha256']
    folder = Path(f'os/test-results/footprint-{args.memory_mib}').resolve()
    folder.mkdir(parents=True, exist_ok=False)
    vm = VM(folder, iso, 'uefi', args.memory_mib, cpu='Nehalem')
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123', encrypt=True, serial_console=True)
    result = dict(status='running', started_at=time.time(), image_source_commit=manifest['source_commit'],
                  test_source_commit=subprocess.check_output(['git','rev-parse','HEAD'], text=True).strip(),
                  iso_sha256=manifest['iso']['sha256'], memory_mib=args.memory_mib, cpu='Nehalem',
                  limitations=['One ordered sequence per VM, not randomized repeated performance trials.',
                               'Software-rendered virtual display; no physical GPU or laptop timing claim.',
                               'OpenCode idle/default setup, not a model throughput or code-quality benchmark.'])
    try:
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ', timeout=180)
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
        vm.command('sudo -n touch /run/harness-footprint-disposable')
        vm.command('mkdir -p /home/me/footprint-assessment')
        script = Path(__file__).with_name('footprint_guest.py')
        copy_file(vm, script.read_bytes(), '/home/me/footprint-assessment/observe.py')
        # Keep background update downloads out of a short controlled sample.
        vm.command('systemctl --user stop harness-update.timer harness-update.service')
        vm.command('for n in $(seq 1 90); do pgrep -u "$(id -u)" -x opencode >/dev/null && exit 0; sleep 1; done; exit 1', timeout=100)
        vm.boot_diagnostics(config, 'installed')
        result['phases'] = {}
        for phase in ['agent-workspace', 'terminal-only', 'browser']:
            if phase == 'terminal-only':
                # Only this disposable user's bundled trial is stopped; no host process is touched.
                vm.command('pkill -TERM -u "$(id -u)" -x opencode')
                vm.command('for n in $(seq 1 40); do pgrep -u "$(id -u)" -x opencode >/dev/null || exit 0; sleep .25; done; exit 1')
                result['terminal_keyboard'] = check_graphical_keyboard(vm, 'agent-free')
            if phase == 'browser':
                copy_file(vm, b'<!doctype html><title>Harness footprint</title><h1>Harness footprint</h1><p>A local browser preview.</p>', '/home/me/footprint-assessment/preview.html')
                vm.command('hn-browser file:///home/me/footprint-assessment/preview.html')
                deadline = time.monotonic() + 45
                while time.monotonic() < deadline:
                    vm.screenshot('browser-visible')
                    visible = subprocess.check_output(['tesseract', str(folder / 'browser-visible.png'), 'stdout', '--psm', '11'], text=True, stderr=subprocess.DEVNULL, timeout=10)
                    if 'Harness footprint' in visible:
                        break
                    time.sleep(1)
                else:
                    raise RuntimeError('The local browser page did not render')
            path = '/home/me/footprint-assessment/' + phase + '.json'
            output, status = vm.command('sudo -n python3 /home/me/footprint-assessment/observe.py --phase ' + phase + ' --output ' + path, timeout=180, check=False)
            (folder / (phase + '.log')).write_text(output)
            data = vm.read_file(path)
            (folder / (phase + '.json')).write_bytes(data)
            result['phases'][phase] = json.loads(data)
            assert status == 0 and result['phases'][phase]['status'] == 'passed', phase
            vm.screenshot(phase)
        vm.keys('meta_l', 'ret')
        result['after_browser_keyboard'] = check_graphical_keyboard(vm, 'footprint-complete')
        vm.command('systemctl --user start harness-update.timer')
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', error=repr(error))
        try:
            vm.screenshot('failure')
        except Exception:
            pass
        raise
    finally:
        result['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
        vm.stop()


if __name__ == '__main__':
    main()
