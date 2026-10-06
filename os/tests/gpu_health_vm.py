#!/usr/bin/env python3
"""Installed OS diagnostic integration; virtual display, no physical NVIDIA GPU."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time

from footprint_vm import copy_file
from hardware_update_vm import graceful_stop, verify_image
from vm import VM, check_graphical_keyboard


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    iso, folder = args.iso.resolve(), args.output.absolute()
    image = verify_image(iso, json.loads(Path(__file__).with_name('hardware-update.lock.json').read_text()))
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        parser.error('Native x86 KVM is required.')
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip():
        parser.error('Commit the candidate before native acceptance.')
    folder.mkdir(parents=True, exist_ok=False)
    root = Path(__file__).resolve().parents[1]
    files = {name: 'usr/lib/harness-os/' + name for name in ['gpu_health.py', 'gpu_probe.py', 'hardware.py']}
    files.update({'root/' + name: name for name in ['usr/lib/harness-os/session',
                 *['usr/lib/systemd/user/' + unit for unit in ['harness-os.target', 'harness-gpu-check.service', 'harness-gpu-check.timer']]]})
    record = dict(status='running', started_at=time.time(), source_commit=source, image=image['iso'],
                  image_source=image['source_commit'], files={name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files},
                  checks=[], limits=['Candidate OS overlay on original preview14, not a newly built image.',
                                     'Virtual display with no NVIDIA device. This proves service/reporting behavior, not GPU hardware support.'])
    vm = VM(folder, iso, 'uefi', 2048, cpu='Nehalem')
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123', encrypt=True, serial_console=True)

    def auth():
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')

    try:
        vm.start(live=True)
        vm.monitor('set_link', name='hnnet', up=False)
        vm.wait(r'root@[^\r\n]*[#] ')
        vm.shell_ready = True
        vm.command('stty -echo; nmcli networking off')
        copy_file(vm, json.dumps(config).encode(), '/tmp/install.json')
        output, _ = vm.command('harness install --config /tmp/install.json --yes-erase-disk', timeout=360)
        (folder / 'install.log').write_text(output)
        graceful_stop(vm, False)
        vm.start(live=False)
        vm.login_installed(config)
        auth()
        vm.command('systemctl --user mask --now harness-update.timer harness-update.service')
        for index, (local, target) in enumerate(files.items()):
            data = (root / local).read_bytes()
            temporary = '/tmp/gpu-overlay-' + str(index)
            copy_file(vm, data, temporary)
            vm.command('printf %s ' + shlex.quote(record['files'][local] + '  ' + temporary + '\n') + ' | sha256sum -c -')
            vm.command('sudo -n install -m ' + ('755' if target.endswith('/session') else '644') + ' ' + temporary + ' /' + target)
        # No GPU readiness check belongs in the boot critical path. Activate the
        # package's real target by cold boot, not by calling its Python entrypoint.
        graceful_stop(vm, True)
        vm.start(live=False)
        vm.login_installed(config)
        path = '/home/me/.local/state/harness-os/gpu/health.json'
        vm.command('timeout 40 sh -c ' + shlex.quote('until test -f ' + path + '; do sleep .2; done'), timeout=45)
        before = json.loads(vm.read_file(path))
        assert before['status'] == 'skipped' and before['devices'] == []
        assert before['duration_seconds'] < 3, 'No-GPU check performed unnecessary work'
        assert before['inventory']['boot_id'] == vm.read_file('/proc/sys/kernel/random/boot_id').decode().strip()
        (folder / 'first-check.json').write_text(json.dumps(before, indent=2) + '\n')
        check_graphical_keyboard(vm, 'gpu-health-keyboard')
        vm.command('hn display-message -p "#{pane_id}" > /tmp/gpu-original-pane')
        original_pane = vm.read_file('/tmp/gpu-original-pane').decode().strip()
        assert re.fullmatch(r'%\d+', original_pane), 'Expected the existing shell pane'
        # The reference client restores terminal shells after a cold boot; it
        # does not replay an arbitrary prior foreground command. Start a real
        # bundled agent explicitly before asserting that checks preserve it.
        vm.command("mkdir -p ~/projects/gpu-health-proof && hn new-window -n gpu-proof " +
                   shlex.quote('cd "$HOME/projects/gpu-health-proof" && exec /usr/bin/opencode'))
        vm.command('timeout 40 sh -c ' + shlex.quote('until pgrep -u 1000 -x opencode >/dev/null; do sleep .2; done'), timeout=45)
        deadline = time.monotonic() + 40
        while True:
            output, _ = vm.command('hn capture-pane -p')
            if 'opencode' in output.lower() and 'Ask anything' in output:
                break
            if time.monotonic() > deadline:
                raise TimeoutError('The bundled OpenCode did not become interactive')
            time.sleep(.5)
        (folder / 'agent-before-check.txt').write_text(output)
        vm.screenshot('agent-before-check')
        # Existing work must remain alive while checks and reports run.
        vm.command('pgrep -x opencode > /tmp/gpu-agent-pids && systemctl --user show harness-daemon -p MainPID --value > /tmp/gpu-daemon-pid')
        vm.command('systemctl --user start harness-gpu-check.service')
        assert json.loads(vm.read_file(path)) == before, 'A second start repeated the same-boot check'
        vm.command('harness hardware > /tmp/gpu-hardware.json')
        report = json.loads(vm.read_file('/tmp/gpu-hardware.json'))
        assert report['gpu_health']['stale'] is False and report['gpu_health']['status'] == 'skipped'
        # Test failure-message routing with an explicit diagnostic fixture, not
        # a fabricated GPU pass. The product source and real report stay intact.
        notice = ('import sys; sys.path.insert(0,"/usr/lib/harness-os"); import gpu_health; '
                  'assert gpu_health.notify({"status":"failed"})')
        vm.command('python3 -c ' + shlex.quote(notice))
        vm.screenshot('failure-message')
        output, _ = vm.command('hn show-messages')
        (folder / 'notification.log').write_text(output)
        assert 'GPU needs attention' in output
        vm.command('pgrep -x opencode | diff /tmp/gpu-agent-pids - && systemctl --user show harness-daemon -p MainPID --value | diff /tmp/gpu-daemon-pid -')
        # The shared keyboard fixture waits for a visible shell prompt. OpenCode
        # is now active in its own tab, so select the retained shell first.
        vm.command('hn select-window -t ' + original_pane + ' && hn select-pane -t ' + original_pane)
        check_graphical_keyboard(vm, 'gpu-health-after-check')
        record['checks'].append('Packaged timer cold-boots, skips absent hardware quickly, caches within the boot, exposes a fresh JSON report, and routes a fixture failure without replacing the agent or daemon.')
        auth()
        graceful_stop(vm, True)
        vm.start(live=False)
        vm.login_installed(config)
        vm.command('timeout 40 sh -c ' + shlex.quote('until systemctl --user show harness-gpu-check.service -p Result --value | grep -qx success && test -f ' + path + '; do sleep .2; done'), timeout=45)
        # Result=success is also the service's initial state: wait for the actual
        # report to carry this boot ID before claiming the second execution.
        expected_boot = vm.read_file('/proc/sys/kernel/random/boot_id').decode().strip()
        deadline = time.monotonic() + 35
        while True:
            after = json.loads(vm.read_file(path))
            if after['inventory']['boot_id'] == expected_boot:
                break
            if time.monotonic() > deadline:
                raise TimeoutError('New boot did not run GPU verification')
            time.sleep(.5)
        assert after['inventory']['boot_id'] != before['inventory']['boot_id'] and after['status'] == 'skipped'
        (folder / 'second-check.json').write_text(json.dumps(after, indent=2) + '\n')
        record['checks'].append('A second real encrypted cold boot rechecks automatically with a new boot identity.')
        auth()
        output, _ = vm.command('journalctl --user -u harness-gpu-check.service --no-pager')
        (folder / 'service.log').write_text(output)
        graceful_stop(vm, True)
        record['status'] = 'passed'
    except Exception as error:
        record.update(status='failed', error=repr(error))
        if vm.process and vm.process.poll() is None:
            try:
                vm.screenshot('failure')
            except Exception as screenshot_error:
                record['screenshot_error'] = repr(screenshot_error)
        raise
    finally:
        vm.stop()
        vm.log.close()
        vm.stderr.close()
        vm.control.cleanup()
        record['duration_seconds'] = round(time.time() - record['started_at'], 3)
        (folder / 'receipt.json').write_text(json.dumps(record, indent=2) + '\n')


if __name__ == '__main__':
    main()
