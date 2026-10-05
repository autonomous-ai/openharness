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
import re
import select
import shlex
import shutil
import signal
import socket
import sqlite3
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


def agent_transcript(home):
    """Read only conversation rows from the fixture's fresh, isolated agent home."""
    database = home / '.local/share/opencode/opencode.db'
    if not database.is_file():
        return {'status': 'unavailable', 'reason': 'No agent conversation database'}
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=2) as db:
        db.row_factory = sqlite3.Row
        # Do not archive the database, auth/config files, or unrelated tables.
        return {table: [dict(row) for row in db.execute(sql)] for table, sql in [
            ('messages', 'SELECT id, session_id, time_created, data FROM message ORDER BY time_created, id'),
            ('parts', 'SELECT id, message_id, session_id, time_created, data FROM part ORDER BY time_created, id'),
        ]}


def finish_fixture_processes(home):
    """Drain only this fixture's private-HOME processes before removing their files.

    Closing a tmux server does not wait for its children to finish writing. Pin
    each matching process with a Linux pidfd so PID reuse cannot target another
    process, and never include an unrelated runner's command line in evidence.
    """
    expected = b'HOME=' + os.fsencode(home)
    signalled = []
    for action, seconds in [(None, 2), (signal.SIGTERM, 3), (signal.SIGKILL, 3)]:
        deadline = time.monotonic() + seconds
        while True:
            pending = {}
            try:
                for process in Path('/proc').iterdir():
                    if not process.name.isdigit() or int(process.name) == os.getpid():
                        continue
                    fd = None
                    try:
                        if process.stat().st_uid != os.getuid():
                            continue
                        fd = os.pidfd_open(int(process.name))
                        if expected not in (process / 'environ').read_bytes().split(b'\0'):
                            continue
                        if select.select([fd], [], [], 0)[0]:
                            continue
                        pending[fd] = int(process.name)
                        fd = None
                    except (ProcessLookupError, FileNotFoundError, PermissionError):
                        continue
                    finally:
                        if fd is not None:
                            os.close(fd)
                if not pending:
                    return signalled
                if action is not None:
                    for fd, pid in pending.items():
                        try:
                            signal.pidfd_send_signal(fd, action)
                            signalled.append({'pid': pid, 'signal': action.name})
                        except ProcessLookupError:
                            pass
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                select.select(list(pending), [], [], min(remaining, .2))
            finally:
                for fd in pending:
                    os.close(fd)
    raise RuntimeError('Fixture processes did not exit before cleanup')


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
    parser.add_argument('--source-commit', help='Expected clean producer commit when testing an exported VM payload')
    args = parser.parse_args()
    if platform.system() != 'Linux' or platform.machine() != args.architecture or os.geteuid() == 0:
        parser.error('Run as an ordinary user on the matching native Linux runner.')
    runtime = args.runtime.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    info = json.loads((runtime / 'source.json').read_text())
    source = args.source_commit or subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if not re.fullmatch(r'[0-9a-f]{40}', source):
        parser.error('A complete source commit is required.')
    assert info['source_commit'] == source and info['dirty'] is False
    assert info['architecture'] == args.architecture
    assert info['target'] == args.architecture + '-unknown-linux-musl'
    assert set(info['files']) == {'harness-tui', 'cli.js', 'notify.mjs'}
    for name, identity in info['files'].items():
        assert (runtime / name).stat().st_size == identity['bytes']
        assert checksum(runtime / name) == identity['sha256']
    assert subprocess.check_output(['node', '-p', 'process.arch'], text=True, timeout=30).strip() == {
        'x86_64': 'x64', 'aarch64': 'arm64'}[args.architecture]
    with (runtime / 'harness-tui').open('rb') as handle:
        header = handle.read(64)
        phoff = struct.unpack_from('<Q', header, 32)[0]
        phsize, phcount = struct.unpack_from('<HH', header, 54)
        assert phsize == 56 and 0 < phcount < 100
        handle.seek(phoff)
        phdrs = handle.read(phsize * phcount)
    assert header[:6] == b'\x7fELF\x02\x01'
    assert int.from_bytes(header[18:20], 'little') == {'x86_64': 62, 'aarch64': 183}[args.architecture]
    load_alignments = [struct.unpack_from('<IIQQQQQQ', phdrs, index * phsize)[-1]
                       for index in range(phcount) if struct.unpack_from('<I', phdrs, index * phsize)[0] == 1]
    assert load_alignments and all(value >= (16384 if args.architecture == 'aarch64' else 4096)
                                   for value in load_alignments)
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
               'page_size': os.sysconf('SC_PAGE_SIZE'), 'hn_load_alignments': load_alignments,
               'tmux': subprocess.check_output(['tmux', '-V'], text=True, timeout=15).strip(),
               'checks': ['Exact source, native ELF/Node architecture, complete hashes and PC packaging boundary verified'],
               'started_at_unix': time.time()}
    report = output / 'receipt.json'
    report.write_text(json.dumps(receipt, indent=2) + '\n')
    daemon = screen = None
    logs = []
    temporary_directory = tempfile.TemporaryDirectory(prefix='harness-native-', dir='/tmp')
    with temporary_directory as temporary:
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
                   PORT=str(port), HN_TMPDIR=str(base), HN_SOCKET_NAME=prefix,
                   TMUX_TMPDIR=str(base), SHELL='/bin/bash',
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

        def stop_tmux():
            # The daemon's terminal backend also needs an isolated server. Never
            # kill the host's default tmux server when cleaning up this fixture.
            tmux_socket = base / f'tmux-{os.getuid()}' / 'default'
            if tmux_socket.exists():
                subprocess.run(['tmux', '-S', str(tmux_socket), 'kill-server'],
                               env=env, check=True, capture_output=True, timeout=15)

        def type_into_screen(pane, line):
            hn('select-pane', '-t', pane)
            wait(lambda: hn('display-message', '-p', '-t', pane, '#{pane_active}') == '1',
                 'Selected input pane ' + pane)
            assert screen.process.poll() is None, 'Native terminal closed'
            screen.write(line + '\r')

        def record_state(label):
            state = {'at_unix': time.time()}
            for key, argv in [
                ('hn', [*command, 'list-panes', '-a', '-F',
                        '#{pane_id}|#{pane_active}|#{pane_current_path}|#{pane_current_command}']),
                ('tmux', ['tmux', '-S', str(base / f'tmux-{os.getuid()}' / 'default'),
                          'list-panes', '-a', '-F',
                          '#{pane_id}|#{pane_pid}|#{session_name}|#{pane_current_path}|#{pane_dead}']),
                ('processes', ['ps', '-eo', 'pid,ppid,pgid,lstart,comm']),
            ]:
                try:
                    result = subprocess.run(argv, env=env, cwd=project, text=True,
                                            capture_output=True, timeout=15)
                    state[key] = {'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
                except (OSError, subprocess.SubprocessError) as error:
                    state[key] = {'error': str(error)}
            (output / (label + '.json')).write_text(json.dumps(state, indent=2) + '\n')

        def wait_for_shell():
            # Escape sequences alone are not proof that the reattached screen
            # has received its terminal replay. Wait for our real shell prompt.
            wait(lambda: b'HN_NATIVE_READY>' in screen.data, 'Restored shell prompt', 45)
            wait(lambda: set(hn('list-panes', '-t', 'runtime', '-F', '#{pane_id}').splitlines())
                 == {shell, right, agent}, 'All three original pane identities', 30)

        try:
            receipt['opencode_version'] = subprocess.check_output([str(binaries / 'opencode'), '--version'],
                                                                 env=env, cwd=project, text=True, timeout=30).strip()
            daemon = start_daemon()
            wait(ready, 'Native daemon readiness', 90)
            receipt['checks'].append('The exact bundled CLI starts without an account and becomes discovery-ready')
            shell = hn('new-session', '-d', '-s', 'runtime', '-c', str(project),
                       '-x', '100', '-y', '32', '-P', '-F', '#{pane_id}',
                       'bash --noprofile --norc')
            right = hn('split-window', '-h', '-p', '50', '-t', shell, '-c', str(project), '-P', '-F', '#{pane_id}',
                       'bash --noprofile --norc')
            agent = hn('split-window', '-v', '-p', '50', '-t', right, '-c', str(project), '-P', '-F', '#{pane_id}',
                       'bash --noprofile --norc')
            screen = Screen([*command, 'attach-session', '-t', 'runtime'], env, project)
            wait(lambda: screen.data, 'Native screen output')
            # The daemon adopts pending shells asynchronously; a first escape
            # sequence is not proof that a terminal is ready for input yet.
            for pane in [shell, right, agent]:
                wait(lambda: hn('display-message', '-p', '-t', pane, '#{pane_current_path}') == str(project),
                     'Project working directory in ' + pane)
            type_into_screen(shell, 'printf "%s" "$$" > ' + shlex.quote(str(project / 'shell.pid')) +
                             '; printf before > ' + shlex.quote(str(project / 'keyboard.txt')) +
                             "; PS1='HN_NATIVE_READY> '")
            wait(lambda: (project / 'keyboard.txt').read_text() == 'before', 'PTY keyboard input')
            # A daemon-backed pane is not a local PTY owner and need not expose
            # pane_pid. Ask the actual shell, independently of UI metadata.
            pid = int((project / 'shell.pid').read_text())
            start_time = Path(f'/proc/{pid}/stat').read_text().split()[21]
            receipt['checks'].append('Three real hn shell panes open; the attached terminal accepts native PTY keyboard input')
            # Diagnose idle-terminal restoration before spending time on a model
            # request. A later restart separately checks a running agent.
            record_state('idle-before-restart')
            stop_daemon()
            daemon = start_daemon()
            wait(ready, 'Restarted idle daemon readiness', 90)
            assert Path(f'/proc/{pid}/stat').read_text().split()[21] == start_time
            screen.close()
            (output / 'idle-before-reconnect.ansi').write_bytes(screen.data)
            screen = None
            screen = Screen([*command, 'attach-session', '-t', 'runtime'], env, project)
            wait_for_shell()
            type_into_screen(shell, 'printf restored > keyboard.txt')
            wait(lambda: (project / 'keyboard.txt').read_text() == 'restored', 'Idle shell input after restart')
            receipt['checks'].append('Idle shell processes and all three panes survive daemon/screen restart and accept new keyboard input')
            record_state('idle-after-restart')
            prompt = (f'Use your file tools to create {project / "sum.py"} using only the Python standard library. '
                      'Write the actual file to that absolute path. It must accept zero or more '
                      'signed integer command-line arguments, print their sum as one integer, and exit successfully. '
                      'No arguments must print 0. Test it. Do the work now without questions or subagents.')
            receipt['agent_prompt'] = prompt
            # Keep the agent open as it is on the OS. A completed `opencode run`
            # process is archived by Harness; that is not a running pane to retain.
            agent_command = shlex.join(['opencode', '--prompt', prompt])
            type_into_screen(agent, 'printf "%s" "$$" > agent.pid; exec ' + agent_command)

            def project_passes():
                identity = project / 'agent.pid'
                if identity.is_file() and not Path('/proc/' + identity.read_text().strip()).exists():
                    raise RuntimeError('The agent exited before completing its project')
                if not (project / 'sum.py').is_file():
                    return False
                before = checksum(project / 'sum.py')
                results = []
                receipt['project_execution'] = results
                for values, expected in [([], '0'), (['13', '-5', '7'], '15'),
                                         (['999999999999999999999', '1'], '1000000000000000000000')]:
                    actual = subprocess.run(['python3', str(project / 'sum.py'), *values], env=env,
                                            cwd=project, text=True, timeout=5, capture_output=True,
                                            stdin=subprocess.DEVNULL)
                    results.append({'arguments': values, 'expected': expected, 'exit': actual.returncode,
                                    'stdout': actual.stdout, 'stderr': actual.stderr})
                    if actual.returncode != 0 or actual.stdout.strip() != expected:
                        return False
                return before == checksum(project / 'sum.py')

            # Judge the actual work independently, rather than asking the model
            # to manufacture a fixture-only "done" file or trusting its reply.
            wait(project_passes, 'Agent-created Python passes independent execution', 480)
            agent_pid = int((project / 'agent.pid').read_text())
            agent_start_time = Path(f'/proc/{agent_pid}/stat').read_text().split()[21]
            receipt['checks'].append('Upstream-default OpenCode runs inside an hn pane and creates Python code that passes independent execution checks')
            expected_panes = {shell, right, agent}
            before_panes = hn('list-panes', '-t', 'runtime', '-F', '#{pane_id}').splitlines()
            assert set(before_panes) == expected_panes, ('Before restart', before_panes, expected_panes)
            (output / 'agent-before-restart.txt').write_text(hn('capture-pane', '-p', '-t', agent) + '\n')
            project_digest = checksum(project / 'sum.py')
            record_state('agent-before-restart')
            stop_daemon()
            daemon = start_daemon()
            wait(ready, 'Restarted native daemon readiness', 90)
            assert Path(f'/proc/{pid}/stat').read_text().split()[21] == start_time
            assert Path(f'/proc/{agent_pid}/stat').read_text().split()[21] == agent_start_time
            assert checksum(project / 'sum.py') == project_digest
            screen.close()
            (output / 'before-reconnect.ansi').write_bytes(screen.data)
            screen = None
            screen = Screen([*command, 'attach-session', '-t', 'runtime'], env, project)
            wait_for_shell()
            type_into_screen(shell, 'printf after > keyboard.txt')
            wait(lambda: (project / 'keyboard.txt').read_text() == 'after', 'Keyboard input after daemon/screen restart')
            assert Path(f'/proc/{pid}/stat').read_text().split()[21] == start_time
            assert Path(f'/proc/{agent_pid}/stat').read_text().split()[21] == agent_start_time
            after_panes = hn('list-panes', '-t', 'runtime', '-F', '#{pane_id}').splitlines()
            assert set(after_panes) == expected_panes, ('After restart', after_panes, expected_panes)
            (output / 'agent-after-restart.txt').write_text(hn('capture-pane', '-p', '-t', agent) + '\n')
            receipt['checks'].append('The same shell and interactive agent processes, three pane identities and generated project survive daemon restart and screen reattachment; keyboard input still works')
            receipt['surviving_processes'] = {'shell': {'pid': pid, 'start_time': start_time},
                                             'opencode_launcher': {'pid': agent_pid, 'start_time': agent_start_time}}
            receipt.update(status='passed', project_sha256=project_digest)
        except BaseException as error:
            receipt.update(status='failed', error=str(error))
            raise
        finally:
            cleanup_errors = []
            try:
                record_state('final-state')
            except OSError as error:
                cleanup_errors.append('State capture: ' + str(error))
            if 'agent' in locals():
                try:
                    (output / 'agent-final.txt').write_text(hn('capture-pane', '-p', '-t', agent) + '\n')
                except (OSError, subprocess.SubprocessError) as error:
                    (output / 'agent-capture-error.txt').write_text(str(error) + '\n')
            # This isolated home has no user account or credentials. Retain the
            # agent's own diagnostic logs, never auth/provider configuration.
            agent_logs = home / '.local/share/opencode/log'
            try:
                if agent_logs.is_dir():
                    shutil.copytree(agent_logs, output / 'opencode-logs')
                try:
                    transcript = agent_transcript(home)
                except (OSError, sqlite3.Error) as error:
                    transcript = {'status': 'unavailable', 'reason': str(error)}
                (output / 'opencode-transcript.json').write_text(json.dumps(transcript, indent=2) + '\n')
                receipt['discovered_project_files'] = [str(path.relative_to(base)) for path in base.rglob('sum.py')]
            except OSError as error:
                cleanup_errors.append('Agent log capture: ' + str(error))
            if screen:
                (output / 'terminal.ansi').write_bytes(screen.data)
                try:
                    screen.close()
                except (OSError, subprocess.SubprocessError) as error:
                    cleanup_errors.append(str(error))
            for cleanup in [lambda: hn('kill-server', check=False), stop_daemon, stop_tmux]:
                try:
                    cleanup()
                except (OSError, subprocess.SubprocessError) as error:
                    cleanup_errors.append(str(error))
            for log in logs:
                log.close()
            for name in ['sum.py', 'agent.pid', 'shell.pid']:
                if (project / name).is_file():
                    shutil.copy2(project / name, output / name)
            try:
                receipt['cleanup_signals'] = finish_fixture_processes(home)
                temporary_directory.cleanup()
            except (OSError, RuntimeError) as error:
                cleanup_errors.append('Private workspace cleanup: ' + str(error))
            receipt['finished_at_unix'] = time.time()
            if cleanup_errors:
                receipt.update(status='failed', cleanup_errors=cleanup_errors)
            report.write_text(json.dumps(receipt, indent=2) + '\n')
            if cleanup_errors:
                raise RuntimeError('Native fixture cleanup did not complete: ' + '; '.join(cleanup_errors))
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
