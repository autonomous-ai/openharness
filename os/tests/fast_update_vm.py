"""Keyboard acceptance on the installed VM, using real private test releases."""
import json
import shlex
import subprocess
import time
from session_vm import put, screen_text, PROBE


def wait_text(vm, text, name, status_bar=False):
    def observed():
        if not status_bar:
            return screen_text(vm, name)
        # Full-screen OCR skips this small status text. Include foot's bottom
        # padding so the crop retains the complete glyphs, not just their tails.
        from PIL import Image
        vm.screenshot(name)
        with Image.open(vm.folder / (name + '.png')) as frame:
            bar = frame.crop((0, frame.height - 32, frame.width, frame.height))
            bar.resize((bar.width * 3, bar.height * 3)).save(vm.folder / (name + '-bar.png'))
        result = subprocess.check_output(['tesseract', str(vm.folder / (name + '-bar.png')),
                                         'stdout', '--psm', '7'], text=True,
                                         stderr=subprocess.DEVNULL, timeout=10)
        (vm.folder / (name + '-bar.txt')).write_text(result)
        return ' '.join(result.lower().split())

    deadline = time.monotonic() + 25
    while text.lower() not in observed():
        if time.monotonic() > deadline:
            raise AssertionError('Missing update screen: ' + text)
        time.sleep(.25)


