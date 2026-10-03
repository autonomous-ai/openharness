#!/usr/bin/env python3
"""Boot and install the actual ISO in a disposable QEMU machine.

Uses a private qcow2 disk with a known serial. Never passes a host block device
to QEMU. Screenshots, serial logs, timings and checks survive every failure.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import select
import shlex
import shutil
import socket
import subprocess
import tempfile
import tarfile
import time
import uuid


class VM:
    def __init__(self, folder, iso, firmware, memory, live_transport='cdrom', cpu=None):
        self.folder, self.iso, self.firmware, self.memory = folder, iso, firmware, memory
        self.live_transport = live_transport
        self.cpu = cpu
        self.unlock_count = 0
        self.boot_count = 0
        self.process = None
        self.serial = None
        self.qmp = None
        self.qmp_file = None
        self.shell_ready = False
        self.control = tempfile.TemporaryDirectory(prefix='hn-os-vm-', dir='/tmp')
        self.control_path = Path(self.control.name)
        self.log = (folder / 'serial.log').open('ab', buffering=0)
        self.stderr = (folder / 'qemu.log').open('ab', buffering=0)
        self.disk = folder / 'target.qcow2'
        subprocess.run(['qemu-img', 'create', '-f', 'qcow2', str(self.disk), '24G'], check=True)
        if live_transport == 'usb':
            self.usb = folder / 'live-usb.qcow2'
            subprocess.run(['qemu-img', 'create', '-f', 'qcow2', '-F', 'raw', '-b',
                            str(iso), str(self.usb)], check=True)
            subprocess.run(['qemu-img', 'resize', str(self.usb), '16G'], check=True)
        if firmware == 'uefi':
            self.code = Path('/usr/share/OVMF/OVMF_CODE_4M.fd')
            self.vars = folder / 'OVMF_VARS.fd'
            shutil.copyfile('/usr/share/OVMF/OVMF_VARS_4M.fd', self.vars)

    def start(self, live):
        self.shell_ready = False
        for name in ['serial.sock', 'qmp.sock']:
            (self.control_path / name).unlink(missing_ok=True)
        self.started = time.monotonic()
        self.boot_count += 1
        self.boot_event('start', live=live)
        acceleration = 'kvm' if os.access('/dev/kvm', os.R_OK | os.W_OK) else 'tcg'
        args = ['qemu-system-x86_64', '-accel', acceleration, '-m', str(self.memory), '-smp', '2',
                '-cpu', self.cpu or ('host' if acceleration == 'kvm' else 'max'), '-device', 'virtio-vga',
                '-display', 'none', '-no-reboot',
                '-drive', f'file={self.disk},format=qcow2,if=none,id=target',
                '-device', f'virtio-blk-pci,drive=target,serial=HN_OS_TEST,bootindex={2 if live else 1}',
                '-device', 'virtio-net-pci,netdev=net', '-netdev', 'user,id=net',
                '-serial', f'unix:{self.control_path / "serial.sock"},server=on,wait=off',
                '-qmp', f'unix:{self.control_path / "qmp.sock"},server=on,wait=off']
        if live:
            # UEFI remembers the installed disk in NVRAM. Explicit device boot
            # indices are needed to select the recovery ISO again on later boots.
            if self.live_transport == 'usb':
                # A private overlay exposes a full-sized writable USB while
                # preserving the verified host ISO, including on test failure.
                args += ['-device', 'qemu-xhci,id=usb',
                         '-drive', f'file={self.usb},format=qcow2,if=none,id=live',
                         '-device', 'usb-storage,bus=usb.0,drive=live,serial=HN_OS_LIVE,removable=on,bootindex=1']
            else:
                args += ['-drive', f'file={self.iso},format=raw,media=cdrom,if=none,id=live',
                         '-device', 'ide-cd,drive=live,bootindex=1']
        if self.firmware == 'uefi':
            args += ['-drive', f'if=pflash,format=raw,readonly=on,file={self.code}',
                     '-drive', f'if=pflash,format=raw,file={self.vars}']
        self.process = subprocess.Popen(args, stdout=self.stderr, stderr=self.stderr)
        self.serial = self.connect('serial.sock')
        self.qmp = self.connect('qmp.sock')
        self.qmp.settimeout(10)
        self.qmp_file = self.qmp.makefile('rb')
        json.loads(self.qmp_file.readline())
        self.monitor('qmp_capabilities')

    def connect(self, name):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError('QEMU exited before opening its control sockets: ' +
                                   (self.folder / 'qemu.log').read_text()[-2000:])
            sock = socket.socket(socket.AF_UNIX)
            try:
                sock.connect(str(self.control_path / name))
                return sock
            except (FileNotFoundError, ConnectionRefusedError):
                sock.close()
                time.sleep(0.1)
        raise TimeoutError(f'QEMU did not expose {name}')

    def monitor(self, name, **arguments):
        identity = uuid.uuid4().hex
        self.qmp.sendall((json.dumps({'execute': name, 'arguments': arguments, 'id': identity}) + '\n').encode())
        while True:
            result = json.loads(self.qmp_file.readline())
            if result.get('id') == identity:
                if 'error' in result:
                    raise RuntimeError(result['error'])
                return result.get('return')

    def wait(self, pattern, timeout=180):
        deadline = time.monotonic() + timeout
        output = b''
        regex = re.compile(pattern.encode(), re.S)
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(f'QEMU exited while waiting for {pattern!r}')
            if select.select([self.serial], [], [], min(1, max(0, deadline - time.monotonic())))[0]:
                chunk = self.serial.recv(65536)
                if not chunk:
                    raise RuntimeError('Guest serial console disconnected.')
                self.log.write(chunk)
                output += chunk
                if regex.search(output):
                    return output.decode(errors='replace')
        raise TimeoutError(f'Guest did not produce {pattern!r}; see serial.log')

    def send(self, text):
        self.serial.sendall(text.encode())

    def boot_event(self, stage, **details):
        event = dict(boot=self.boot_count, stage=stage,
                     seconds=round(time.monotonic() - self.started, 3), **details)
        with (self.folder / 'boot-events.jsonl').open('a') as log:
            log.write(json.dumps(event) + '\n')

    def boot_diagnostics(self, config, name):
        # Keep the initrd journal as well as userspace timings. A single overall
        # boot duration cannot distinguish waiting for a person from an OS stall.
        output, _ = self.command('printf %s ' + shlex.quote(config['password'] + '\n') +
                                 ' | sudo -S journalctl -b -o short-monotonic --no-pager', timeout=60)
        (self.folder / (name + '-boot-journal.log')).write_text(output)
        output, _ = self.command('systemd-analyze; systemd-analyze blame; '
                                 'systemd-analyze critical-chain; systemctl --failed --no-pager')
        (self.folder / (name + '-boot-analysis.txt')).write_text(output)

    def command(self, command, timeout=90, check=True):
        marker = 'HN_RESULT_' + uuid.uuid4().hex
        # A probe may use `exit` or `exec`. Keep it inside a subshell so the
        # serial login remains available to report its status and run diagnostics.
        self.send('(' + command + f"); hn_status=$?; printf '\\n{marker}:%s\\n' \"$hn_status\"\n")
        output = self.wait(r'\r?\n' + marker + r':\d+\r?\n', timeout)
        match = re.search(r'\r?\n' + marker + r':(\d+)\r?\n', output)
        status = int(match.group(1))
        if check and status:
            raise RuntimeError(f'Guest command failed ({status}): {command}\n{output[-2000:]}')
        return output[:match.start()], status

    def login_installed(self, config, unlock_delay=0):
        if config['encrypt']:
            self.unlock_count += 1
            self.wait_unlock()
            self.boot_event('unlock-prompt')
            if unlock_delay:
                time.sleep(unlock_delay)
                self.screenshot('delayed-disk-unlock')
                # A wrong password must return to the prompt, without losing
                # the ability to unlock after the old device-timeout deadline.
                self.type_probe('wrong-password')
                self.keys('ret')
                time.sleep(8)
                self.wait_unlock()
                self.boot_event('unlock-retry-prompt')
                self.screenshot('disk-unlock-retry')
            self.type_probe(config['password'][:3])
            self.screenshot(f'disk-unlock-{self.unlock_count}-masked')
            self.type_probe(config['password'][3:])
            self.keys('ret')
            self.boot_event('password-submitted')
        self.wait(r'login:', timeout=180)
        self.boot_event('serial-login-prompt')
        self.send(config['username'] + '\n')
        self.wait(r'Password:')
        self.send(config['password'] + '\n')
        self.wait(r'\$ ')
        self.shell_ready = True
        self.command('stty -echo')
        if not config['encrypt']:
            for word in [config['username'], config['password']]:
                for char in word:
                    self.keys('minus' if char == '-' else char)
                self.keys('ret')
                time.sleep(2)
        self.command('for n in $(seq 1 90); do systemctl --user is-active --quiet hn-screen && pgrep -x "hn|harness-tui" >/dev/null && exit 0; sleep 1; done; exit 1', timeout=110)
        self.command('/usr/lib/harness-os/wait-runtime', timeout=160)
        self.boot_event('harness-ready')

    def wait_unlock(self):
        # OCR reads the actual framebuffer; a process or serial prompt alone
        # cannot prove the intended unlock screen was shown to the user.
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            name = f'disk-unlock-{self.unlock_count}'
            self.screenshot(name)
            text = subprocess.check_output(['tesseract', str(self.folder / (name + '.png')),
                                            'stdout', '--psm', '11'], text=True,
                                           stderr=subprocess.DEVNULL, timeout=10)
            if 'enter your password' in text.lower():
                (self.folder / (name + '.txt')).write_text(text)
                return
            time.sleep(2)
        raise TimeoutError('The Harness graphical unlock prompt was not rendered.')

    def screenshot(self, name):
        ppm = self.folder / (name + '.ppm')
        self.monitor('screendump', filename=str(ppm))
        from PIL import Image
        Image.open(ppm).save(self.folder / (name + '.png'))
        ppm.unlink()

    def keys(self, *keys):
        self.monitor('send-key', keys=[{'type': 'qcode', 'data': key} for key in keys], **{'hold-time': 100})
        time.sleep(0.12)  # Release each key, including repeated password characters.

    def type_probe(self, text):
        # Send display keyboard events, not hn's CLI input path. Probe commands
        # deliberately need only these unshifted US-layout characters.
        if not re.fullmatch(r'[a-z0-9 -]+', text):
            raise ValueError('Keyboard probe contains unsupported characters.')
        for char in text:
            self.keys({' ': 'spc', '-': 'minus'}.get(char, char))

    def stop(self):
        if self.process and self.process.poll() is None:
            try:
                self.monitor('quit')
            except (OSError, ValueError, RuntimeError):
                self.process.terminate()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        for handle in [self.serial, self.qmp_file, self.qmp]:
            if handle:
                handle.close()
        self.serial = self.qmp_file = self.qmp = None


def check_graphical_keyboard(vm, name):
    """Prove the installed graphical surface accepts input and renders output."""
    started = time.monotonic()
    vm.command('pgrep -x labwc >/dev/null && pgrep -x foot >/dev/null')
    vm.keys('ctrl', 'b')
    vm.keys('shift', 't')
    marker = 'keyboard-' + name + '-ready'
    vm.type_probe('echo ' + marker)
    vm.keys('ret')
    output, _ = vm.command(
        'for n in $(seq 1 60); do hn capture-pane -p 2>/dev/null | '
        'grep -Fx ' + shlex.quote(marker) +
        ' >/dev/null && break; sleep 0.25; done; '
        'hn capture-pane -p | grep -Fx ' + shlex.quote(marker) +
        '; hn display-message -p "HN_KEYBOARD_PANE=#{pane_id}"; hn capture-pane -p')
    pane = re.search(r'HN_KEYBOARD_PANE=(%\d+)', output)
    if not pane:
        raise RuntimeError('Keyboard probe did not identify its actual hn pane.')
    # Require the standalone response, not merely the echoed command text.
    if not re.search(r'(?m)^' + re.escape(marker) + r'\r?$', output):
        raise RuntimeError('Graphical keyboard input did not produce shell output.')
    confirmed = time.monotonic()
    (vm.folder / (name + '-keyboard.txt')).write_text(output)
    vm.screenshot(name + '-keyboard')
    vm.keys('ctrl', 'd')
    vm.command('for n in $(seq 1 60); do '
               'if ! hn list-panes -a -F "#{pane_id}" | grep -Fx ' +
               shlex.quote(pane.group(1)) + '; then exit 0; fi; '
               'sleep 0.25; done; exit 1')
    vm.command('systemctl --user is-active --quiet hn-screen && pgrep -x "hn|harness-tui" >/dev/null')
    time.sleep(0.25)  # Let the frame following the pane-close event paint.
    return {'confirmed_seconds_since_boot': round(confirmed - vm.started, 3),
            'probe_seconds_including_automated_typing': round(confirmed - started, 3)}


def check_console_fallback(vm, user, folder):
    """Break graphics in the live overlay, then type through hn on a real VT."""
    # The payload and session launcher remain unchanged. An invalid wlroots
    # backend forces the compositor to fail through its normal startup path.
    override = '/etc/profile.d/00-hn-test-broken-graphics.sh'
    vm.command('printf %s ' + shlex.quote('export WLR_BACKENDS=hn-test-missing\n') +
               ' > ' + override + '; systemctl restart getty@tty1.service')
    try:
        vm.command('for n in $(seq 1 60); do '
                   'for p in $(pgrep -u 1000 -x "hn|harness-tui"); do '
                   'if test "$(readlink /proc/$p/fd/0)" = /dev/tty1; then '
                   'printf "HN_CONSOLE_PID=%s\\n" "$p"; exit 0; fi; done; '
                   'sleep 1; done; exit 1', timeout=75)
        vm.command('! pgrep -u 1000 -x labwc && ! pgrep -u 1000 -x foot')
        vm.command(user('/usr/lib/harness-os/wait-runtime'), timeout=160)
        vm.command('kill -0 "$(cat /tmp/hn-survivor.pid)"')
        probe = ('printf "Console input ready\\n"; touch /tmp/hn-console-input-ready; '
                 'read -r answer; test "$answer" = ready && '
                 'touch /tmp/hn-console-input-passed; exec sleep 1800')
        vm.command(user('hn new-window -n console-input ' + shlex.quote(probe)))
        vm.command('for n in $(seq 1 15); do test -e /tmp/hn-console-input-ready && '
                   'exit 0; sleep 1; done; exit 1', timeout=20)
        for key in ['r', 'e', 'a', 'd', 'y', 'ret']:
            vm.keys(key)
        vm.command('for n in $(seq 1 15); do test -e /tmp/hn-console-input-passed && '
                   'exit 0; sleep 1; done; exit 1', timeout=20)
        vm.screenshot('03a-console-fallback')
    finally:
        output, _ = vm.command('cat /home/me/.local/state/harness-os/display.log; '
                               'ps -u 1000 -o pid,ppid,tty,comm; cat /dev/vcs1', check=False)
        (folder / 'console-fallback.log').write_text(output)
        vm.command('rm -f ' + override + '; systemctl restart getty@tty1.service')
    vm.command(user("sh -c 'for n in $(seq 1 60); do systemctl --user is-active --quiet hn-screen && "
                    "pgrep -x labwc >/dev/null && pgrep -x foot >/dev/null && exit 0; "
                    "sleep 1; done; exit 1'"), timeout=75)
    vm.command('kill -0 "$(cat /tmp/hn-survivor.pid)"')
    vm.command(user('/usr/lib/harness-os/wait-runtime'), timeout=160)
    vm.screenshot('03b-graphics-restored')


def check_first_use(vm, user, folder):
    """Operate the actual USB front door without a terminal command from the user."""
    vm.command('test "$(uname -n)" = harness && test "$(id -nu 1000)" = me && test -f /etc/harness-live')
    vm.command('nmcli networking off')
    version, _ = vm.command(user('/usr/bin/opencode --version'))
    (folder / 'bundled-opencode-version.txt').write_text(version)
    vm.command('test ! -e /home/me/.config/opencode/opencode.json')
    vm.keys('t')
    vm.command('for n in $(seq 1 30); do pgrep -x "nmtui|nmtui-connect" >/dev/null && exit 0; sleep 1; done; exit 1', timeout=40)
    vm.command('! pgrep -u 1000 -x opencode')
    vm.screenshot('01a-try-needs-network')
    vm.keys('esc')
    vm.command('for n in $(seq 1 15); do ! pgrep -x "nmtui|nmtui-connect" >/dev/null && exit 0; sleep 1; done; exit 1', timeout=20)
    vm.keys('ret')
    vm.command('sleep 1; ! pgrep -u 1000 -x opencode')
    # Enter is Install, including while the network is disabled.
    vm.keys('ret')
    vm.command(user('sh -c ' + shlex.quote('for n in $(seq 1 30); do hn capture-pane -p | grep -q "All data on this disk will be erased" && exit 0; sleep 1; done; exit 1')), timeout=40)
    vm.screenshot('01b-direct-install-offline')
    vm.keys('esc')
    vm.command('sleep 1; test "$(lsblk -n -o TYPE /dev/vda | wc -l)" -eq 1')
    # A preflight error must remain visible in a command-owned pane until read.
    vm.command(user('hn new-window -n install-error ' + shlex.quote('sudo /usr/bin/harness install --source /run/hn-missing-image')))
    vm.command(user('sh -c ' + shlex.quote('for n in $(seq 1 15); do hn capture-pane -p | grep -q "Press Enter to return to Harness" && exit 0; sleep 1; done; exit 1')), timeout=20)
    installer_process = '^/usr/bin/python3 /usr/lib/harness-os/install[.]py --source /run/hn-missing-image$'
    vm.command('pgrep -f ' + shlex.quote(installer_process))
    vm.screenshot('01b-install-error')
    vm.keys('ret')
    vm.command('for n in $(seq 1 15); do ! pgrep -f ' + shlex.quote(installer_process) + ' && exit 0; sleep 1; done; exit 1', timeout=20)
    # New terminal is a shell immediately, without agent/project/task fields.
    vm.keys('ctrl', 'b')
    vm.keys('shift', 't')
    vm.type_probe('echo terminal-ready')
    vm.keys('ret')
    vm.command(user('sh -c ' + shlex.quote('for n in $(seq 1 20); do hn capture-pane -p | grep -qx terminal-ready && exit 0; sleep 1; done; exit 1')), timeout=30)
    vm.screenshot('01c-direct-terminal')
    # Allow a full discovery cycle, then ensure a live-overlay shell or
    # installer has not been promoted to an agent by rounded file identities.
    vm.command('sleep 6')
    identity_probe = '''const fs = require('node:fs');
for (const path of ['/usr/bin/opencode', '/usr/bin/bash', '/usr/bin/python3', '/usr/bin/nmtui', '/usr/bin/sudo']) {
    const numeric = fs.statSync(path), exact = fs.statSync(path, {bigint: true});
    console.log(JSON.stringify({path, numberKey: `${numeric.dev}:${numeric.ino}`, exactKey: `${exact.dev}:${exact.ino}`}));
}
const rows = JSON.parse(fs.readFileSync('/home/me/.harness/cli/data/registry.json', 'utf8'));
for (const row of rows) console.log(JSON.stringify({agentId: row.agentId, engine: row.engine, active: row.active, processIdentity: row.processIdentity}));
if (rows.some(row => row.engine !== 'terminal')) throw new Error('A plain shell or installer was misidentified as an agent');
'''
    output, identity_status = vm.command(user('node -e ' + shlex.quote(identity_probe)), check=False)
    (folder / 'live-process-identities.txt').write_text(output)
    assert identity_status == 0, 'Live USB executable discovery must distinguish shells and installers from agents'
    output, _ = vm.command(user('hn display-message -p "HN_FIRST_TERMINAL=#{pane_id}"'))
    pane = re.search(r'HN_FIRST_TERMINAL=(%\d+)', output)
    assert pane, 'New terminal must identify its actual pane'
    vm.keys('ctrl', 'd')
    vm.command(user('sh -c ' + shlex.quote('for n in $(seq 1 30); do '
        'hn list-panes -a -F "#{pane_id}" | grep -Fx ' + shlex.quote(pane.group(1)) +
        ' >/dev/null || exit 0; sleep .25; done; exit 1')), timeout=15)
    vm.command('nmcli networking on; for n in $(seq 1 30); do test "$(nmcli -t -f STATE general)" = connected && exit 0; sleep 1; done; exit 1', timeout=40)
    vm.keys('t')
    vm.command('for n in $(seq 1 90); do pgrep -u 1000 -x opencode >/dev/null && exit 0; sleep 1; done; exit 1', timeout=100)
    time.sleep(5)
    vm.screenshot('01d-bundled-opencode')
    vm.command('test ! -e /home/me/.config/opencode/plugin/launcher-register.js && test -s /home/me/.config/opencode/plugins/launcher-register/tui.js')
    screen, _ = vm.command(user('hn capture-pane -p'))
    (folder / 'bundled-opencode-screen.txt').write_text(screen)
    assert 'Plugin failed:' not in screen and 'plugin failed /plugins' not in screen, 'Bundled OpenCode must open without a plugin error'
    output, _ = vm.command(user('hn display-message -p "HN_FIRST_AGENT=#{pane_id}"'))
    agent_pane = re.search(r'HN_FIRST_AGENT=(%\d+)', output)
    assert agent_pane, 'The visible OpenCode must identify its actual pane'
    # Exercise what a first-time user actually does after choosing Try: type
    # into the visible agent and receive its answer, without a CLI/API shortcut.
    vm.type_probe('what is six times seven reply with digits only')
    vm.keys('ret')
    _, interactive_status = vm.command(user('sh -c ' + shlex.quote(
        'for n in $(seq 1 120); do hn capture-pane -p > /tmp/hn-first-tui.txt; '
        "grep -Eq '^[^[:alnum:]]*42[^[:alnum:]]*$' /tmp/hn-first-tui.txt && exit 0; "
        'sleep 1; done; exit 1')), timeout=140, check=False)
    screen, _ = vm.command('cat /tmp/hn-first-tui.txt')
    (folder / 'first-opencode-interactive.txt').write_text(screen)
    vm.screenshot('01e-first-agent-reply')
    assert interactive_status == 0, 'The visible bundled agent must accept keyboard input and display its reply'
    # No model flag/config, API key, account, or installer. Validate a real
    # upstream-default reply; preserve all events rather than just the exit code.
    prompt = 'What is six times seven? Reply with only the decimal number. Do not use tools.'
    command = 'cd "$HOME/Projects" && timeout 120 /usr/bin/opencode run --format json ' + shlex.quote(prompt) + ' > /tmp/hn-first-chat.jsonl 2>/tmp/hn-first-chat.err'
    _, status = vm.command(user('sh -c ' + shlex.quote(command)), timeout=140, check=False)
    output, _ = vm.command('cat /tmp/hn-first-chat.jsonl')
    errors, _ = vm.command('cat /tmp/hn-first-chat.err')
    (folder / 'first-opencode-chat.jsonl').write_text(output)
    (folder / 'first-opencode-chat.stderr.txt').write_text(errors)
    events = []
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    reply = ''.join(e.get('part', {}).get('text', '') for e in events if e.get('type') == 'text').strip()
    assert status == 0 and reply == '42', f'Bundled OpenCode default conversation failed: exit={status}, reply={reply!r}'
    vm.keys('ctrl', 'c')
    time.sleep(.3)
    vm.keys('ctrl', 'c')
    # OpenCode 2 keeps `opencode serve --service` alive after its TUI exits.
    # The user's pane must close; the vendor's shared service is not a window.
    vm.command(user('sh -c ' + shlex.quote('for n in $(seq 1 60); do '
        'hn list-panes -a -F "#{pane_id}" | grep -Fx ' + shlex.quote(agent_pane.group(1)) +
        ' >/dev/null || exit 0; sleep .25; done; exit 1')), timeout=20)


def install_interactively(vm, config, folder):
    # The shipped form and installer run on a real guest TTY. The only test
    # addition is serial-console boot output, needed to observe the next boot.
    bootstrap = f'''import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location('installer', '/usr/lib/harness-os/install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
expected = {config!r}
installer.selected_disk(expected)
original_install = installer.install
def observed_install(actual, source, target):
    assert actual == {{k: v for k, v in expected.items() if k != 'serial_console'}}, 'Interactive installation choices differ from test input'
    actual['serial_console'] = True
    return original_install(actual, source, target)
installer.install = observed_install
installer.main()
'''
    encoded = base64.b64encode(bootstrap.encode()).decode()
    assert len(encoded) < 3000, 'Keep serial-console commands below the line discipline limit.'
    vm.command(f"printf %s {shlex.quote(encoded)} | base64 -d > /run/hn-interactive-test.py; chmod 600 /run/hn-interactive-test.py")
    vm.command('stty rows 24 cols 80')
    marker = 'HN_INTERACTIVE_' + uuid.uuid4().hex
    vm.send('(TERM=xterm-256color python3 /run/hn-interactive-test.py); '
            f"hn_status=$?; printf '\\n{marker}:%s\\n' \"$hn_status\"\n")
    transcript = []
    def wait(pattern, timeout=30):
        output = vm.wait(pattern, timeout)
        transcript.append(output)
        return output
    try:
        wait(r'All data on this disk will be erased')
        vm.send('\n')
        wait(r'Select disk')
        vm.send('\x1b')
        wait(r'All data on this disk will be erased')
        vm.send('\n')
        wait(r'Select disk')
        vm.send('\n')
        wait(r'All data on this disk will be erased')
        vm.send('\t' + ('' if config['encrypt'] else ' ') + '\t')
        vm.send(config['password'] + '\n' + config['password'] + '\n')
        # Password entry focuses Install. Only its explicit activation starts it.
        time.sleep(.25)
        vm.send('\n')
        output = wait(r'Harness is installed|\r?\n' + marker + r':\d+\r?\n', timeout=900)
        assert 'Harness is installed' in output, 'Interactive installation failed; see installer-ui.log'
        vm.send('\x1b')  # Completion remains visible; return to the live system for the receipt.
        output = wait(r'\r?\n' + marker + r':\d+\r?\n', timeout=900)
        status = int(re.search(r'\r?\n' + marker + r':(\d+)\r?\n', output).group(1))
        assert status == 0, 'Interactive installation failed; see installer-ui.log'
    finally:
        (folder / 'installer-ui.log').write_text(''.join(transcript))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', required=True, type=Path)
    parser.add_argument('--firmware', choices=['bios', 'uefi'], default='bios')
    parser.add_argument('--encrypt', action='store_true')
    parser.add_argument('--memory', type=int, default=2048)
    parser.add_argument('--live-transport', choices=['cdrom', 'usb'], default='cdrom')
    parser.add_argument('--cpu', help='Optional QEMU CPU model, for an older instruction-set baseline')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--agents', action='store_true', help='Install and start real agent executables after recovery; no accounts/API calls')
    parser.add_argument('--workloads', action='store_true', help='Opt in to real free-model project builds and browser acceptance after --agents')
    parser.add_argument('--dsh', action='store_true', help='Exercise three real DSH agents and shared viewers after --agents')
    parser.add_argument('--workload-seed', type=Path, help='Previous workload artifact: preserve its generated projects and rerun acceptance')
    parser.add_argument('--live-only', action='store_true', help='Development probe: stop after the live-session checks, without installing')
    args = parser.parse_args()
    if args.workloads and not args.agents:
        parser.error('--workloads requires --agents')
    if args.dsh and not args.agents:
        parser.error('--dsh requires --agents')
    if args.workloads and args.dsh:
        parser.error('Run the two long model suites separately.')
    if args.workload_seed and not args.workloads:
        parser.error('--workload-seed requires --workloads')
    folder = (args.output or Path(__file__).resolve().parents[1] / 'test-results' / (args.firmware + ('-encrypted' if args.encrypt else '-plain'))).resolve()
    folder.mkdir(parents=True, exist_ok=False)
    result = {'firmware': args.firmware, 'encrypted': args.encrypt, 'memory_mib': args.memory,
              'live_transport': args.live_transport, 'cpu': args.cpu or 'native/default',
              'scope': 'live session only' if args.live_only else 'live session, offline installation and recovery',
              'started_at_unix': time.time(), 'checks': [], 'status': 'running'}
    manifest = json.loads((args.iso.parent / 'manifest.json').read_text())
    with args.iso.open('rb') as handle:
        digest = hashlib.file_digest(handle, 'sha256').hexdigest()
    if digest != manifest['iso']['sha256']:
        raise RuntimeError('ISO does not match its build manifest.')
    result['iso_sha256'] = digest
    result['image_source_commit'] = manifest['source_commit']
    result['test_source_commit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    result['test_script_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    vm = VM(folder, args.iso.resolve(), args.firmware, args.memory, args.live_transport, args.cpu)
    user = lambda cmd: 'runuser -u "$(id -nu 1000)" -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus ' + cmd
    try:
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ')
        vm.shell_ready = True
        vm.command('stty -echo')
        if args.live_transport == 'usb' and args.memory >= 4096:
            vm.command('test -f /run/archiso/copytoram/airootfs.sfs && test ! -e /run/archiso/bootmnt')
            result['checks'].append('Real USB boot automatically copies the payload into RAM and unmounts the boot medium')
            # The unmounted writable boot USB must still be rejected, even
            # though its size otherwise makes it an eligible target.
            probe = '''import importlib.util
s = importlib.util.spec_from_file_location('installer', '/usr/lib/harness-os/install.py')
i = importlib.util.module_from_spec(s)
s.loader.exec_module(i)
d = next(d for d in i.inventory() if d.get('serial') == 'HN_OS_LIVE')
assert not d['ro'] and d['size'] >= i.MIN_DISK_BYTES
try:
    i.validate_disk(d)
except ValueError as e:
    assert 'booted into RAM' in str(e), str(e)
else:
    raise AssertionError('The unmounted boot USB was offered as a target')
assert str(i.live_payload()) == '/run/archiso/copytoram/airootfs.sfs'
'''
            encoded = base64.b64encode(probe.encode()).decode()
            vm.command('printf %s ' + encoded + ' | base64 -d | python3')
            result['checks'].append('The unmounted writable Harness USB is rejected as an installation target in RAM mode')
        vm.command('foot --check-config --config=/usr/share/harness-os/foot.ini')
        vm.command(user("sh -c 'for n in $(seq 1 90); do systemctl --user is-active --quiet hn-screen && pgrep -u 1000 -x \"hn|harness-tui\" >/dev/null && exit 0; sleep 1; done; systemctl --user --no-pager status hn-screen harness-daemon; exit 1'"), timeout=110)
        vm.command(user('/usr/lib/harness-os/wait-runtime'), timeout=160)
        result['live_hn_ready_seconds'] = round(time.monotonic() - vm.started, 3)
        result['checks'].append('Harness runtime reports discovery ready before hn startup is measured')
        output, _ = vm.command("printf 'HN_SCRATCH=%s\\n' \"$(df -B1 --output=size /run/archiso/cowspace | tail -1)\"")
        scratch_bytes = int(re.search(r'HN_SCRATCH=\s*(\d+)', output).group(1))
        if scratch_bytes < args.memory * 1024 ** 2 * 0.45:
            raise RuntimeError('Live writable space is too small for on-demand agent installation.')
        result['live_scratch_mib'] = round(scratch_bytes / 1024 ** 2, 1)
        vm.command('! pgrep -x chromium')
        result['checks'].append('Live hn ready; browser absent at boot')
        vm.command('systemctl start harness-keyring; pacman -Si git chromium >/dev/null', timeout=180)
        result['checks'].append('Dated package repositories are queryable before the first download')
        vm.command(user('systemd-run --user --quiet --wait --pipe --collect /bin/sh -c ' +
                        shlex.quote('printf hn-clipboard-check | wl-copy; test "$(wl-paste --no-newline)" = hn-clipboard-check')))
        result['checks'].append('Wayland clipboard round trip')
        vm.screenshot('01-live-hn')
        output, _ = vm.command(user('hn-os measure'))
        (folder / 'live-measurement.txt').write_text(output)
        check_first_use(vm, user, folder)
        result['checks'].append('USB Enter opens Install offline; Try opens network setup while disconnected; direct terminal accepts physical keyboard input')
        result['checks'].append('Installer errors remain visible until acknowledged; exiting a direct terminal removes its pane')
        result['checks'].append('USB first agent conversation accepts physical keyboard input and displays the expected reply')
        result['checks'].append('Bundled OpenCode starts offline and its upstream-default clean-profile conversation returns the independently checked answer')
        vm.keys('meta_l', 'b')
        vm.command("for n in $(seq 1 45); do pgrep -x chromium >/dev/null && break; sleep 1; done; pgrep -x chromium", timeout=60)
        time.sleep(3)
        vm.screenshot('02-browser')
        vm.keys('meta_l', 'b')
        time.sleep(1)
        vm.screenshot('03-return-to-hn')
        result['checks'].append('Browser starts only on shortcut; toggle screenshots recorded')
        # hn has its own tmux-style settings; the underlying tmux server needs
        # its separate system configuration so a short-lived last pane cannot
        # restart the server and reuse a still-registered terminal identity.
        for index in range(3):
            vm.command(user('hn new-window -n quick-exit ' + shlex.quote(f'touch /tmp/hn-quick-exit-{index}')))
            vm.command(f'for n in $(seq 1 10); do test -e /tmp/hn-quick-exit-{index} && exit 0; sleep 1; done; exit 1', timeout=15)
        result['checks'].append('Closing the last terminal and immediately opening another works repeatedly')
        # A long-lived terminal process proves a screen restart does not kill the work.
        survivor = "echo $$ > /tmp/hn-survivor.pid; exec sleep 1800"
        vm.command(user("hn new-window -n persistence " + shlex.quote(survivor)))
        vm.command('for n in $(seq 1 15); do test -s /tmp/hn-survivor.pid && exit 0; sleep 1; done; exit 1', timeout=20)
        clipboard_probe = 'printf hn-pane-clipboard | wl-copy; test "$(wl-paste --no-newline)" = hn-pane-clipboard && touch /tmp/hn-pane-clipboard-passed'
        vm.command(user('hn new-window -n clipboard ' + shlex.quote(clipboard_probe)))
        vm.command('for n in $(seq 1 15); do test -e /tmp/hn-pane-clipboard-passed && exit 0; sleep 1; done; exit 1', timeout=20)
        result['checks'].append('An hn terminal pane inherits the working Wayland clipboard environment')
        vm.command('! ' + user('hn detach'))
        vm.command('! ' + user('hn suspend-client'))
        vm.command('kill -0 "$(cat /tmp/hn-survivor.pid)"')
        result['checks'].append('OS surface refuses detach and suspend while work stays alive')
        vm.command(user('systemctl --user restart hn-screen'))
        vm.command('sleep 3; kill -0 "$(cat /tmp/hn-survivor.pid)"')
        result['checks'].append('Terminal process survives screen restart')
        check_console_fallback(vm, user, folder)
        result['checks'].append('Graphics startup failure falls back to hn on tty1; physical-keyboard input reaches a terminal pane and existing work survives')
        result['checks'].append('Restoring graphics returns to the fullscreen hn service without losing the terminal process')
        if args.live_only:
            result['status'] = 'passed'
            return
        config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                      username='me', hostname='harness', password='test-password-123',
                      encrypt=args.encrypt, serial_console=True)
        # Installation must work with the NIC down, using the ISO's immutable payload.
        vm.command('nmcli networking off')
        install_interactively(vm, config, folder)
        result['checks'].append('Keyboard disk selection, encryption checkbox, masked password entry and a single Install action work on the guest terminal')
        result['checks'].append('Offline installer completed on disposable disk')
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        unlock_delay = 100 if config['encrypt'] else 0
        vm.login_installed(config, unlock_delay=unlock_delay)
        result['deliberate_unlock_delay_seconds'] = unlock_delay
        if unlock_delay:
            result['checks'].append('Harness unlock screen renders, masks input, accepts a retry after a wrong password, and unlocks after the deliberate 100-second wait')
        result['installed_hn_ready_seconds_including_test_login'] = round(time.monotonic() - vm.started, 3)
        result['installed_keyboard_readiness'] = check_graphical_keyboard(vm, 'installed')
        result['checks'].append('Installed graphical hn accepts physical-keyboard shell input, returns output and returns home after closing the pane')
        vm.command('test "$(id -un)" = ' + shlex.quote(config['username']) +
                   ' && test "$HOME" = ' + shlex.quote('/home/' + config['username']) +
                   ' && test "$(uname -n)" = ' + shlex.quote(config['hostname']))
        vm.command('test ! -e /etc/sudoers.d/10-live && test ! -e /etc/harness-live && ! sudo -n true')
        vm.command('! pgrep -x chromium')
        vm.command('test "$(npm prefix -g)" = "$HOME/.local"')
        vm.command('findmnt -n -o FSTYPE / | grep -qx btrfs')
        vm.command('findmnt -n -o FSTYPE /boot | grep -qx vfat')
        output, _ = vm.command('cat /var/lib/harness-os/install.json; hn-os measure')
        (folder / 'installed-measurement.txt').write_text(output)
        vm.screenshot('04-installed-hn')
        result['checks'].append('Installed disk boots to hn with intended account permissions and no browser')
        # Let boot jobs settle before calling a sample "idle". Keep all three
        # measurements, including CPU, rather than selecting the smallest one.
        output, _ = vm.command('sleep 45; for n in 1 2 3; do hn-os measure; done', timeout=65)
        (folder / 'installed-idle-measurements.txt').write_text(output)
        vm.boot_diagnostics(config, 'installed')
        # A disposable failure exercises actual root + boot restoration, including
        # an encrypted root in the UEFI row. The project's separate subvolume survives.
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
        update_script = base64.b64encode(Path(__file__).with_name('updates.sh').read_bytes()).decode()
        vm.command(': > /tmp/hn-os-updates.b64')
        for offset in range(0, len(update_script), 2000):
            vm.command('printf %s ' + update_script[offset:offset + 2000] + ' >> /tmp/hn-os-updates.b64')
        vm.command('base64 -d /tmp/hn-os-updates.b64 > /tmp/hn-os-updates.sh')
        output, status = vm.command('sudo bash /tmp/hn-os-updates.sh', timeout=300, check=False)
        (folder / 'update-retry.log').write_text(output)
        assert status == 0, 'Full-update failure/retry check failed; see update-retry.log'
        result['checks'].append('Failed full update blocks package changes; successful retry upgrades a local fixture and retains the original recovery checkpoint')
        # A local package exercises the actual pacman PreTransaction hook while
        # networking is unavailable. Its checkpoint includes the active db.lck.
        package_script = '''set -eu
mkdir -p /tmp/hn-recovery-package/etc
printf 'pkgname = hn-os-recovery-probe\npkgver = 1-1\npkgdesc = Disposable VM rollback probe\narch = any\nsize = 7\n' > /tmp/hn-recovery-package/.PKGINFO
printf changed > /tmp/hn-recovery-package/etc/hn-os-recovery-probe
bsdtar --zstd -cf /tmp/hn-os-recovery-probe-1-1-any.pkg.tar.zst -C /tmp/hn-recovery-package .PKGINFO etc
pacman --noconfirm -U /tmp/hn-os-recovery-probe-1-1-any.pkg.tar.zst
'''
        encoded = base64.b64encode(package_script.encode()).decode()
        output, _ = vm.command('printf %s ' + encoded + ' | base64 -d | sudo bash', timeout=180)
        checkpoint = re.search(r'Checkpoint ([A-Za-z0-9_-]+)', output).group(1)
        vm.command('pacman -Q hn-os-recovery-probe && test -f /etc/hn-os-recovery-probe')
        result['checks'].append('A real offline package transaction creates its pre-update checkpoint')
        vm.command('printf keep-my-project > ~/Projects/recovery-probe.txt')
        vm.command("sudo sh -c 'printf broken > /etc/hn-os-recovery-probe; chmod 000 /usr/lib/harness/harness-tui'")
        vm.command('sync')
        vm.stop()
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ')
        vm.shell_ready = True
        vm.command('stty -echo')
        root_device = '/dev/vda3'
        if config['encrypt']:
            vm.command('printf %s ' + shlex.quote(config['password']) + ' | cryptsetup open --key-file=- /dev/vda3 hn-recovery')
            root_device = '/dev/mapper/hn-recovery'
        vm.command('hn-os recover ' + root_device + ' ' + checkpoint, timeout=180)
        if config['encrypt']:
            vm.command('cryptsetup close hn-recovery')
        result['checks'].append('Offline checkpoint restored root and verified matching boot files')
        vm.stop()
        vm.start(live=False)
        vm.login_installed(config)
        vm.boot_diagnostics(config, 'recovered')
        vm.command('test ! -e /etc/hn-os-recovery-probe && test -x /usr/lib/harness/harness-tui && test "$(cat ~/Projects/recovery-probe.txt)" = keep-my-project')
        vm.command('test ! -e /var/lib/pacman/db.lck && ! pacman -Q hn-os-recovery-probe')
        result['recovered_keyboard_readiness'] = check_graphical_keyboard(vm, 'recovered')
        result['checks'].append('Recovered graphical hn accepts physical-keyboard shell input, returns output and returns home after closing the pane')
        vm.screenshot('05-recovered-hn')
        result['checks'].append('Recovered disk boots to hn; system and package database reverted, stale lock cleared and project preserved')
        if args.agents:
            # A real development toolchain must install from the shipped package
            # indexes, compile a project, and serve its preview in another hn pane.
            vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S pacman --noconfirm -S --needed gcc make', timeout=300)
            development = base64.b64encode(Path(__file__).with_name('development.sh').read_bytes()).decode()
            vm.command(f'printf %s {development} | base64 -d > /tmp/hn-os-development.sh')
            vm.command('hn new-window -n development ' + shlex.quote('bash /tmp/hn-os-development.sh > "$HOME/.local/state/harness-os/development.log" 2>&1'))
            output, _ = vm.command('for n in $(seq 1 60); do test -s ~/.local/state/harness-os/development-check/status && break; sleep 1; done; cat ~/.local/state/harness-os/development.log; test "$(cat ~/.local/state/harness-os/development-check/status)" = 0', timeout=75)
            (folder / 'development.log').write_text(output)
            vm.command('hn new-window -n local-preview ' + shlex.quote('node "$HOME/Projects/os-validation/server.mjs"'))
            vm.command('curl --fail --retry 15 --retry-connrefused --retry-delay 1 http://127.0.0.1:18781 | grep -F "Local development works."', timeout=30)
            vm.command('hn-browser http://127.0.0.1:18781')
            time.sleep(5)
            vm.screenshot('06-local-development-preview')
            vm.keys('meta_l', 'ret')
            vm.command('pkill -x chromium', check=False)
            result['checks'].append('On-demand gcc/make installation, C compilation, Git diff and Node preview in an hn pane passed')
            script = Path(__file__).with_name('agents.sh').read_bytes()
            encoded = base64.b64encode(script).decode()
            vm.command(f'printf %s {shlex.quote(encoded)} | base64 -d > /tmp/hn-os-agents.sh')
            vm.command('hn new-window -n agent-compatibility ' + shlex.quote('bash /tmp/hn-os-agents.sh > "$HOME/.local/state/harness-os/agent-check.log" 2>&1'))
            output, _ = vm.command('for n in $(seq 1 600); do test -s ~/.local/state/harness-os/agent-check/status && break; sleep 1; done; cat ~/.local/state/harness-os/agent-check.log; test "$(cat ~/.local/state/harness-os/agent-check/status)" = 0', timeout=630)
            (folder / 'agent-installation.log').write_text(output)
            output, _ = vm.command('cat ~/.local/state/harness-os/agent-check/packages.json')
            (folder / 'agent-versions.txt').write_text(output)
            result['checks'].append('Claude Code, Codex and pi install on demand; bundled OpenCode and all four agents report versions inside an hn terminal')
        if args.workloads:
            # Public fictional tasks only, in the disposable guest. No host keys,
            # accounts or workspaces are made available to the model.
            package = io.BytesIO()
            with tarfile.open(fileobj=package, mode='w:gz') as archive:
                archive.add(Path(__file__).with_name('workloads'), arcname='workloads')
                if args.workload_seed:
                    seeds = list(args.workload_seed.rglob('Projects/os-workloads'))
                    if len(seeds) != 1:
                        raise RuntimeError('Need exactly one prior generated project tree.')
                    for name in ['terminal-tool', 'website', 'game', 'fullstack']:
                        archive.add(seeds[0] / name, arcname='workloads/seed/' + name)
                    result['workload_project_source_run_id'] = os.environ.get('OS_WORKLOAD_SOURCE_RUN')
            encoded = base64.b64encode(package.getvalue()).decode()
            vm.command(': > /tmp/hn-workloads.b64')
            for offset in range(0, len(encoded), 2000):
                vm.command('printf %s ' + encoded[offset:offset + 2000] + ' >> /tmp/hn-workloads.b64')
            vm.command('base64 -d /tmp/hn-workloads.b64 | tar -xz -C /tmp; rm /tmp/hn-workloads.b64')
            vm.command('hn new-window -n programmer-workloads ' + shlex.quote('bash /tmp/workloads/run.sh > "$HOME/.local/state/harness-os/workloads.log" 2>&1'))
            output, _ = vm.command('for n in $(seq 1 3300); do test -s ~/.local/state/harness-os/workloads/status && break; sleep 1; done; cat ~/.local/state/harness-os/workloads.log', timeout=3320)
            (folder / 'workloads.log').write_text(output)
            # Keep both successful and failed model output for review; exclude
            # install caches and dependencies from the small source archive.
            vm.command('tar --exclude=node_modules --exclude=.git --exclude=__pycache__ -czf /tmp/hn-workloads-results.tgz -C "$HOME" Projects/os-workloads .local/state/harness-os/workloads', timeout=60)
            output, _ = vm.command("printf 'HN_WORKLOAD_ARCHIVE='; base64 -w0 /tmp/hn-workloads-results.tgz; printf '\\n'", timeout=120)
            packed = base64.b64decode(re.search(r'HN_WORKLOAD_ARCHIVE=([A-Za-z0-9+/=]+)', output).group(1), validate=True)
            destination = folder / 'workloads'
            destination.mkdir()
            with tarfile.open(fileobj=io.BytesIO(packed), mode='r:gz') as archive:
                archive.extractall(destination, filter='data')
            (destination / '.local/state/harness-os/workloads').rename(destination / 'reports')
            vm.command('test "$(cat ~/.local/state/harness-os/workloads/status)" = 0')
            result['checks'].append('Free OpenCode built four projects; independent CLI, keyboard browser, game and persistent API checks passed')
        if args.dsh:
            package = io.BytesIO()
            with tarfile.open(fileobj=package, mode='w:gz') as archive:
                archive.add(Path(__file__).with_name('dsh'), arcname='dsh')
                store = Path(__file__).resolve().parents[2] / 'store'
                for component in ['viewers/web-viewer', 'viewers/game-viewer', 'examples/hello-world']:
                    archive.add(store / component, arcname='dsh/components/' + component)
            encoded = base64.b64encode(package.getvalue()).decode()
            vm.command(': > /tmp/hn-dsh.b64')
            for offset in range(0, len(encoded), 2000):
                vm.command('printf %s ' + encoded[offset:offset + 2000] + ' >> /tmp/hn-dsh.b64')
            vm.command('base64 -d /tmp/hn-dsh.b64 | tar -xz -C /tmp; rm /tmp/hn-dsh.b64')
            vm.command('hn new-window -n dsh-acceptance ' + shlex.quote('bash /tmp/dsh/run.sh > "$HOME/.local/state/harness-os/dsh-check.log" 2>&1'))
            output, _ = vm.command('for n in $(seq 1 2700); do test -s ~/.local/state/harness-os/dsh-check/status && break; sleep 1; done; cat ~/.local/state/harness-os/dsh-check.log', timeout=2720)
            (folder / 'dsh-check.log').write_text(output)
            vm.command('tar --exclude=node_modules --exclude=.git --exclude=__pycache__ -czf /tmp/hn-dsh-results.tgz -C "$HOME" Projects/os-dsh .local/state/harness-os/dsh-check', timeout=60)
            output, _ = vm.command("printf 'HN_DSH_ARCHIVE='; base64 -w0 /tmp/hn-dsh-results.tgz; printf '\\n'", timeout=120)
            packed = base64.b64decode(re.search(r'HN_DSH_ARCHIVE=([A-Za-z0-9+/=]+)', output).group(1), validate=True)
            destination = folder / 'dsh'
            destination.mkdir()
            with tarfile.open(fileobj=io.BytesIO(packed), mode='r:gz') as archive:
                archive.extractall(destination, filter='data')
            (destination / '.local/state/harness-os/dsh-check').rename(destination / 'reports')
            vm.command('test "$(cat ~/.local/state/harness-os/dsh-check/status)" = 0')
            result['checks'].append('Three managed DSH agents, terminal output, shared Web Viewer reload and Game Viewer keyboard play/export passed')
        result['status'] = 'passed'
    except Exception as error:
        result['status'] = 'failed'
        result['error'] = str(error)
        if vm.shell_ready:
            try:
                diagnostics, _ = vm.command('journalctl -b --no-pager -n 350; systemctl --failed --no-pager; cat /home/*/.local/state/harness-os/display.log; ps -efww', timeout=20, check=False)
                (folder / 'guest-diagnostics.log').write_text(diagnostics)
            except Exception:
                pass
        try:
            vm.screenshot('failure')
        except Exception:
            pass
        raise
    finally:
        vm.stop()
        vm.control.cleanup()
        result['finished_at_unix'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
        # Large disposable disks are never uploaded with the small evidence set.
        vm.disk.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
