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
import select
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

from arm_boot import check_arm_image, digest, download, zboot_payload
from vm import VM

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'os/tools'))
from fedora_payload import package_identity, runtime_identity, stage as stage_payload
USER = 'runuser -u me -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus '


def frame_contains(output, expected, absent=()):
    expected = [expected] if isinstance(expected, str) else expected
    visible = ' '.join(output.casefold().split())
    return (all(' '.join(word.casefold().split()) in visible for word in expected) and
            not any(word.casefold() in visible for word in absent))


def stage(runtime, destination, commit):
    # Kept as a small portable staging check; fresh VM roots install the RPM.
    return stage_payload(ROOT, runtime, destination, commit, commit)


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
        accelerator = ('hvf' if platform.system() == 'Darwin' and platform.machine() == 'arm64'
                       else 'kvm' if os.access('/dev/kvm', os.R_OK | os.W_OK) else 'tcg')
        self.accelerator = accelerator
        cpu = 'host' if accelerator in ['kvm', 'hvf'] else 'cortex-a76'
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
        # Keep asynchronous shutdown events on the socket for poweroff(),
        # rather than prefetching them into a buffered response reader.
        self.qmp_file = self.qmp.makefile('rb', buffering=0)
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

    def keys(self, *keys):
        # QMP send-key releases held keys on a guest timer. Under HVF load that
        # release can arrive after the compositor starts repeating a character.
        # Queue actual presses and releases together, leaving normal OS repeat
        # settings intact and still exercising the graphical keyboard path.
        events = [{'type': 'key', 'data': {'down': down, 'key': {'type': 'qcode', 'data': key}}}
                  for down, chord in [(True, keys), (False, reversed(keys))] for key in chord]
        self.monitor('input-send-event', events=events)
        time.sleep(.12)

    def frame(self, name, text, seconds=60, absent=()):
        from PIL import Image, ImageOps
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.screenshot(name)
            # Match click_word's treatment of small controls. Preserve the real
            # framebuffer too; OCR must not miss a visibly rendered button just
            # because its native text is close to the border or only 12 px tall.
            ocr_frame = self.folder / (name + '-frame-ocr.png')
            with Image.open(self.folder / (name + '.png')) as frame:
                width, height = frame.size
                readable = ImageOps.invert(frame.convert('L')).resize((width * 2, height * 2))
                ImageOps.expand(readable, border=24, fill=255).save(ocr_frame)
            output = subprocess.check_output(['tesseract', str(ocr_frame), 'stdout', '--psm', '11'],
                                             text=True, stderr=subprocess.DEVNULL, timeout=15)
            (self.folder / (name + '.txt')).write_text(output)
            if frame_contains(output, text, absent):
                return
            time.sleep(1)
        raise TimeoutError('Expected visible screen was not rendered: ' + repr(text))

    def keyboard(self, name):
        before, _ = self.user('hn display-message -p "#{pane_id}"')
        old = re.search(r'%\d+', before)
        if not old:
            raise RuntimeError('No current pane before keyboard probe')
        self.keys('meta_l', 't')
        self.wait_user('test "$(hn display-message -p "#{pane_id}")" != ' + shlex.quote(old[0]) +
                       ' && hn capture-pane -p | grep -Eq ' + shlex.quote(r'^\[me@harness [^]]*\]\$'))
        # Separate words stay legible to OCR in narrow restored panes; the
        # shell capture still requires the exact independently typed line.
        marker = 'arm ' + name.replace('-', ' ') + ' ready'
        self.type_probe('echo ' + marker)
        self.keys('ret')
        self.wait_user('hn capture-pane -p | grep -Fx ' + shlex.quote(marker))
        self.frame(name, marker)
        self.keys('ctrl', 'd')

    def poweroff(self, timeout=60):
        started = time.monotonic()
        report = {'status': 'waiting', 'events': []}
        streams = {self.serial: 'serial', self.qmp: 'qmp'}
        pending = b''
        try:
            # The test console may terminate before printing a command result.
            # Require the guest's actual shutdown event and clean QEMU exit.
            self.send('sync; systemctl poweroff --no-block\n')
            while True:
                remaining = timeout - (time.monotonic() - started)
                exited = self.process.poll() is not None
                if remaining <= 0 and not exited:
                    raise TimeoutError('Guest poweroff did not finish; see shutdown.json and serial.log')
                # Read until EOF after exit too, retaining the final guest event.
                ready, _, _ = select.select(list(streams), [], [], 0 if exited else min(.2, max(0, remaining)))
                if not ready and exited:
                    break
                for stream in ready:
                    data = stream.recv(65536)
                    if not data:
                        del streams[stream]
                    elif streams[stream] == 'serial':
                        self.log.write(data)
                    else:
                        pending += data
                        while b'\n' in pending:
                            line, pending = pending.split(b'\n', 1)
                            event = json.loads(line)
                            report['events'].append(event)
            if self.process.returncode != 0:
                raise RuntimeError('QEMU exited unsuccessfully during guest poweroff')
            if not any(event.get('event') == 'SHUTDOWN' and
                       event.get('data', {}).get('guest') is True and
                       event['data'].get('reason') == 'guest-shutdown' for event in report['events']):
                raise RuntimeError('QEMU exit lacks a completed guest poweroff event')
            report['status'] = 'passed'
            return report
        except BaseException as error:
            report.update(status='failed', error=str(error))
            raise
        finally:
            report.update(seconds=round(time.monotonic() - started, 3), exit_code=self.process.poll())
            (self.folder / 'shutdown.json').write_text(json.dumps(report, indent=2) + '\n')

    def close(self):
        self.stop()
        self.log.close()
        self.stderr.close()
        self.control.cleanup()