def exercise(vm, fixture, host_url):
    # Observe the actual curses event and hit targets without changing mouse
    # modes, coordinates or dispatch. This runs only in the disposable guest;
    # restore the packaged module before the separate system-channel checks.
    source_path = '/usr/lib/harness-os/live_update.py'
    original = vm.read_file(source_path).decode()
    marker = '                _, x, y, _, buttons = curses.getmouse()\n'
    assert original.count(marker) == 1
    traced = original.replace(marker, marker +
        "                with open('/tmp/harness-update-mouse.jsonl', 'a') as trace:\n" +
        "                    trace.write(json.dumps(dict(x=x, y=y, buttons=buttons, targets=targets)) + '\\n')\n")
    put(vm, '/tmp/live-update-observed.py', traced)
    put(vm, '/tmp/live-update-packaged.py', original)
    vm.command('sudo install -m 755 /tmp/live-update-observed.py ' + source_path)
    vm.command('sudo nmcli networking on')
    vm.command('nm-online -q --timeout=30', timeout=35)
    vm.command('mkdir -p /tmp/fast-updates')
    for path in fixture.iterdir():
        if path.is_file():
            vm.command('curl --fail --silent --show-error --retry 2 --retry-connrefused --max-time 90 ' +
                shlex.quote(host_url + '/fast/' + path.name) + ' -o ' + shlex.quote('/tmp/fast-updates/' + path.name), timeout=100)
    vm.command('systemd-run --user --collect --unit=harness-test-feed python3 -m http.server 19447 '
               '--bind 127.0.0.1 --directory /tmp/fast-updates')
    vm.command('for n in $(seq 1 30); do curl -fsS http://127.0.0.1:19447/fixture.json && exit 0; sleep .2; done; exit 1')
    # Even though a source CLI reports 0.0.1, an already-included public version
    # must not replace it. The new 999.x fixture below must still be accepted.
    vm.command('harness updates check --feeds /tmp/fast-updates/feeds-ancestor.json', timeout=60)
    vm.command('test ! -e ~/.local/state/harness-os/updates/ready.json && test ! -e ~/.local/state/harness-os/updates/current')
    # The radio/network can remain off: only the loopback test release is used.
    vm.command('sudo nmcli networking off')
    put(vm, '/tmp/update-session-probe.py', PROBE)
    vm.command('hn new-window -n update-probe ' + shlex.quote('python3 /tmp/update-session-probe.py'))
    vm.command('for n in $(seq 1 40); do test -s ~/projects/session-probe/pid && exit 0; sleep .25; done; exit 1')
    vm.command('cp ~/projects/session-probe/pid /tmp/fast-original-pid; cat /proc/$(cat /tmp/fast-original-pid)/stat > /tmp/fast-original-stat')
    vm.command('systemctl --user show harness-daemon -p MainPID --value > /tmp/fast-original-daemon')
    vm.command('hn new-window -n live-agent opencode')
    vm.command('for n in $(seq 1 80); do pgrep -u 1000 -x opencode > /tmp/fast-original-agent && exit 0; sleep .25; done; exit 1')
    vm.command('cat /proc/sys/kernel/random/boot_id > /tmp/fast-original-boot')
    vm.command('hn hn-list-clients -F "#{session_id}" > /tmp/fast-visible-session')
    vm.command('mkdir -p ~/.config/systemd/user/harness-update.service.d ~/.config/systemd/user/harness-update.timer.d')
    put(vm, '/tmp/update-service.conf', '[Service]\nExecStart=\nExecStart=/usr/bin/python3 /usr/lib/harness-os/live_update.py check --feeds /tmp/fast-updates/feeds-hn.json\n')
    # systemd's default AccuracySec=1min can coalesce the one-second fixture
    # beyond its deadline. Keep the real timer path, with explicit test accuracy.
    put(vm, '/tmp/update-timer.conf', '[Timer]\nOnStartupSec=\nOnUnitInactiveSec=\nRandomizedDelaySec=0\nAccuracySec=100ms\nOnActiveSec=1s\n')
    vm.command('cp /tmp/update-service.conf ~/.config/systemd/user/harness-update.service.d/fixture.conf; '
               'cp /tmp/update-timer.conf ~/.config/systemd/user/harness-update.timer.d/fixture.conf; '
               'systemctl --user daemon-reload; systemctl --user restart harness-update.timer')
    state = '~/.local/state/harness-os/updates'
    vm.command('for n in $(seq 1 120); do test -s ' + state + '/ready.json && exit 0; sleep .5; done; '
               'sudo journalctl _UID=1000 _SYSTEMD_USER_UNIT=harness-update.service --no-pager; '
               'systemctl --user status harness-update.timer harness-update.service --no-pager; exit 1', timeout=75)
    # The installed OS uses hn's standard footer. Availability belongs to the
    # Updates screen, which must still expose the timer's staged release.
    vm.command('hn show-options -gv status-right > /tmp/fast-footer.txt')
    footer = vm.read_file('/tmp/fast-footer.txt').decode()
    assert 'local_machine' in footer and '%H:%M' in footer and '@harness-update' not in footer, footer
    # Opening the command screen permits inspection without starting an update.
    # The OS shortcut itself is the user's request to apply it immediately.
    vm.command("hn new-window -n Updates '/usr/bin/harness updates'")
    wait_text(vm, 'update available', 'fast-01-ready')
    vm.keys('esc')
    # Closing the shell is asynchronous. The OS shortcut reuses a named Updates
    # window, so reopening before its removal can select the closing window and
    # make OCR accept its old frame before the next Enter reaches a live screen.
    vm.command('for n in $(seq 1 80); do hn list-windows -F "#{window_name}" > /tmp/fast-windows.txt && '
               '! grep -Fx Updates /tmp/fast-windows.txt && exit 0; sleep .25; done; exit 1', timeout=30)
    checks = ['An already-included public CLI release is ignored before staging; independent newer hn and CLI releases remain eligible', 'User timer discovers, verifies and stages a real hn release without changing the running selection', 'Super+u shows the prepared update while the installed footer stays hn’s standard footer']
    vm.command('test ! -e ' + state + '/current')

    def alive(name):
        expression = '''from pathlib import Path
import time
pid = Path('/tmp/fast-original-pid').read_text().strip()
assert Path('/proc/'+pid+'/stat').read_text().split()[21] == Path('/tmp/fast-original-stat').read_text().split()[21]
root = Path.home() / 'projects/session-probe'
before = (root/'heartbeat').stat().st_mtime_ns
time.sleep(.6)
assert (root/'heartbeat').stat().st_mtime_ns != before
'''
        vm.command('python3 -c ' + shlex.quote(expression))
        vm.command('while read -r pid; do kill -0 "$pid" || exit 1; done < /tmp/fast-original-agent; '
                   'cmp /tmp/fast-original-boot /proc/sys/kernel/random/boot_id')
        vm.command('hn hn-list-clients -F "#{session_id}" > /tmp/fast-restored-session; '
                   'cmp /tmp/fast-visible-session /tmp/fast-restored-session')
        vm.command('for n in $(seq 1 80); do hn select-window -t update-probe && exit 0; sleep .25; done; exit 1')
        wait_text(vm, 'visible lock probe', name + '-restored')
        vm.type_probe(name)
        vm.keys('ret')
        vm.command('for n in $(seq 1 30); do grep -Fx ' + shlex.quote(name) +
                   ' ~/projects/session-probe/input && exit 0; sleep .1; done; exit 1')
        vm.screenshot(name + '-accepted-input')

    def activate(expect_failure=False, mouse=False):
        if mouse:
            vm.command("hn select-window -t Updates || hn new-window -n Updates '/usr/bin/harness updates'")
            wait_text(vm, 'update available', 'fast-02-update-action')
            vm.click_word('fast-02-click-update', 'Update')
        else:
            vm.keys('meta_l', 'u')
        condition = ('grep -q ' + shlex.quote('"status": "failed"') + ' ' + state + '/transaction.json' if expect_failure else
                     'test ! -e ' + state + '/ready.json && test -s ' + state + '/applied.json')
        try:
            vm.command('for n in $(seq 1 120); do ' + condition + ' && systemctl --user is-active --quiet hn-screen && exit 0; sleep .5; done; '
                       'sudo journalctl _UID=1000 --no-pager; exit 1', timeout=90)
        finally:
            if mouse:
                vm.command('touch /tmp/harness-update-mouse.jsonl')
                observed = vm.read_file('/tmp/harness-update-mouse.jsonl')
                (vm.folder / 'update-mouse-events.log').write_bytes(observed)
        if mouse:
            events = [json.loads(line) for line in observed.splitlines()]
            assert any(event['y'] == row and left <= event['x'] < right and action == 'update'
                       for event in events for row, left, right, action in event['targets']), \
                'The actual curses mouse event did not reach the Update hit target'

    # A real systemd start failure for the new binary must restore the old
    # selection and layout. The fault is a private guest-only unit override.
    vm.command('mkdir -p ~/.config/systemd/user/hn-screen.service.d')
    put(vm, '/tmp/hn-fail-new-screen.sh', '#!/bin/sh\n/usr/bin/hn --version | grep -q "hn 999.0.1 " && exit 1\nexit 0\n')
    put(vm, '/tmp/hn-screen-fault.conf', '[Service]\nExecStartPre=/bin/sh /tmp/hn-fail-new-screen.sh\n')
    vm.command('cp /tmp/hn-screen-fault.conf ~/.config/systemd/user/hn-screen.service.d/fixture.conf; systemctl --user daemon-reload')
    activate(expect_failure=True)
    vm.command('test ! -e ' + state + '/current; ! hn --version | grep -F "999.0.1"')
    alive('failed-update-restored')
    checks.append('A real new-screen start failure restores the previous binary and visible tabs while the same agent and terminal remain alive')
    vm.command('rm ~/.config/systemd/user/hn-screen.service.d/fixture.conf; systemctl --user daemon-reload')

    activate(mouse=True)
    vm.command('hn --version | grep -F "999.0.1"')
    vm.command('test "$(systemctl --user show harness-daemon -p MainPID --value)" = "$(cat /tmp/fast-original-daemon)"')
    alive('hn-update')
    checks.append('Clicking Update activates the real new hn binary with no confirmation; daemon PID, live OpenCode, terminal PID, keyboard input and boot ID survive')
    # Add a CLI release through the same channel, independently of hn's version.
    vm.command('harness updates check --feeds /tmp/fast-updates/feeds-both.json', timeout=90)
    activate()
    vm.command('test "$(harness version)" = 999.0.1')
    vm.command('test "$(systemctl --user show harness-daemon -p MainPID --value)" != "$(cat /tmp/fast-original-daemon)"')
    alive('cli-update')
    checks.append('Super+u alone activates a separate CLI release while the same OpenCode and terminal processes remain alive')
    vm.command('systemd-run --user --collect --unit=harness-test-rollback /usr/bin/python3 /usr/lib/harness-os/live_update.py rollback')
    vm.command('for n in $(seq 1 120); do test "$(harness version)" != 999.0.1 && '
               'systemctl --user is-active --quiet hn-screen && exit 0; sleep .5; done; exit 1', timeout=90)
    alive('after-rollback')
    checks.append('Rollback restores the prior CLI while retaining the fast hn release, live agent and terminal input')
    output, _ = vm.command('harness updates status; systemctl --user status harness-update.timer --no-pager; '
                           'sudo journalctl _UID=1000 --no-pager')
    (vm.folder / 'fast-updates.log').write_text(output)
    vm.command('sudo install -m 755 /tmp/live-update-packaged.py ' + source_path)
    receipt = {'status': 'passed', 'fixture': json.loads((fixture / 'fixture.json').read_text()), 'checks': checks}
    (vm.folder / 'fast-update-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt
