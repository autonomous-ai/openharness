#!/usr/bin/env python3
"""Isolated local-PTY lifecycle test; run after cargo build --release --offline.

Requires Python 3, tmux and Node with cli/node_modules for the mock-daemon transition.
Optional: HN_LOCAL_TEST_BINARY, HN_LOCAL_TEST_PORT (19440..19449), HN_LOCAL_TEST_PREFIX.
Every hn call uses a frozen binary, throwaway HOME, explicit socket and guarded mock port.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time

TUI = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get('HN_LOCAL_TEST_PORT', '19441'))
PREFIX = os.environ.get('HN_LOCAL_TEST_PREFIX', f'hn-local-test-{os.getpid()}')
if not 19440 <= PORT <= 19449 or not re.fullmatch(r'(?:hn-local-test-|hne19fix)[A-Za-z0-9_-]+', PREFIX):
    raise SystemExit('refusing a port or socket outside the isolated local-shell test namespace')
TMUX = shutil.which('tmux')
NODE = shutil.which('node')
if not TMUX or not NODE:
    raise SystemExit('tmux and node are required for the local-shell regression test')
SOURCE = Path(os.environ.get('HN_LOCAL_TEST_BINARY', str(TUI / 'target/release/harness-tui')))
BASE = Path(tempfile.mkdtemp(prefix='hn-local-', dir='/tmp')).resolve()
HOME = BASE / 'home'
HOME.mkdir()
HN = BASE / 'hn'
shutil.copy2(SOURCE, HN)
ENV = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'TZ', 'NODE_PATH') if k in os.environ}
ENV.update(HOME=str(HOME), PORT=str(PORT), HN_SOCKET_NAME=PREFIX, HN_TMPDIR=str(BASE), SHELL='/bin/sh',
           TERM='xterm-256color', HNE_REMOVE='bad', HNE_KEEP='bad', HNE_HIDDEN='bad')
CONF = BASE / 'tmux.conf'
CONF.write_text('set -g default-shell /bin/sh\nset -g default-terminal tmux-256color\n'
                'set -g pane-border-status off\nset -g status off\n'
                'setenv -g HNE_KEEP kept\nsetenv -gr HNE_REMOVE\nsetenv -gh HNE_HIDDEN secret\n')
mock = None


def run(argv, check=True, timeout=12):
    result = subprocess.run(list(map(str, argv)), env=ENV, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise AssertionError((argv, result.returncode, result.stdout, result.stderr))
    return result


def hn(*args, check=True):
    assert 19440 <= PORT <= 19449 and PREFIX.startswith(('hn-local-test-', 'hne19fix'))
    return run([HN, '-L', PREFIX, '--port', PORT, '-f', CONF, *args], check)


def tm(*args, check=True):
    return run([TMUX, '-L', PREFIX + 'outer', '-f', '/dev/null', *args], check)


def launch(*args):
    command = shlex.join(['env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'HN_SOCKET',
                          f'HOME={HOME}', f'PORT={PORT}', f'HN_SOCKET_NAME={PREFIX}', f'HN_TMPDIR={BASE}',
                          str(HN), '-L', PREFIX, '--port', str(PORT), '-f', str(CONF), *args])
    tm('new-session', '-d', '-s', 'outer', '-x', '80', '-y', '24', command)


def capture(target='work:0.0'):
    return hn('capture-pane', '-p', '-t', target).stdout


def send(text, target='work:0.0'):
    hn('send-keys', '-t', target, text, 'Enter')


def wait(predicate, label, seconds=12):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            answer = predicate()
            if answer:
                return answer
        except (AssertionError, subprocess.TimeoutExpired):
            pass
        time.sleep(.1)
    print('FAIL', label, 'processes', own_processes(), flush=True)
    outer = tm('capture-pane', '-p', '-t', 'outer', check=False)
    print('Outer terminal:', outer.stdout, outer.stderr, flush=True)
    raise AssertionError(label)


def own_processes():
    found = []
    for row in run(['ps', '-ax', '-o', 'pid=,command=']).stdout.splitlines():
        parts = row.strip().split(None, 1)
        if len(parts) == 2 and parts[1].startswith(str(HN) + ' ') and f'-L {PREFIX} ' in parts[1]:
            found.append((int(parts[0]), parts[1]))
    return found


def gone(pid):
    try:
        os.kill(pid, 0)
        return False
    except ProcessLookupError:
        return True


try:
    # Fail before starting anything if another process owns this test port.
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', PORT))
    launch('new-session', '-s', 'work')
    wait(lambda: hn('list-panes', '-t', 'work', '-F', '#{pane_id}', check=False).stdout.strip() == '%0', 'initial local shell')
    send("printf 'ENV:%s:%s:%s:%s:%s:%s\\n' \"$$\" \"$SHELL\" \"$HNE_KEEP\" \"${HNE_REMOVE-unset}\" \"${HNE_HIDDEN-unset}\" \"$TMUX_PANE\"; HNE_PERSIST=remembered")
    # An interactive shell may leave its startup prompt before the record. Match every
    # field from one capture instead of assuming that output starts in column zero.
    record = wait(lambda: re.search(r'ENV:(\d+):/bin/sh:kept:unset:unset:%0(?=\s|$)',
                                    capture()), 'configured environment and stable pane ID')
    pid = int(record.group(1))
    sockets = list((BASE / f'hn-{os.getuid()}').glob('*.pty'))
    assert len(sockets) == 1 and stat.S_IMODE(sockets[0].stat().st_mode) == 0o600
    assert stat.S_IMODE(sockets[0].parent.stat().st_mode) == 0o700
    print('PASS local shell, environment, pane ID and private socket', flush=True)

    query = BASE / 'query.py'
    query.write_text("import termios,tty,os,select,time\nold=termios.tcgetattr(0)\ntry:\n tty.setraw(0);os.write(1,b'\\x1b[6n');b=b'';end=time.monotonic()+2\n while time.monotonic()<end and not b.endswith(b'R'):\n  if select.select([0],[],[],.2)[0]:b+=os.read(0,128)\nfinally:termios.tcsetattr(0,termios.TCSANOW,old)\nprint('QUERY:'+repr(b),flush=True)\n")
    send(shlex.join([sys.executable, str(query)]))
    wait(lambda: "QUERY:b'\\x1b[" in capture(), 'terminal device-status reply')
    print('PASS terminal query reply', flush=True)

    data = ('alpha\nbeta\t' * 16000).encode()
    pastefile = BASE / 'paste.txt'
    pastefile.write_bytes(data)
    receiver = BASE / 'paste.py'
    receiver.write_text("import os,tty,termios,select,time,hashlib\nold=termios.tcgetattr(0)\ntry:\n tty.setraw(0);os.write(1,b'\\x1b[?2004hPASTE_READY\\r\\n');b=b'';end=time.monotonic()+12\n while time.monotonic()<end and not b.endswith(b'\\x1b[201~'):\n  if select.select([0],[],[],.2)[0]:b+=os.read(0,32768)\nfinally:os.write(1,b'\\x1b[?2004l');termios.tcsetattr(0,termios.TCSANOW,old)\nprint('PASTE:'+str(len(b))+':'+hashlib.sha256(b).hexdigest(),flush=True)\n")
    send(shlex.join([sys.executable, str(receiver)]))
    wait(lambda: 'PASTE_READY' in capture(), 'paste receiver ready')
    tm('load-buffer', '-b', PREFIX, pastefile)
    tm('paste-buffer', '-p', '-d', '-b', PREFIX, '-t', 'outer')
    expected = b'\x1b[200~' + data.replace(b'\n', b'\r') + b'\x1b[201~'
    marker = f'PASTE:{len(expected)}:{hashlib.sha256(expected).hexdigest()}'
    wait(lambda: marker in capture().replace('\n', ''), 'large paste bytes', 15)
    print('PASS 176 KB bracketed paste, exact bytes and newline mapping', flush=True)

    send(f'cd {shlex.quote(str(BASE))}; printf "BEFORE:%s\\n" "$$"')
    wait(lambda: f'BEFORE:{pid}' in capture(), 'detach marker')
    wait(lambda: hn('display-message', '-p', '-t', 'work:0.0', '#{pane_current_path}').stdout.strip() == str(BASE), 'native current path')
    tm('send-keys', '-t', 'outer', 'C-b', 'd')
    wait(lambda: any('--headless' in cmd for _, cmd in own_processes()), 'headless handoff')
    time.sleep(.4)
    for owned_pid, cmd in own_processes():
        if '--headless' in cmd:
            os.kill(owned_pid, signal.SIGKILL)
    time.sleep(.2)
    assert not gone(pid)
    launch('attach-session', '-t', 'work')
    wait(lambda: f'BEFORE:{pid}' in tm('capture-pane', '-p', '-t', 'outer', check=False).stdout, 'reattach snapshot in the actual UI')
    assert hn('list-clients', '-F', '#{client_pid}').stdout.strip()
    send("printf 'AFTER:%s:%s\\n' \"$$\" \"$HNE_PERSIST\"")
    wait(lambda: f'AFTER:{pid}:remembered' in capture(), 'same shell after reattach')
    print('PASS detach, headless crash, reconnect history/PID/variable/cwd', flush=True)

    hn('split-window', '-h', '-t', 'work:0')
    wait(lambda: len(hn('list-panes', '-t', 'work:0', '-F', '#{pane_id}').stdout.splitlines()) == 2, 'split shell')
    send("printf 'SECOND:%s\\n' \"$TMUX_PANE\"", 'work:0.1')
    wait(lambda: 'SECOND:%1' in capture('work:0.1'), 'split pane ID')
    hn('kill-pane', '-t', 'work:0.1')
    window_file = BASE / 'window-done'
    hn('new-window', '-t', 'work:', '-n', 'test', f'printf window > {shlex.quote(str(window_file))}')
    wait(window_file.exists, 'new window command')
    wait(lambda: len(hn('list-windows', '-t', 'work', '-F', '#{window_id}').stdout.splitlines()) == 1, 'window exits naturally')
    popup_file = BASE / 'popup-done'
    hn('display-popup', '-E', f'printf popup > {shlex.quote(str(popup_file))}')
    wait(popup_file.exists, 'popup shell command')
    time.sleep(.3)
    send("printf 'AFTER_POPUP:%s\\n' \"$$\"")
    wait(lambda: f'AFTER_POPUP:{pid}' in capture(), 'popup closes back to original pane')
    print('PASS split, new window, popup and natural exit', flush=True)

    mock_log = open(BASE / 'mock.log', 'w')
    mock = subprocess.Popen([NODE, str(TUI / 'tests/mock-daemon.mjs'), str(PORT)], env=ENV, stdout=mock_log, stderr=subprocess.STDOUT)
    wait(lambda: 'Mock Claude' in hn('list-harnesses', check=False).stdout, 'Harness daemon arrives', 15)
    send("printf 'WITH_DAEMON:%s:%s\\n' \"$$\" \"$HNE_PERSIST\"")
    wait(lambda: f'WITH_DAEMON:{pid}:remembered' in capture(), 'original local shell survives daemon arrival')
    wait(lambda: hn('display-message', '-p', '#{local_machine}|#{pane_machine}').stdout.strip() == 'mock-local|mock-local',
         'local shell and status share the machine name from the app')
    hn('workspace-menu', 'new-harness')
    wait(lambda: ' @ local' in tm('capture-pane', '-p', '-t', 'outer').stdout, 'New Harness identifies the local destination')
    tm('send-keys', '-t', 'outer', 'Escape')
    print('PASS daemon arrival preserves local shell and identifies the local destination', flush=True)

    hn('kill-server', check=False)
    wait(lambda: not own_processes(), 'all test hn processes stop')
    wait(lambda: gone(pid), 'local shell exits')
    assert not sockets[0].exists()
    print('PASS kill-server cleans supervisor, shell and socket', flush=True)

    # Start in a real desk, then lose Harness. Local additions must remain private when
    # its original desk returns, including a local split inside the formerly desk window.
    launch('new-session', '-s', 'desk')
    wait(lambda: hn('list-panes', '-t', 'desk:0', '-F', '#{pane_id}', check=False).stdout.strip() == '%0', 'daemon-backed desk')
    hn('send-keys', '-t', 'desk:0.0', 'BEFORE_DESK')
    wait(lambda: 'BEFORE_DESK' in capture('desk:0.0'), 'daemon-backed terminal')
    desk_session = hn('display-message', '-p', '-t', 'desk:0.0', '#{session_id}').stdout.strip()
    os.kill(mock.pid, signal.SIGSTOP)
    time.sleep(16)
    offline_popup = BASE / 'offline-popup-done'
    hn('display-popup', '-E', '-d', BASE, f'printf popup > {shlex.quote(str(offline_popup))}')
    wait(offline_popup.exists, 'popup while daemon is unavailable')
    time.sleep(.3)
    assert hn('display-message', '-p', '-t', 'desk:0.0', '#{session_id}').stdout.strip() == desk_session
    print('PASS offline popup preserves its parent desk session', flush=True)
    hn('split-window', '-h', '-t', 'desk:0', '-c', BASE)
    wait(lambda: len(hn('list-panes', '-t', 'desk:0', '-F', '#{pane_id}').stdout.splitlines()) == 2, 'local split after daemon loss')
    send('printf LOCAL_SPLIT', 'desk:0.1')
    wait(lambda: 'LOCAL_SPLIT' in capture('desk:0.1'), 'local split runs')
    hn('new-window', '-t', 'desk:', '-n', 'local', '-c', BASE)
    wait(lambda: len(hn('list-windows', '-t', 'desk', '-F', '#{window_id}').stdout.splitlines()) == 2, 'local window after daemon loss')
    send('printf LOCAL_WINDOW', 'desk:1.0')
    wait(lambda: 'LOCAL_WINDOW' in capture('desk:1.0'), 'local window runs')
    assert hn('display-message', '-p', '-t', 'desk:1.0', '#{local_machine}|#{pane_machine}').stdout.strip() == 'mock-local|mock-local'
    os.kill(mock.pid, signal.SIGCONT)
    hn('send-keys', '-t', 'desk:0.0', 'RETURNED_DESK')
    wait(lambda: 'RETURNED_DESK' in capture('desk:0.0'), 'daemon stream reconnects', 25)
    assert 'LOCAL_SPLIT' in capture('desk:0.1') and 'LOCAL_WINDOW' in capture('desk:1.0')
    import http.client
    connection = http.client.HTTPConnection('127.0.0.1', PORT, timeout=3)
    connection.request('GET', '/api/desk')
    desk = json.loads(connection.getresponse().read())['data']
    connection.close()
    assert all(p.get('machineId') != 'hn-local-shells' for tab in desk['tabs'] for p in tab['panes'])
    print('PASS daemon loss, local split/window, reconnect preserves private layout', flush=True)
    hn('kill-server', check=False)
    wait(lambda: not own_processes(), 'transition test processes stop')
finally:
    hn('kill-server', check=False)
    tm('kill-server', check=False)
    for owned_pid, _ in own_processes():
        os.kill(owned_pid, signal.SIGTERM)
    if mock is not None:
        if mock.poll() is None:
            os.kill(mock.pid, signal.SIGCONT)
            mock.terminate()
        mock.wait(timeout=5)
    print(f'Test files: {BASE}', flush=True)
