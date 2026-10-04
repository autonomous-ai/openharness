#!/usr/bin/env python3
"""Exercise an exact OS runtime in isolated native Linux panes, without a disk image."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import pty
import select
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import threading
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]


def wait(predicate, label, seconds=30):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        try:
            if result := predicate():
                return result
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            last = str(error)
        time.sleep(.1)
    raise RuntimeError(f'{label} timed out; last observation: {last}')


def checksum(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


class Screen:
    def __init__(self, argv, env, cwd):
        self.fd, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 100, 0, 0))

        def setup():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        self.process = subprocess.Popen(argv, env=env, cwd=cwd, stdin=slave, stdout=slave,
                                        stderr=slave, preexec_fn=setup)
        os.close(slave)
        self.data = bytearray()
        self.reading = True
        self.thread = threading.Thread(target=self.read, daemon=True)
        self.thread.start()

    def read(self):
        while self.reading:
            if select.select([self.fd], [], [], .1)[0]:
                try:
                    chunk = os.read(self.fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                self.data.extend(chunk)

    def write(self, text):
        pending = memoryview(text.encode())
        while pending:
            sent = os.write(self.fd, pending)
            if sent <= 0:
                raise RuntimeError('Terminal input closed')
            pending = pending[sent:]

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.reading = False
        self.thread.join(timeout=2)
        os.close(self.fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--opencode', type=Path, required=True)
    parser.add_argument('--architecture', choices=['x86_64', 'aarch64'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != 'Linux' or platform.machine() != args.architecture or os.geteuid() == 0:
        parser.error('Run as an ordinary user on the matching native Linux runner.')
    runtime = args.runtime.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    info = json.loads((runtime / 'source.json').read_text())
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    assert info['source_commit'] == source and info['dirty'] is False
    assert info['architecture'] == args.architecture
    assert info['target'] == args.architecture + '-unknown-linux-musl'
    assert set(info['files']) == {'harness-tui', 'cli.js', 'notify.mjs'}
    for name, identity in info['files'].items():
        assert (runtime / name).stat().st_size == identity['bytes']
        assert checksum(runtime / name) == identity['sha256']
    assert subprocess.check_output(['node', '-p', 'process.arch'], text=True).strip() == {
        'x86_64': 'x64', 'aarch64': 'arm64'}[args.architecture]
    with (runtime / 'harness-tui').open('rb') as handle:
        header = handle.read(20)
    assert header[:6] == b'\x7fELF\x02\x01'
    assert int.from_bytes(header[18:20], 'little') == {'x86_64': 62, 'aarch64': 183}[args.architecture]
    spec = importlib.util.spec_from_file_location('package', ROOT / 'os/tools/build-package.py')
    package = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(package)
    if args.architecture == 'x86_64':
        package.validate_runtime(runtime, source)
    else:
        try:
            package.validate_runtime(runtime, source)
        except ValueError:
            pass
        else:
            raise AssertionError('The PC image must reject an ARM runtime')
    receipt = {'status': 'running', 'scope': 'native userspace; no boot, drivers or platform installation',
               'architecture': args.architecture, 'kernel': platform.release(), 'runtime': info,
               'checks': ['Exact source, native ELF/Node architecture, complete hashes and PC packaging boundary verified'],
               'started_at_unix': time.time()}
    report = output / 'receipt.json'
    report.write_text(json.dumps(receipt, indent=2) + '\n')
    daemon = screen = None
    logs = []
    with tempfile.TemporaryDirectory(prefix='harness-native-', dir='/tmp') as temporary:
        base = Path(temporary)
        home, binaries = base / 'home', base / 'bin'
        project = home / 'projects/native-agent'
        project.mkdir(parents=True)
        binaries.mkdir()
        shutil.copy2(runtime / 'harness-tui', binaries / 'hn')
        wrapper = binaries / 'harness'
        wrapper.write_text('#!/bin/sh\nexec ' + shlex.join([shutil.which('node'), str(runtime / 'cli.js')]) + ' "$@"\n')
        wrapper.chmod(0o755)
        (binaries / 'opencode').symlink_to(args.opencode.resolve())
        # No host HOME, tokens, provider settings, tmux socket or model choice.
        env = {key: os.environ[key] for key in ['PATH', 'LANG', 'LC_ALL', 'TZ'] if key in os.environ}
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        prefix = 'harness-native-' + str(os.getpid())
        env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / '.config'),
                   XDG_DATA_HOME=str(home / '.local/share'), XDG_STATE_HOME=str(home / '.local/state'),
                   XDG_CACHE_HOME=str(home / '.cache'), PATH=str(binaries) + ':' + env['PATH'],
                   PORT=str(port), HN_TMPDIR=str(base), HN_SOCKET_NAME=prefix, SHELL='/bin/bash',
                   TERM='xterm-256color', HARNESS_OS='1', HARNESS_TUI_DESK='off',
                   HARNESS_TUI_NOTIFY='off', HARNESS_TUI_BIN=str(binaries / 'hn'),
                   HARNESS_CLI=str(wrapper), HARNESS_CLI_ARGS='[]', ADAPTER_UPDATE_DISABLE='true',
                   CABLE_DISABLE='true')
        command = [str(binaries / 'hn'), '-L', prefix, '--port', str(port), '-f',
                   str(ROOT / 'os/root/usr/share/harness-os/tmux.conf')]

        def hn(*args, check=True):
            return subprocess.run([*command, *args], cwd=project, env=env, text=True,
                                  capture_output=True, timeout=15, check=check).stdout.strip()

        def start_daemon():
            log = (output / f'daemon-{len(logs)}.log').open('w')
            logs.append(log)
            process = subprocess.Popen([str(wrapper), 'start', '--foreground'], env=env, cwd=project,
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            return process

        def ready():
            if daemon.poll() is not None:
                raise RuntimeError(f'Harness daemon exited: {daemon.returncode}')
            with urlopen(f'http://127.0.0.1:{port}/api/status', timeout=2) as response:
                status = json.load(response)
            return status.get('discoveryReady') is True and status.get('safeMode') is not True

        def stop_daemon():
            if daemon and daemon.poll() is None:
                os.killpg(daemon.pid, signal.SIGTERM)
                try:
                    daemon.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    os.killpg(daemon.pid, signal.SIGKILL)
                    daemon.wait(timeout=5)

        def type_into_screen(pane, line):
            hn('select-pane', '-t', pane)
            time.sleep(.2)
            assert screen.process.poll() is None, 'Native terminal closed'
            screen.write(line + '\r')

        try:
            receipt['opencode_version'] = subprocess.check_output([str(binaries / 'opencode'), '--version'],
                                                                 env=env, cwd=project, text=True, timeout=30).strip()
            daemon = start_daemon()
            wait(ready, 'Native daemon readiness', 90)
            receipt['checks'].append('The exact bundled CLI starts without an account and becomes discovery-ready')
            shell = hn('new-session', '-d', '-s', 'runtime', '-x', '100', '-y', '32', '-P', '-F', '#{pane_id}',
                       'bash --noprofile --norc')
            right = hn('split-window', '-h', '-p', '50', '-t', shell, '-P', '-F', '#{pane_id}',
                       'bash --noprofile --norc')
            agent = hn('split-window', '-v', '-p', '50', '-t', right, '-P', '-F', '#{pane_id}',
                       'bash --noprofile --norc')
            screen = Screen([*command, 'attach-session', '-t', 'runtime'], env, project)
            wait(lambda: screen.data, 'Native screen output')
            type_into_screen(shell, 'printf before > keyboard.txt')
            wait(lambda: (project / 'keyboard.txt').read_text() == 'before', 'PTY keyboard input')
            pid = int(hn('display-message', '-p', '-t', shell, '#{pane_pid}'))
            start_time = Path(f'/proc/{pid}/stat').read_text().split()[21]
            receipt['checks'].append('Three real hn shell panes open; the attached terminal accepts native PTY keyboard input')
            prompt = ('Create sum.py here using only the Python standard library. It must accept zero or more '
                      'signed integer command-line arguments, print their sum as one integer, and exit successfully. '
                      'No arguments must print 0. Test it. Do the work now without questions or subagents.')
            agent_command = shlex.join(['opencode', 'run', '--format', 'json', prompt])
            type_into_screen(agent, agent_command + ' > agent.jsonl 2>&1; printf "%s" "$?" > agent.status')
            wait(lambda: (project / 'agent.status').exists(), 'OpenCode upstream-default project turn', 480)
            assert (project / 'agent.status').read_text() == '0', 'OpenCode did not complete successfully'
            assert (project / 'sum.py').is_file(), 'The agent did not create the requested project'
            for values, expected in [([], '0'), (['13', '-5', '7'], '15'), (['999999999999999999999', '1'], '1000000000000000000000')]:
                actual = subprocess.check_output(['python3', str(project / 'sum.py'), *values], env=env,
                                                 cwd=project, text=True, timeout=5).strip()
                assert actual == expected, (values, actual, expected)
            receipt['checks'].append('Upstream-default OpenCode runs inside an hn pane and creates Python code that passes independent execution checks')
            project_digest = checksum(project / 'sum.py')
            stop_daemon()
            daemon = start_daemon()
            wait(ready, 'Restarted native daemon readiness', 90)
            assert Path(f'/proc/{pid}/stat').read_text().split()[21] == start_time
            assert checksum(project / 'sum.py') == project_digest
            screen.close()
            (output / 'before-reconnect.ansi').write_bytes(screen.data)
            screen = None
            screen = Screen([*command, 'attach-session', '-t', 'runtime'], env, project)
            wait(lambda: screen.data, 'Reattached native screen')
            type_into_screen(shell, 'printf after > keyboard.txt')
            wait(lambda: (project / 'keyboard.txt').read_text() == 'after', 'Keyboard input after daemon/screen restart')
            assert Path(f'/proc/{pid}/stat').read_text().split()[21] == start_time
            assert len(hn('list-panes', '-t', 'runtime').splitlines()) == 3
            receipt['checks'].append('The same shell process, three panes and agent-created project survive daemon restart and screen reattachment; keyboard input still works')
            receipt.update(status='passed', project_sha256=project_digest)
        except BaseException as error:
            receipt.update(status='failed', error=str(error))
            raise
        finally:
            cleanup_errors = []
            if screen:
                (output / 'terminal.ansi').write_bytes(screen.data)
                try:
                    screen.close()
                except (OSError, subprocess.SubprocessError) as error:
                    cleanup_errors.append(str(error))
            for cleanup in [lambda: hn('kill-server', check=False), stop_daemon]:
                try:
                    cleanup()
                except (OSError, subprocess.SubprocessError) as error:
                    cleanup_errors.append(str(error))
            for log in logs:
                log.close()
            for name in ['sum.py', 'agent.jsonl', 'agent.status']:
                if (project / name).is_file():
                    shutil.copy2(project / name, output / name)
            receipt['finished_at_unix'] = time.time()
            if cleanup_errors:
                receipt.update(status='failed', cleanup_errors=cleanup_errors)
            report.write_text(json.dumps(receipt, indent=2) + '\n')
            if cleanup_errors:
                raise RuntimeError('Native fixture cleanup did not complete: ' + '; '.join(cleanup_errors))
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
