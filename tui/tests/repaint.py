#!/usr/bin/env python3
"""Animation, timed UI and idle-input checks in an isolated real terminal.

Run after a release build. HARNESS_TUI_BIN can select a frozen comparison build.
Only a private HOME, named hn/tmux sockets, and a guarded mock port are used.
"""
import os
from pathlib import Path
import re
import shlex
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get('HN_REPAINT_TEST_PORT', '19794'))
assert 19794 <= PORT <= 19799, 'refusing non-test repaint port'
PREFIX = f'hn-repaint-{os.getpid()}'
BASE = Path(tempfile.mkdtemp(prefix='hn-repaint-', dir='/tmp')).resolve()
HN = BASE / 'hn'
shutil.copy2(os.environ.get('HARNESS_TUI_BIN', ROOT / 'target/release/harness-tui'), HN)
TMUX = shutil.which('tmux')
assert TMUX
ENV = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TZ') if k in os.environ}
ENV.update(HOME=str(BASE), HN_TMPDIR=str(BASE), HN_SOCKET_NAME=PREFIX, PORT=str(PORT),
           TERM='xterm-256color', SHELL='/bin/sh', HARNESS_TUI_DESK='off',
           HARNESS_TUI_NOTIFY='off', HN_DESKTOP='off', HARNESS_TUI_ASK_TERMINAL='off',
           HARNESS_TUI_KITTY_KEYS='off')
CONF = BASE / 'tmux.conf'
CONF.write_text('set -g automatic-rename off\nset -g status-right "REPAINT_IDLE"\n'
                'set -g set-titles-string "REPAINT_TITLE"\n')
COMMAND = [str(HN), '-L', PREFIX, '--port', str(PORT), '-f', str(CONF)]
OUTER = [TMUX, '-L', PREFIX + '-outer', '-f', '/dev/null']


def run(args, ok=True):
    p = subprocess.run(args, env=ENV, cwd=BASE, text=True, capture_output=True, timeout=12)
    if ok:
        assert p.returncode == 0, (args, p.stdout, p.stderr)
    return p.stdout


def hn(*args):
    return run(COMMAND + list(args))


def outer(*args):
    return run(OUTER + list(args))


def screen():
    return outer('capture-pane', '-p', '-t', 'view')


def wait(fn, label, seconds=5):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = fn()
        if value:
            return value
        time.sleep(.025)
    raise AssertionError(label + '\n' + screen())


def changes(read, seconds=1.3):
    """Read only the outer terminal, so observing never repaints the application."""
    prior = read()
    count = 0
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        time.sleep(.03)
        value = read()
        if value is None: # tmux can capture between the cells of a terminal update
            continue
        if value != prior:
            count += 1
        prior = value
    return count


def spinner():
    match = re.search(r'REPAINT_ANIM=([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])', screen())
    return match[1] if match else None


def clock():
    match = re.search(r'REPAINT_CLOCK=\d\d:\d\d:\d\d', screen())
    return match[0] if match else None


