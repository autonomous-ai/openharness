#!/usr/bin/env python3
"""Measure unchanged payloads in fresh, offline 1 GiB USB installations."""
import base64
import hashlib
import json
from pathlib import Path
import shlex
import time

from vm import VM, check_graphical_keyboard


# Run inside the disposable guest. Sample the whole guest, including decompressor
# caches, rather than presenting the host's extraction RSS as machine memory use.
INSTALL_PROBE = '''import json, os, resource, signal, subprocess, time
from pathlib import Path
samples = []
failure = None
started = time.monotonic()
before = resource.getrusage(resource.RUSAGE_CHILDREN)
with open('/tmp/compression-install.log', 'wb') as log:
    child = subprocess.Popen(['harness', 'install', '--config', '/tmp/compression-config.json',
                              '--yes-erase-disk'], stdout=log, stderr=subprocess.STDOUT,
                             start_new_session=True)
    try:
        while child.poll() is None:
            fields = {k: int(v.split()[0]) for k, v in (line.split(':', 1)
                      for line in Path('/proc/meminfo').read_text().splitlines())}
            samples.append(dict(seconds=round(time.monotonic() - started, 3),
                used_kib=fields['MemTotal']-fields['MemAvailable'],
                available_kib=fields['MemAvailable'],
                swap_used_kib=fields['SwapTotal']-fields['SwapFree']))
            if time.monotonic() - started > 600:
                raise TimeoutError('Offline installation exceeded ten minutes')
            time.sleep(.25)
    except BaseException as error:
        failure = repr(error)
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
after = resource.getrusage(resource.RUSAGE_CHILDREN)
Path('/tmp/compression-install.json').write_text(json.dumps(dict(
    exit_status=child.returncode, error=failure, wall_seconds=time.monotonic()-started,
    user_seconds=after.ru_utime-before.ru_utime, system_seconds=after.ru_stime-before.ru_stime,
    samples=samples)))
raise SystemExit(child.returncode)
'''


def run_trial(iso, folder, firmware):
    folder.mkdir(parents=True, exist_ok=False)
    result = dict(status='running', started_at=time.time(), firmware=firmware,
                  memory_mib=1024, cpu='Nehalem', live_transport='usb', network='disconnected')
    vm = VM(folder, iso, firmware, 1024, 'usb', 'Nehalem')
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123',
                  encrypt=firmware == 'uefi', serial_console=True)
    user = lambda cmd: ('runuser -u me -- env XDG_RUNTIME_DIR=/run/user/1000 '
                        'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus ' + cmd)
    project = b'Compression must preserve the trial project.\n'
    try:
        vm.start(live=True)
        if vm.acceleration != 'kvm':
            raise RuntimeError('Native KVM is required for the comparison')
        vm.monitor('set_link', name='hnnet', up=False)
        vm.wait(r'root@[^\r\n]*[#] ')
        vm.shell_ready = True
        vm.command('stty -echo')
        vm.command(user('/usr/lib/harness-os/wait-runtime'), timeout=160)
        vm.command(user('sh -c ' + shlex.quote(
            'for n in $(seq 1 60); do hn capture-pane -p | '
            'grep -q "Connect to start with an agent" && exit 0; sleep .25; done; exit 1')))
        result['live_harness_ready_seconds'] = round(time.monotonic() - vm.started, 3)
        vm.command('! pgrep -x chromium && ! pgrep -x opencode')
        vm.screenshot('live-network')
        vm.command('nmcli networking off')
        # Check the recompressed media's actual payload checksum in the guest.
        vm.command('cd /run/archiso/bootmnt/arch/x86_64 && sha512sum -c airootfs.sha512', timeout=90)
        vm.command(user('sh -c ' + shlex.quote('mkdir -p "$HOME/Projects/compression"; printf %s ' +
            shlex.quote(base64.b64encode(project).decode()) +
            ' | base64 -d > "$HOME/Projects/compression/retained.txt"')))
        for name, data in [('config.json', json.dumps(config).encode()),
                           ('probe.py', INSTALL_PROBE.encode())]:
            encoded = base64.b64encode(data).decode()
            vm.command(': > /tmp/compression-' + name + '.b64')
            for offset in range(0, len(encoded), 2000):
                vm.command('printf %s ' + encoded[offset:offset + 2000] +
                           ' >> /tmp/compression-' + name + '.b64')
            vm.command('base64 -d /tmp/compression-' + name + '.b64 > /tmp/compression-' + name)
        # The integrity read above must not give one compression level a larger
        # guest page-cache head start. Host cache state is recorded as uncontrolled.
        vm.command('sync; echo 3 > /proc/sys/vm/drop_caches')
        _, status = vm.command('python3 /tmp/compression-probe.py', timeout=650, check=False)
        (folder / 'install.log').write_bytes(vm.read_file('/tmp/compression-install.log'))
        measured = vm.read_file('/tmp/compression-install.json')
        (folder / 'install-measurements.json').write_bytes(measured)
        result['installation'] = json.loads(measured)
        samples = result['installation'].pop('samples')
        assert status == result['installation']['exit_status'] == 0, 'Offline installation failed'
        assert samples, 'Installation produced no memory samples'
        result['installation'].update(peak_used_mib=max(r['used_kib'] for r in samples) / 1024,
            minimum_available_mib=min(r['available_kib'] for r in samples) / 1024,
            peak_swap_used_mib=max(r['swap_used_kib'] for r in samples) / 1024,
            sample_count=len(samples))
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        vm.monitor('set_link', name='hnnet', up=False)
        vm.login_installed(config)
        result['installed_harness_ready_seconds_including_test_login'] = round(time.monotonic()-vm.started, 3)
        if config['encrypt']:
            result['unlock_prompt_seconds'] = vm.unlock_prompt_seconds
        result['keyboard'] = check_graphical_keyboard(vm, 'compression')
        assert vm.read_file('/home/me/Projects/compression/retained.txt') == project
        vm.command('test ! -e /etc/harness-live && ! pgrep -x chromium && ! pgrep -x opencode')
        # A new disk/boot per trial prevents page-cache reuse inside the guest.
        vm.command('sleep 20; hn-os measure > /tmp/compression-idle.json', timeout=35)
        result['idle'] = json.loads(vm.read_file('/tmp/compression-idle.json'))
        result['install_receipt'] = json.loads(vm.read_file('/var/lib/harness-os/install.json'))
        vm.screenshot('installed-home')
        vm.boot_diagnostics(config, 'installed')
        result.update(status='passed', trial_project_sha256=hashlib.sha256(project).hexdigest())
    except BaseException as error:
        result.update(status='failed', error=repr(error))
        try:
            vm.screenshot('failure')
        except Exception:
            pass
        raise
    finally:
        vm.stop()
        vm.log.close()
        vm.stderr.close()
        vm.control.cleanup()
        # Only large files owned by this disposable VM are discarded.
        for path in [vm.disk, getattr(vm, 'usb', None)]:
            if path is not None:
                path.unlink(missing_ok=True)
        result['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
    return result
