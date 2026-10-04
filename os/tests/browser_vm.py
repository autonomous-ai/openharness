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


def focused(vm, app, name, maximized=False, timeout=15):
    started = time.monotonic()
    criteria = ['app_id:' + app, 'state:active']
    if maximized:
        criteria += ['state:maximized']
    wait_command(vm, observe(vm, 'toplevel', 'find', *criteria), timeout)
    vm.screenshot(name)
    return round(time.monotonic() - started, 3)


def state(vm, *, path=None, value=None, timeout=10):
    expression = 'import json; d=json.load(open("/tmp/harness-browser-probe/state.json")); '
    if path is not None:
        expression += 'assert d["path"] == ' + repr(path) + '; '
    if value is not None:
        expression += 'assert d["input"] == ' + repr(value) + '; '
    wait_command(vm, 'python3 -c ' + shlex.quote(expression), timeout)
    return json.loads(vm.read_file('/tmp/harness-browser-probe/state.json'))


def page_fills_display(vm, name):
    # Read the actual rendered page, independently from the compositor's state.
    # Below Chromium's toolbar the white page must reach both sides and bottom.
    vm.screenshot(name)
    with Image.open(vm.folder / (name + '.png')).convert('RGB') as frame:
        width, height = frame.size
        positions = [(3, height//2), (width-4, height//2), (3, height-4), (width-4, height-4)]
        pixels = [frame.getpixel(position) for position in positions]
    assert all(min(pixel) > 235 for pixel in pixels), (positions, pixels)


def check_browser(vm, result):
    vm.command('! pgrep -u "$(id -u)" -x chromium')
    result['checks'].append('Browser is absent on installed boot')
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
    result['cold_start_seconds_including_observer'] = focused(vm, 'chromium', 'browser-shortcut-cold', maximized=True, timeout=45)
    vm.keys('ctrl', 'l')
    vm.type_probe('http://127.0.0.1:18782/first')
    vm.keys('ret')
    result['page'] = state(vm, path='/first')
    page_fills_display(vm, 'browser-page-full-display')
    vm.type_probe('browser')
    state(vm, value='browser')
    result['checks'].append('Super+b cold-starts a maximized browser; its local page fills the display and receives real keyboard input')
    result['toggles'] = []
    for index in range(4):
        vm.keys('meta_l', 'b')
        to_terminal = focused(vm, 'hn', 'toggle-terminal-' + str(index))
        terminal('terminal-' + str(index))
        state(vm, value='browser' + 'x'*index)
        vm.keys('meta_l', 'b')
        to_browser = focused(vm, 'chromium', 'toggle-browser-' + str(index), maximized=True)
        vm.type_probe('x')
        state(vm, value='browser' + 'x'*(index+1))
        result['toggles'].append(dict(to_terminal_seconds=to_terminal, to_browser_seconds=to_browser))
    result['checks'].append('Repeated Super+b switching routes keyboard input only to the intended surface and preserves the terminal process and browser input')
    vm.keys('meta_l', 'ret')
    focused(vm, 'hn', 'explicit-request-terminal')
    terminal('before-explicit-request')
    # An explicit URL from an agent/terminal must display its result even while
    # the existing browser is behind the fullscreen terminal.
    vm.command('hn-browser http://127.0.0.1:18782/second')
    focused(vm, 'chromium', 'explicit-url-browser', maximized=True)
    state(vm, path='/second')
    page_fills_display(vm, 'explicit-url-full-display')
    result['checks'].append('An explicit hn-browser URL raises the already running browser from behind Harness')
    vm.keys('ctrl', 'n')
    focused(vm, 'chromium', 'new-browser-window', maximized=True)
    vm.keys('ctrl', 'l')
    vm.type_probe('http://127.0.0.1:18782/new-window')
    vm.keys('ret')
    state(vm, path='/new-window')
    page_fills_display(vm, 'new-window-full-display')
    vm.keys('ctrl', 'shift', 'w')
    focused(vm, 'chromium', 'original-browser-restored', maximized=True)
    vm.keys('ctrl', 'shift', 'w')
    focused(vm, 'hn', 'browser-closed-terminal')
    terminal('after-browser-close')
    wait_command(vm, '! pgrep -u "$(id -u)" -x chromium')
    vm.keys('meta_l', 'b')
    focused(vm, 'chromium', 'browser-reopened', maximized=True, timeout=45)
    vm.keys('meta_l', 'b')
    focused(vm, 'hn', 'browser-final-return')
    terminal('after-browser-reopen')
    result['checks'].append('New browser windows maximize; close and reopen restores working keyboard focus without losing the terminal')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--firmware', choices=['bios', 'uefi'], required=True)
    parser.add_argument('--memory-mib', type=int, choices=[1024, 2048, 4096], default=1024)
    parser.add_argument('--wlrctl', type=Path, required=True)
    parser.add_argument('--browser-script', type=Path, required=True)
    parser.add_argument('--compositor-config', type=Path, required=True)
    args = parser.parse_args()
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        parser.error('Native x86 KVM is required')
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    with iso.open('rb') as handle:
        assert hashlib.file_digest(handle, 'sha256').hexdigest() == manifest['iso']['sha256']
    folder = Path(f'os/test-results/{args.firmware}-browser').resolve()
    folder.mkdir(parents=True, exist_ok=False)
    vm = VM(folder, iso, args.firmware, args.memory_mib, cpu='Nehalem')
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda', username='me',
                  hostname='harness', password='test-password-123', encrypt=args.firmware == 'uefi', serial_console=True)
    result = dict(status='running', started_at=time.time(), checks=[], firmware=args.firmware,
                  image_source_commit=manifest['source_commit'], iso_sha256=manifest['iso']['sha256'],
                  test_source_commit=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
                  memory_mib=args.memory_mib, candidates={},
                  observer=dict(sha256=hashlib.sha256(args.wlrctl.read_bytes()).hexdigest(),
                                version=subprocess.check_output([str(args.wlrctl),'--version'],text=True).strip()),
                  limitations=['Only the two recorded candidate files replace packaged files in the disposable guest.',
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
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        vm.login_installed(config)
        result['installed_runtime_ready_seconds_including_test_login'] = round(time.monotonic() - vm.started, 3)
        vm.command('printf %s ' + shlex.quote(config['password']+'\n') + ' | sudo -S -v')
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
        check_browser(vm, result)
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', error=repr(error))
        try:
            vm.screenshot('failure')
            output, _ = vm.command(observe(vm, 'toplevel', 'list'), check=False)
            (folder / 'failure-windows.txt').write_text(output)
            output, _ = vm.command('journalctl --user -b --no-pager -n 150', check=False)
            (folder / 'failure-journal.log').write_text(output)
        except Exception as diagnostic:
            result['diagnostic_error'] = repr(diagnostic)
        raise
    finally:
        if vm.shell_ready:
            for name in ['events.jsonl', 'state.json', 'terminal-input']:
                try:
                    (folder / name).write_bytes(vm.read_file('/tmp/harness-browser-probe/' + name))
                except Exception:
                    pass
        result['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(result,indent=2)+'\n')
        vm.stop()


if __name__ == '__main__':
    main()
