#!/usr/bin/env python3
"""Observe locking and suspend/resume on a disposable installed Harness machine."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time
from vm import VM


PROBE = '''import os, pathlib, sys, threading, time
root = pathlib.Path.home() / 'Projects/session-probe'
root.mkdir(exist_ok=True)
(root / 'pid').write_text(str(os.getpid()))
(root / 'input').write_text('')
def heartbeat():
    while True:
        (root / 'heartbeat').write_text(str(time.time_ns()))
        time.sleep(0.2)
threading.Thread(target=heartbeat, daemon=True).start()
print('HARNESS VISIBLE LOCK PROBE', flush=True)
for line in sys.stdin:
    with (root / 'input').open('a') as output: output.write(line)
    print('received: ' + line.rstrip(), flush=True)
'''


def put(vm, path, data):
    encoded = base64.b64encode(data.encode()).decode()
    scratch = shlex.quote(path + '.base64')
    vm.command(': > ' + scratch)
    for start in range(0, len(encoded), 1800):
        vm.command('printf %s ' + encoded[start:start + 1800] + ' >> ' + scratch)
    vm.command('base64 -d ' + scratch + ' > ' + shlex.quote(path) + ' && rm ' + scratch)


def screen_text(vm, name):
    vm.screenshot(name)
    text = subprocess.check_output(['tesseract', str(vm.folder / (name + '.png')), 'stdout', '--psm', '11'],
                                   text=True, stderr=subprocess.DEVNULL, timeout=10)
    (vm.folder / (name + '.txt')).write_text(text)
    return ' '.join(text.lower().split())


def wait_lock(vm, locked, timeout=15):
    # -f returns only after the compositor acknowledges the lock, then its child
    # calls setsid(). A matching process alone includes the pre-lock parent/PAM
    # helper and can race the screen and keyboard grab.
    command = ("ps -u 1000 -o pid=,sid=,comm= | awk '$1 == $2 && $3 == \"swaylock\" {ready=1} END {exit !ready}'"
               if locked else '! pgrep -u 1000 -x swaylock >/dev/null')
    vm.command('for n in $(seq 1 ' + str(timeout * 4) + '); do if ' + command + '; then exit 0; fi; sleep 0.25; done; exit 1', timeout=timeout + 5)


def live_lock(vm, user):
    """No password has been chosen on the USB; a lock must not strand the user."""
    results = []
    for name, trigger in [('shortcut', lambda: vm.keys('meta_l', 'l')),
                          ('idle-event', lambda: vm.command('pkill -USR1 -u 1000 -x swayidle'))]:
        print('Checking live ' + name, flush=True)
        trigger()
        time.sleep(1)
        _, status = vm.command('pgrep -u 1000 -x swaylock', check=False)
        if status == 0:
            vm.screenshot('live-' + name + '-locked')
            vm.keys('ret')
            wait_lock(vm, False, timeout=10)
            results.append(name + ': live password lock exited after Enter with the empty live password')
        else:
            results.append(name + ': no password lock remained active on the passwordless live account')
    vm.command(user('systemctl --user is-active --quiet hn-screen'))
    vm.screenshot('live-after-lock-probe')
    return results


def installed_session(vm, config, result):
    put(vm, '/tmp/harness-session-probe.py', PROBE)
    vm.command('hn new-window -n session-probe ' + shlex.quote('python3 /tmp/harness-session-probe.py'))
    vm.command('for n in $(seq 1 60); do test -s ~/Projects/session-probe/pid && test -s ~/Projects/session-probe/heartbeat && exit 0; sleep 0.25; done; exit 1')
    vm.command('cp ~/Projects/session-probe/pid /tmp/session-original-pid')
    time.sleep(1)
    assert 'visible lock probe' in screen_text(vm, 'session-before-lock'), 'The visible terminal probe was not rendered'
    accepted = []

    def work_survives():
        vm.command('test "$(cat ~/Projects/session-probe/pid)" = "$(cat /tmp/session-original-pid)" && kill -0 "$(cat /tmp/session-original-pid)"')
        vm.command('before=$(cat ~/Projects/session-probe/heartbeat); sleep 0.5; test "$before" != "$(cat ~/Projects/session-probe/heartbeat)"')
        expected = ''.join(word + '\n' for word in accepted)
        expression = ('from pathlib import Path; import time\n'
            'p = Path.home()/"Projects/session-probe/input"\n'
            'expected = ' + repr(expected) + '\n'
            'deadline = time.monotonic() + 3\n'
            'while p.read_text() != expected and time.monotonic() < deadline: time.sleep(.05)\n'
            'actual = p.read_text()\n'
            'assert actual == expected, (repr(actual), repr(expected))')
        vm.command('python3 -c ' + shlex.quote(expression))

    def unlock(name):
        wait_lock(vm, True)
        assert 'visible lock probe' not in screen_text(vm, name + '-locked'), 'Locked screen exposed terminal content'
        # These must go to the lock, never to the terminal or its agent.
        for label, keys in [('escape', ('esc',)), ('interrupt', ('ctrl', 'c')), ('clear', ('ctrl', 'u'))]:
            vm.keys(*keys)
            wait_lock(vm, True, timeout=2)
            work_survives()
            vm.screenshot(name + '-after-' + label)
        vm.type_probe('wrong-password')
        vm.keys('ret')
        time.sleep(4)
        wait_lock(vm, True)
        work_survives()
        vm.screenshot(name + '-wrong-password')
        vm.keys('ctrl', 'u')
        vm.type_probe(config['password'])
        vm.keys('ret')
        wait_lock(vm, False)
        deadline = time.monotonic() + 10
        while 'visible lock probe' not in screen_text(vm, name + '-unlocked'):
            if time.monotonic() >= deadline:
                raise AssertionError('Unlock did not restore the terminal')
            time.sleep(.25)
        work_survives()
        word = 'accepted-' + name
        vm.type_probe(word)
        vm.keys('ret')
        accepted.append(word)
        time.sleep(0.5)
        work_survives()
        vm.screenshot(name + '-accepted-input')

    vm.keys('meta_l', 'l')
    print('Checking installed manual lock', flush=True)
    unlock('manual')
    result['checks'].append('Super+L hides the terminal, rejects a wrong password and Esc/Ctrl+C, accepts the account password, and does not leak lock input into the running terminal')
    vm.command('systemctl --user is-active --quiet harness-idle && pkill -USR1 -u 1000 -x swayidle')
    print('Checking installed idle lock', flush=True)
    unlock('idle')
    result['checks'].append('The idle event runs the same working password lock; the test sends SIGUSR1 rather than waiting ten minutes')
    capabilities = vm.monitor('query-current-machine')
    assert capabilities.get('wakeup-suspend-support'), 'The test machine does not support QMP wake from suspend'
    output, _ = vm.command('cat /sys/power/state /sys/power/mem_sleep; systemd-inhibit --list --no-pager')
    (vm.folder / 'sleep-capabilities.txt').write_text(output)
    started = time.monotonic()
    print('Checking actual ACPI suspend and wake', flush=True)
    vm.command('sudo systemctl suspend --no-block')
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        status = vm.monitor('query-status')
        if status['status'] == 'suspended':
            break
        time.sleep(0.25)
    else:
        raise RuntimeError('The guest did not reach ACPI suspend; last QMP status: ' + json.dumps(status))
    result['suspend_seconds'] = round(time.monotonic() - started, 3)
    vm.screenshot('sleep-suspended')
    vm.monitor('system_wakeup')
    resumed = time.monotonic()
    # QMP acknowledges CPU wake before the guest UART is ready. Do not send a
    # command into its short hardware FIFO while the serial driver is resuming.
    # Only blank lines are retried; a real shell prompt acknowledges input.
    deadline = time.monotonic() + 30
    while True:
        vm.send('\n')
        try:
            vm.wait(r'\[me@harness [^\r\n]*\]\$ ', timeout=2)
            break
        except TimeoutError:
            if time.monotonic() >= deadline:
                raise TimeoutError('The guest serial console did not resume within 30 seconds')
    vm.command('true', timeout=60)
    unlock('resume')
    result['resume_check_seconds_including_wrong_password_and_automated_typing'] = round(time.monotonic() - resumed, 3)
    output, _ = vm.command('sudo journalctl -b -u systemd-suspend.service --no-pager; journalctl --user -b -u harness-idle --no-pager')
    (vm.folder / 'sleep-journal.log').write_text(output)
    result['checks'].append('Guest actually enters ACPI suspend and wakes through QMP; it resumes locked and the same terminal process, input and project survive password unlock')
    vm.command('hn kill-window')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--firmware', choices=['bios', 'uefi'], required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--video', choices=['VGA', 'virtio-vga'], default='VGA',
                        help='QEMU display; bochs VGA has suspend/resume callbacks in the pinned LTS kernel')
    parser.add_argument('--session-file', type=Path,
                        help='Explicitly test this candidate launcher over the verified base ISO; records its hash and reboots before checking')
    args = parser.parse_args()
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        parser.error('Use native x86 KVM for session and suspend acceptance.')
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    with iso.open('rb') as handle:
        assert hashlib.file_digest(handle, 'sha256').hexdigest() == manifest['iso']['sha256']
    folder = (args.output or Path('os/test-results') / (args.firmware + '-session')).resolve()
    folder.mkdir(parents=True, exist_ok=False)
    vm = VM(folder, iso, args.firmware, 2048, video=args.video)
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123',
                  encrypt=args.firmware == 'uefi', serial_console=True)
    result = {'status': 'running', 'scope': 'password lock, input isolation and virtual ACPI suspend/resume',
              'firmware': args.firmware, 'encrypted': config['encrypt'], 'memory_mib': 2048,
              'video': args.video,
              'iso_sha256': manifest['iso']['sha256'], 'image_source_commit': manifest['source_commit'],
              'test_source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
              'started_at_unix': time.time(), 'checks': []}
    user = lambda command: 'runuser -u me -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus ' + command
    try:
        print('Booting the verified image for live-session checks', flush=True)
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ')
        vm.shell_ready = True
        vm.command('stty -echo')
        vm.command(user('/usr/lib/harness-os/wait-runtime'))
        vm.command(user('systemctl --user is-active --quiet hn-screen harness-idle'))
        time.sleep(2)
        try:
            result['live_lock_observations'] = live_lock(vm, user)
        except Exception as error:
            result['live_lock_error'] = str(error)
            vm.screenshot('live-lock-failure')
            # Recover this disposable fixture so installed locking can still be diagnosed.
            vm.command('pkill -u 1000 -x swaylock || true')
        put(vm, '/tmp/install-config.json', json.dumps(config))
        vm.command('nmcli networking off')
        print('Installing offline into the disposable test disk', flush=True)
        output, _ = vm.command('harness install --config /tmp/install-config.json --yes-erase-disk', timeout=360)
        (folder / 'install.log').write_text(output)
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        print('Booting the installed session', flush=True)
        vm.login_installed(config)
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
        tty_probe = "sudo -n stty -a -F /dev/tty1; ps -u 1000 -o pid,ppid,sid,tpgid,tty,comm --width 200"
        output, _ = vm.command(tty_probe)
        (folder / 'base-console-state.txt').write_text(output)
        if args.session_file:
            candidate = args.session_file.read_bytes()
            result['candidate_session'] = {'path': str(args.session_file), 'sha256': hashlib.sha256(candidate).hexdigest(),
                'scope': 'Only /usr/lib/harness-os/session replaced in disposable installed guest; other files are the verified base image'}
            put(vm, '/tmp/session-candidate', candidate.decode())
            vm.command('test "$(sha256sum /tmp/session-candidate | cut -d " " -f 1)" = ' + shlex.quote(result['candidate_session']['sha256']))
            vm.command('sudo install -o root -g root -m 755 /tmp/session-candidate /usr/lib/harness-os/session; sync')
            vm.stop()
            vm.start(live=False)
            vm.login_installed(config)
            vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
            output, _ = vm.command(tty_probe)
            (folder / 'candidate-console-state.txt').write_text(output)
        installed_session(vm, config, result)
        assert 'live_lock_error' not in result, 'The unconfigured live session could not be unlocked'
        result['status'] = 'passed'
    except BaseException as error:
        result['status'] = 'failed'
        result['error'] = str(error)
        try:
            vm.screenshot('failure')
            if vm.shell_ready:
                output, _ = vm.command('sudo -n journalctl -b -o short-monotonic --no-pager; '
                    'cat ~/.local/state/harness-os/display.log; ps -eo pid,ppid,sid,comm,args --width 240; '
                    'cat /sys/class/drm/card*-*/status /sys/class/drm/card*-*/dpms; '
                    'sudo -n sh -c "cat /sys/kernel/debug/dri/*/state"; '
                    'cat ~/Projects/session-probe/input',
                    check=False, timeout=15)
                (folder / 'session-diagnostics.log').write_text(output)
        except Exception:
            pass
        raise
    finally:
        result['finished_at_unix'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
        vm.stop()


if __name__ == '__main__':
    main()