def exercise(vm, result):
    vm.start(offline=True)
    # Hosted ARM runners may lack KVM. On the first TCG boot the recorded
    # readiness command completed successfully just after the old 100s host
    # deadline. Keep the same condition and visual assertion, with a bounded
    # cold-start allowance; this emulated run is not a boot-speed benchmark.
    vm.wait_user('systemctl --user is-active --quiet hn-screen && hn capture-pane -p | grep -q "Connect to Wi-Fi"', 180)
    vm.frame('01-wifi', 'Connect to Wi-Fi')
    result['first_visible_wifi'] = {'accelerator': vm.accelerator,
                                  'seconds_since_boot': round(time.monotonic() - vm.started, 3)}
    vm.keyboard('offline')
    result['checks'].append('Fresh offline boot shows Wi-Fi; Super+t opens a real shell and accepts graphical keyboard input')
    vm.monitor('set_link', name='hnnet', up=True)
    vm.wait_user('test -f ~/.local/state/harness-os/onboarded && pgrep -u 1000 -x opencode >/dev/null', 150)
    vm.wait_user('test "$(hn list-panes -F "#{pane_id}" | wc -l)" -eq 3')
    # The status bar names OpenCode before its input is ready. Require the
    # actual composer, then observe the prompt before submitting it once.
    vm.frame('02-agent', ['OpenCode', 'Ask anything'])
    output, _ = vm.command('pgrep -u 1000 -x opencode | head -1')
    pid = re.search(r'(?m)^\d+\r?$', output)[0].strip()
    if result.get('package', {}).get('agent'):
        agent = result['package']['agent']
        vm.command('rpm -V harness-os-session')
        vm.command('test "$(readlink /proc/' + pid + '/exe)" = /usr/lib/harness-opencode/opencode')
        vm.command('test "$(rpm -qf --qf ' + shlex.quote('%{NAME}') +
                   ' /usr/lib/harness-opencode/opencode)" = harness-os-session')
        vm.command('printf %s ' + shlex.quote(agent['files']['opencode']['sha256'] +
                   '  /usr/lib/harness-opencode/opencode\n') + ' | sha256sum -c -')
        result['checks'].append('The actual first agent executes the RPM-owned, checksum-pinned ARM binary on the 16 KiB kernel')
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
    vm.user('hn send-keys -l ' + shlex.quote(prompt))
    vm.wait_user('hn capture-pane -p | grep -F ' + shlex.quote('Create hello.py'), 15)
    vm.frame('02-prompt', 'Create hello.py', 15)
    vm.keys('ret')
    files = 'test -s ' + shlex.quote(project + '/hello.py') + ' && test -s ' + shlex.quote(project + '/index.html')
    vm.wait_user(files, 240)
    vm.wait_user('test "$(python3 ' + shlex.quote(project + '/hello.py') + ')" = "harness arm ready"', 30)
    for name in ['hello.py', 'index.html']:
        (vm.folder / name).write_bytes(vm.read_file(project + '/' + name))
    vm.screenshot('03-agent-project')
    result['checks'].append('Upstream-default OpenCode creates Python and HTML; independent Python execution checks the result')
    vm.user('hn-browser ' + shlex.quote('file://' + project + '/index.html'))
    # The agent's transcript contains the same page title and HTML. Wait for
    # the rendered page after Chromium takes focus, not that earlier terminal.
    vm.frame('04-browser', ['Harness ARM Demo', 'Count: 0', 'Increment'], 90, absent=['me@harness'])
    vm.click_word('05-increment', 'Increment')
    vm.frame('06-counter', 'Count: 1', absent=['me@harness'])
    output, _ = vm.command('python3 - <<\'PY\'\nfrom pathlib import Path\n'
        'renderers=[]\nfor p in Path("/proc").glob("[0-9]*"):\n'
        ' try:\n  cmd=(p/"cmdline").read_bytes()\n'
        '  if b"--type=renderer" in cmd and p.stat().st_uid==1000:\n'
        '   status=(p/"status").read_text(); assert "NoNewPrivs:\\t1" in status and "Seccomp:\\t2" in status; '
        'assert b"--no-sandbox" not in cmd; renderers.append(p.name)\n'
        ' except FileNotFoundError: pass\nassert renderers\nprint(renderers)\nPY\n')
    (vm.folder / 'browser-sandbox.txt').write_text(output)
    vm.keys('meta_l', 'b')
    vm.frame('07-return', 'OpenCode')
    vm.command('kill -0 ' + pid)
    vm.keyboard('after-browser')
    vm.command('kill -0 ' + pid)
    result['checks'].append('Sandboxed native Chromium renders the agent page; mouse click increments it; Super+b returns to the same agent and keyboard works')
    vm.command('uname -r; getconf PAGESIZE; systemd-analyze; df -B1 /')
    result['projects'] = {name: digest(vm.folder / name) for name in ['hello.py', 'index.html']}
    result['first_shutdown'] = vm.poweroff()


