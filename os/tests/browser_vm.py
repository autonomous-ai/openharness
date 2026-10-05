#!/usr/bin/env python3
"""Observe browser sizing, focus and actual input on a disposable installed disk."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import time
from PIL import Image
from footprint_vm import copy_file
from vm import VM
from session_vm import screen_text


class BrowserVM(VM):
    memory_profile = False

    def memory_snapshot(self, phase):
        if not self.memory_profile:
            return
        started = time.monotonic()
        path = '/tmp/harness-browser-memory-' + phase + '.json'
        self.command('sudo -n timeout 10 python3 /tmp/harness-browser-memory.py --phase ' +
                     shlex.quote(phase) + ' --output ' + shlex.quote(path), timeout=15)
        (self.folder / ('memory-' + phase + '.json')).write_bytes(self.read_file(path, timeout=15))
        self.memory_samples.append(dict(phase=phase, host_elapsed_seconds=time.monotonic() - started))

    def keys(self, *keys):
        # Use explicit press/release events. send-key's delayed release follows
        # the VM clock; a host sleep can finish while the guest is still holding
        # Ctrl during a memory-heavy browser startup. Never paste probe text.
        for down, sequence in [(True, keys), (False, reversed(keys))]:
            self.monitor('input-send-event', events=[
                {'type': 'key', 'data': {'down': down, 'key': {'type': 'qcode', 'data': key}}}
                for key in sequence])
            time.sleep(.06)


TERMINAL = '''import os, pathlib, sys
p = pathlib.Path('/tmp/harness-browser-probe')
(p/'terminal-pid').write_text(str(os.getpid()))
(p/'terminal-input').write_text('')
print('HARNESS BROWSER RETURN CHECK', flush=True)
for line in sys.stdin:
    with (p/'terminal-input').open('a') as out: out.write(line)
    print('received: ' + line.rstrip(), flush=True)
'''


def wait_command(vm, command, timeout=15):
    vm.command('timeout ' + str(timeout) + ' sh -c ' + shlex.quote(
        'until ' + command + '; do sleep .1; done'), timeout=timeout + 5)


def observe(vm, *args):
    return 'systemd-run --user --quiet --wait --pipe --collect /tmp/harness-wlrctl ' + shlex.join(args)


def focused(vm, app, name, timeout=15, title=None):
    started = time.monotonic()
    criteria = ['app_id:' + app, 'state:active']
    if title:
        criteria.append('title:' + title)
    # wlrctl 0.2.2's contains_value rejects enum zero, which is the Wayland
    # maximized state. Observe focus here; actual page pixels independently
    # verify display coverage instead of trusting that broken query.
    wait_command(vm, observe(vm, 'toplevel', 'find', *criteria), timeout)
    vm.screenshot(name)
    return round(time.monotonic() - started, 3)


def new_tab_ready(vm, name):
    # For Ctrl+n the old browser can still be active until the new window maps.
    # Wait for that window's own title and its painted toolbar before typing.
    focused(vm, 'chromium', name, timeout=45, title='New Tab - Chromium')
    deadline = time.monotonic() + 15
    while 'new tab' not in screen_text(vm, name):
        assert time.monotonic() < deadline, 'The new browser window has not painted'
        time.sleep(.1)


def state(vm, *, path=None, value=None, ready=False, timeout=10):
    filename = 'states.json' if path is not None else 'state.json'
    expression = 'import json; d=json.load(open("/tmp/harness-browser-probe/' + filename + '")); '
    if path is not None:
        expression += 'd=d[' + repr(path) + ']; '
        expression += 'assert d["path"] == ' + repr(path) + '; '
    if value is not None:
        expression += 'assert d["input"] == ' + repr(value) + '; '
    if ready:
        expression += 'assert d["focused"] and d["inputFocused"] and d["outerWidth"] > 0; '
    wait_command(vm, 'python3 -c ' + shlex.quote(expression), timeout)
    data = json.loads(vm.read_file('/tmp/harness-browser-probe/' + filename))
    return data[path] if path is not None else data


def page_fills_display(vm, name):
    # Read the actual rendered page, independently from the compositor's state.
    # Below Chromium's toolbar the fixture color must reach both sides and bottom.
    # A white frame can be Chromium's previous blank tab, before this page paints.
    # HTTP load/input events can precede the next compositor frame. Observe a
    # bounded render deadline, retaining every sample rather than assuming that
    # receiving the page's event means its pixels are already on the display.
    started = time.monotonic()
    while True:
        vm.screenshot(name)
        with Image.open(vm.folder / (name + '.png')).convert('RGB') as frame:
            width, height = frame.size
            positions = [(3, height//2), (width-4, height//2), (3, height-4), (width-4, height-4)]
            pixels = [frame.getpixel(position) for position in positions]
        with (vm.folder / 'display-coverage.jsonl').open('a') as log:
            log.write(json.dumps(dict(frame=name, seconds=time.monotonic()-started, pixels=pixels)) + '\n')
        if all(all(abs(actual - expected) <= 3 for actual, expected in zip(pixel, (230, 245, 236)))
               for pixel in pixels):
            return
        assert time.monotonic() - started < 5, (positions, pixels)
        time.sleep(.1)


def install_zram_candidate(vm, config, source, result):
    # Change only the private test disk, before its first installed boot. Do
    # not swapoff a running low-memory workspace to apply a startup setting.
    assert config['disk'] == '/dev/vda' and config['expected_serial'] == 'HN_OS_TEST'
    vm.command('test -f /etc/harness-live && test "$(lsblk -dn -o SERIAL /dev/vda)" = HN_OS_TEST')
    data = source.read_bytes()
    copy_file(vm, data, '/tmp/harness-zram-candidate')
    root_device = '/dev/vda3'
    if config['encrypt']:
        vm.command('printf %s ' + shlex.quote(config['password']) +
                   ' | cryptsetup open --key-file=- /dev/vda3 hn-browser-candidate')
        root_device = '/dev/mapper/hn-browser-candidate'
    mounted = False
    try:
        vm.command('mkdir -p /mnt/harness-browser-candidate && mount -o subvol=@ ' +
                   root_device + ' /mnt/harness-browser-candidate')
        mounted = True
        vm.command('test -f /mnt/harness-browser-candidate/var/lib/harness-os/install.json')
        target = '/etc/systemd/zram-generator.conf'
        base = vm.read_file('/mnt/harness-browser-candidate' + target)
        result['candidates'][target] = dict(source=str(source), sha256=hashlib.sha256(data).hexdigest(),
                                            original_sha256=hashlib.sha256(base).hexdigest(), changed=data != base)
        vm.command('install -m 644 /tmp/harness-zram-candidate /mnt/harness-browser-candidate' + target)
        vm.command('sync')
    finally:
        if mounted:
            vm.command('umount /mnt/harness-browser-candidate')
        if config['encrypt']:
            vm.command('dmsetup remove --deferred --noudevsync hn-browser-candidate')


def check_browser(vm, result):
    vm.command('! pgrep -u "$(id -u)" -x chromium')
    result['checks'].append('Browser is absent on installed boot')
    vm.memory_snapshot('workspace')
    vm.command('mkdir -p /tmp/harness-browser-probe')
    copy_file(vm, TERMINAL.encode(), '/tmp/harness-browser-terminal.py')
    copy_file(vm, Path(__file__).with_name('browser_guest.py').read_bytes(), '/tmp/harness-browser-page.py')
    vm.command('systemd-run --user --quiet --collect --unit=harness-browser-probe python3 /tmp/harness-browser-page.py')
    wait_command(vm, 'curl --fail --silent http://127.0.0.1:18782/ >/dev/null')
    vm.command('hn new-window -n browser-check ' + shlex.quote('python3 /tmp/harness-browser-terminal.py'))
    wait_command(vm, 'test -s /tmp/harness-browser-probe/terminal-pid')
    focused(vm, 'hn', 'terminal-before-browser')
    accepted = []

    def terminal(word):
        vm.type_probe(word)
        vm.keys('ret')
        accepted.append(word + '\n')
        wait_command(vm, 'python3 -c ' + shlex.quote('from pathlib import Path; '
            'assert Path("/tmp/harness-browser-probe/terminal-input").read_text() == ' + repr(''.join(accepted))))
        vm.command('kill -0 "$(cat /tmp/harness-browser-probe/terminal-pid)"')

    terminal('before-browser')
    vm.keys('meta_l', 'b')
    result['cold_start_seconds_including_observer'] = focused(vm, 'chromium', 'browser-shortcut-cold', timeout=45)
    new_tab_ready(vm, 'browser-shortcut-ready')
    vm.keys('ctrl', 'l')
    vm.type_probe('http://127.0.0.1:18782/first')
    vm.keys('ret')
    result['page'] = state(vm, path='/first')
    page_fills_display(vm, 'browser-page-full-display')
    # Select the actual rendered input label as a user would. HTML autofocus on
    # first navigation is asynchronous and is not the OS focus contract.
    vm.click_word('browser-input-click', 'Keyboard')
    state(vm, path='/first', ready=True)
    vm.type_probe('browser')
    state(vm, value='browser')
    vm.memory_snapshot('first-page')
    result['checks'].append('Super+b cold-starts a maximized browser; its local page fills the display and receives real keyboard input')
    result['toggles'] = []
    for index in range(4):
        vm.keys('meta_l', 'b')
        to_terminal = focused(vm, 'hn', 'toggle-terminal-' + str(index))
        terminal('terminal-' + str(index))
        state(vm, value='browser' + 'x'*index)
        vm.keys('meta_l', 'b')
        to_browser = focused(vm, 'chromium', 'toggle-browser-' + str(index))
        state(vm, ready=True)
        vm.type_probe('x')
        state(vm, value='browser' + 'x'*(index+1))
        page_fills_display(vm, 'toggle-full-display-' + str(index))
        result['toggles'].append(dict(to_terminal_seconds=to_terminal, to_browser_seconds=to_browser))
    result['checks'].append('Repeated Super+b switching routes keyboard input only to the intended surface and preserves the terminal process and browser input')
    vm.memory_snapshot('after-toggles')
    vm.keys('meta_l', 'ret')
    focused(vm, 'hn', 'explicit-request-terminal')
    terminal('before-explicit-request')
    # An explicit URL from an agent/terminal must display its result even while
    # the existing browser is behind the fullscreen terminal.
    vm.command('hn-browser http://127.0.0.1:18782/second')
    focused(vm, 'chromium', 'explicit-url-browser')
    state(vm, path='/second')
    page_fills_display(vm, 'explicit-url-full-display')
    vm.click_word('first-window-input', 'Keyboard')
    state(vm, path='/second', ready=True)
    vm.type_probe('window-one')
    state(vm, path='/second', value='window-one')
    vm.memory_snapshot('second-page')
    result['checks'].append('An explicit hn-browser URL raises the already running browser from behind Harness')
    vm.keys('ctrl', 'n')
    new_tab_ready(vm, 'new-browser-window')
    vm.keys('ctrl', 'l')
    vm.type_probe('http://127.0.0.1:18782/new-window')
    vm.keys('ret')
    state(vm, path='/new-window')
    page_fills_display(vm, 'new-window-full-display')
    vm.click_word('second-window-input', 'Keyboard')
    state(vm, path='/new-window', ready=True)
    vm.type_probe('window-two')
    state(vm, path='/new-window', value='window-two')
    vm.keys('meta_l', 'b')
    focused(vm, 'hn', 'two-window-terminal')
    terminal('with-two-browser-windows')
    vm.keys('meta_l', 'b')
    focused(vm, 'chromium', 'two-window-return', title='Harness browser check /new-window - Chromium')
    state(vm, path='/new-window', value='window-two', ready=True)
    vm.type_probe('-returned')
    state(vm, path='/new-window', value='window-two-returned')
    state(vm, path='/second', value='window-one')
    vm.memory_snapshot('two-window-return')
    result['checks'].append('With two browser windows open, Super+b returns to the window the user left and typing leaves the other window unchanged')
    vm.keys('ctrl', 'shift', 'w')
    focused(vm, 'chromium', 'original-browser-restored')
    vm.keys('ctrl', 'shift', 'w')
    focused(vm, 'hn', 'browser-closed-terminal')
    terminal('after-browser-close')
    wait_command(vm, '! pgrep -u "$(id -u)" -x chromium')
    vm.keys('meta_l', 'b')
    new_tab_ready(vm, 'browser-reopened')
    vm.keys('ctrl', 'l')
    vm.type_probe('http://127.0.0.1:18782/reopened')
    vm.keys('ret')
    state(vm, path='/reopened')
    page_fills_display(vm, 'reopened-full-display')
    vm.keys('meta_l', 'b')
    focused(vm, 'hn', 'browser-final-return')
    terminal('after-browser-reopen')
    vm.memory_snapshot('reopened')
    result['checks'].append('New browser windows maximize; close and reopen restores working keyboard focus without losing the terminal')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--firmware', choices=['bios', 'uefi'], required=True)
    parser.add_argument('--memory-mib', type=int, choices=[1024, 2048, 4096], default=1024)
    parser.add_argument('--wlrctl', type=Path, required=True)
    parser.add_argument('--browser-script', type=Path, required=True)
    parser.add_argument('--compositor-config', type=Path, required=True)
    parser.add_argument('--memory-profile', action='store_true',
                        help='Capture finite read-only memory snapshots; separate from ordinary focus acceptance')
    parser.add_argument('--zram-config', type=Path,
                        help='Overlay this startup configuration on the private installed disk before boot')
    args = parser.parse_args()
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        parser.error('Native x86 KVM is required')
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    with iso.open('rb') as handle:
        assert hashlib.file_digest(handle, 'sha256').hexdigest() == manifest['iso']['sha256']
    folder = Path(f'os/test-results/{args.firmware}-browser').resolve()
    folder.mkdir(parents=True, exist_ok=False)
    vm = BrowserVM(folder, iso, args.firmware, args.memory_mib, cpu='Nehalem')
    vm.memory_samples = []
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda', username='me',
                  hostname='harness', password='test-password-123', encrypt=args.firmware == 'uefi', serial_console=True)
    result = dict(status='running', started_at=time.time(), checks=[], firmware=args.firmware,
                  image_source_commit=manifest['source_commit'], iso_sha256=manifest['iso']['sha256'],
                  test_source_commit=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
                  memory_mib=args.memory_mib, candidates={},
                  memory_profile=args.memory_profile, cpu='Nehalem', display='virtio-vga (2D)',
                  memory_samples=vm.memory_samples,
                  observer=dict(sha256=hashlib.sha256(args.wlrctl.read_bytes()).hexdigest(),
                                version=subprocess.check_output([str(args.wlrctl),'--version'],text=True).strip()),
                  limitations=['Only the recorded candidate files replace packaged files in the disposable guest.',
                               'Native virtual display and physical-keyboard events; not a physical laptop or GPU claim.',
                               'Observer and screenshot overhead are included in transition timings.'])
    try:
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ', timeout=180)
        vm.shell_ready = True
        vm.command('stty -echo')
        copy_file(vm, json.dumps(config).encode(), '/tmp/install-config.json')
        vm.command('nmcli networking off')
        output, _ = vm.command('harness install --config /tmp/install-config.json --yes-erase-disk', timeout=360)
        (folder / 'install.log').write_text(output)
        if args.zram_config:
            install_zram_candidate(vm, config, args.zram_config, result)
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        vm.login_installed(config)
        result['installed_runtime_ready_seconds_including_test_login'] = round(time.monotonic() - vm.started, 3)
        vm.command('printf %s ' + shlex.quote(config['password']+'\n') + ' | sudo -S -v')
        if args.zram_config:
            assert vm.read_file('/etc/systemd/zram-generator.conf') == args.zram_config.read_bytes()
            output, _ = vm.command('systemctl is-active systemd-zram-setup@zram0.service dev-zram0.swap && '
                                   'cat /sys/block/zram0/disksize /proc/swaps')
            (folder / 'zram-startup.txt').write_text(output)
        vm.command('systemctl --user stop harness-update.timer harness-update.service')
        copy_file(vm, args.wlrctl.read_bytes(), '/tmp/harness-wlrctl')
        vm.command('chmod 700 /tmp/harness-wlrctl')
        for source, target, mode in [(args.browser_script, '/usr/bin/hn-browser', '755'),
                                     (args.compositor_config, '/usr/share/harness-os/labwc/rc.xml', '644')]:
            data = source.read_bytes()
            base = vm.read_file(target)
            result['candidates'][target] = dict(source=str(source), sha256=hashlib.sha256(data).hexdigest(),
                                                original_sha256=hashlib.sha256(base).hexdigest(), changed=data != base)
            copy_file(vm, data, '/tmp/browser-candidate')
            vm.command('sudo install -m ' + mode + ' /tmp/browser-candidate ' + shlex.quote(target))
        vm.command('systemd-run --user --quiet --wait --pipe --collect labwc --reconfigure')
        if args.memory_profile:
            data = Path(__file__).with_name('browser_memory.py').read_bytes()
            result['memory_observer_sha256'] = hashlib.sha256(data).hexdigest()
            result['limitations'].append('Memory snapshots add recorded observer cost between phases; this is a diagnostic run.')
            copy_file(vm, data, '/tmp/harness-browser-memory.py')
            vm.command('sudo -n touch /run/harness-browser-memory-disposable')
            vm.memory_profile = True
        check_browser(vm, result)
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', error=repr(error))
        try:
            vm.memory_snapshot('failure')
        except Exception as diagnostic:
            result['memory_diagnostic_error'] = repr(diagnostic)
        try:
            vm.screenshot('failure')
            output, _ = vm.command(observe(vm, 'toplevel', 'list'), check=False)
            (folder / 'failure-windows.txt').write_text(output)
            output, _ = vm.command('sudo -n journalctl -b --no-pager -n 150; '
                'cat /proc/meminfo; ps -u 1000 -o pid,ppid,rss,args --width 200', check=False)
            (folder / 'failure-journal.log').write_text(output)
        except Exception as diagnostic:
            result['diagnostic_error'] = repr(diagnostic)
        raise
    finally:
        if vm.shell_ready:
            for name in ['events.jsonl', 'state.json', 'states.json', 'terminal-input']:
                try:
                    (folder / name).write_bytes(vm.read_file('/tmp/harness-browser-probe/' + name))
                except Exception:
                    pass
        result['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(result,indent=2)+'\n')
        vm.stop()


if __name__ == '__main__':
    main()
