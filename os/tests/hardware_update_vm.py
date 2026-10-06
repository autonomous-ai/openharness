#!/usr/bin/env python3
"""One native changed-kernel update/recovery VM, reusing a frozen preview ISO."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import select
import shlex
import shutil
import signal
import subprocess
import time
import uuid

from footprint_vm import copy_file
from hardware_install_vm import candidate_record
from hardware_update_guest import digest, validate_lock, validate_recovery, validate_transition
from vm import VM, check_graphical_keyboard


def verify_image(iso, lock):
    old = lock['baseline']
    manifest_path = iso.with_name('manifest.json')
    assert digest(manifest_path) == old['manifest_sha256'], 'Wrong image manifest'
    manifest = json.loads(manifest_path.read_text())
    assert manifest['source_commit'] == old['source_commit']
    assert manifest['iso'] == old['iso']
    assert iso.name == old['iso']['name'] and iso.stat().st_size == old['iso']['bytes']
    assert digest(iso) == old['iso']['sha256'], 'Wrong preview14 ISO'
    assert manifest['harness_inputs']['files'] == old['runtime_files']
    assert manifest['harness_inputs']['source_commit'] == old['source_commit']
    assert manifest['package_version'] == old['packages']['harness-os']
    assert manifest['arch_snapshot'] == old['snapshot']
    assert {'broadcom-offline', 'nvidia-offline'}.issubset(manifest['capabilities'])
    return manifest


def graceful_stop(vm, privileged, timeout=45):
    # Poweroff may terminate the requesting shell before it prints a command
    # status. Require QMP's fresh guest-shutdown event and the owned QEMU
    # process's real exit status; the live ISO need not log its kernel to serial.
    process = vm.process
    started = time.monotonic()
    deadline = started + timeout
    event = {'boot': vm.boot_count, 'qemu_pid': process.pid, 'started_at': time.time(),
             'status': 'failed', 'command_status': None, 'serial_eof': False,
             'qmp_before_request': [], 'qmp_after_request': []}
    output = bytearray()
    qmp_timeout = vm.qmp.gettimeout()

    def remaining():
        value = deadline - time.monotonic()
        if value <= 0:
            raise TimeoutError('Guest shutdown exceeded its bounded deadline')
        return value

    def qmp_message():
        # Read the file object's buffer even after QEMU exits; select() on the
        # socket alone cannot account for messages already buffered by readline.
        vm.qmp.settimeout(remaining())
        line = vm.qmp_file.readline(65537)
        assert len(line) <= 65536, 'Oversized QMP shutdown message'
        return json.loads(line) if line else None

    try:
        assert process.poll() is None, 'QEMU had already exited before shutdown request'
        # Old buffered bytes and earlier boots' log entries cannot prove this
        # shutdown. Drain pending console output before sending the request.
        while select.select([vm.serial], [], [], 0)[0]:
            remaining()
            chunk = vm.serial.recv(65536)
            assert chunk, 'Serial was disconnected before shutdown request'
            vm.log.write(chunk)
        event['serial_offset'] = vm.log.tell()
        # A correlated response separates earlier events from this request,
        # including events already read into qmp_file's buffer by other probes.
        barrier = uuid.uuid4().hex
        vm.qmp.sendall((json.dumps({'execute': 'query-status', 'id': barrier}) + '\n').encode())
        while True:
            message = qmp_message()
            assert message is not None, 'QMP disconnected before shutdown request'
            event['qmp_before_request'].append(message)
            if message.get('id') == barrier:
                status = message.get('return', {})
                assert 'error' not in message and status.get('running') is True and status.get('status') == 'running', 'Guest was not running before shutdown'
                break
        assert process.poll() is None, 'QEMU exited before shutdown request'
        marker = 'HN_POWEROFF_' + uuid.uuid4().hex
        command = ('sudo -n ' if privileged else '') + 'systemctl --no-block poweroff'
        event['command'] = command
        vm.send('(' + command + f"); hn_poweroff_status=$?; printf '\\n{marker}:%s\\n' \"$hn_poweroff_status\"\n")
        while not event['serial_eof']:
            if select.select([vm.serial], [], [], min(1, remaining()))[0]:
                chunk = vm.serial.recv(65536)
                if not chunk:
                    event['serial_eof'] = True
                    break
                vm.log.write(chunk)
                output.extend(chunk)
                match = re.search(rb'\r?\n' + marker.encode() + rb':(\d+)\r?\n', output)
                if match:
                    event['command_status'] = int(match.group(1))
                    assert event['command_status'] == 0, 'Guest poweroff command failed'
        # Drain QMP through EOF as well, retaining its exact events independently
        # of serial-console configuration and the timing of the child exit.
        while True:
            message = qmp_message()
            if message is None:
                break
            event['qmp_after_request'].append(message)
        event['qemu_exit_status'] = process.wait(timeout=remaining())
        assert event['qemu_exit_status'] == 0, 'QEMU did not exit cleanly'
        event['guest_power_down'] = bool(re.search(rb'\[\s*[0-9.]+\]\s+reboot: Power down(?:\r?\n|$)', output))
        shutdown = [row for row in event['qmp_after_request'] if row.get('event') == 'SHUTDOWN']
        assert len(shutdown) == 1, 'Missing or ambiguous fresh QMP shutdown event'
        event['guest_shutdown'] = shutdown[0].get('data', {})
        assert event['guest_shutdown'].get('guest') is True and event['guest_shutdown'].get('reason') == 'guest-shutdown', 'QEMU exit was not a guest shutdown'
        assert not any(row.get('event') in ('RESET', 'GUEST_PANICKED') for row in event['qmp_after_request']), 'Guest reset or panicked during shutdown'
        event['status'] = 'passed'
    except BaseException as error:
        event['error'] = repr(error)
        raise
    finally:
        event['qemu_exit_status'] = process.poll()
        event['seconds'] = round(time.monotonic() - started, 3)
        event['serial_tail'] = output[-2000:].decode(errors='replace')
        with (vm.folder / 'shutdown-events.jsonl').open('a') as log:
            log.write(json.dumps(event) + '\n')
        vm.qmp.settimeout(qmp_timeout)
    vm.stop()
    return event


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--snapshot-lock', type=Path, default=Path(__file__).with_name('hardware-update.lock.json'))
    parser.add_argument('--candidate-system', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('os/test-results/hardware-update'))
    args = parser.parse_args()
    assert os.uname().machine == 'x86_64' and os.access('/dev/kvm', os.R_OK | os.W_OK), 'Native x86 KVM is required'
    lock = json.loads(args.snapshot_lock.read_text())
    validate_lock(lock)
    manifest = verify_image(args.iso.resolve(), lock)
    candidate = candidate_record(args.candidate_system)
    assert candidate['path'] == 'os/system.py', 'Only the OS update/recovery helper may be overlaid'
    boot_helper = args.candidate_system.with_name('boot_profile.py')
    boot_candidate = candidate_record(boot_helper)
    assert boot_candidate['path'] == 'os/boot_profile.py'
    assert boot_candidate['source_commit'] == candidate['source_commit']
    sources = {name: candidate_record(Path(__file__).with_name(name)) for name in
               ('hardware_update_vm.py', 'hardware_update_guest.py',
                'vm.py', 'footprint_vm.py', 'hardware_install_vm.py')}
    sources['lock'] = candidate_record(args.snapshot_lock)
    assert sources['lock']['path'] == 'os/tests/hardware-update.lock.json'
    sources['workflow'] = candidate_record(Path(__file__).resolve().parents[2] / '.github/workflows/os.yml')
    assert {row['source_commit'] for row in sources.values()} == {candidate['source_commit']}
    folder = args.output.resolve()
    folder.mkdir(parents=True, exist_ok=False)
    assert shutil.disk_usage(folder).free >= 12 * 1024**3, 'This installed snapshot/rollback gate needs 12 GiB free'
    vm = VM(folder, args.iso.resolve(), 'uefi', 2048, 'usb')
    config = dict(username='me', password='test-password-123', encrypt=True)
    receipt = {'status': 'running', 'started_at': time.time(), 'image_source_commit': manifest['source_commit'],
               'image_run_id': lock['baseline']['image_run_id'], 'iso': lock['baseline']['iso'],
               'candidate_system': candidate, 'candidate_boot_profile': boot_candidate,
               'test_sources': sources, 'memory_mib': 2048, 'firmware': 'uefi',
               'limits': ['Full-upgrade API, not public Update UI activation.',
                          'Synthetic PCI selection and real software hooks, no physical radio or GPU.',
                          'Combined driver row does not prove NVIDIA-only dependency footprint.',
                          'Offline checkpoint recovery, not a power-cut atomicity experiment.'], 'phases': {}}

    def timeout(_signum, _frame):
        raise TimeoutError('Changed-kernel gate exceeded its 1200 second budget')

    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(1200)

    def authenticate():
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')

    def transfer(live):
        # Serial transfer keeps installation and recovery completely offline.
        prefix = '/run' if live else '/tmp'
        for source, name in [(Path(__file__).with_name('hardware_update_guest.py'), 'hardware-update-guest.py'),
                             (args.snapshot_lock, 'hardware-update-lock.json')]:
            copy_file(vm, source.read_bytes(), prefix + '/' + name)
        return prefix

    def guest(phase, before=None, live=False, extra=(), seconds=90):
        prefix = '/run' if live else '/tmp'
        destination = prefix + '/hardware-update/' + phase + '.json'
        command = ([] if live or phase.startswith(('live-', 'project-')) or phase == 'fresh-agent' else ['sudo', '-n'])
        command += ['python3', prefix + '/hardware-update-guest.py', phase,
                    '--lock', prefix + '/hardware-update-lock.json', '--output', destination]
        if before is not None:
            copy_file(vm, json.dumps(before).encode(), prefix + '/hardware-update-before.json')
            command += ['--before', prefix + '/hardware-update-before.json']
        command += list(extra)
        started = time.monotonic()
        output, status = vm.command(shlex.join(command), timeout=seconds, check=False)
        (folder / (phase + '.log')).write_text(output)
        assert status == 0, phase + ' failed; see its full log and serial.log'
        result = json.loads(vm.read_file(destination))
        (folder / (phase + '.json')).write_text(json.dumps(result, indent=2) + '\n')
        probe = 'pre-reboot' if phase == 'update' else phase
        if probe in ('baseline', 'pre-reboot', 'candidate', 'recovered'):
            for suffix in ('.partial.json', '.initramfs.txt', '.initramfs-early.txt', '.initramfs-main.txt'):
                name = probe + suffix
                (folder / name).write_bytes(vm.read_file(prefix + '/hardware-update/' + name))
        receipt['phases'][phase] = {'seconds': round(time.monotonic() - started, 3), 'status': 'passed'}
        return result

    def installed_boot(label):
        vm.start(live=False)
        vm.login_installed(config)
        authenticate()
        transfer(False)
        vm.command('mkdir -p /tmp/hardware-update')
        vm.command('test "$(systemctl --user is-enabled harness-update.timer)" = masked && '
                   'test "$(systemctl --user is-enabled harness-update.service)" = masked')
        receipt[label + '_keyboard'] = check_graphical_keyboard(vm, label)
        vm.boot_diagnostics(config, label)

    try:
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ', timeout=180)
        vm.shell_ready = True
        vm.command('stty -echo; nmcli networking off')
        transfer(True)
        copy_file(vm, args.candidate_system.read_bytes(), '/run/system-candidate.py')
        copy_file(vm, boot_helper.read_bytes(), '/run/boot_profile.py')
        receipt['installation'] = guest('install', live=True, extra=('--candidate-system', '/run/system-candidate.py'), seconds=360)
        assert receipt['installation']['candidate_system_sha256'] == candidate['sha256']
        vm.screenshot('01-installed-offline')
        graceful_stop(vm, False)

        installed_boot('baseline')
        assert hashlib.sha256(vm.read_file('/usr/lib/harness-os/boot_profile.py')).hexdigest() == boot_candidate['sha256']
        baseline = guest('baseline')
        assert baseline['system_sha256'] == candidate['sha256']
        live = guest('live-start')
        # Ensure connectivity for the full update after checking runtime masks
        # and identities. Installed boot may already have enabled networking;
        # baseline.json records that state. Install/recovery are explicitly offline.
        vm.command('sudo -n nmcli networking on && nm-online -q --timeout=60')
        transaction = guest('update', before=baseline, seconds=650)
        before_reboot = json.loads(vm.read_file('/tmp/hardware-update/pre-reboot.json'))
        (folder / 'pre-reboot.json').write_text(json.dumps(before_reboot, indent=2) + '\n')
        validate_transition(baseline, before_reboot)
        receipt['live_processes'] = guest('live-check', before=live)
        receipt['apply_keyboard'] = check_graphical_keyboard(vm, 'applied')
        project = guest('project-edit', before=transaction)
        receipt['checkpoint'] = transaction['checkpoint']
        receipt['checkpoint_sha256'] = transaction['checkpoint_sha256']
        authenticate()
        vm.command('sudo -n cp /var/log/pacman.log /tmp/hardware-update/pacman.log && '
                   'sudo -n chmod -R a+rX /tmp/hardware-update')
        (folder / 'pacman.log').write_bytes(vm.read_file('/tmp/hardware-update/pacman.log'))
        vm.screenshot('02-applied-before-reboot')
        graceful_stop(vm, True)

        installed_boot('candidate')
        updated = guest('candidate')
        validate_transition(baseline, updated)
        assert updated['boot'] == before_reboot['boot'] and updated['modules'] == before_reboot['modules']
        assert guest('project-state') == project
        receipt['candidate_agent'] = guest('fresh-agent')
        (folder / 'candidate-project.json').write_text(json.dumps(project, indent=2) + '\n')
        receipt['candidate_kernel'] = updated['running_kernel']
        # Explicit cold boot boundary: old PIDs are not compared after this point.
        authenticate()
        graceful_stop(vm, True)

        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ', timeout=180)
        vm.shell_ready = True
        vm.command('stty -echo; nmcli networking off')
        original = hashlib.sha256(vm.read_file(str(Path('/usr/lib/harness-os/system.py')))).hexdigest()
        assert original == receipt['installation']['image_system_sha256']
        copy_file(vm, args.candidate_system.read_bytes(), '/usr/lib/harness-os/system.py')
        copy_file(vm, boot_helper.read_bytes(), '/usr/lib/harness-os/boot_profile.py')
        assert hashlib.sha256(vm.read_file('/usr/lib/harness-os/boot_profile.py')).hexdigest() == boot_candidate['sha256']
        receipt['recovery_system_sha256'] = hashlib.sha256(vm.read_file('/usr/lib/harness-os/system.py')).hexdigest()
        assert receipt['recovery_system_sha256'] == candidate['sha256']
        vm.command('printf %s ' + shlex.quote(config['password']) + ' | cryptsetup open --key-file=- /dev/vda3 hn-recovery')
        # No inspection mounts: production recover validates and mounts the real
        # root/boot identities itself, then restores @ while preserving @home.
        started = time.monotonic()
        output, status = vm.command('hn-os recover /dev/mapper/hn-recovery ' +
                                    shlex.quote(transaction['checkpoint']['name']), timeout=180, check=False)
        (folder / 'offline-recovery.log').write_text(output)
        assert status == 0, 'Offline recovery failed; see offline-recovery.log'
        receipt['phases']['offline-recovery'] = {'status': 'passed', 'seconds': round(time.monotonic() - started, 3)}
        vm.command('cryptsetup close hn-recovery')
        graceful_stop(vm, False)

        installed_boot('recovered')
        restored = guest('recovered')
        receipt['recovered_agent'] = guest('fresh-agent')
        # project-state is recorded separately on each boot; no old process IDs
        # are treated as evidence of functionality after a real reboot.
        post = guest('project-state')
        validate_recovery(baseline, restored, transaction, project, post)
        checkpoint_path = '/.snapshots/' + transaction['checkpoint']['name'] + '/checkpoint.json'
        vm.command('sudo -n cp ' + shlex.quote(checkpoint_path) + ' /tmp/original-checkpoint.json && sudo -n chmod a+r /tmp/original-checkpoint.json')
        assert hashlib.sha256(vm.read_file('/tmp/original-checkpoint.json')).hexdigest() == transaction['checkpoint_sha256']
        receipt['restored_kernel'] = restored['running_kernel']
        receipt['post_checkpoint_project'] = post
        receipt['status'] = 'passed'
        graceful_stop(vm, True)
    except BaseException as error:
        receipt.update(status='failed', error=repr(error))
        try:
            vm.screenshot('failure')
            diagnostics, _ = vm.command('cat /var/log/pacman.log; dkms status; systemctl --failed --no-pager', timeout=20, check=False)
            (folder / 'failure-diagnostics.log').write_text(diagnostics)
            names = ['transaction.json'] + [phase + suffix for phase in ('baseline', 'pre-reboot', 'candidate', 'recovered')
                    for suffix in ('.json', '.partial.json', '.initramfs.txt', '.initramfs-early.txt', '.initramfs-main.txt')]
            for name in names:
                remote = '/tmp/hardware-update/' + name
                _, exists = vm.command('test -r ' + shlex.quote(remote), timeout=5, check=False)
                if exists == 0:
                    (folder / ('failure-' + name)).write_bytes(vm.read_file(remote, timeout=15))
        except Exception:
            pass
        raise
    finally:
        signal.alarm(0)
        receipt['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        vm.stop()
        vm.log.close()
        vm.stderr.close()
        vm.control.cleanup()


if __name__ == '__main__':
    main()