def exercise_reboot(machine, receipt, output):
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
    receipt['second_shutdown'] = machine.poweroff()
    receipt['checks'].append('Second cold boot reaches Harness, accepts graphical typing and preserves byte-identical working projects')


def failure_evidence(machine):
    if not machine:
        return
    errors = []
    for collect in [lambda: machine.screenshot('failure'),
                    lambda: machine.command('ps -eo pid,ppid,stat,pcpu,pmem,wchan:32,comm; '
                        'journalctl -b --no-pager -n 250; '
                        'cat /home/me/.local/state/harness-os/display.log; '
                        'tail -n 80 /home/me/.local/share/opencode/log/*.log', check=False, timeout=30)]:
        try:
            collect()
        except (OSError, RuntimeError, TimeoutError, ValueError) as error:
            errors.append(str(error))
    if errors:
        (machine.folder / 'diagnostic-errors.json').write_text(json.dumps(errors, indent=2) + '\n')


def fixture_identity(folder, source):
    """A portable fixture is a fresh test disk, never a hardware installer."""
    manifest = folder / 'manifest.json'
    if manifest.is_symlink() or not manifest.is_file():
        raise ValueError('Missing regular fixture manifest.')
    info = json.loads(manifest.read_text())
    if info.get('schema') != 1 or info.get('status') != 'prepared' or info.get('source_commit') != source:
        raise ValueError('Use a prepared fixture from this exact clean source commit.')
    if set(info.get('artifacts', {})) != {'Image', 'guest.raw.zst'}:
        raise ValueError('The fixture must contain its kernel and compressed private disk.')
    for name, item in info['artifacts'].items():
        path = folder / name
        if (path.is_symlink() or not path.is_file() or path.stat().st_size != item['bytes'] or
                digest(path) != item['sha256']):
            raise ValueError('Fixture checksum mismatch: ' + name)
    disk = info.get('raw_disk', {})
    if disk.get('bytes') != 6 * 1024 ** 3 or not re.fullmatch(r'[a-f0-9]{64}', disk.get('sha256', '')):
        raise ValueError('Unexpected private disk identity.')
    with (folder / 'Image').open('rb') as handle:
        check_arm_image(handle.read(64))
    return info


