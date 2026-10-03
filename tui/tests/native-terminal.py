#!/usr/bin/env python3
"""Guarded native PTY/death/startup comparisons against tmux 3.5a.

Run after a release build. Optional HN_NATIVE_TEST_BINARY, HN_NATIVE_TEST_PORT
(19430..19439), HN_NATIVE_TEST_PREFIX (hnt19fixnative...). No daemon is started.
"""
import fcntl
from collections import deque
import os
from pathlib import Path
import pty
import re
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

TUI = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get('HN_NATIVE_TEST_PORT', '19433'))
PREFIX = os.environ.get('HN_NATIVE_TEST_PREFIX', f'hnt19fixnative{os.getpid()}')
if not 19430 <= PORT <= 19439 or not re.fullmatch(r'hnt19fixnative[A-Za-z0-9_-]+', PREFIX):
    raise SystemExit('refusing non-test native terminal port/socket')
TMUX = shutil.which('tmux')
if not TMUX:
    raise SystemExit('tmux is required')
BASE = Path(tempfile.mkdtemp(prefix='hnnt-', dir='/tmp')).resolve()
HOME = BASE / 'home'
HOME.mkdir()
HN = BASE / 'hn'
shutil.copy2(os.environ.get('HN_NATIVE_TEST_BINARY', TUI / 'target/release/harness-tui'), HN)
ENV = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TZ') if k in os.environ}
ENV.update(HOME=str(HOME), HN_TMPDIR=str(BASE), HN_SOCKET_NAME=PREFIX, PORT=str(PORT),
           SHELL='/bin/sh', TERM='xterm-256color', HARNESS_TUI_DESK='off',
           HARNESS_TUI_NOTIFY='off', HN_DESKTOP='off', PS1='$ ')
CONF = BASE / 'tmux.conf'
CONF.write_text('set -g default-shell /bin/sh\nset -g @hn-look tmux\n'
                'set -g automatic-rename off\nset -g status off\n'
                'set -g pane-border-status off\n')
clients = []
observations = deque(maxlen=4)


def argv(kind, *args):
    assert 19430 <= PORT <= 19439 and PREFIX.startswith('hnt19fixnative')
    prefix = [HN, '-L', PREFIX, '--port', PORT] if kind == 'hn' else [TMUX, '-L', PREFIX + 'ref']
    return list(map(str, [*prefix, '-f', CONF, *args]))


def cli(kind, *args, check=True):
    p = subprocess.run(argv(kind, *args), env=ENV, cwd=BASE, text=True, capture_output=True, timeout=12)
    if check and p.returncode:
        raise AssertionError((kind, args, p.returncode, p.stdout, p.stderr))
    return p


def same(*args):
    h, t = (cli(kind, *args, check=False) for kind in ('hn', 'tmux'))
    observations.append((args, (h.returncode, h.stdout, h.stderr), (t.returncode, t.stdout, t.stderr)))
    assert (h.returncode, h.stdout, h.stderr) == (t.returncode, t.stdout, t.stderr), (args, h, t)
    return h.stdout.strip()


def both(*args):
    for kind in ('hn', 'tmux'):
        cli(kind, *args)


def wait(fn, label, seconds=8):
    end = time.monotonic() + seconds
    last_error = None
    while time.monotonic() < end:
        try:
            if answer := fn():
                return answer
        except (AssertionError, subprocess.TimeoutExpired) as error:
            last_error = repr(error)
        time.sleep(.04)
    raise AssertionError(f'{label}; last error: {last_error}; recent hn/tmux comparisons: {list(observations)!r}')


def owned():
    out = subprocess.check_output(['ps', '-ax', '-o', 'pid=,command='], text=True)
    found = []
    for row in out.splitlines():
        parts = row.strip().split(None, 1)
        if len(parts) == 2 and parts[1].startswith(str(HN) + ' ') and f'-L {PREFIX} ' in parts[1]:
            found.append((int(parts[0]), parts[1]))
    return found


