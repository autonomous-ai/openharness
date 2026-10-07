#!/usr/bin/env python3
"""Observe locking, suspend or compositor recovery on a disposable installed machine."""
import argparse
import base64
import gzip
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
root = pathlib.Path.home() / 'projects/session-probe'
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
    # The lock's marker is written only once the compositor acknowledges the lock
    # (gtklock's lock command, usr/lib/harness-os/lock). A matching process alone
    # includes the pre-lock parent and can race the screen and keyboard grab.
    command = ('pgrep -u 1000 -x gtklock >/dev/null && test -e /run/user/1000/harness-os-locked'
               if locked else '! pgrep -u 1000 -x gtklock >/dev/null')
    vm.command('for n in $(seq 1 ' + str(timeout * 4) + '); do if ' + command + '; then exit 0; fi; sleep 0.25; done; exit 1', timeout=timeout + 5)


def live_lock(vm, user):
    """No password has been chosen on the USB; a lock must not strand the user."""
    results = []
    for name, trigger in [('shortcut', lambda: vm.keys('meta_l', 'l')),
                          ('idle-event', lambda: vm.command('pkill -USR1 -u 1000 -x swayidle'))]:
        print('Checking live ' + name, flush=True)
        trigger()
        time.sleep(1)
        _, status = vm.command('pgrep -u 1000 -x gtklock', check=False)
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
    vm.command('for n in $(seq 1 60); do test -s ~/projects/session-probe/pid && test -s ~/projects/session-probe/heartbeat && exit 0; sleep 0.25; done; exit 1')
    vm.command('cp ~/projects/session-probe/pid /tmp/session-original-pid')
    time.sleep(1)
    assert 'visible lock probe' in screen_text(vm, 'session-before-lock'), 'The visible terminal probe was not rendered'
    accepted = []

    def work_survives():
        vm.command('test "$(cat ~/projects/session-probe/pid)" = "$(cat /tmp/session-original-pid)" && kill -0 "$(cat /tmp/session-original-pid)"')
        vm.command('before=$(cat ~/projects/session-probe/heartbeat); sleep 0.5; test "$before" != "$(cat ~/projects/session-probe/heartbeat)"')
        expected = ''.join(word + '\n' for word in accepted)
        expression = ('from pathlib import Path; import time\n'
            'p = Path.home()/"projects/session-probe/input"\n'
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


def installed_recovery(vm, config, result):
    """Crash only the disposable guest compositor, preserving real running work."""
    vm.command('mkdir -p ~/projects/recovery-agent; printf %s recovery-project > ~/projects/recovery-agent/proof.txt')
    agent = 'echo $$ > /tmp/harness-recovery-agent-pid; cd ~/projects/recovery-agent; exec opencode'
    vm.command('hn new-window -n recovery-agent ' + shlex.quote(agent))
    vm.command('for n in $(seq 1 80); do p=$(cat /tmp/harness-recovery-agent-pid 2>/dev/null) && '
               'test "$(cat /proc/$p/comm 2>/dev/null)" = opencode && exit 0; sleep .25; done; exit 1', timeout=30)
    put(vm, '/tmp/harness-recovery-probe.py', PROBE.replace('LOCK PROBE', 'RECOVERY PROBE'))
    vm.command('hn new-window -n recovery-probe ' + shlex.quote('python3 /tmp/harness-recovery-probe.py'))
    vm.command('for n in $(seq 1 40); do test -s ~/projects/session-probe/heartbeat && '
               'test -s ~/projects/session-probe/pid && exit 0; sleep .25; done; exit 1')
    observer = '''from pathlib import Path
import hashlib, json, subprocess, sys, time
root = Path.home() / 'projects/session-probe'
def identity(pid):
    process = Path('/proc') / str(pid)
    return {'pid': pid, 'start_ticks': (process/'stat').read_text().rsplit(')', 1)[1].split()[19],
            'executable': str((process/'exe').resolve(strict=True))}
pids = {'terminal': int((root/'pid').read_text()),
        'agent': int(Path('/tmp/harness-recovery-agent-pid').read_text()),
        'daemon': int(subprocess.check_output(['systemctl', '--user', 'show',
                    'harness-daemon.service', '-p', 'MainPID', '--value'], text=True))}
snapshot = {'processes': {name: identity(pid) for name, pid in pids.items()},
            'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'project_sha256': hashlib.sha256((Path.home()/'projects/recovery-agent/proof.txt').read_bytes()).hexdigest()}
baseline = Path('/tmp/harness-recovery-baseline.json')
if sys.argv[1] == 'record':
    baseline.write_text(json.dumps(snapshot, indent=2)+'\\n')
else:
    assert snapshot == json.loads(baseline.read_text()), 'Running work or project identity changed'
    expected = json.loads(sys.argv[2])
    deadline = time.monotonic()+5
    while (root/'input').read_text() != expected and time.monotonic() < deadline: time.sleep(.05)
    assert (root/'input').read_text() == expected, 'Keyboard input did not reach the surviving terminal'
    before = (root/'heartbeat').read_text()
    time.sleep(.5)
    assert (root/'heartbeat').read_text() != before, 'Terminal heartbeat stopped'
print(json.dumps(snapshot))
'''
    put(vm, '/tmp/harness-recovery-state.py', observer)
    vm.command('python3 /tmp/harness-recovery-state.py record')
    baseline = json.loads(vm.read_file('/tmp/harness-recovery-baseline.json'))
    result['surviving_work'] = baseline
    accepted = ''

    def type_and_check(name):
        nonlocal accepted
        vm.command('hn select-window -t recovery-probe')
        deadline = time.monotonic() + 15
        while 'visible recovery probe' not in screen_text(vm, name):
            if time.monotonic() >= deadline:
                raise AssertionError('The recovery terminal was not visible: ' + name)
            time.sleep(.25)
        vm.type_probe(name)
        vm.keys('ret')
        accepted += name + '\n'
        output, _ = vm.command('python3 /tmp/harness-recovery-state.py check ' + shlex.quote(json.dumps(accepted)))
        (vm.folder / (name + '-processes.txt')).write_text(output)
        vm.screenshot(name + '-accepted')

    type_and_check('recovery-before-crash')
    print('Crashing the installed compositor while an agent and terminal remain active', flush=True)
    vm.command('pkill -KILL -u "$(id -u)" -x labwc')
    # An arbitrary hn process is not proof that the visible fallback accepts
    # commands. Require the actual client responding on tty1, then type there.
    vm.command('for n in $(seq 1 120); do '
               'p=$(hn display-message -p "#{client_pid}" 2>/dev/null) || p=; '
               'case "$p" in ""|*[!0-9]*) ;; *) '
               'if test "$(readlink /proc/$p/fd/0)" = /dev/tty1; then exit 0; fi ;; esac; '
               'sleep .25; done; exit 1', timeout=40)
    vm.command('! pgrep -u "$(id -u)" -x labwc && ! pgrep -u "$(id -u)" -x foot')
    type_and_check('recovery-console')
    result['checks'].append('A killed installed compositor falls back to a responsive hn console; the same OpenCode, daemon, terminal and project survive and real keyboard input reaches that terminal')
    print('Restoring graphics without restarting the computer or agent', flush=True)
    vm.command('sudo systemctl restart getty@tty1.service')
    if not config['encrypt']:
        deadline = time.monotonic() + 20
        while 'login:' not in screen_text(vm, 'recovery-console-login'):
            if time.monotonic() >= deadline:
                raise AssertionError('The unencrypted installed console did not offer login')
            time.sleep(.25)
        vm.type_probe(config['username'])
        vm.keys('ret')
        deadline = time.monotonic() + 10
        while 'password:' not in screen_text(vm, 'recovery-console-password'):
            if time.monotonic() >= deadline:
                raise AssertionError('The restored console did not request its account password')
            time.sleep(.25)
        vm.type_probe(config['password'])
        vm.keys('ret')
    vm.command('for n in $(seq 1 160); do '
               'if systemctl --user is-active --quiet hn-screen && pgrep -u "$(id -u)" -x labwc >/dev/null && '
               'pgrep -u "$(id -u)" -x foot >/dev/null; then '
               'p=$(hn display-message -p "#{client_pid}" 2>/dev/null) || p=; '
               'case "$p" in ""|*[!0-9]*) ;; *) '
               'case "$(readlink /proc/$p/fd/0)" in /dev/pts/*) exit 0 ;; esac ;; esac; fi; '
               'sleep .25; done; exit 1', timeout=50)
    type_and_check('recovery-graphics')
    result['checks'].append('Restoring the installed graphical session preserves the same agent, daemon and terminal process identities, boot ID and project; real keyboard input works again in foot')
    result['keyboard_input'] = accepted.splitlines()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--firmware', choices=['bios', 'uefi'], required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--check', choices=['lock', 'recovery'], default='lock',
                        help='Run the existing lock/suspend check or the separate compositor recovery check')
    parser.add_argument('--video', choices=['VGA', 'virtio-vga'], default='VGA',
                        help='QEMU display; bochs VGA has suspend/resume callbacks in the pinned LTS kernel')
    parser.add_argument('--session-file', type=Path,
                        help='Explicitly test this candidate launcher over the verified base ISO; records its hash and reboots before checking')
    parser.add_argument('--theme-directory', type=Path,
                        help='Explicitly test the candidate Plymouth theme after regenerating the installed initramfs')
    parser.add_argument('--compositor-file', type=Path,
                        help='Private labwc proof only: stage a manifest-verified compositor and reboot before testing')
    args = parser.parse_args()
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        parser.error('Use native x86 KVM for session acceptance.')
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    with iso.open('rb') as handle:
        assert hashlib.file_digest(handle, 'sha256').hexdigest() == manifest['iso']['sha256']
    folder = (args.output or Path('os/test-results') /
              (args.firmware + ('-session' if args.check == 'lock' else '-recovery'))).resolve()
    folder.mkdir(parents=True, exist_ok=False)
    vm = VM(folder, iso, args.firmware, 2048, video=args.video)
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123',
                  encrypt=args.firmware == 'uefi', serial_console=True)
    result = {'status': 'running', 'scope': ('password lock, input isolation and virtual ACPI suspend/resume'
              if args.check == 'lock' else 'installed compositor crash, console fallback and graphical recovery'),
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
        if args.check == 'lock' and 'install-first' not in manifest.get('capabilities', []):
            vm.command(user('/usr/lib/harness-os/wait-runtime'))
            vm.command(user('systemctl --user is-active --quiet hn-screen harness-idle'))
            time.sleep(2)
            try:
                result['live_lock_observations'] = live_lock(vm, user)
            except Exception as error:
                result['live_lock_error'] = str(error)
                vm.screenshot('live-lock-failure')
                # Recover this disposable fixture so installed locking can still be diagnosed.
                vm.command('pkill -u 1000 -x gtklock || true')
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
        if args.compositor_file:
            candidate = args.compositor_file.read_bytes()
            manifest = json.loads(args.compositor_file.with_name('manifest.json').read_text())
            checksum = hashlib.sha256(candidate).hexdigest()
            assert manifest['binary']['sha256'] == checksum
            assert manifest['binary']['bytes'] == len(candidate)
            assert candidate[:6] == b'\x7fELF\x02\x01' and int.from_bytes(candidate[18:20], 'little') == 62
            assert manifest['source_commit'] == result['test_source_commit']
            result['candidate_compositor'] = manifest
            packed = base64.b64encode(gzip.compress(candidate, mtime=0)).decode()
            put(vm, '/tmp/lock-compositor.gz.b64', packed)
            vm.command('base64 -d /tmp/lock-compositor.gz.b64 | gzip -d > /tmp/lock-compositor && '
                       'test "$(sha256sum /tmp/lock-compositor | cut -d " " -f 1)" = ' + shlex.quote(checksum) + ' && '
                       'sudo install -o root -g root -m 755 /tmp/lock-compositor /usr/bin/labwc && sync')
        if args.session_file:
            candidate = args.session_file.read_bytes()
            result['candidate_session'] = {'path': str(args.session_file), 'sha256': hashlib.sha256(candidate).hexdigest(),
                'scope': 'Only /usr/lib/harness-os/session replaced in disposable installed guest; other files are the verified base image'}
            put(vm, '/tmp/session-candidate', candidate.decode())
            vm.command('test "$(sha256sum /tmp/session-candidate | cut -d " " -f 1)" = ' + shlex.quote(result['candidate_session']['sha256']))
            vm.command('sudo install -o root -g root -m 755 /tmp/session-candidate /usr/lib/harness-os/session; sync')
        if args.theme_directory and config['encrypt']:
            result['candidate_theme'] = {'path': str(args.theme_directory), 'files': {}}
            for name in ['harness.plymouth', 'harness.script']:
                candidate = (args.theme_directory / name).read_bytes()
                checksum = hashlib.sha256(candidate).hexdigest()
                result['candidate_theme']['files'][name] = checksum
                put(vm, '/tmp/' + name, candidate.decode())
                vm.command('test "$(sha256sum /tmp/' + name + ' | cut -d " " -f 1)" = ' + shlex.quote(checksum))
                vm.command('sudo install -o root -g root -m 644 /tmp/' + name + ' /usr/share/plymouth/themes/harness/' + name)
            output, _ = vm.command('sudo mkinitcpio -P && sudo lsinitcpio -l /boot/initramfs-linux-lts.img | grep -E "Plymouth.*ttf|harness\\.(script|plymouth)"', timeout=180)
            (folder / 'candidate-initramfs.txt').write_text(output)
        if args.session_file or args.compositor_file or (args.theme_directory and config['encrypt']):
            # VM.stop is a power cut, not an orderly guest shutdown. Flush the
            # rebuilt initramfs before testing that exact candidate at boot.
            vm.command('sync')
            vm.stop()
            vm.start(live=False)
            vm.login_installed(config)
            vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
            output, _ = vm.command(tty_probe)
            (folder / 'candidate-console-state.txt').write_text(output)
        if args.check == 'recovery':
            installed_recovery(vm, config, result)
        else:
            installed_session(vm, config, result)
            from session_update_vm import screenshots
            screenshots(vm, result)
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
                    'cat ~/projects/session-probe/input',
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
