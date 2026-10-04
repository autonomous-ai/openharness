#!/usr/bin/env python3
"""Native laptop-key acceptance on a verified image, without physical Mac claims."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import time
from footprint_vm import copy_file
from session_vm import screen_text
from vm import VM


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('os/test-results/input'))
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
    vm = VM(folder, iso, 'uefi', 1024, cpu='Nehalem')
    result = {'status': 'running', 'image_sha256': manifest['iso']['sha256'],
              'image_source': manifest['source_commit'], 'candidate_files': {},
              'test_source': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
              'started_at_unix': time.time(), 'checks': []}
    config = {'disk': '/dev/vda', 'expected_serial': 'HN_OS_TEST', 'confirm_erase': '/dev/vda',
              'username': 'me', 'hostname': 'harness', 'password': 'test-password-123',
              'encrypt': True, 'serial_console': True}

    def exercise(name, installed=False):
        print('Checking ' + name + ' media keys', flush=True)
        config_path = '/usr/share/harness-os/' + ('labwc' if installed else 'labwc-install') + '/rc.xml'
        candidate = root / 'root' / config_path.lstrip('/')
        result['candidate_files'][config_path] = hashlib.sha256(candidate.read_bytes()).hexdigest()
        copy_file(vm, candidate.read_bytes(), '/tmp/input-candidate.xml')
        copy_file(vm, Path(__file__).with_name('input_guest.py').read_bytes(), '/tmp/input-guest.py')
        command = ('sudo -n ' if installed else '') + 'python3 /tmp/input-guest.py --candidate /tmp/input-candidate.xml --config ' + config_path + ' --output /tmp/input-result.json' + (' --installed' if installed else '')
        try:
            output, _ = vm.command(command, timeout=80)
            (folder / (name + '.log')).write_text(output)
        finally:
            output = vm.read_file('/tmp/input-result.json')
            (folder / (name + '.json')).write_bytes(output)
        record = json.loads(output)
        assert record['status'] == 'passed', record
        result['checks'].append(name + ': actual media keys passed through labwc and packaged brightnessctl; kernel keyboard LED permissions unchanged')
        vm.screenshot(name)

    try:
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ')
        vm.shell_ready = True
        vm.command('stty -echo')
        vm.command('timeout 30 sh -c \'until pgrep -u 1000 -x labwc && pgrep -u 1000 -x foot; do sleep .2; done\'')
        exercise('usb')
        copy_file(vm, json.dumps(config).encode(), '/tmp/install-config.json')
        vm.command('nmcli networking off')
        output, _ = vm.command('harness install --config /tmp/install-config.json --yes-erase-disk', timeout=360)
        (folder / 'install.log').write_text(output)
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        vm.login_installed(config)
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
        vm.command('/usr/lib/harness-os/wait-runtime')
        exercise('installed', installed=True)
        # Media keys must leave ordinary typing directed to the same terminal.
        vm.command('hn new-window -n keyboard-check ' + shlex.quote(
            'echo $$ > /tmp/input-terminal-pid; printf "Type into Harness: "; read -r word; printf %s "$word" > /tmp/input-terminal-word; exec sleep 600'))
        deadline = time.monotonic() + 20
        while 'type into harness' not in screen_text(vm, 'terminal-ready'):
            assert time.monotonic() < deadline
            time.sleep(.2)
        vm.type_probe('keyboard-still-works')
        vm.keys('ret')
        vm.command('timeout 10 sh -c \'until test "$(cat /tmp/input-terminal-word 2>/dev/null)" = keyboard-still-works; do sleep .1; done\'; kill -0 "$(cat /tmp/input-terminal-pid)"')
        vm.screenshot('terminal-after-media-keys')
        result['checks'].append('Installed hn accepts real graphical keyboard input after media controls')
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', error=str(error))
        if vm.process and vm.process.poll() is None:
            try:
                vm.screenshot('failure')
                output, _ = vm.command('cat /home/me/.local/state/harness-os/display.log; '
                    'sudo -n journalctl -b --no-pager -n 200; ls -l /sys/class/leds/*/brightness; '
                    'cat /tmp/input-result.json', check=False, timeout=20)
                (folder / 'diagnostics.log').write_text(output)
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