class Terminal:
    def __init__(self, kind, *args, cols=80, rows=24):
        master, slave = pty.openpty()
        self.fd, self.data, self.reading = master, bytearray(), True
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

        def setup():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        self.proc = subprocess.Popen(argv(kind, *args), stdin=slave, stdout=slave, stderr=slave,
                                     env=ENV, cwd=BASE, preexec_fn=setup)
        os.close(slave)
        self.thread = threading.Thread(target=self.read, daemon=True)
        self.thread.start()
        clients.append(self)

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
        pending = memoryview(text)
        while pending:
            written = os.write(self.fd, pending)
            assert written > 0, 'PTY input closed'
            pending = pending[written:]

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(timeout=3)
        self.reading = False
        self.thread.join(timeout=1)
        os.close(self.fd)
        clients.remove(self)


def stop_servers():
    both('kill-server')
    wait(lambda: not owned(), 'native processes cleaned')


def idle_input():
    """Exercise the real input fd after idle, with byte-exact delivery to a raw PTY."""
    program = BASE / 'record-input.py'
    program.write_text('''import os, signal, sys, tty
from pathlib import Path
tty.setraw(0)
def resized(*_):
    size = os.get_terminal_size(0)
    Path(sys.argv[2]).write_text(f"{size.columns}x{size.lines}")
signal.signal(signal.SIGWINCH, resized)
resized()
with open(sys.argv[1], "ab", buffering=0) as output:
    os.write(1, b"\\x1b[?2004hINPUT_READY")
    while chunk := os.read(0, 65536):
        output.write(chunk)
''')
    for kind in ('hn', 'tmux'):
        recorded = BASE / f'{kind}-input-bytes'
        size_file = BASE / f'{kind}-input-size'
        ui = Terminal(kind, 'new-session', '-s', 'input',
                      shlex.join(['python3', str(program), str(recorded), str(size_file)]))
        wait(lambda: b'INPUT_READY' in ui.data, f'{kind} raw input program ready')
        # tmux also applies escape-time (10 ms by default) to partial UTF-8.
        # Allow the deliberate 100 ms fragmentation below in the reference.
        if kind == 'tmux':
            cli(kind, 'set-option', '-s', 'escape-time', '500')
        expected = bytearray()

        def received():
            return recorded.read_bytes() if recorded.exists() else b''

        def send(parts, result):
            for chunk, delay in parts:
                ui.write(chunk)
                if delay:
                    time.sleep(delay)
            expected.extend(result)
            wait(lambda: received() == expected, f'{kind} byte-exact input {result[:30]!r}')

        time.sleep(.2)
        send([(b'after-idle', 0)], b'after-idle')
        send([(b'\x1b', 0)], b'\x1b')
        send([(b'\x1bP', 0)], b'\x1bP')
        send([(b'\xc3', .1), (b'\xa9', 0)], 'é'.encode())
        send([(b'\x1b[', .1), (b'A', 0)], b'\x1b[A')
        # Use terminal return bytes; this test isolates buffering/timing from
        # the client's existing normalization of clipboard line endings.
        paste = 'first line\rsecond 🐯'.encode()
        send([(b'\x1b[200~' + paste[:5], .1), (paste[5:] + b'\x1b[201~', 0)],
             b'\x1b[200~' + paste + b'\x1b[201~')
        # A full input buffer may end with Escape: without a deadline that final
        # key could remain stuck until somebody types again.
        burst = b'x' * 8191 + b'\x1b'
        send([(burst, 0)], burst)
        print(f'PASS {kind} idle input: Escape, Alt-P, split UTF-8/arrow/paste and full-buffer typeahead', flush=True)

        time.sleep(.15)
        fcntl.ioctl(ui.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 27, 91, 0, 0))
        wait(lambda: size_file.read_text() == '91x27', f'{kind} resize with no keyboard activity')
        os.kill(ui.proc.pid, signal.SIGSTOP)
        try:
            time.sleep(.1)
        finally:
            os.kill(ui.proc.pid, signal.SIGCONT)
        send([(b'after-resume', 0)], b'after-resume')
        time.sleep(.15)
        # A server command ends the client while its input thread has nothing
        # to read. A blocking wait must not prevent shutdown.
        cli(kind, 'kill-server')
        ui.proc.wait(timeout=4)
        ui.stop()
        assert received() == expected
        print(f'PASS {kind} idle input: resize, process resume and shutdown without another key', flush=True)


