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
from vm import VM, check_live_media, install_interactively
from session_vm import screen_text, wait_lock


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


def zram_probe(vm, source, phase, live=False):
    data = Path(__file__).with_name('zram_probe.py').read_bytes()
    copy_file(vm, data, '/tmp/harness-zram-probe.py')
    path = '/tmp/harness-zram-' + phase + '.json'
    vm.command(('' if live else 'sudo -n ') + 'python3 /tmp/harness-zram-probe.py --config-sha256 ' +
               hashlib.sha256(source.read_bytes()).hexdigest() + ' --output ' + path, timeout=15)
    content = vm.read_file(path, timeout=10)
    (vm.folder / ('zram-' + phase + '.json')).write_bytes(content)
    return json.loads(content)


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


def check_browser_suspend(vm, config, manifest, result):
    """Suspend from a real browser window, keeping agents and terminal work alive."""
    vm.command('! pgrep -u "$(id -u)" -x chromium')
    vm.command('mkdir -p /tmp/harness-browser-probe ~/projects/browser-suspend; '
               'printf %s browser-suspend-project > ~/projects/browser-suspend/proof.txt')
    copy_file(vm, TERMINAL.encode(), '/tmp/harness-browser-terminal.py')
    for source, target in [('browser_guest.py', '/tmp/harness-browser-page.py'),
                           ('browser_suspend_guest.py', '/tmp/harness-browser-suspend.py')]:
        data = Path(__file__).with_name(source).read_bytes()
        result.setdefault('guest_observers', {})[source] = hashlib.sha256(data).hexdigest()
        copy_file(vm, data, target)
    vm.command('systemd-run --user --quiet --collect --unit=harness-browser-probe python3 /tmp/harness-browser-page.py')
    wait_command(vm, 'curl --fail --silent http://127.0.0.1:18782/ >/dev/null')
    vm.command('hn new-window -n browser-suspend ' + shlex.quote('python3 /tmp/harness-browser-terminal.py'))
    wait_command(vm, 'test -s /tmp/harness-browser-probe/terminal-pid')
    focused(vm, 'hn', 'suspend-terminal-before-browser')
    vm.type_probe('before-suspend')
    vm.keys('ret')
    vm.keys('meta_l', 'b')
    new_tab_ready(vm, 'suspend-browser-started')
    for path, value in [('/first', 'window-one'), ('/second', 'window-two')]:
        if path == '/second':
            vm.keys('ctrl', 'n')
            new_tab_ready(vm, 'suspend-second-window')
        vm.keys('ctrl', 'l')
        vm.type_probe('http://127.0.0.1:18782' + path)
        vm.keys('ret')
        state(vm, path=path)
        page_fills_display(vm, 'suspend-page' + path.replace('/', '-'))
        # The previous click leaves the VGA software cursor over this label.
        # Move it away without clicking before locating the exact visible word.
        vm.monitor('input-send-event', events=[
            {'type': 'abs', 'data': {'axis': 'x', 'value': 0}},
            {'type': 'abs', 'data': {'axis': 'y', 'value': 0}}])
        time.sleep(.2)
        vm.click_word('suspend-input' + path.replace('/', '-'), 'Keyboard')
        state(vm, path=path, ready=True)
        vm.type_probe(value)
        state(vm, path=path, value=value, ready=True)

    expected_runtime = {name: item['sha256'] for name, item in manifest['harness_inputs']['files'].items()}
    assert set(expected_runtime) == {'harness-tui', 'cli.mjs', 'notify.mjs'}

    def snapshot(name):
        vm.command('python3 /tmp/harness-browser-suspend.py > /tmp/harness-browser-suspend.json')
        data = vm.read_file('/tmp/harness-browser-suspend.json')
        (vm.folder / (name + '.json')).write_bytes(data)
        observed = json.loads(data)
        assert observed['runtime'] == expected_runtime, 'Shared runtime differs from the verified image'
        return observed

    before = snapshot('suspend-work-before')
    assert before['terminal_input'] == 'before-suspend\n'
    result['work_before'] = before

    def preserved(name, terminal_input='before-suspend\n'):
        after = snapshot(name)
        for key in ['agents', 'browser', 'daemon', 'terminal', 'boot_id', 'runtime', 'project_sha256']:
            assert after[key] == before[key], ('Work changed across suspend', key, before[key], after[key])
        assert after['terminal_input'] == terminal_input, 'Lock or browser input reached the terminal'
        return after

    assert vm.monitor('query-current-machine').get('wakeup-suspend-support')
    output, _ = vm.command('cat /sys/power/state /sys/power/mem_sleep; systemd-inhibit --list --no-pager')
    (vm.folder / 'sleep-capabilities.txt').write_text(output)
    started = time.monotonic()
    vm.command('sudo -n systemctl suspend --no-block')
    deadline = time.monotonic() + 30
    while True:
        current = vm.monitor('query-status')
        if current['status'] == 'suspended':
            break
        assert time.monotonic() < deadline, ('Guest did not suspend', current)
        time.sleep(.25)
    result['suspend_seconds'] = round(time.monotonic() - started, 3)
    result['suspended_qmp_status'] = current
    vm.shell_ready = False
    vm.screenshot('browser-suspended')
    vm.monitor('system_wakeup')
    resumed = time.monotonic()
    # Reuse the acknowledged UART resume boundary; never type a command into
    # the short serial FIFO while the guest driver is still waking.
    deadline = time.monotonic() + 30
    while True:
        vm.send('\n')
        try:
            vm.wait(r'\[me@harness [^\r\n]*\]\$ ', timeout=2)
            vm.shell_ready = True
            break
        except TimeoutError:
            if time.monotonic() >= deadline:
                raise TimeoutError('The guest serial console did not resume within 30 seconds')
    wait_lock(vm, True)

    def hidden(name):
        text = screen_text(vm, name)
        assert 'harness browser check' not in text and 'keyboard' not in text, 'Lock exposed the browser'
        with Image.open(vm.folder / (name + '.png')).convert('RGB') as frame:
            width, height = frame.size
            pixels = [frame.getpixel(p) for p in [(3, height//2), (width-4, height//2),
                                                 (3, height-4), (width-4, height-4)]]
        assert all(max(pixel) <= 8 for pixel in pixels), ('Lock did not hide the page', pixels)
        state(vm, path='/first', value='window-one')
        state(vm, path='/second', value='window-two')

    hidden('browser-resumed-locked')
    for name, keys in [('escape', ('esc',)), ('interrupt', ('ctrl', 'c')), ('shortcut', ('meta_l', 'b'))]:
        vm.keys(*keys)
        wait_lock(vm, True, timeout=2)
        hidden('browser-lock-' + name)
    vm.type_probe('wrong-password')
    vm.keys('ret')
    time.sleep(4)
    wait_lock(vm, True)
    hidden('browser-lock-wrong-password')
    preserved('suspend-work-locked')
    vm.keys('ctrl', 'u')
    vm.type_probe(config['password'])
    vm.keys('ret')
    wait_lock(vm, False)
    title = 'Harness browser check /second - Chromium'
    focused(vm, 'chromium', 'browser-resumed-unlocked', title=title)
    state(vm, path='/second', value='window-two', ready=True)
    page_fills_display(vm, 'browser-resumed-painted')
    vm.type_probe('-resumed')
    state(vm, path='/second', value='window-two-resumed')
    state(vm, path='/first', value='window-one')
    vm.keys('meta_l', 'b')
    focused(vm, 'hn', 'browser-resume-terminal')
    vm.type_probe('after-suspend')
    vm.keys('ret')
    wait_command(vm, 'python3 -c ' + shlex.quote('from pathlib import Path; '
        'assert Path("/tmp/harness-browser-probe/terminal-input").read_text() == "before-suspend\\nafter-suspend\\n"'))
    vm.keys('meta_l', 'b')
    focused(vm, 'chromium', 'browser-resume-return', title=title)
    state(vm, path='/second', value='window-two-resumed', ready=True)
    vm.type_probe('-returned')
    state(vm, path='/second', value='window-two-resumed-returned')
    state(vm, path='/first', value='window-one')
    result['work_after'] = preserved('suspend-work-after', 'before-suspend\nafter-suspend\n')
    events = [json.loads(line) for line in vm.read_file('/tmp/harness-browser-probe/events.jsonl').decode().splitlines()]
    for event in events:
        expected = {'/first': 'window-one', '/second': 'window-two-resumed-returned'}[event['path']]
        assert expected.startswith(event['input']), ('Unexpected input reached the page', event)
    result['resume_check_seconds_including_lock_and_typing'] = round(time.monotonic() - resumed, 3)
    output, _ = vm.command('sudo -n journalctl -b -u systemd-suspend.service --no-pager; '
                           'journalctl --user -b -u harness-idle --no-pager')
    (vm.folder / 'sleep-journal.log').write_text(output)
    result['checks'].extend([
        'The browser-active guest actually suspends; wake remains password-locked and hides the page.',
        'Escape, Ctrl+c, Super+b and a wrong password stay inside the lock; browser and terminal input remain unchanged.',
        'Unlock restores the same browser window and field; real typing and a Super+b terminal/browser round trip work without changing the other window.',
        'Both OpenCode processes, browser main process, daemon, terminal, project, boot ID and verified runtime bytes survive unchanged.'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--firmware', choices=['bios', 'uefi'], required=True)
    parser.add_argument('--memory-mib', type=int, choices=[1024, 2048, 4096], default=1024)
    parser.add_argument('--check', choices=['focus', 'suspend'], default='focus')
    parser.add_argument('--wlrctl', type=Path, required=True)
    parser.add_argument('--browser-script', type=Path,
                        help='Explicitly overlay a candidate browser launcher; omit to test the packaged image')
    parser.add_argument('--compositor-config', type=Path,
                        help='Explicitly overlay a candidate compositor configuration; omit to test the packaged image')
    parser.add_argument('--home-source', type=Path,
                        help='Stage and exercise this source checkout\'s signed browser start page on the disposable disk')
    parser.add_argument('--memory-profile', action='store_true',
                        help='Capture finite read-only memory snapshots; separate from ordinary focus acceptance')
    parser.add_argument('--zram-config', type=Path,
                        help='Overlay this startup configuration on the private installed disk before boot')
    parser.add_argument('--expected-zram-config', type=Path,
                        help='Require this configuration active from the live and installed cold boots; no overlay')
    parser.add_argument('--interactive-install', action='store_true')
    parser.add_argument('--live-transport', choices=['cdrom', 'usb'], default='cdrom')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.check == 'suspend' and (args.firmware != 'uefi' or args.memory_mib != 2048 or
            args.memory_profile or args.zram_config or args.expected_zram_config or args.interactive_install or
            args.live_transport != 'cdrom'):
        parser.error('Browser suspend requires the focused 2 GiB encrypted UEFI/CD-ROM fixture without memory/install variants')
    if args.zram_config and args.expected_zram_config:
        parser.error('Choose a preboot overlay or verification of a prepared image, not both')
    if args.expected_zram_config and not args.interactive_install:
        parser.error('--expected-zram-config requires --interactive-install')
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        parser.error('Native x86 KVM is required')
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    with iso.open('rb') as handle:
        assert hashlib.file_digest(handle, 'sha256').hexdigest() == manifest['iso']['sha256']
    assert iso.stat().st_size == manifest['iso']['bytes']
    suffix = '-suspend' if args.check == 'suspend' else ''
    folder = (args.output or Path(f'os/test-results/{args.firmware}-browser{suffix}')).resolve()
    folder.mkdir(parents=True, exist_ok=False)
    (folder / 'image-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    video = 'VGA' if args.check == 'suspend' else 'virtio-vga'
    vm = BrowserVM(folder, iso, args.firmware, args.memory_mib, live_transport=args.live_transport, cpu='Nehalem', video=video)
    vm.memory_samples = []
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda', username='me',
                  hostname='harness', password='test-password-123', encrypt=args.firmware == 'uefi', serial_console=True)
    result = dict(status='running', started_at=time.time(), checks=[], firmware=args.firmware,
                  image_source_commit=manifest['source_commit'], iso_sha256=manifest['iso']['sha256'],
                  test_source_commit=subprocess.check_output(['git','-c',f'safe.directory={Path.cwd()}',
                                                              'rev-parse','HEAD'],text=True).strip(),
                  memory_mib=args.memory_mib, candidates={},
                  validation_fixture=manifest.get('validation_fixture'), live_transport=args.live_transport,
                  memory_profile=args.memory_profile, cpu='Nehalem', display=video, check=args.check,
                  memory_samples=vm.memory_samples,
                  observer=dict(sha256=hashlib.sha256(args.wlrctl.read_bytes()).hexdigest(),
                                version=subprocess.check_output([str(args.wlrctl),'--version'],text=True).strip()),
                  limitations=['Only the recorded candidate files replace packaged files in the disposable guest.',
                               'Virtual display and QMP virtual keyboard events; not a physical laptop or GPU claim.',
                               'Observer and screenshot overhead are included in transition timings.'])
    if args.check == 'suspend':
        result['test_inputs'] = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                                for name in ['browser_vm.py', 'browser_suspend_guest.py', 'browser_guest.py',
                                             'session_vm.py', 'footprint_vm.py', 'vm.py']}
        result['limitations'].extend(['One virtual ACPI suspend using bochs-drm; no physical lid, panel, radio or GPU acceptance.',
                                      'Existing OpenCode process survival is checked, not a remote model turn.'])
    try:
        vm.start(live=True)
        if args.check == 'suspend':
            assert vm.acceleration == 'kvm'
            result['acceleration'] = vm.acceleration
            result['virtual_cpus'] = 2
        vm.wait(r'root@[^\r\n]*[#] ', timeout=180)
        vm.shell_ready = True
        vm.command('stty -echo')
        if args.expected_zram_config:
            result['zram_probe_sha256'] = hashlib.sha256(Path(__file__).with_name('zram_probe.py').read_bytes()).hexdigest()
            result['live_zram'] = zram_probe(vm, args.expected_zram_config, 'live', live=True)
            assert result['live_zram']['oom_kills'] == 0
        if args.live_transport == 'usb':
            check_live_media(vm, result, 'media')
        copy_file(vm, json.dumps(config).encode(), '/tmp/install-config.json')
        vm.command('nmcli networking off')
        if args.interactive_install:
            assert 'install-first' in manifest.get('capabilities', [])
            from install_first import wait_installer_screen
            wait_installer_screen(vm, 'Repeat password', 'live-installer')
            vm.command('! pgrep -x "hn|harness-tui|opencode|chromium"')
            result['interactive_install_seconds'] = install_interactively(vm, config, folder, direct=True)
            result['checks'].append('USB boots the installer; disk selection, encryption, masked passwords and offline installation succeed')
            if config['encrypt']:
                code = ('import json,sys; k=json.load(sys.stdin)["keyslots"]["0"]["kdf"]; '
                        'print(json.dumps({key:k[key] for key in ["type","time","memory","cpus"]}))')
                vm.command('cryptsetup luksDump --dump-json-metadata /dev/vda3 | python3 -c ' +
                           shlex.quote(code) + ' > /tmp/hn-zram-argon.json')
                result['argon'] = json.loads(vm.read_file('/tmp/hn-zram-argon.json'))
        else:
            output, _ = vm.command('harness install --config /tmp/install-config.json --yes-erase-disk', timeout=360)
            (folder / 'install.log').write_text(output)
        if args.zram_config:
            install_zram_candidate(vm, config, args.zram_config, result)
        if args.expected_zram_config:
            result['live_installed_zram'] = zram_probe(vm, args.expected_zram_config, 'live-installed', live=True)
            assert result['live_installed_zram']['oom_kills'] == 0, 'Live installation triggered an OOM kill'
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        vm.login_installed(config)
        result['installed_runtime_ready_seconds_including_test_login'] = round(time.monotonic() - vm.started, 3)
        vm.command('printf %s ' + shlex.quote(config['password']+'\n') + ' | sudo -S -v')
        if args.zram_config:
            result['installed_zram'] = zram_probe(vm, args.zram_config, 'installed')
        vm.command('systemctl --user stop harness-update.timer harness-update.service')
        copy_file(vm, args.wlrctl.read_bytes(), '/tmp/harness-wlrctl')
        vm.command('chmod 700 /tmp/harness-wlrctl')
        for source, target, mode in [(args.browser_script, '/usr/bin/hn-browser', '755'),
                                     (args.compositor_config, '/usr/share/harness-os/labwc/rc.xml', '644')]:
            if source is None:
                continue
            data = source.read_bytes()
            base = vm.read_file(target)
            result['candidates'][target] = dict(source=str(source), sha256=hashlib.sha256(data).hexdigest(),
                                                original_sha256=hashlib.sha256(base).hexdigest(), changed=data != base)
            copy_file(vm, data, '/tmp/browser-candidate')
            vm.command('sudo install -m ' + mode + ' /tmp/browser-candidate ' + shlex.quote(target))
        if args.compositor_config:
            # Signal the actual running compositor, including the private
            # OS-owned executable. Exact-image acceptance needs no reload.
            vm.command('pkill -HUP -u "$(id -u)" -x labwc')
        if args.home_source:
            import browser_home_vm
            browser_home_vm.overlay(vm, args.home_source.resolve(), result)
            browser_home_vm.exercise(vm, result)
        if args.memory_profile:
            data = Path(__file__).with_name('browser_memory.py').read_bytes()
            result['memory_observer_sha256'] = hashlib.sha256(data).hexdigest()
            result['limitations'].append('Memory snapshots add recorded observer cost between phases; this is a diagnostic run.')
            copy_file(vm, data, '/tmp/harness-browser-memory.py')
            vm.command('sudo -n touch /run/harness-browser-memory-disposable')
            vm.memory_profile = True
        if args.expected_zram_config:
            result['install_receipt'] = json.loads(vm.read_file('/var/lib/harness-os/install.json'))
            if config['encrypt']:
                argon = result['argon']
                budget = result['install_receipt']['pbkdf_memory_limit_kib']
                assert argon['type'] == 'argon2id' and argon['time'] >= 4
                assert 64 * 1024 <= argon['memory'] <= budget <= 1024 * 1024
            before = result['installed_zram'] = zram_probe(vm, args.expected_zram_config, 'installed')
            assert sum(p['role'] == 'OpenCode' for p in before['identities']) == 2, before
            assert sum(p['role'] == 'Harness daemon' for p in before['identities']) == 1, before
            assert before['oom_kills'] == 0
        if args.check == 'suspend':
            check_browser_suspend(vm, config, manifest, result)
        else:
            check_browser(vm, result)
        if args.expected_zram_config:
            after = result['completed_zram'] = zram_probe(vm, args.expected_zram_config, 'completed')
            assert after['identities'] == before['identities'], 'Agent or daemon process changed'
            assert after['oom_kills'] == 0, 'The workload triggered an OOM kill'
            result['checks'].append('Original agent and daemon PID/starttime identities survive the ordinary browser workload without OOM')
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
                    destination = name + '.txt' if name == 'terminal-input' else name
                    (folder / destination).write_bytes(vm.read_file('/tmp/harness-browser-probe/' + name))
                except Exception:
                    pass
        result['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(result,indent=2)+'\n')
        vm.stop()


if __name__ == '__main__':
    main()
