#!/usr/bin/env python3
"""Build and exercise a private Fedora/Asahi graphical VM from tracked inputs.

This is a session prototype, not a board installer or an update artifact. It never
opens a host block device. Every fresh disk belongs to this disposable test.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET

from arm_boot import check_arm_image, digest, download, zboot_payload
from vm import VM

ROOT = Path(__file__).resolve().parents[2]
USER = 'runuser -u me -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus '


def runtime_identity(runtime, commit):
    info = json.loads((runtime / 'source.json').read_text())
    if (info.get('dirty') is not False or info.get('source_commit') != commit or
            info.get('architecture') != 'aarch64' or info.get('target') != 'aarch64-unknown-linux-musl'):
        raise ValueError('Use the clean native ARM runtime from this source commit.')
    if set(info.get('files', {})) != {'harness-tui', 'cli.js', 'notify.mjs'}:
        raise ValueError('Runtime is incomplete.')
    for name, identity in info['files'].items():
        path = runtime / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size != identity['bytes'] or digest(path) != identity['sha256']:
            raise ValueError('Runtime checksum mismatch: ' + name)
    with (runtime / 'harness-tui').open('rb') as handle:
        header = handle.read(20)
    if header[:6] != b'\x7fELF\x02\x01' or int.from_bytes(header[18:20], 'little') != 183:
        raise ValueError('The terminal must be a little-endian ARM64 ELF executable.')
    return info


def stage(runtime, destination, commit):
    info = runtime_identity(runtime, commit)
    # Deliberately select the shared session only. Do not transplant pacman,
    # BIOS/EFI installation, x86 driver hooks, or PC update services into Fedora.
    paths = [
        'etc/profile.d/harness-os.sh', 'etc/sudoers.d/20-harness-network',
        'etc/NetworkManager/conf.d/10-dns.conf', 'etc/chromium/policies/managed/harness.json',
        'etc/skel/projects/AGENTS.md', 'usr/bin/hn', 'usr/bin/harness', 'usr/bin/hn-browser',
        'usr/share/harness-os/foot.ini', 'usr/share/harness-os/tmux.conf',
        'usr/share/harness-os/guide.md', 'usr/share/harness-os/AGENTS.md',
        *['usr/share/harness-os/labwc/' + name for name in ['autostart', 'shutdown', 'rc.xml']],
        *['usr/lib/harness-os/' + name for name in
          ['session', 'session-settings.py', 'runtime-path', 'wait-runtime', 'virtio-2d', 'open-wifi']],
        *['usr/lib/systemd/user/' + name for name in
          ['hn-screen.service', 'harness-daemon.service', 'harness-idle.service']],
    ]
    for name in paths:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / 'os/root' / name, target)
    for source, name in [
        *[('os/' + name + '.py', 'usr/lib/harness-os/' + name + '.py') for name in
          ['onboarding', 'network', 'projects', 'hardware']],
        ('os/tools/hn-os', 'usr/bin/hn-os'), ('tui/README.md', 'usr/share/harness-os/guide/tui.md'),
        ('LICENSE', 'usr/share/licenses/harness-os/LICENSE'),
    ]:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / source, target)
    library = destination / 'usr/lib/harness'
    library.mkdir(parents=True)
    for source, target in [('harness-tui', 'harness-tui'), ('cli.js', 'cli.mjs'), ('notify.mjs', 'notify.mjs')]:
        shutil.copy2(runtime / source, library / target)
    (library / 'hn').symlink_to('harness-tui')
    info['files'] = {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p)}
                     for p in library.iterdir() if not p.is_symlink()}
    (destination / 'usr/share/harness-os/runtime.json').write_text(json.dumps(info, indent=2) + '\n')
    (destination / 'usr/lib/systemd/user/harness-os.target').write_text(
        '[Unit]\nDescription=Private ARM Harness session\n'
        'Wants=hn-screen.service harness-idle.service\nAfter=graphical-session-pre.target\n')
    config = destination / 'usr/share/harness-os/labwc/rc.xml'
    tree = ET.parse(config)
    keyboard = tree.getroot().find('keyboard')
    for binding in list(keyboard.findall('keybind')):
        if binding.get('key') in ['W-i', 'W-u']:
            keyboard.remove(binding)
    for action in tree.findall('.//action'):
        if action.get('name') == 'NextWindowImmediate':
            action.set('name', 'NextWindow')  # Fedora's labwc 0.9.6 action name.
    tree.write(config, encoding='unicode')
    browser = destination / 'usr/bin/hn-browser'
    browser.write_text(browser.read_text().replace('/usr/bin/chromium ', '/usr/bin/chromium-browser '))
    tmux = destination / 'usr/share/harness-os/tmux.conf'
    tmux.write_text('\n'.join(line for line in tmux.read_text().splitlines() if not line.startswith('bind U ')) + '\n')
    for directory in ['usr/bin', 'usr/lib/harness-os']:
        for path in (destination / directory).iterdir():
            path.chmod(0o755)
    for name in ['autostart', 'shutdown']:
        (destination / 'usr/share/harness-os/labwc' / name).chmod(0o755)
    (library / 'harness-tui').chmod(0o755)
    (destination / 'etc/sudoers.d/20-harness-network').chmod(0o440)
    return {'runtime': info, 'files': {str(p.relative_to(destination)): digest(p)
                                     for p in sorted(destination.rglob('*')) if p.is_file() and not p.is_symlink()}}


class SessionVM(VM):
    def __init__(self, folder, disk, kernel):
        if not disk.is_file() or disk.is_symlink():
            raise ValueError('The private VM disk must be a regular file.')
        self.folder, self.disk, self.kernel = folder, disk, kernel
        folder.mkdir()
        self.control = tempfile.TemporaryDirectory(prefix='hn-arm-session-', dir='/tmp')
        self.control_path = Path(self.control.name)
        self.log = (folder / 'serial.log').open('ab', buffering=0)
        self.stderr = (folder / 'qemu.log').open('ab', buffering=0)
        self.serial = self.qmp = self.qmp_file = self.process = None
        self.boot_count = 0
        self.shell_ready = False

    def start(self, offline=False):
        self.started = time.monotonic()
        self.boot_count += 1
        accelerator = 'kvm' if os.access('/dev/kvm', os.R_OK | os.W_OK) else 'tcg'
        cpu = 'host' if accelerator == 'kvm' else 'cortex-a76'
        args = ['qemu-system-aarch64', '-machine', 'virt,gic-version=3', '-accel', accelerator,
                '-cpu', cpu, '-smp', '2', '-m', '3072', '-nodefaults', '-display', 'none', '-no-reboot',
                '-kernel', str(self.kernel), '-append', 'root=/dev/vda rw console=tty0 console=ttyAMA0 loglevel=3 panic=1',
                '-drive', f'file={self.disk},format=raw,if=none,id=root', '-device', 'virtio-blk-pci,drive=root,serial=HARNESS_ARM_TEST',
                '-device', 'virtio-gpu-pci', '-device', 'virtio-keyboard-pci', '-device', 'virtio-tablet-pci',
                '-netdev', 'user,id=net', '-device', 'virtio-net-pci,netdev=net,id=hnnet,romfile=',
                '-serial', f'unix:{self.control_path / "serial.sock"},server=on,wait=off',
                '-qmp', f'unix:{self.control_path / "qmp.sock"},server=on,wait=off']
        (self.folder / 'command.json').write_text(json.dumps(args, indent=2) + '\n')
        self.process = subprocess.Popen(args, stdout=self.stderr, stderr=self.stderr)
        self.serial = self.connect('serial.sock')
        self.qmp = self.connect('qmp.sock')
        self.qmp.settimeout(10)
        self.qmp_file = self.qmp.makefile('rb')
        json.loads(self.qmp_file.readline())
        self.monitor('qmp_capabilities')
        if offline:
            self.monitor('set_link', name='hnnet', up=False)
        self.wait('HARNESS_ARM_CONSOLE> ', timeout=180)
        self.command('stty -echo')
        self.command('test "$(getconf PAGESIZE)" = 16384 && test "$(uname -m)" = aarch64')
        self.shell_ready = True

    def user(self, command, **kwargs):
        return self.command(USER + 'sh -c ' + shlex.quote(command), **kwargs)

    def wait_user(self, command, seconds=45):
        return self.user('for n in $(seq 1 ' + str(seconds * 2) + '); do if ' + command +
                         '; then exit 0; fi; sleep .5; done; exit 1', timeout=seconds + 10)

    def frame(self, name, text, seconds=60):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.screenshot(name)
            output = subprocess.check_output(['tesseract', str(self.folder / (name + '.png')), 'stdout', '--psm', '11'],
                                             text=True, stderr=subprocess.DEVNULL, timeout=15)
            (self.folder / (name + '.txt')).write_text(output)
            if text.lower() in output.lower():
                return
            time.sleep(1)
        raise TimeoutError('Expected visible text was not rendered: ' + text)

    def keyboard(self, name):
        before, _ = self.user('hn display-message -p "#{pane_id}"')
        old = re.search(r'%\d+', before)
        if not old:
            raise RuntimeError('No current pane before keyboard probe')
        self.keys('meta_l', 't')
        self.wait_user('test "$(hn display-message -p "#{pane_id}")" != ' + shlex.quote(old[0]) +
                       ' && hn capture-pane -p | grep -Eq ' + shlex.quote(r'^\[me@harness [^]]*\]\$'))
        marker = 'arm-' + name + '-ready'
        self.type_probe('echo ' + marker)
        self.keys('ret')
        self.wait_user('hn capture-pane -p | grep -Fx ' + shlex.quote(marker))
        self.frame(name, marker)
        self.keys('ctrl', 'd')

    def close(self):
        self.stop()
        self.log.close()
        self.stderr.close()
        self.control.cleanup()


def exercise(vm, result):
    vm.start(offline=True)
    vm.wait_user('systemctl --user is-active --quiet hn-screen && hn capture-pane -p | grep -q "Connect to Wi-Fi"', 90)
    vm.frame('01-wifi', 'Connect to Wi-Fi')
    vm.keyboard('offline')
    result['checks'].append('Fresh offline boot shows Wi-Fi; Super+t opens a real shell and accepts graphical keyboard input')
    vm.monitor('set_link', name='hnnet', up=True)
    vm.wait_user('test -f ~/.local/state/harness-os/onboarded && pgrep -u 1000 -x opencode >/dev/null', 150)
    vm.wait_user('test "$(hn list-panes -F "#{pane_id}" | wc -l)" -eq 3')
    vm.frame('02-agent', 'OpenCode')
    output, _ = vm.command('pgrep -u 1000 -x opencode | head -1')
    pid = re.search(r'(?m)^\d+\r?$', output)[0].strip()
    output, _ = vm.command('readlink /proc/' + pid + '/cwd')
    match = re.search(r'/home/me/projects/[a-zA-Z0-9._-]+', output)
    if not match:
        raise RuntimeError('Agent did not start in its own projects subfolder')
    project = match[0]
    result['agent_pid'] = int(pid)
    result['project'] = project
    prompt = ('Create hello.py that prints exactly harness arm ready and exits. Also create index.html with title Harness ARM Demo, '
              'visible text Harness ARM Demo, and exactly one button named Increment. The page displays Count: 0 initially and '
              'Count: 1 after clicking the button once. Use plain HTML and JavaScript only, no dependencies. Save both files now.')
    vm.user('hn send-keys -l ' + shlex.quote(prompt) + '; hn send-keys Enter')
    files = 'test -s ' + shlex.quote(project + '/hello.py') + ' && test -s ' + shlex.quote(project + '/index.html')
    vm.wait_user(files, 240)
    vm.wait_user('test "$(python3 ' + shlex.quote(project + '/hello.py') + ')" = "harness arm ready"', 30)
    for name in ['hello.py', 'index.html']:
        (vm.folder / name).write_bytes(vm.read_file(project + '/' + name))
    vm.screenshot('03-agent-project')
    result['checks'].append('Upstream-default OpenCode creates Python and HTML; independent Python execution checks the result')
    vm.user('hn-browser ' + shlex.quote('file://' + project + '/index.html'))
    vm.frame('04-browser', 'Harness ARM Demo', 90)
    vm.click_word('05-increment', 'Increment')
    vm.frame('06-counter', 'Count: 1')
    output, _ = vm.command('python3 - <<\'PY\'\nfrom pathlib import Path\n'
        'renderers=[]\nfor p in Path("/proc").glob("[0-9]*"):\n'
        ' try:\n  cmd=(p/"cmdline").read_bytes()\n'
        '  if b"--type=renderer" in cmd and p.stat().st_uid==1000:\n'
        '   status=(p/"status").read_text(); assert "NoNewPrivs:\\t1" in status and "Seccomp:\\t2" in status; '
        'assert b"--no-sandbox" not in cmd; renderers.append(p.name)\n'
        ' except FileNotFoundError: pass\nassert renderers\nprint(renderers)\nPY')
    (vm.folder / 'browser-sandbox.txt').write_text(output)
    vm.keys('meta_l', 'b')
    vm.frame('07-return', 'OpenCode')
    vm.command('kill -0 ' + pid)
    vm.keyboard('after-browser')
    vm.command('kill -0 ' + pid)
    result['checks'].append('Sandboxed native Chromium renders the agent page; mouse click increments it; Super+b returns to the same agent and keyboard works')
    vm.command('uname -r; getconf PAGESIZE; systemd-analyze; df -B1 /')
    result['projects'] = {name: digest(vm.folder / name) for name in ['hello.py', 'index.html']}
    vm.command('sync; systemctl poweroff --no-block')
    vm.process.wait(timeout=60)
    if vm.process.returncode != 0:
        raise RuntimeError('Guest did not shut down cleanly')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != 'Linux' or platform.machine() != 'aarch64' or os.geteuid() == 0:
        parser.error('Use an ordinary user on a native ARM Linux runner.')
    for name in ['docker', 'rpm', 'rpmkeys', 'gpg', 'bsdtar', 'zstd', 'mkfs.ext4', 'qemu-system-aarch64', 'sudo', 'tesseract']:
        if not shutil.which(name):
            parser.error('Missing tool: ' + name)
    from PIL import Image  # noqa: F401 — fail before preparing a disk if unavailable.
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip():
        parser.error('Commit the exact source before building a traceable VM.')
    runtime = args.runtime.resolve()
    runtime_identity(runtime, source)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    work = Path(tempfile.mkdtemp(prefix='harness-arm-session-', dir=os.environ.get('RUNNER_TEMP')))
    container = work.name
    lock = json.loads(Path(__file__).with_name('arm-boot.lock.json').read_text())
    graphical = json.loads(Path(__file__).with_name('arm-session.lock.json').read_text())
    receipt = {'status': 'running', 'source_commit': source, 'scope': 'Private Fedora/Asahi graphical VM only',
               'started_at_unix': time.time(), 'kernel_inputs': lock, 'session_inputs': graphical, 'checks': [],
               'limitations': ['No Apple hardware, firmware provisioning or installer', 'No Fedora update/recovery integration',
                               'No OS/runtime release; signed repository package versions are recorded, not snapshot-pinned']}
    log = (output / 'host.log').open('w')
    machine = None

    def run(argv, timeout=120, capture=False, check=True):
        log.write('$ ' + repr([str(a) for a in argv]) + '\n')
        log.flush()
        result = subprocess.run([str(a) for a in argv], timeout=timeout, check=check, text=True,
                                stdout=subprocess.PIPE if capture else log, stderr=subprocess.STDOUT if capture else log)
        if capture:
            log.write(result.stdout)
            log.flush()
            return result.stdout
        return result

    try:
        inputs = work / 'inputs'
        inputs.mkdir()
        print('Verify signed 16 KiB kernel and graphical modules', flush=True)
        with ThreadPoolExecutor(max_workers=3) as pool:
            paths = list(pool.map(lambda item: download(item, inputs), [*lock['kernel_packages'], graphical['graphics_modules'], lock['signing_key']]))
        key, packages = paths[-1], paths[:-1]
        gpg_home, rpmdb = work / 'gpg', work / 'rpmdb'
        gpg_home.mkdir(mode=0o700)
        rpmdb.mkdir()
        keys = run(['gpg', '--homedir', gpg_home, '--with-colons', '--show-keys', '--fingerprint', key], capture=True)
        if [line.split(':')[9] for line in keys.splitlines() if line.startswith('fpr:')] != [lock['signing_key']['fingerprint']]:
            raise ValueError('Unexpected kernel signing key')
        run(['rpm', '--dbpath', rpmdb, '--initdb'])
        run(['rpm', '--dbpath', rpmdb, '--import', key])
        kernel = work / 'kernel'
        kernel.mkdir()
        for package in packages:
            signature = run(['rpmkeys', '--dbpath', rpmdb, '--checksig', '--verbose', package], capture=True)
            if not re.search(r'signature, key (?:ID|fingerprint):? [0-9a-f]+: OK', signature, re.I) or 'NOKEY' in signature or 'NOT OK' in signature:
                raise ValueError('Missing verified kernel package signature')
            run(['bsdtar', '--no-same-owner', '-xpf', package, '-C', kernel])
        modules = kernel / 'lib/modules' / lock['kernel_release']
        compressed, image = work / 'Image.zst', work / 'Image'
        compressed.write_bytes(zboot_payload((modules / 'vmlinuz').read_bytes()))
        run(['zstd', '-d', compressed, '-o', image])
        check_arm_image(image.read_bytes()[:64])
        receipt['kernel_sha256'] = digest(image)
        shutil.move(kernel / 'lib/modules', inputs / 'modules')
        (inputs / 'kernel-release').write_text(lock['kernel_release'] + '\n')
        receipt['payload'] = stage(runtime, inputs / 'overlay', source)
        shutil.copy2(Path(__file__).with_name('arm_session_root.sh'), inputs / 'provision')
        receipt['provision_sha256'] = digest(inputs / 'provision')
        print('Build a fresh signed Fedora session without a desktop', flush=True)
        run(['docker', 'run', '--name', container, '--platform', 'linux/arm64', '--memory=4g', '--cpus=2', '--pids-limit=1024',
             '--mount', f'type=bind,source={inputs},target=/inputs,readonly', graphical['root_image'], 'bash', '/inputs/provision'], timeout=1200)
        for source_path, name in [('/harness-packages.tsv', 'packages.tsv'), ('/opt/harness-agent/package-lock.json', 'agent-lock.json')]:
            run(['docker', 'cp', container + ':' + source_path, output / name])
        archive, root, disk = work / 'root.tar', work / 'root', work / 'guest.raw'
        root.mkdir()
        run(['docker', 'export', '--output', archive, container], timeout=180)
        run(['sudo', 'bsdtar', '-xpf', archive, '-C', root], timeout=180)
        archive.unlink()
        # Correct only the exported private root, never the host /etc files.
        run(['sudo', 'rm', '-f', root / 'etc/resolv.conf', root / '.dockerenv'])
        run(['sudo', 'ln', '-s', '/run/systemd/resolve/stub-resolv.conf', root / 'etc/resolv.conf'])
        for path, content in [('etc/hostname', 'harness\n'), ('etc/hosts', '127.0.0.1 localhost\n127.0.1.1 harness\n::1 localhost\n'), ('etc/machine-id', '')]:
            replacement = work / ('replacement-' + Path(path).name)
            replacement.write_text(content)
            run(['sudo', 'install', '-m', '644', replacement, root / path])
        with disk.open('xb') as handle:
            handle.truncate(6 * 1024 ** 3)
        run(['sudo', 'mkfs.ext4', '-F', '-q', '-L', 'HARNESS_ARM_TEST', '-d', root, disk], timeout=180)
        receipt['disk'] = {'virtual_bytes': disk.stat().st_size, 'allocated_bytes': disk.stat().st_blocks * 512}
        print('Boot into Wi-Fi, use an agent, open its page, and return to Harness', flush=True)
        machine = SessionVM(output / 'first-boot', disk, image)
        exercise(machine, receipt)
        machine.close()
        machine = SessionVM(output / 'second-boot', disk, image)
        machine.start()
        machine.wait_user('systemctl --user is-active --quiet hn-screen && hn list-panes >/dev/null', 120)
        machine.frame('08-restored', 'harness', 90)
        machine.keyboard('reboot')
        for name, expected in receipt['projects'].items():
            data = machine.read_file(receipt['project'] + '/' + name)
            target = output / 'second-boot' / name
            target.write_bytes(data)
            if digest(target) != expected:
                raise ValueError('Project changed across cold boot: ' + name)
        machine.user('test "$(python3 ' + shlex.quote(receipt['project'] + '/hello.py') + ')" = "harness arm ready"')
        machine.command('sync; systemctl poweroff --no-block')
        machine.process.wait(timeout=60)
        if machine.process.returncode != 0:
            raise RuntimeError('Second boot did not shut down cleanly')
        receipt['checks'].append('Second cold boot reaches Harness, accepts graphical typing and preserves byte-identical working projects')
        receipt['status'] = 'passed'
        print('Fresh Fedora/Asahi graphical session and reboot passed', flush=True)
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
        if machine:
            try:
                machine.screenshot('failure')
                machine.command('journalctl -b --no-pager -n 250; cat /home/me/.local/state/harness-os/display.log', check=False, timeout=20)
            except (OSError, RuntimeError, TimeoutError):
                pass
        raise
    finally:
        cleanup = []
        if machine:
            try:
                machine.close()
            except (OSError, RuntimeError) as error:
                cleanup.append(str(error))
        for argv in [['docker', 'rm', '-f', container], ['sudo', 'rm', '-rf', '--', work]]:
            try:
                if run(argv, timeout=90, check=False).returncode:
                    cleanup.append('Cleanup failed: ' + repr([str(a) for a in argv]))
            except subprocess.SubprocessError as error:
                cleanup.append(str(error))
        if cleanup:
            receipt['cleanup_errors'] = cleanup
            receipt['status'] = 'failed'
        receipt['finished_at_unix'] = time.time()
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        log.close()
        if cleanup:
            raise RuntimeError('; '.join(cleanup))


if __name__ == '__main__':
    main()
