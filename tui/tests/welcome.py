#!/usr/bin/env python3
"""Real-terminal welcome/new-window journeys against a private, fresh-user fixture.

No accounts, installed agents, user settings, or live sessions are used.
"""
import json
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
PORT = int(os.environ.get('HN_WELCOME_TEST_PORT', '19787'))
assert 19780 <= PORT <= 19789
PREFIX = f'hn-welcome-{os.getpid()}'
BASE = Path(tempfile.mkdtemp(prefix='hn-welcome-', dir='/tmp')).resolve()
PROJECT = BASE / 'autonomous-harness'
PROJECT.mkdir()
HN = BASE / 'hn'
shutil.copy2(os.environ.get('HN_WELCOME_TEST_BINARY', ROOT / 'target/release/harness-tui'), HN)
TMUX = shutil.which('tmux')
assert TMUX
ENV = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TZ', 'NODE_PATH', 'LLVM_PROFILE_FILE') if k in os.environ}
ENV.update(HOME=str(BASE), HN_TMPDIR=str(BASE), HN_SOCKET_NAME=PREFIX, PORT=str(PORT),
           TERM='xterm-256color', COLORTERM='truecolor', SHELL='/bin/sh', RUST_BACKTRACE='1',
           HARNESS_TUI_DESK='off', HARNESS_TUI_NOTIFY='off', HN_DESKTOP='off',
           MOCK_WELCOME='1', MOCK_NEW_UI='1', MOCK_RECONNECT='1')
OUTPUT = Path(os.environ['HN_WELCOME_OUTPUT']) if os.environ.get('HN_WELCOME_OUTPUT') else None
if OUTPUT: OUTPUT.mkdir(parents=True, exist_ok=True)


def hn(*args, ok=True):
    result = subprocess.run([str(HN), '-L', PREFIX, '--port', str(PORT), '-f', '/dev/null', *args],
                            env=ENV, cwd=PROJECT, text=True, capture_output=True, timeout=12)
    if ok: assert result.returncode == 0, (args, result.stdout, result.stderr)
    return result.stdout.strip()


def tmux(*args, ok=True):
    result = subprocess.run([TMUX, '-L', PREFIX + '-outer', *args], env=ENV, cwd=PROJECT,
                            text=True, capture_output=True, timeout=10)
    if ok: assert result.returncode == 0, (args, result.stderr)
    return result.stdout


def state(route='dial', update=None):
    request = urllib.request.Request(f'http://127.0.0.1:{PORT}/test/{route}',
                                     data=json.dumps(update).encode() if update is not None else None)
    with urllib.request.urlopen(request, timeout=2) as response:
        return json.load(response)['data']


def screen(): return tmux('capture-pane', '-p', '-t', 'test')


def wait(fn, description, seconds=10):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if fn(): return
        time.sleep(.05)
    raise AssertionError(description + '\n' + screen())


def shows(text): wait(lambda: text in screen(), text)


def keys(*args):
    for key in args:
        tmux('send-keys', '-t', 'test', key)
        time.sleep(.06)


def type_text(text): tmux('send-keys', '-l', '-t', 'test', text)


def raw(text): tmux('send-keys', '-H', '-t', 'test', *[f'{b:02x}' for b in text.encode()])


def paste(text): raw('\x1b[200~' + text + '\x1b[201~')


def position(label):
    lines = screen().splitlines()
    width = int(tmux('display', '-p', '-t', 'test', '#{pane_width}').strip())
    left = (width - min(60, max(0, width - 4))) // 2
    for y, line in enumerate(lines[:-1]):
        text = line[left:left+60]
        if text[3:].startswith(label): return left + 3, y


def click(label):
    wait(lambda: position(label), label)
    x, y = position(label)
    raw(f'\x1b[<0;{x+1};{y+1}M\x1b[<0;{x+1};{y+1}m')
    time.sleep(.12)


def choose(label, query):
    click(label)
    type_text(query)
    keys('Enter')


def snapshot(name):
    time.sleep(.15)
    if OUTPUT:
        (OUTPUT / (name + '.ansi')).write_text(tmux('capture-pane', '-p', '-e', '-t', 'test'))
        (OUTPUT / (name + '.txt')).write_text(screen())


