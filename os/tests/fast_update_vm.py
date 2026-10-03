"""Keyboard acceptance on the installed VM, using real private test releases."""
import json
import shlex
import time
from session_vm import put, screen_text, PROBE


def wait_text(vm, text, name):
    deadline = time.monotonic() + 25
    while text.lower() not in screen_text(vm, name):
        if time.monotonic() > deadline:
            raise AssertionError('Missing update screen: ' + text)
        time.sleep(.25)


def exercise(vm, fixture, host_url):
    vm.command('sudo nmcli networking on')
    vm.command('mkdir -p /tmp/fast-updates')
    for path in fixture.iterdir():
        if path.is_file():
            vm.command('curl --fail --silent --show-error --retry 2 --max-time 90 ' +
                shlex.quote(host_url + '/fast/' + path.name) + ' -o ' + shlex.quote('/tmp/fast-updates/' + path.name), timeout=100)
    vm.command('systemd-run --user --collect --unit=harness-test-feed python3 -m http.server 19447 '
               '--bind 127.0.0.1 --directory /tmp/fast-updates')
    vm.command('for n in $(seq 1 30); do curl -fsS http://127.0.0.1:19447/fixture.json && exit 0; sleep .2; done; exit 1')
    # The radio/network can remain off: only the loopback test release is used.
    vm.command('sudo nmcli networking off')
    put(vm, '/tmp/update-session-probe.py', PROBE)
    vm.command('hn new-window -n update-probe ' + shlex.quote('python3 /tmp/update-session-probe.py'))
    vm.command('for n in $(seq 1 40); do test -s ~/Projects/session-probe/pid && exit 0; sleep .25; done; exit 1')
    vm.command('cp ~/Projects/session-probe/pid /tmp/fast-original-pid; cat /proc/$(cat /tmp/fast-original-pid)/stat > /tmp/fast-original-stat')
    vm.command('systemctl --user show harness-daemon -p MainPID --value > /tmp/fast-original-daemon')
    vm.command('hn new-window -n live-agent opencode')
    vm.command('for n in $(seq 1 80); do pgrep -u 1000 -x opencode > /tmp/fast-original-agent && exit 0; sleep .25; done; exit 1')
    vm.command('cat /proc/sys/kernel/random/boot_id > /tmp/fast-original-boot')
    vm.command('mkdir -p ~/.config/systemd/user/harness-update.service.d ~/.config/systemd/user/harness-update.timer.d')
    put(vm, '/tmp/update-service.conf', '[Service]\nExecStart=\nExecStart=/usr/bin/python3 /usr/lib/harness-os/live_update.py check --feeds /tmp/fast-updates/feeds-hn.json\n')
    put(vm, '/tmp/update-timer.conf', '[Timer]\nOnStartupSec=\nOnUnitInactiveSec=\nRandomizedDelaySec=0\nOnActiveSec=1s\n')
    vm.command('cp /tmp/update-service.conf ~/.config/systemd/user/harness-update.service.d/fixture.conf; '
               'cp /tmp/update-timer.conf ~/.config/systemd/user/harness-update.timer.d/fixture.conf; '
               'systemctl --user daemon-reload; systemctl --user restart harness-update.timer')
    state = '~/.local/state/harness-os/updates'
    vm.command('for n in $(seq 1 120); do test -s ' + state + '/ready.json && exit 0; sleep .5; done; '
               'journalctl --user -u harness-update --no-pager; exit 1', timeout=75)
    wait_text(vm, 'update ready', 'fast-01-notice')
    checks = ['User timer discovers, verifies and stages a real hn release without changing the running selection']
    vm.command('test ! -e ' + state + '/current')

    def alive(name):
        expression = '''from pathlib import Path
import time
pid = Path('/tmp/fast-original-pid').read_text().strip()
assert Path('/proc/'+pid+'/stat').read_text().split()[21] == Path('/tmp/fast-original-stat').read_text().split()[21]
root = Path.home() / 'Projects/session-probe'
before = (root/'heartbeat').stat().st_mtime_ns
time.sleep(.6)
assert (root/'heartbeat').stat().st_mtime_ns != before
'''
        vm.command('python3 -c ' + shlex.quote(expression))
        vm.command('while read -r pid; do kill -0 "$pid" || exit 1; done < /tmp/fast-original-agent; '
                   'cmp /tmp/fast-original-boot /proc/sys/kernel/random/boot_id')
        vm.command('hn select-window -t update-probe')
        wait_text(vm, 'visible lock probe', name + '-restored')
        vm.type_probe(name)
        vm.keys('ret')
        vm.command('for n in $(seq 1 30); do grep -Fx ' + shlex.quote(name) +
                   ' ~/Projects/session-probe/input && exit 0; sleep .1; done; exit 1')
        vm.screenshot(name + '-accepted-input')

    def activate():
        vm.keys('meta_l', 'u')
        wait_text(vm, 'an update is ready', 'fast-02-update-action')
        vm.keys('ret')
        vm.command('for n in $(seq 1 120); do test ! -e ' + state + '/ready.json && test -s ' + state +
                   '/applied.json && systemctl --user is-active --quiet hn-screen && exit 0; sleep .5; done; '
                   'journalctl --user -u harness-apply-update --no-pager; exit 1', timeout=90)

    activate()
    vm.command('hn --version | grep -F "999.0.1"')
    vm.command('test "$(systemctl --user show harness-daemon -p MainPID --value)" = "$(cat /tmp/fast-original-daemon)"')
    alive('hn-update')
    checks.append('Super+U and Enter activate the real new hn binary; daemon PID, live OpenCode, terminal PID, keyboard input and boot ID survive')
    # Add a CLI release through the same channel, independently of hn's version.
    vm.command('harness updates check --feeds /tmp/fast-updates/feeds-both.json', timeout=90)
    activate()
    vm.command('test "$(harness version)" = 999.0.1')
    vm.command('test "$(systemctl --user show harness-daemon -p MainPID --value)" != "$(cat /tmp/fast-original-daemon)"')
    alive('cli-update')
    checks.append('A separate CLI release restarts its supervised service while the same OpenCode and terminal processes remain alive')
    vm.command('systemd-run --user --collect --unit=harness-test-rollback /usr/bin/python3 /usr/lib/harness-os/live_update.py rollback')
    vm.command('for n in $(seq 1 120); do test "$(harness version)" != 999.0.1 && '
               'systemctl --user is-active --quiet hn-screen && exit 0; sleep .5; done; exit 1', timeout=90)
    alive('after-rollback')
    checks.append('Rollback restores the prior CLI while retaining the fast hn release, live agent and terminal input')
    output, _ = vm.command('harness updates status; systemctl --user status harness-update.timer --no-pager; '
                           'journalctl --user -u harness-update -u harness-apply-update -u harness-test-rollback --no-pager')
    (vm.folder / 'fast-updates.log').write_text(output)
    receipt = {'status': 'passed', 'fixture': json.loads((fixture / 'fixture.json').read_text()), 'checks': checks}
    (vm.folder / 'fast-update-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt
