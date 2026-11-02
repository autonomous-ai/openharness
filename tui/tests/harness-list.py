#!/usr/bin/env python3
"""The harness list with real keys: newest first, machine over folders, old sessions folded.

Only a private fixture backend, temporary HOME and explicitly named hn/tmux sockets.
"""
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get('HN_HARNESS_LIST_PORT', '19786'))
assert 19783 <= PORT <= 19789, 'refusing non-test port'
PREFIX = f'hn-harness-list-{os.getpid()}'
BASE = Path(tempfile.mkdtemp(prefix='hnhl-', dir='/tmp')).resolve()
HN = BASE / 'hn'
shutil.copy2(os.environ.get('HN_HARNESS_LIST_BINARY', ROOT / 'target/release/harness-tui'), HN)
TMUX = shutil.which('tmux')
assert TMUX
ENV = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TZ') if k in os.environ}
ENV.update(HOME=str(BASE), HN_TMPDIR=str(BASE), HN_SOCKET_NAME=PREFIX, PORT=str(PORT),
           TERM='xterm-256color', COLORTERM='truecolor', SHELL='/bin/sh', HARNESS_TUI_DESK='sync',
           HARNESS_TUI_NOTIFY='off', HN_DESKTOP='off', MOCK_DEMO='1', MOCK_RECONNECT='1',
           MOCK_OLD_HARNESSES='1')
# (hn asks the `harness` CLI who is signed in: one on this PATH answers "nobody" for this HOME.)
ENV['PATH'] = os.pathsep.join(d for d in ENV['PATH'].split(os.pathsep) if not (Path(d) / 'harness').exists())


def tmux(*args, ok=True):
    p = subprocess.run([TMUX, '-L', PREFIX + '-outer', *args], env=ENV, cwd=BASE,
                       text=True, capture_output=True, timeout=10)
    if ok: assert p.returncode == 0, (args, p.stderr)
    return p.stdout


def screen(): return tmux('capture-pane', '-p', '-t', 'test')
def coloured(): return tmux('capture-pane', '-p', '-e', '-t', 'test')
def wait(fn, label, seconds=8):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if fn(): return
        time.sleep(.05)
    raise AssertionError(label + '\n' + screen())
def shows(text): taken(text)
def gone(text): wait(lambda: text not in screen(), 'still shows ' + text)
def keys(*args): tmux('send-keys', '-t', 'test', *args); time.sleep(.15)
def type_text(text): tmux('send-keys', '-l', '-t', 'test', text); time.sleep(.15)
def taken(text, seconds=8):
    # One capture that has [text]: every check on it reads the same frame.
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        s = screen()
        if text in s: return s
        time.sleep(.05)
    raise AssertionError(text + '\n' + screen())


mock = None
started = False
try:
    with socket.socket() as probe: probe.bind(('127.0.0.1', PORT))
    mock = subprocess.Popen(['node', str(ROOT / 'tests/mock-daemon.mjs'), str(PORT)], env=ENV,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(100):
        assert mock.poll() is None
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{PORT}/test/dial', timeout=2).read()
            break
        except OSError: time.sleep(.05)
    else: raise AssertionError('mock startup timeout')
    command = shlex.join(['env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'HN_SOCKET',
                          *[f'{k}={v}' for k, v in ENV.items()], str(HN), '-L', PREFIX,
                          '--port', str(PORT), '-f', '/dev/null'])
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-x', '170', '-y', '50', command)
    tmux('set-window-option', '-t', 'test', 'remain-on-exit', 'on')
    shows('Fix flaky login test')
    started = True

    time.sleep(1)  # (The account check settles first: it owns the keys until it has.)
    keys('C-b', 's')
    s = taken('▸ 25 older')
    if len(sys.argv) > 1: print(s)

    # The month-old ones are folded, and their folder is the last one on their machine.
    assert 'Old session' not in s, s
    assert s.index('old-repo') > s.index('billing'), 'newest folders first\n' + s

    # The button is on its folder's label, one line.
    assert any('old-repo' in l and '▸ 25 older' in l for l in s.splitlines()), s

    # One column: a machine, its folders, no indent; never `machine · folder`.
    column = lambda text: next(l.index(text) for l in s.splitlines() if text in l)
    assert column('studio') == column('old-repo'), s
    assert ' · old-repo' not in s, s

    # The keys line has the main keys and says where the rest are.
    assert 'enter add pane' in s and 'C-t new window' in s and '? all keys' in s, s
    assert 'M-s message' not in s and 'M-r restart' not in s, s

    # Enter on `▸ 25 older` shows them, newest first.
    for _ in range(60):
        if any('›' in l and '▸ 25 older' in l for l in taken('Search harnesses').splitlines()): break
        keys('Down')
    else: raise AssertionError('never reached ▸ 25 older\n' + screen())
    keys('Enter')
    s = taken('Old session 0')
    assert '▸ 25 older' not in s, s
    assert s.index('Old session 0') < s.index('Old session 2'), s
    assert any('old-repo' in l and '▾ hide older' in l and '›' in l for l in s.splitlines()), s

    # The same key hides them again, and shows them again.
    keys('Enter'); gone('Old session 0'); taken('▸ 25 older')
    keys('Enter'); taken('Old session 0')

    # Opened again they are folded again; a search finds one, with no `older` row in its results.
    keys('Escape'); gone('Search harnesses')
    keys('C-b', 's'); taken('▸ 25 older')
    type_text('Old session 7')
    s = taken('Old session 7')
    assert '▸ 25 older' not in s and 'hide older' not in s, s

    # OpenCode's hollow square and Codex's cloud, as their icons: marks with no tile behind them.
    assert '□' in screen(), screen()
    keys('C-u'); type_text('Old session 8'); taken('Old session 8')
    assert '☁' in screen(), screen()
    tiled = ('48;2;255;255;255m☁', '48;5;231m☁', '48;5;15m☁')
    assert not any(t in coloured() for t in tiled), repr(coloured())
    print('harness-list ok')
except BaseException:
    if started: print(screen(), file=sys.stderr)
    raise
finally:
    if started:
        subprocess.run([str(HN), '-L', PREFIX, '--port', str(PORT), '-f', '/dev/null', 'kill-server'], env=ENV, cwd=BASE, capture_output=True, timeout=12)
    subprocess.run([TMUX, '-L', PREFIX + '-outer', 'kill-server'], env=ENV, cwd=BASE, capture_output=True)
    if mock:
        mock.terminate()
        try: mock.wait(timeout=5)
        except subprocess.TimeoutExpired: mock.kill()
    shutil.rmtree(BASE, ignore_errors=True)
