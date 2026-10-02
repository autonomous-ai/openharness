#!/usr/bin/env python3
"""Boot and install the actual ISO in a disposable QEMU machine.

Uses a private qcow2 disk with a known serial. Never passes a host block device
to QEMU. Screenshots, serial logs, timings and checks survive every failure.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
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
import time
import uuid


class VM:
    def __init__(self, folder, iso, firmware, memory):
        self.folder, self.iso, self.firmware, self.memory = folder, iso, firmware, memory
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
        if firmware == 'uefi':
            self.code = Path('/usr/share/OVMF/OVMF_CODE_4M.fd')
            self.vars = folder / 'OVMF_VARS.fd'
            shutil.copyfile('/usr/share/OVMF/OVMF_VARS_4M.fd', self.vars)

    def start(self, live):
        self.shell_ready = False
        for name in ['serial.sock', 'qmp.sock']:
            (self.control_path / name).unlink(missing_ok=True)
        self.started = time.monotonic()
        acceleration = 'kvm' if os.access('/dev/kvm', os.R_OK | os.W_OK) else 'tcg'
        args = ['qemu-system-x86_64', '-accel', acceleration, '-m', str(self.memory), '-smp', '2',
                '-cpu', 'host' if acceleration == 'kvm' else 'max', '-device', 'virtio-vga',
                '-display', 'none', '-no-reboot',
                '-drive', f'file={self.disk},format=qcow2,if=none,id=target',
                '-device', f'virtio-blk-pci,drive=target,serial=HN_OS_TEST,bootindex={2 if live else 1}',
                '-device', 'virtio-net-pci,netdev=net', '-netdev', 'user,id=net',
                '-serial', f'unix:{self.control_path / "serial.sock"},server=on,wait=off',
                '-qmp', f'unix:{self.control_path / "qmp.sock"},server=on,wait=off']
        if live:
            # UEFI remembers the installed disk in NVRAM. Explicit device boot
            # indices are needed to select the recovery ISO again on later boots.
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

    def login_installed(self, config):
        if config['encrypt']:
            self.wait(r'(?:passphrase|Passphrase|Password)[^\r\n]*:', timeout=180)
            self.send(config['password'] + '\n')
        self.wait(r'login:', timeout=180)
        self.send('programmer\n')
        self.wait(r'Password:')
        self.send(config['password'] + '\n')
        self.wait(r'\$ ')
        self.shell_ready = True
        self.command('stty -echo')
        if not config['encrypt']:
            for word in ['programmer', config['password']]:
                for char in word:
                    self.keys('minus' if char == '-' else char)
                self.keys('ret')
                time.sleep(2)
        self.command('for n in $(seq 1 90); do systemctl --user is-active --quiet hn-screen && pgrep -x "hn|harness-tui" >/dev/null && exit 0; sleep 1; done; exit 1', timeout=110)

    def screenshot(self, name):
        ppm = self.folder / (name + '.ppm')
        self.monitor('screendump', filename=str(ppm))
        from PIL import Image
        Image.open(ppm).save(self.folder / (name + '.png'))
        ppm.unlink()

    def keys(self, *keys):
        self.monitor('send-key', keys=[{'type': 'qcode', 'data': key} for key in keys], **{'hold-time': 100})
        time.sleep(0.12)  # Release each key, including repeated password characters.

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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', required=True, type=Path)
    parser.add_argument('--firmware', choices=['bios', 'uefi'], default='bios')
    parser.add_argument('--encrypt', action='store_true')
    parser.add_argument('--memory', type=int, default=2048)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--agents', action='store_true', help='Install and start real agent executables after recovery; no accounts/API calls')
    parser.add_argument('--live-only', action='store_true', help='Development probe: stop after the live-session checks, without installing')
    args = parser.parse_args()
    folder = (args.output or Path(__file__).resolve().parents[1] / 'test-results' / (args.firmware + ('-encrypted' if args.encrypt else '-plain'))).resolve()
    folder.mkdir(parents=True, exist_ok=False)
    result = {'firmware': args.firmware, 'encrypted': args.encrypt, 'memory_mib': args.memory,
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
    vm = VM(folder, args.iso.resolve(), args.firmware, args.memory)
    user = lambda cmd: 'runuser -u programmer -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus ' + cmd
    try:
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ')
        vm.shell_ready = True
        vm.command('stty -echo')
        vm.command('foot --check-config --config=/usr/share/harness-os/foot.ini')
        vm.command(user("sh -c 'for n in $(seq 1 90); do systemctl --user is-active --quiet hn-screen && pgrep -u 1000 -x \"hn|harness-tui\" >/dev/null && exit 0; sleep 1; done; systemctl --user --no-pager status hn-screen harness-daemon; exit 1'"), timeout=110)
        result['live_hn_ready_seconds'] = round(time.monotonic() - vm.started, 3)
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
        vm.keys('meta_l', 'b')
        vm.command("for n in $(seq 1 45); do pgrep -x chromium >/dev/null && break; sleep 1; done; pgrep -x chromium", timeout=60)
        time.sleep(3)
        vm.screenshot('02-browser')
        vm.keys('meta_l', 'b')
        time.sleep(1)
        vm.screenshot('03-return-to-hn')
        result['checks'].append('Browser starts only on shortcut; toggle screenshots recorded')
        # A long-lived terminal process proves a screen restart does not kill the work.
        survivor = "echo $$ > /tmp/hn-survivor.pid; exec sleep 1800"
        vm.command(user("hn new-window -n persistence " + shlex.quote(survivor)))
        vm.command('test -s /tmp/hn-survivor.pid')
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
        if args.live_only:
            result['status'] = 'passed'
            return
        config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                      username='programmer', hostname='hn-test', password='test-password-123',
                      encrypt=args.encrypt, serial_console=True)
        encoded = base64.b64encode(json.dumps(config).encode()).decode()
        vm.command(f"printf %s {shlex.quote(encoded)} | base64 -d > /run/hn-install-test.json; chmod 600 /run/hn-install-test.json")
        # Installation must work with the NIC down, using the ISO's immutable payload.
        vm.command('nmcli networking off')
        vm.command('hn-os install --config /run/hn-install-test.json --yes-erase-disk', timeout=900)
        result['checks'].append('Offline installer completed on disposable disk')
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        vm.login_installed(config)
        result['installed_hn_ready_seconds_including_test_login'] = round(time.monotonic() - vm.started, 3)
        vm.command('test ! -e /etc/sudoers.d/10-live && ! sudo -n true')
        vm.command('! pgrep -x chromium')
        vm.command('findmnt -n -o FSTYPE / | grep -qx btrfs')
        vm.command('findmnt -n -o FSTYPE /boot | grep -qx vfat')
        output, _ = vm.command('cat /var/lib/harness-os/install.json; hn-os measure')
        (folder / 'installed-measurement.txt').write_text(output)
        vm.screenshot('04-installed-hn')
        result['checks'].append('Installed disk boots to hn with intended account permissions and no browser')
        # A disposable failure exercises actual root + boot restoration, including
        # an encrypted root in the UEFI row. The project's separate subvolume survives.
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
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
        vm.command('test ! -e /etc/hn-os-recovery-probe && test -x /usr/lib/harness/harness-tui && test "$(cat ~/Projects/recovery-probe.txt)" = keep-my-project')
        vm.command('test ! -e /var/lib/pacman/db.lck && ! pacman -Q hn-os-recovery-probe')
        vm.screenshot('05-recovered-hn')
        result['checks'].append('Recovered disk boots to hn; system and package database reverted, stale lock cleared and project preserved')
        if args.agents:
            script = Path(__file__).with_name('agents.sh').read_bytes()
            encoded = base64.b64encode(script).decode()
            vm.command(f'printf %s {shlex.quote(encoded)} | base64 -d > /tmp/hn-os-agents.sh')
            vm.command('hn new-window -n agent-compatibility ' + shlex.quote('bash /tmp/hn-os-agents.sh > "$HOME/.local/state/harness-os/agent-check.log" 2>&1'))
            output, _ = vm.command('for n in $(seq 1 600); do test -s ~/.local/state/harness-os/agent-check/status && break; sleep 1; done; cat ~/.local/state/harness-os/agent-check.log; test "$(cat ~/.local/state/harness-os/agent-check/status)" = 0', timeout=630)
            (folder / 'agent-installation.log').write_text(output)
            output, _ = vm.command('cat ~/.local/state/harness-os/agent-check/packages.json')
            (folder / 'agent-versions.txt').write_text(output)
            result['checks'].append('Real Claude Code, Codex, OpenCode and pi install and report versions inside an hn terminal; model turns unverified')
        result['status'] = 'passed'
    except Exception as error:
        result['status'] = 'failed'
        result['error'] = str(error)
        if vm.shell_ready:
            try:
                diagnostics, _ = vm.command('journalctl -b --no-pager -n 350; systemctl --failed --no-pager; cat /home/programmer/.local/state/harness-os/display.log; ps -ef', timeout=20, check=False)
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