mock = None
started = False
try:
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', PORT))
    with (BASE / 'mock.log').open('w') as log:
        mock = subprocess.Popen(['node', str(ROOT / 'tests/mock-daemon.mjs'), str(PORT)],
                                env=ENV, cwd=BASE, stdout=log, stderr=log)
    for _ in range(100):
        assert mock.poll() is None, (BASE / 'mock.log').read_text()
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/api/status', timeout=.2):
                break
        except OSError:
            time.sleep(.05)
    else:
        raise AssertionError('mock startup timeout')
    launch = ['env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'HN_SOCKET',
              *[f'{k}={v}' for k, v in ENV.items()], *COMMAND]
    outer('new-session', '-d', '-s', 'view', '-x', '120', '-y', '32', shlex.join(launch))
    started = True
    wait(lambda: 'Mock terminal' in screen() and 'REPAINT_IDLE' in screen(), 'initial frame')

    hn('set', '-g', 'status-right', 'REPAINT_ANIM=#{spinner}')
    wait(lambda: 'REPAINT_ANIM=' in screen(), 'custom spinner visible')
    assert changes(spinner) >= 8, 'animation fell back to maintenance-tick speed'
    hn('set', '-g', '@hn-animations', 'off')
    wait(lambda: spinner() == '⠋', 'reduced motion first frame')
    assert changes(spinner, .6) == 0, 'reduced motion still animates'
    hn('set', '-g', '@hn-animations', 'on')
    assert changes(spinner) >= 8, 'animation did not restart'
    print('PASS repaint: live animation, reduced motion and restarting motion', flush=True)

    hn('set', '-g', 'status-right', 'REPAINT_IDLE')
    hn('set', '-g', 'set-titles-string', 'REPAINT_TITLE=#{spinner}')
    title = lambda: outer('display-message', '-p', '-t', 'view', '#{pane_title}')
    wait(lambda: 'REPAINT_TITLE=' in title(), 'animated terminal title')
    assert changes(title) >= 8, 'terminal title lost its animation timer'
    hn('set', '-g', 'set-titles-string', 'REPAINT_TITLE')
    hn('set', '-g', '@hn-animations', 'off')
    print('PASS repaint: animation used only in the terminal title', flush=True)

    hn('set', '-g', 'status-right', 'REPAINT_CLOCK=%H:%M:%S')
    first = wait(clock, 'clock visible')
    wait(lambda: (value := clock()) is not None and value != first, 'clock advances without animation', seconds=2)
    hn('set', '-g', 'status-right', 'REPAINT_IDLE')
    hn('display-message', '-d', '180', 'REPAINT_NOTICE')
    wait(lambda: 'REPAINT_NOTICE' in screen(), 'notice appears', seconds=.5)
    wait(lambda: 'REPAINT_IDLE' in screen(), 'notice expires', seconds=.7)
    hn('display-message', '-d', '0', 'REPAINT_UNTIL_KEY')
    wait(lambda: 'REPAINT_UNTIL_KEY' in screen(), 'persistent notice appears')
    time.sleep(.4)
    assert 'REPAINT_UNTIL_KEY' in screen()
    # The mock echoes input as output; use C-g so an echoed Escape cannot leave
    # its VT parser inside an unfinished output sequence.
    outer('send-keys', '-t', 'view', 'C-g')
    wait(lambda: 'REPAINT_IDLE' in screen(), 'key dismisses persistent notice')
    hn('bind-key', '-N', 'REPAINT_HINT', 'c', 'new-window')
    hn('set', '-g', '@hn-hint-time', '180')
    outer('send-keys', '-t', 'view', 'C-b')
    wait(lambda: 'REPAINT_HINT' in screen(), 'prefix hints appear', seconds=.7)
    outer('send-keys', '-t', 'view', 'C-g')
    wait(lambda: 'REPAINT_HINT' not in screen(), 'prefix hints disappear')
    print('PASS repaint: clock, timed and persistent notices, delayed key hints', flush=True)

    time.sleep(.4)
    outer('send-keys', '-t', 'view', 'Enter', 'REPAINT_INPUT_READY')
    wait(lambda: 'REPAINT_INPUT_READY' in screen(), 'typing after idle', seconds=1)
    for width, height in [(1, 1), (120, 32)]:
        outer('resize-window', '-t', 'view', '-x', str(width), '-y', str(height))
        wait(lambda: hn('display-message', '-p', '#{client_width} #{client_height}').strip()
             == f'{width} {height}', 'resize')
    wait(lambda: 'REPAINT_INPUT_READY' in screen(), 'content after resize')
    print('PASS repaint: input after idle and recovery from a one-cell terminal', flush=True)
finally:
    if started:
        run(COMMAND + ['kill-server'], ok=False)
        run(OUTER + ['kill-server'], ok=False)
    if mock is not None:
        mock.terminate()
        mock.wait(timeout=5)
    shutil.rmtree(BASE)