def created(): return [p for p in state().get('created', []) if p['engine'] != 'terminal']
def window(): return hn('display', '-p', '#{window_id}')
def resize(width, height):
    tmux('resize-window', '-t', 'test', '-x', str(width), '-y', str(height))
    time.sleep(.2)
    assert tmux('display', '-p', '-t', 'test', '#{pane_dead}').strip() == '0', screen()


def launch():
    command = shlex.join(['env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'HN_SOCKET',
                          *[f'{k}={v}' for k, v in ENV.items()], str(HN), '-L', PREFIX,
                          '--port', str(PORT), '-f', '/dev/null'])
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-x', '150', '-y', '42', command)
    tmux('set-window-option', '-t', 'test', 'remain-on-exit', 'on')


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
    launch()
    started = True
    shows('Welcome to Harness')
    shows('Finding saved sessions')
    snapshot('welcome-discovering')
    anchor = position('Task')
    first = window()
    task = '1 fix café login\nKeep 界 and 🦀 intact.\nFrom a tmux buffer!.'
    type_text('1 fix café login')
    paste('\r\nKeep 界 and 🦀 intact.')
    shows('Keep 界 and 🦀 intact.')
    hn('set-buffer', '\nFrom a tmux buffer.')
    keys('C-b', ']'); shows('From a tmux buffer.')
    keys('C-b', 'C-b'); type_text('!'); shows('From a tmux buffer!.')
    assert not created(), 'typing a digit or pasting must not launch/resume'
    assert not state('reconnect')['inputs'], 'the backing shell never receives task text'
    state('welcome', {'history': 'empty'})
    keys('C-r'); shows('No recent sessions')
    assert position('Task') == anchor
    snapshot('welcome-first-task')
    state('welcome', {'history': 'ready'})
    keys('C-r'); shows('Continue NFC device chat')
    assert position('Task') == anchor, 'late history must not move the form'
    assert not created()
    snapshot('welcome-existing-history')
    print('PASS welcome: fresh history loading/empty/found, immediate typing, paste and no input leak', flush=True)

    # The default agent must work without opening a chooser. In particular, a form
    # created before the connection arrives must acquire its Git state automatically.
    shows('Start OpenCode')
    assert 'Could not read Git' not in screen(), screen()
    state('welcome', {'delay': 1200})
    keys('Enter', 'Enter')
    shows('Starting')
    snapshot('welcome-starting')
    keys('C-b', 'c'); shows('New Window')
    second = window()
    assert second != first
    type_text('second window draft')
    shows('second window draft')
    wait(lambda: len(created()) == 1, 'one launch')
    wait(lambda: hn('display', '-p', '-t', first, '#{window_name}') == 'Mock opencode', 'launch delivered to its original window')
    assert created()[0]['prompt'] == task, created()
    assert created()[0]['engine'] == 'opencode', created()
    assert window() == second, 'a late launch must not steal the current window'
    assert hn('display', '-p', '-t', first, '#{window_panes}') == '1'
    assert not state('reconnect')['inputs']
    keys('C-b', 'l'); shows('Mock opencode (mock)')
    keys('C-b', 'l'); shows('second window draft')
    snapshot('new-window-draft')
    print('PASS welcome: immediate first task, duplicate prevention, delayed placement and independent drafts', flush=True)

    keys('Down'); shows('Search agents and harnesses')
    keys('Up'); type_text('!'); shows('second window draft!')
    keys('BSpace')
    wait(lambda: 'second window draft!' not in screen(), 'Backspace edits the task after returning from Agent')
    keys('Escape', 'Escape'); shows('Mock opencode (mock)')
    assert window() == first, 'Escape returns to the previous window'
    keys('C-b', 'l'); shows('second window draft')
    click('Task')
    print('PASS welcome: task arrow navigation, Escape back and preserved draft', flush=True)

    keys('C-b', 'N'); shows('New Harness')
    type_text('a separate modal task')
    shows('a separate modal task'); snapshot('new-harness-immediate-task')
    keys('Escape'); shows('second window draft')
    assert 'a separate modal task' not in screen()
    # A plain-key prefix and plain root binding both belong to the task editor here.
    hn('set', '-g', 'prefix', '`')
    hn('bind', '-n', 'x', 'rename-window', 'wrong-binding')
    type_text(' ` x'); shows('second window draft ` x')
    assert hn('display', '-p', '#{window_name}') != 'wrong-binding'
    keys('Tab', '`', 'c')
    wait(lambda: window() != second, 'plain prefix navigates after tabbing out of the task')
    wait(lambda: hn('display', '-p', '#{window_panes}') == '1', 'temporary welcome backing shell')
    hn('kill-window')
    shows('second window draft ` x')
    hn('set', '-g', 'prefix', 'C-b'); hn('unbind', '-n', 'x')
    choose('Agent', 'codex'); click('Task')
    resize(80, 24)
    for text in ('Task', 'Agent', 'Project', 'Branch', 'Worktree', 'Model', 'Approvals', 'Profile', 'Start Codex', 'Open Terminal', 'Browse All Sessions'):
        shows(text)
    snapshot('new-window-80x24')
    click('Project'); shows('Search projects'); snapshot('new-window-picker-narrow')
    keys('Escape'); shows('second window draft')
    for width, height in [(45, 14), (22, 5), (1, 1), (150, 42)]: resize(width, height)
    shows('second window draft')
    anchor = position('Task')
    click('Project'); shows('Search projects')
    assert position('Task') == anchor
    snapshot('new-window-picker-right')
    keys('Escape')
    raw('\x1b]10;rgb:2020/2020/2020\x1b\\\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
    snapshot('new-window-light')
    print('PASS welcome: modal separation, keyboard ownership, wide/narrow/light rendering and resize', flush=True)

    state('welcome', {'history': 'failed', 'delay': 0}); keys('C-r')
    shows('Some history is unavailable')
    snapshot('welcome-history-unavailable')
    state('welcome', {'history': 'ready'}); keys('C-r')
    shows('Recent sessions')
    click('Browse All Sessions'); shows('Search harnesses')
    keys('Escape'); shows('second window draft')
    count = len(created())
    click('Continue NFC device chat')
    shows('Continue NFC device chat (mock)')
    assert len(created()) == count + 1
    resumed = created()[-1]
    assert resumed['resumeSessionId'] == 'ext-codex-nfc' and 'prompt' not in resumed
    assert window() == second
    keys('C-b', 'c'); shows('New Window')
    third = window()
    click('Open Terminal'); shows('Mock terminal (mock)')
    assert window() == third
    assert len(created()) == count + 1, 'Open Terminal never launches the selected coding agent'
    # Replacing the backing shell may delete one already. Closing the opened terminal
    # must also end its shell, exactly as closing a tmux window does.
    deleted = len(state().get('deleted', []))
    hn('kill-window')
    wait(lambda: len(state().get('deleted', [])) > deleted, 'closing Open Terminal ends its shell')
    keys('C-b', 'c'); shows('New Window')
    type_text('Keep this task away from the terminal')
    click('Agent'); type_text('Terminal')
    shows('No matches')
    keys('Escape')
    click('Open Terminal'); shows('Mock terminal (mock)')
    assert len(created()) == count + 1, 'Open Terminal never starts a coding agent'
    assert not state('reconnect')['inputs'], 'Open Terminal never sends the task'
    keys('C-b', 'N'); shows('a separate modal task')
    keys('Escape'); hn('kill-window')
    print('PASS welcome: discovery recovery, browse all, existing-session resume and explicit terminal', flush=True)

    # A USB welcome can finish after a person has already requested another
    # terminal. Release both replies in each order: neither may steal the other's
    # window, change current focus, or make the CLI creation request fail.
    for order in ['first', 'last']:
        hn('kill-server', ok=False)
        tmux('kill-server')
        fresh = BASE / ('usb-startup-' + order)
        fresh.mkdir()
        ENV.update(HOME=str(fresh), HN_TMPDIR=str(fresh), HARNESS_OS='1', HARNESS_OS_LIVE='1',
                   ADAPTER_DATA_DIR=str(BASE / '.harness/cli/data'))
        state('welcome', {'holdTerminals': True})
        launch()
        wait(lambda: state('welcome')['pendingTerminals'] == 1, 'USB welcome creation held')
        first_window = window()
        creation = subprocess.Popen(
            [str(HN), '-L', PREFIX, '--port', str(PORT), '-f', '/dev/null',
             'new-window', '-n', 'early-terminal', 'printf terminal-ready'],
            env=ENV, cwd=PROJECT, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            wait(lambda: state('welcome')['pendingTerminals'] == 2, 'concurrent terminal creation held')
            second_window = window()
            assert first_window != second_window
            state('welcome', {'releaseTerminal': order})
            expected_window = first_window if order == 'first' else second_window
            wait(lambda: hn('display', '-p', '-t', expected_window, '#{window_panes}') == '1',
                 'first completion belongs to its originating window')
            assert window() == second_window, 'completion stole focus'
            state('welcome', {'releaseTerminal': 'first'})
            stdout, stderr = creation.communicate(timeout=5)
            assert creation.returncode == 0, (stdout, stderr)
            wait(lambda: hn('display', '-p', '-t', first_window, '#{window_panes}') == '1', 'USB pane placed')
            assert hn('display', '-p', '-t', second_window, '#{window_panes}') == '1'
            for target, command in [(first_window, '/usr/bin/hn-os welcome'),
                                    (second_window, 'printf terminal-ready')]:
                actual = hn('display', '-p', '-t', target, '#{pane_start_command}')
                assert shlex.split(actual) == [command], (order, target, actual, command)
            assert window() == second_window
        finally:
            if creation.poll() is None:
                creation.kill(); creation.communicate(timeout=5)
        state('welcome', {'holdTerminals': False})
    ENV.pop('HARNESS_OS'); ENV.pop('HARNESS_OS_LIVE'); ENV.pop('ADAPTER_DATA_DIR')
    print('PASS welcome: USB startup and concurrent terminal creation stay in their own windows in both reply orders', flush=True)

    # A new user can arrive without the daemon. Keep the task, explain how to connect,
    # and let Open Terminal use a real local PTY without executing any draft text.
    hn('kill-server', ok=False)
    tmux('kill-server')
    mock.terminate(); mock.wait(timeout=5); mock = None
    offline = BASE / 'offline'
    offline.mkdir()
    # Upgrading a user who last chose Terminal must start with a real agent,
    # without retaining Terminal's name or specialized harness identity.
    defaults = offline / '.harness/tui/new-harness.json'
    defaults.parent.mkdir(parents=True, exist_ok=True)
    defaults.write_text(json.dumps({'engine': 'terminal', 'label': 'Terminal', 'dsh': 'old/shell'}))
    ENV.update(HOME=str(offline), HN_TMPDIR=str(offline))
    launch()
    shows('New Window')
    shows('Start OpenCode')
    shows('Run `harness start` to connect agents.')
    type_text('Preserve this offline task')
    keys('Enter')
    shows('task stays here.')
    shows('Preserve this offline task')
    snapshot('welcome-offline')
    click('Open Terminal')
    wait(lambda: 'Start OpenCode' not in screen(), 'local terminal opened')
    assert 'Preserve this offline task' not in hn('capture-pane', '-p'), 'draft leaked into the local shell'
    type_text("printf 'HN_OFFLINE_TERMINAL_%s\\n' OK")
    keys('Enter'); shows('HN_OFFLINE_TERMINAL_OK')
    print('PASS welcome: daemon unavailable, preserved task and real local terminal', flush=True)
finally:
    try:
        if started:
            hn('kill-server', ok=False)
            tmux('kill-server', ok=False)
        rows = subprocess.check_output(['ps', '-ax', '-o', 'pid=,command='], text=True).splitlines()
        owned = [int(parts[0]) for row in rows if len(parts := row.strip().split(None, 1)) == 2
                 and parts[1].startswith(str(HN) + ' ') and f'-L {PREFIX} ' in parts[1]]
        for pid in owned:
            try: os.kill(pid, 15)
            except ProcessLookupError: pass
    finally:
        if mock:
            mock.terminate()
            try: mock.wait(timeout=5)
            except subprocess.TimeoutExpired: mock.kill(); mock.wait()
        shutil.rmtree(BASE, ignore_errors=True)
