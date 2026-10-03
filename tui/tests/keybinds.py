#!/usr/bin/env python3
"""Keybinds with real hn keys: open it from Commands, put Split right on h, C-b h splits.

Only a private fixture backend, temporary HOME (its own tui.toml) and explicitly named hn/tmux
sockets.
"""
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get('HN_KEYBINDS_PORT', '19787'))
assert 19783 <= PORT <= 19789, 'refusing non-test keybinds port'
PREFIX = f'hn-keybinds-{os.getpid()}'
BASE = Path(tempfile.mkdtemp(prefix='hnkb-', dir='/tmp')).resolve()
HN = BASE / 'hn'
shutil.copy2(os.environ.get('HN_KEYBINDS_BINARY', ROOT / 'target/release/harness-tui'), HN)
TMUX = shutil.which('tmux')
assert TMUX
ENV = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TZ') if k in os.environ}
ENV.update(HOME=str(BASE), HN_TMPDIR=str(BASE), HN_SOCKET_NAME=PREFIX, PORT=str(PORT),
           TERM='xterm-256color', COLORTERM='truecolor', SHELL='/bin/sh', HARNESS_TUI_DESK='sync',
           HARNESS_TUI_NOTIFY='off', HN_DESKTOP='off', MOCK_DEMO='1', MOCK_RECONNECT='1')
TOML = BASE / '.config' / 'harness' / 'tui.toml'

def hn(*args, ok=True):
    assert PREFIX.startswith('hn-keybinds-')
    p = subprocess.run([str(HN), '-L', PREFIX, '--port', str(PORT), '-f', '/dev/null', *args],
                       env=ENV, cwd=BASE, text=True, capture_output=True, timeout=12)
    if ok: assert p.returncode == 0, (args, p.stdout, p.stderr)
    return p.stdout.strip()

def tmux(*args, ok=True):
    p = subprocess.run([TMUX, '-L', PREFIX + '-outer', *args], env=ENV, cwd=BASE,
                       text=True, capture_output=True, timeout=10)
    if ok: assert p.returncode == 0, (args, p.stderr)
    return p.stdout

def state():
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/test/dial', timeout=2) as r: return r.read()

def screen(): return tmux('capture-pane', '-p', '-t', 'test')
def wait(fn, label, seconds=8):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if fn(): return
        time.sleep(.05)
    raise AssertionError(label + '\n' + screen())
def shows(text): wait(lambda: text in screen(), text)
def gone(text): wait(lambda: text not in screen(), 'still shows ' + text)
def keys(*args): tmux('send-keys', '-t', 'test', *args); time.sleep(.15)
def type_text(text): tmux('send-keys', '-l', '-t', 'test', text); time.sleep(.15)
def panes(): return int(hn('display-message', '-p', '#{window_panes}'))

def start():
    command = shlex.join(['env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'HN_SOCKET',
                          *[f'{k}={v}' for k, v in ENV.items()], str(HN), '-L', PREFIX,
                          '--port', str(PORT), '-f', '/dev/null'])
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-x', '150', '-y', '42', command)
    tmux('set-window-option', '-t', 'test', 'remain-on-exit', 'on')
    shows('Fix flaky login test')

mock = None
started = False
try:
    with socket.socket() as probe: probe.bind(('127.0.0.1', PORT))
    mock = subprocess.Popen(['node', str(ROOT / 'tests/mock-daemon.mjs'), str(PORT)], env=ENV,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(100):
        assert mock.poll() is None
        try: state(); break
        except OSError: time.sleep(.05)
    else: raise AssertionError('mock startup timeout')
    start()
    started = True

    # C-b Enter → keyb → Enter: Keybinds, its own panel, the prefixes first.
    keys('C-b', 'Enter'); shows('Commands')
    type_text('keyb'); keys('Enter'); shows('Second prefix')
    s = screen()
    assert 'Keybinds' in s and 'Split right' in s and 'Preview' not in s and 'Appearance' not in s, s
    # Split right → Enter → h.
    type_text('split right'); wait(lambda: '› Split right' in screen(), 'cursor on Split right')
    keys('Enter'); shows('press a key')
    keys('h'); shows('saved to tui.toml')
    assert any('Split right' in l and 'C-b h' in l for l in screen().splitlines()), screen()
    # Esc back to Commands, Esc closes.
    keys('Escape'); shows('Commands'); gone('Second prefix')
    keys('Escape'); gone('Commands')
    toml = TOML.read_text()
    assert '[prefix_keys]' in toml and '"h" = "split-window -h"' in toml and '"%" = "none"' in toml, toml
    # C-b h splits; C-b % does nothing now.
    before = panes()
    keys('C-b', 'h'); wait(lambda: panes() == before + 1, 'C-b h splits')
    keys('C-b', '%'); time.sleep(.5)
    assert panes() == before + 1, 'C-b % no longer splits'
    print('PASS Keybinds: opened from Commands, Split right on h, C-b h splits and C-b % does not', flush=True)

    # A restart reads tui.toml: still h.
    hn('kill-server', ok=False); tmux('kill-server', ok=False); started = False
    time.sleep(.3)
    start(); started = True
    before = panes()
    keys('C-b', 'h'); wait(lambda: panes() == before + 1, 'C-b h splits after a restart')
    keys('C-b', '%'); time.sleep(.5)
    assert panes() == before + 1, 'C-b % still free after a restart'
    print('PASS Keybinds: after a restart C-b h still splits', flush=True)

    # The prefix, any key: Keybinds → Prefix → Enter → ` — set at once, as `set -g prefix` does.
    # Saved to tui.toml; ` h splits, still after a restart.
    keys('C-b', 'Enter'); shows('Commands')
    type_text('keyb'); keys('Enter'); shows('Second prefix')
    keys('Enter'); shows('Prefix: press a key')
    type_text('`'); shows('Prefix: ` — saved')
    keys('Escape'); keys('Escape'); gone('Commands')
    toml = TOML.read_text()
    assert 'prefix = "`"' in toml and 'send-prefix' not in toml, toml
    before = panes()
    type_text('`'); keys('h'); wait(lambda: panes() == before + 1, '` h splits')
    hn('kill-server', ok=False); tmux('kill-server', ok=False); started = False
    time.sleep(.3)
    start(); started = True
    before = panes()
    type_text('`'); keys('h'); wait(lambda: panes() == before + 1, '` h splits after a restart')
    print('PASS Keybinds: ` as the prefix, set at once and saved, still ` after a restart', flush=True)

finally:
    try:
        if started:
            hn('kill-server', ok=False); tmux('kill-server', ok=False)
        def clients():
            rows = subprocess.check_output(['ps', '-ax', '-o', 'pid=,command='], text=True).splitlines()
            return [int(parts[0]) for row in rows if len(parts := row.strip().split(None, 1)) == 2
                    and parts[1].startswith(str(HN) + ' ') and f'-L {PREFIX} ' in parts[1]]
        for pid in clients():
            try: os.kill(pid, 15)
            except ProcessLookupError: pass
        deadline = time.monotonic() + 5
        while clients() and time.monotonic() < deadline: time.sleep(.05)
        assert not clients(), 'Keybinds test client did not exit'
    finally:
        if mock:
            mock.terminate()
            try: mock.wait(timeout=5)
            except subprocess.TimeoutExpired: mock.kill(); mock.wait()
        shutil.rmtree(BASE, ignore_errors=True)