def prepare_fixture(disk, image, output, receipt, run):
    folder = output / 'fixture'
    folder.mkdir()
    shutil.copy2(image, folder / 'Image')
    run(['zstd', '-T2', '-3', disk, '-o', folder / 'guest.raw.zst'], timeout=180)
    info = {**receipt, 'schema': 1, 'status': 'prepared',
            'raw_disk': {'bytes': disk.stat().st_size, 'sha256': digest(disk)},
            'artifacts': {name: {'bytes': (folder / name).stat().st_size, 'sha256': digest(folder / name)}
                          for name in ['Image', 'guest.raw.zst']}}
    (folder / 'manifest.json').write_text(json.dumps(info, indent=2) + '\n')
    fixture_identity(folder, receipt['source_commit'])
    receipt['status'] = 'prepared'
    receipt['fixture'] = info['artifacts']
    print('Fresh private fixture prepared; graphical acceptance has not run', flush=True)


def run_fixture(folder, output, source, test_source):
    info = fixture_identity(folder, source)
    receipt = {**info, 'status': 'running', 'checks': [], 'started_at_unix': time.time(),
               'fixture_manifest_sha256': digest(folder / 'manifest.json'), 'test_source_commit': test_source}
    machine = None
    with tempfile.TemporaryDirectory(prefix='harness-arm-acceptance-') as temporary:
        disk = Path(temporary) / 'guest.raw'
        try:
            subprocess.run(['zstd', '-d', '--sparse', str(folder / 'guest.raw.zst'), '-o', str(disk)],
                           check=True, timeout=180)
            if disk.stat().st_size != info['raw_disk']['bytes'] or digest(disk) != info['raw_disk']['sha256']:
                raise ValueError('Decompressed disk identity mismatch.')
            machine = SessionVM(output / 'first-boot', disk, folder / 'Image')
            exercise(machine, receipt)
            machine.close()
            machine = SessionVM(output / 'second-boot', disk, folder / 'Image')
            exercise_reboot(machine, receipt, output)
            receipt['status'] = 'passed'
            print('Fresh Fedora/Asahi graphical session and reboot passed', flush=True)
        except BaseException as error:
            receipt.update(status='failed', error=str(error))
            failure_evidence(machine)
            raise
        finally:
            try:
                if machine:
                    machine.close()
            except (OSError, RuntimeError) as error:
                receipt.update(status='failed', cleanup_errors=[str(error)])
                raise
            finally:
                receipt['finished_at_unix'] = time.time()
                (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument('--package', type=Path, help='Build a fresh fixture from a verified Fedora session RPM on native ARM Linux.')
    inputs.add_argument('--fixture', type=Path, help='Exercise an exact-source prepared fixture on ARM Linux or macOS.')
    parser.add_argument('--fixture-source', help='Explicit full source SHA of an older immutable fixture; recorded separately from the test source.')
    parser.add_argument('--prepare-only', action='store_true', help='Prepare a private fixture without claiming acceptance.')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if os.geteuid() == 0:
        parser.error('Use an ordinary user.')
    if args.fixture and args.prepare_only:
        parser.error('--prepare-only requires --package.')
    if args.fixture_source and (not args.fixture or not re.fullmatch(r'[a-f0-9]{40}', args.fixture_source)):
        parser.error('--fixture-source requires --fixture and its full source SHA.')
    if args.package and (platform.system(), platform.machine()) != ('Linux', 'aarch64'):
        parser.error('Build the fixture on a native ARM Linux runner.')
    if args.fixture and (platform.system(), platform.machine()) not in [('Linux', 'aarch64'), ('Darwin', 'arm64')]:
        parser.error('Exercise the fixture on ARM Linux or Apple Silicon macOS.')
    required = ['zstd']
    if args.package:
        required += ['docker', 'rpm', 'rpmkeys', 'gpg', 'bsdtar', 'mkfs.ext4', 'sudo']
    if not args.prepare_only:
        required += ['qemu-system-aarch64', 'tesseract']
        from PIL import Image  # noqa: F401 — fail before preparing a disk if unavailable.
    for name in required:
        if not shutil.which(name):
            parser.error('Missing tool: ' + name)
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip():
        parser.error('Commit the exact source before building a traceable VM.')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    if args.fixture:
        run_fixture(args.fixture.resolve(), output, args.fixture_source or source, source)
        return
    package_folder = args.package.resolve()
    package = package_identity(package_folder, source)
    work = Path(tempfile.mkdtemp(prefix='harness-arm-session-', dir=os.environ.get('RUNNER_TEMP')))
    container = work.name
    lock = json.loads(Path(__file__).with_name('arm-boot.lock.json').read_text())
    graphical = json.loads(Path(__file__).with_name('arm-session.lock.json').read_text())
    receipt = {'status': 'running', 'source_commit': source, 'scope': 'Private Fedora/Asahi graphical VM only',
               'started_at_unix': time.time(), 'package': package, 'kernel_inputs': lock, 'session_inputs': graphical, 'checks': [],
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
        for kernel_package in packages:
            signature = run(['rpmkeys', '--dbpath', rpmdb, '--checksig', '--verbose', kernel_package], capture=True)
            if not re.search(r'signature, key (?:ID|fingerprint):? [0-9a-f]+: OK', signature, re.I) or 'NOKEY' in signature or 'NOT OK' in signature:
                raise ValueError('Missing verified kernel package signature')
            run(['bsdtar', '--no-same-owner', '-xpf', kernel_package, '-C', kernel])
        modules = kernel / 'lib/modules' / lock['kernel_release']
        compressed, image = work / 'Image.zst', work / 'Image'
        compressed.write_bytes(zboot_payload((modules / 'vmlinuz').read_bytes()))
        run(['zstd', '-d', compressed, '-o', image])
        check_arm_image(image.read_bytes()[:64])
        receipt['kernel_sha256'] = digest(image)
        shutil.move(kernel / 'lib/modules', inputs / 'modules')
        (inputs / 'kernel-release').write_text(lock['kernel_release'] + '\n')
        receipt['payload'] = {key: package[key] for key in ['runtime', 'files', 'symlinks']}
        shutil.copyfile(package_folder / package['package']['name'], inputs / 'session.rpm')
        # These are test-image choices, never contents or scriptlets of the RPM.
        for local, name in [('etc/profile.d/harness-os.sh', 'session-login'),
                            ('etc/sudoers.d/20-harness-network', 'network-sudoers'),
                            ('etc/NetworkManager/conf.d/10-dns.conf', 'dns.conf'),
                            ('etc/chromium/policies/managed/harness.json', 'browser-policy.json'),
                            ('etc/skel/projects/AGENTS.md', 'project-AGENTS.md')]:
            shutil.copyfile(ROOT / 'os/root' / local, inputs / name)
        shutil.copy2(Path(__file__).with_name('arm_session_root.sh'), inputs / 'provision')
        receipt['provision_sha256'] = digest(inputs / 'provision')
        print('Build a fresh signed Fedora session without a desktop', flush=True)
        run(['docker', 'run', '--name', container, '--platform', 'linux/arm64', '--memory=4g', '--cpus=2', '--pids-limit=1024',
             '--mount', f'type=bind,source={inputs},target=/inputs,readonly', graphical['root_image'], 'bash', '/inputs/provision'], timeout=1200)
        for source_path, name in [('/harness-packages.tsv', 'packages.tsv'), ('/usr/share/harness-os/opencode.json', 'agent-lock.json')]:
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
        if args.prepare_only:
            prepare_fixture(disk, image, output, receipt, run)
            return
        print('Boot into Wi-Fi, use an agent, open its page, and return to Harness', flush=True)
        machine = SessionVM(output / 'first-boot', disk, image)
        exercise(machine, receipt)
        machine.close()
        machine = SessionVM(output / 'second-boot', disk, image)
        exercise_reboot(machine, receipt, output)
        receipt['status'] = 'passed'
        print('Fresh Fedora/Asahi graphical session and reboot passed', flush=True)
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
        failure_evidence(machine)
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