def async_creation():
    """Hold only our supervisor so pending creation ownership is deterministic."""
    requests = []
    stopped = None

    def start(*args):
        process = subprocess.Popen(argv('hn', *args), env=ENV, cwd=BASE,
                                   text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        requests.append(process)
        return process

    def result(process, timeout=8):
        out, err = process.communicate(timeout=timeout)
        return process.returncode, out, err

    def quick(*args):
        reply = result(start(*args), timeout=3)
        assert reply[0] == 0, (args, reply)
        return reply[1].strip()

    def reserved(index):
        return str(index) in quick('list-windows', '-t', 'async', '-F', '#I').splitlines()

    def supervisor():
        found = [pid for pid, command in owned() if command.endswith(' --local-server')]
        assert len(found) == 1, found
        return found[0]

    def pause():
        nonlocal stopped
        assert stopped is None
        stopped = supervisor()
        os.kill(stopped, signal.SIGSTOP)

    def resume():
        nonlocal stopped
        if stopped is not None:
            try:
                os.kill(stopped, signal.SIGCONT)
            except ProcessLookupError:
                pass
            stopped = None

    def children(pid):
        rows = subprocess.check_output(['ps', '-ax', '-o', 'pid=,ppid='], text=True)
        return {int(child) for child, parent in (row.split() for row in rows.splitlines())
                if int(parent) == pid}

    def creation(index, printed):
        command = f'printf "ASYNC_{index}\\n"; exit 7'
        args = ['new-window', '-d', '-t', f'async:{index}']
        if printed:
            args += ['-P', '-F', f'REPLY_{index}:#I:#{{pane_start_command}}']
        return [*args, command]

    focus_format = '#{window_index}:#{session_stack}'
    focus_args = ('display', '-p', '-t', 'async', focus_format)
    try:
        both('new-session', '-d', '-s', 'async')
        both('new-window', '-d', '-t', 'async:1', '-n', 'anchor')
        wait(lambda: same('list-windows', '-t', 'async', '-F', '#I:#{window_panes}') == '0:1\n1:1', 'async anchors ready')
        both('set', '-g', 'remain-on-exit', 'on')
        both('select-window', '-t', 'async:1')
        both('select-window', '-t', 'async:0')
        before = same(*focus_args)

        # The plain command must wait too; the two -P requests must each own their output.
        pause()
        pending = []
        for index, printed in ((4, False), (5, True), (6, True)):
            args = creation(index, printed)
            process = start(*args)
            wait(lambda index=index: reserved(index), f'pending window {index} reserved')
            pending.append((index, args, process))
            assert quick(*focus_args) == before, ('detached creation changed focus/history', index)
        assert quick('display', '-p', 'READ_WHILE_PENDING') == 'READ_WHILE_PENDING'
        assert all(process.poll() is None for _, _, process in pending), 'creation answered before its shell existed'

        # A later explicit selection wins even when the earlier creation replies arrive later.
        both('select-window', '-t', 'async:1')
        selected = same(*focus_args)
        expected = {}
        for index, args, _ in pending:
            reference = cli('tmux', *args)
            expected[index] = reference.returncode, reference.stdout, reference.stderr
        resume()
        for index, _, process in pending:
            reply = result(process)
            assert reply == expected[index], (index, reply, expected[index])
            wait(lambda index=index: same('list-panes', '-t', f'async:{index}', '-F', '#{pane_dead}:#{pane_dead_status}') == '1:7', f'async exit {index}')
            assert f'ASYNC_{index}' in same('display', '-p', '-t', f'async:{index}', '#{pane_start_command}')
            for kind in ('hn', 'tmux'):
                wait(lambda kind=kind, index=index: cli(kind, 'capture-pane', '-p', '-S', '-1000', '-t', f'async:{index}').stdout.count(f'ASYNC_{index}') == 1,
                     f'{kind} async output {index}')
                capture = cli(kind, 'capture-pane', '-p', '-S', '-1000', '-t', f'async:{index}').stdout
                assert all(f'ASYNC_{other}' not in capture for other in (4, 5, 6) if other != index), (kind, index, capture)
        assert same(*focus_args) == selected, 'a delayed creation stole the newer selection/history'

        # Two completions can arrive before either hook continuation: its target must remain
        # the pane that request made, including across run-shell's asynchronous wait.
        both('set', '-g', '@async_created', '')
        both('set-hook', '-g', 'after-new-window',
             'run-shell "sleep 0.15"; set -agF @async_created "#{window_index}:#{pane_start_command}|"')
        pause()
        pending = []
        for index in (8, 9):
            args = creation(index, True)
            process = start(*args)
            wait(lambda index=index: reserved(index), f'hooked pending window {index} reserved')
            pending.append((index, args, process))
        expected = {}
        for index, args, _ in pending:
            reference = cli('tmux', *args)
            expected[index] = reference.returncode, reference.stdout, reference.stderr
        resume()
        for index, _, process in pending:
            reply = result(process)
            assert reply == expected[index], (index, reply, expected[index])
            wait(lambda index=index: same('list-panes', '-t', f'async:{index}', '-F', '#{pane_dead}:#{pane_dead_status}') == '1:7', f'hooked async exit {index}')
        expected_hooks = sorted(f'{index}:' + cli('tmux', 'display', '-p', '-t', f'async:{index}', '#{pane_start_command}').stdout.strip() for index in (8, 9))
        for kind in ('hn', 'tmux'):
            wait(lambda kind=kind: sorted(filter(None, cli(kind, 'show', '-gv', '@async_created').stdout.strip().split('|'))) == expected_hooks,
                 f'{kind} delayed creation hooks keep their own targets')
        assert same(*focus_args) == selected, 'hooked detached creation changed focus/history'
        both('set-hook', '-gu', 'after-new-window')

        # If the reserved target is killed before the RPC responds, failure belongs to that
        # caller and the newly returned shell must be deleted. Real tmux creates synchronously;
        # compare its final killed-window state, not this artificial cancellation's exit code.
        local_pid = supervisor()
        # A pane-dead event precedes asynchronous PTY reaping. A snapshot here can include an
        # earlier exited child; comparing against it later then mistakes fewer children for a leak.
        # The two live anchors are the stable baseline, and all earlier work must drain first.
        baseline_children = {int(quick('display', '-p', '-t', f'async:{index}', '#{pane_pid}'))
                             for index in (0, 1)}
        wait(lambda: children(local_pid) == baseline_children, 'earlier creation shells reaped')
        pause()
        args = ['new-window', '-d', '-P', '-t', 'async:20', 'exec sleep 30']
        cancelled = start(*args)
        wait(lambda: reserved(20), 'cancelled target reserved')
        assert cancelled.poll() is None, 'cancelled creation answered before completion'
        quick('kill-window', '-t', 'async:20')
        cli('tmux', *args)
        cli('tmux', 'kill-window', '-t', 'async:20')
        resume()
        code, out, err = result(cancelled)
        assert code != 0 and err and not out, ('killed target must fail its caller', code, out, err)
        assert '20' not in same('list-windows', '-t', 'async', '-F', '#I').splitlines()
        wait(lambda: children(local_pid) == baseline_children, 'cancelled shell left no supervisor child')
        assert same(*focus_args) == selected
        stop_servers()
        print('PASS concurrent creation replies, detached selection, delayed hooks and cancelled-target cleanup', flush=True)
    finally:
        resume()
        for process in requests:
            if process.poll() is None:
                process.terminate()
                try:
                    process.communicate(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=3)
        for kind in ('hn', 'tmux'):
            try:
                cli(kind, 'kill-server', check=False)
            except subprocess.TimeoutExpired:
                pass


with socket.socket() as probe:
    probe.bind(('127.0.0.1', PORT))
try:
    both('new-session', '-d', '-s', 'work')
    both('set', '-g', '@died', '')
    both('set-hook', '-g', 'pane-died', 'set -agF @died "#{window_index}:#{pane_dead_status}:#{pane_dead_signal},"')
    both('set', '-g', 'remain-on-exit-format', 'DEAD:#{pane_dead_status}:#{pane_dead_signal}')
    both('set', '-g', 'remain-on-exit', 'on')
    both('new-window', '-d', '-t', 'work:4', 'printf "HISTORY_MARK\\n"; exit 7')
    wait(lambda: same('list-panes', '-t', 'work:4', '-F', '#{pane_dead}:#{pane_dead_status}') == '1:7', 'retained exit 7')
    wait(lambda: same('show', '-gv', '@died') == '4:7:,', 'pane-died once')
    original_command = same('display', '-p', '-t', 'work:4', '#{pane_start_command}')
    assert 'HISTORY_MARK' in original_command
    assert 'HISTORY_MARK' in same('capture-pane', '-p', '-S', '-1000', '-t', 'work:4')
    both('respawn-window', '-t', 'work:4', 'printf "RESPAWN_MARK\\n"; exit 9')
    wait(lambda: same('show', '-gv', '@died') == '4:7:,4:9:,', 'respawn death')
    assert same('display', '-p', '-t', 'work', '#{window_index}') == '4'
    respawn_command = same('display', '-p', '-t', 'work:4', '#{pane_start_command}')
    assert 'RESPAWN_MARK' in respawn_command
    both('respawn-pane', '-t', 'work:4')
    wait(lambda: same('show', '-gv', '@died') == '4:7:,4:9:,4:9:,', 'original command reused')
    assert same('display', '-p', '-t', 'work:4', '#{pane_start_command}') == respawn_command
    history = same('capture-pane', '-p', '-S', '-1000', '-t', 'work:4')
    assert history.count('HISTORY_MARK') == 1 and history.count('RESPAWN_MARK') == 2
    both('set', '-g', 'remain-on-exit', 'failed')
    both('new-window', '-d', '-t', 'work:5', 'exit 0')
    wait(lambda: same('list-windows', '-t', 'work', '-F', '#{window_index}') == '0\n4', 'successful exit removed')
    both('new-window', '-d', '-t', 'work:6', 'kill -TERM $$')
    wait(lambda: re.fullmatch(r'1::.+', same('list-panes', '-t', 'work:6', '-F', '#{pane_dead}:#{pane_dead_status}:#{pane_dead_signal}')), 'signal exit retained')
    died = same('show', '-gv', '@died')
    ui = Terminal('hn', 'attach-session', '-t', 'work:4')
    wait(lambda: b'DEAD:9:' in ui.data and ui.proc.poll() is None, 'dead pane on actual UI')
    ui.write(b'\x02d')
    ui.proc.wait(timeout=4)
    ui.stop()
    wait(lambda: any('--headless' in command for _, command in owned()), 'headless handoff')
    for pid, command in owned():
        if '--headless' in command:
            os.kill(pid, signal.SIGKILL)
    time.sleep(.15)
    ui = Terminal('hn', 'attach-session', '-t', 'work:4')
    wait(lambda: b'DEAD:9:' in ui.data and ui.proc.poll() is None, 'dead snapshot after holder crash')
    assert cli('hn', 'show', '-gv', '@died').stdout.strip() == died
    assert same('display', '-p', '-t', 'work:4', '#{pane_start_command}') == respawn_command
    recovered = cli('hn', 'capture-pane', '-p', '-S', '-1000', '-t', 'work:4').stdout
    assert recovered.count('HISTORY_MARK') == 1 and recovered.count('RESPAWN_MARK') == 2
    both('respawn-pane', '-t', 'work:4', 'sleep 30')
    wait(lambda: same('list-panes', '-t', 'work:4', '-F', '#{pane_dead}:#{pane_dead_status}') == '0:', 'live respawn')
    same('respawn-pane', '-t', 'work:4', 'exit 8')
    both('split-window', '-d', '-t', 'work:4', 'sleep 30')
    first_id = same('list-panes', '-t', 'work:4', '-F', '#{pane_id}').splitlines()[0]
    both('select-window', '-t', 'work:0')
    both('respawn-window', '-k', '-t', 'work:4', 'printf "WHOLE_WINDOW\\n"; exit 9')
    wait(lambda: same('list-panes', '-t', 'work:4', '-F', '#{pane_id}:#{pane_dead}:#{pane_dead_status}') == first_id + ':1:9', 'whole-window respawn keeps only the first pane')
    assert same('display', '-p', '-t', 'work', '#{window_index}') == '4'
    assert 'WHOLE_WINDOW' in same('display', '-p', '-t', 'work:4', '#{pane_start_command}')
    both('set', '-g', 'remain-on-exit', 'on')
    for index in range(10, 22):
        both('new-window', '-d', '-t', f'work:{index}', f'printf "FAST_{index}\\n"; exit 7')
    for index in range(10, 22):
        wait(lambda: same('list-panes', '-t', f'work:{index}', '-F', '#{pane_dead}:#{pane_dead_status}') == '1:7', f'fast exit {index}')
        for kind in ('hn', 'tmux'):
            # Death is visible before its queued hook necessarily runs. Await delivery,
            # then check every count together below so duplicate hooks still fail.
            wait(lambda: cli(kind, 'show', '-gv', '@died').stdout.split(',').count(f'{index}:7:') >= 1,
                 f'{kind} pane-died delivered for fast exit {index}')
            capture = cli(kind, 'capture-pane', '-p', '-S', '-1000', '-t', f'work:{index}').stdout
            wait(lambda: cli(kind, 'capture-pane', '-p', '-S', '-1000', '-t', f'work:{index}').stdout.count(f'FAST_{index}') == 1, f'{kind} fast output {index}: {capture!r}')
    for kind in ('hn', 'tmux'):
        deaths = cli(kind, 'show', '-gv', '@died').stdout.split(',')
        for index in range(10, 22):
            assert deaths.count(f'{index}:7:') == 1, (kind, index, deaths)
    stop_servers()
    ui.proc.wait(timeout=4)
    ui.stop()
    print('PASS retained exits/signals, hooks, history, crash recovery and respawn', flush=True)

    async_creation()
    idle_input()

    for delay in (0, .1):
        for kind in ('hn', 'tmux'):
            marker = BASE / f'{kind}-typeahead'
            marker.unlink(missing_ok=True)
            ui = Terminal(kind, 'new-session', '-s', 'work')
            wait(lambda: b'\x1b[c' in ui.data or b'\x1b[0c' in ui.data, 'DA1 query')
            time.sleep(delay)
            ui.write(('printf kept > ' + shlex.quote(str(marker)) + '\r').encode())
            time.sleep(.15)
            ui.write(b'\x1b[?1;2c')
            wait(marker.exists, f'{kind} typeahead at {delay}s')
            cli(kind, 'kill-server')
            ui.proc.wait(timeout=4)
            ui.stop()
            time.sleep(.15)
    print('PASS immediate/delayed startup typeahead through delayed DA1', flush=True)

    for kind in ('hn', 'tmux'):
        start = time.monotonic()
        ui = Terminal(kind, 'new-session', '-s', 'work')
        wait(lambda: b'\x1b[?1049h' in ui.data, 'first screen without DA1')
        elapsed = time.monotonic() - start
        assert elapsed < .6, (kind, elapsed)
        print(f'PASS {kind} first screen without DA1: {elapsed:.3f}s', flush=True)
        # First paint can precede the command socket on a fast host. Measure it above,
        # but do not race cleanup against the session still being created.
        wait(lambda: cli(kind, 'has-session', '-t', 'work', check=False).returncode == 0,
             f'{kind} first-screen session ready for cleanup')
        cli(kind, 'kill-server')
        ui.proc.wait(timeout=4)
        ui.stop()
        time.sleep(.15)
        tiny = BASE / f'{kind}-size'
        ui = Terminal(kind, 'new-session', '-s', 'tiny', f'stty size > {shlex.quote(str(tiny))}; sleep 2', cols=1, rows=1)
        wait(lambda: tiny.exists() and tiny.read_text().strip(), f'{kind} tiny initial size written')
        assert tiny.read_text().strip() == '1 1', (kind, tiny.read_text())
        assert cli(kind, 'display-message', '-p', '-t', 'tiny:0', '#{pane_width}x#{pane_height}').stdout.strip() == '1x1'
        cli(kind, 'kill-server')
        ui.proc.wait(timeout=4)
        ui.stop()
    print('PASS native PTY starts at the actual 1x1 pane size', flush=True)
finally:
    for kind in ('hn', 'tmux'):
        try:
            cli(kind, 'kill-server', check=False)
        except subprocess.TimeoutExpired:
            pass
    for ui in list(clients):
        ui.stop()
    for pid, _ in owned():
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    wait(lambda: not owned(), 'final native process cleanup')
    print(f'Test files: {BASE}', flush=True)
