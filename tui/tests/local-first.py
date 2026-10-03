#!/usr/bin/env python3
"""Packaged CLI + hn: signed-out startup beside another user's daemon.

Build cli/dist/cli.js with `cd cli && node build-bundle.mjs` first.
HN_LOCAL_FIRST_BINARY selects the native hn build (default: tui/target/release/harness-tui).
Only disposable homes, owned daemon processes, and explicitly named tmux servers are used.
"""
import http.client
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import tempfile
import time

REPO = Path(__file__).resolve().parents[2]
BASE = Path(tempfile.mkdtemp(prefix='hnown-', dir='/tmp')).resolve()
NODE = shutil.which('node')
TMUX = shutil.which('tmux')
HN = os.environ.get('HN_LOCAL_FIRST_BINARY', str(REPO / 'tui/target/release/harness-tui'))
assert NODE and TMUX, 'node and tmux are required'
assert Path(HN).is_file() and (REPO / 'cli/dist/cli.js').is_file(), 'build hn and bundle the CLI first'
PREFIX = f'hn-owners-{os.getpid()}'
CLI = [NODE, str(REPO / 'cli/dist/cli.js')]
children = []
environments = []
logs = []
with socket.socket() as probe:
    probe.bind(('127.0.0.1', 0))
    PORT = probe.getsockname()[1]

def fixture(label):
    root = BASE / label
    (root / 'bin').mkdir(parents=True)
    for command in ('open', 'xdg-open'):
        path = root / 'bin' / command
        path.write_text('#!/bin/sh\necho unexpected-login >> ' + shlex.quote(str(root / 'browser-opened')) + '\nexit 1\n')
        path.chmod(0o700)
    wrapper = root / 'bin/tmux'
    wrapper.write_text('#!/bin/sh\nfor arg in "$@"; do case "$arg" in -L*|-S*) exit 125;; esac; done\nexec ' + shlex.join([TMUX, '-L', PREFIX + '-' + label]) + ' "$@"\n')
    wrapper.chmod(0o700)
    env = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TZ') if k in os.environ}
    env.update(HOME=str(root), PATH=str(root / 'bin') + ':' + env['PATH'], PORT=str(PORT),
        ADAPTER_DATA_DIR=str(root / 'data'), ADAPTER_CLI_DIR=str(root / 'cli'),
        HARNESS_AUTH_DIR=str(root / 'auth'), ADAPTER_COMPUTER_ID=label * 32,
        ADAPTER_COMPUTER_ID_FILE=str(root / 'computer-id'), ADAPTER_RUNTIME_DIR=str(root / 'runtime'),
        DSH_DIR=str(root / 'dsh'), HARNESS_GRID_BIN=str(root / 'no-grid'),
        BACKEND_WS_URL='ws://127.0.0.1:1', WEB_URL='http://127.0.0.1:1',
        HARNESS_STORE_CATALOG_URL='http://127.0.0.1:1/catalog', DISABLE_GRID_INSTALL='true',
        DISABLE_HOOK_INSTALL='true', ADAPTER_UPDATE_DISABLE='true', ANALYTICS_ENABLED='false',
        RECAP_FORCE='false', RECAP_WITHOUT_DEVICE='false', CABLE_DISABLE='true', CABLE_FW_DISABLE='true',
        HARNESS_DAEMONS='0', TERMINAL_BACKENDS='tmux', HN_DESKTOP='off', HARNESS_TUI_NOTIFY='off',
        HN_TMPDIR=str(root), HN_SOCKET_NAME=PREFIX + '-' + label, HARNESS_TUI_BIN=HN,
        TERM='xterm-256color', SHELL='/bin/sh')
    environments.append((root, env))
    subprocess.run([TMUX, '-L', PREFIX + '-' + label, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture-keeper'], env=env, check=True)
    return root, env

def status(root):
    conn = http.client.HTTPConnection('localhost', timeout=2)
    conn.sock = socket.socket(socket.AF_UNIX)
    conn.sock.settimeout(2)
    try:
        conn.sock.connect(str(root / 'data' / f'daemon-{PORT}.sock'))
        conn.request('GET', '/api/status')
        response = conn.getresponse()
        assert response.status == 200
        return json.load(response)
    finally:
        conn.close()

def wait(fn, label, seconds=60):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            result = fn()
            if result:
                return result
        except (OSError, ValueError, http.client.HTTPException):
            pass
        time.sleep(.15)
    raise AssertionError(label)

def outer(*args, check=True):
    return subprocess.run([TMUX, '-L', PREFIX + '-outer', *args], text=True, capture_output=True, check=check, timeout=10)

def screen():
    return outer('capture-pane', '-p', '-t', 'guest').stdout

try:
    a, env_a = fixture('a')
    log = open(a / 'daemon.log', 'w'); logs.append(log)
    children.append(subprocess.Popen([*CLI, '__run'], cwd=REPO / 'cli', env=env_a, stdout=log, stderr=log))
    first = wait(lambda: (s if (s := status(a)).get('discoveryReady') else None), 'first local daemon')
    assert first['machineId'] == 'a' * 32 and first['signedIn'] is False
    b, env_b = fixture('b')
    cache = b / '.harness/tui/fleet.json'
    cache.parent.mkdir(parents=True)
    cache.write_text(json.dumps({'machines': [{'id': 'old-account', 'name': 'OTHER_ACCOUNT_PRIVATE'}],
        'agents': [{'machine': 'old-account', 'row': {'id': 'private-pane', 'name': 'OTHER_ACCOUNT_PRIVATE'}}]}))
    command = shlex.join(['env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'HN_SOCKET',
        *[f'{k}={v}' for k, v in env_b.items()], *CLI, 'tui', '-L', PREFIX + '-b'])
    outer('-f', '/dev/null', 'new-session', '-d', '-s', 'guest', '-x', '110', '-y', '34', '-c', str(REPO / 'cli'), command)
    second = wait(lambda: (s if (s := status(b)).get('discoveryReady') else None), 'guest hn bootstrap')
    assert second['machineId'] == 'b' * 32 and second['signedIn'] is False
    assert second['config']['port'] != first['config']['port']
    assert status(a)['pid'] == first['pid']
    wait(lambda: 'Nothing running.' in (s := screen()) or 'Terminal on ' in s, 'guest home or local terminal')
    assert 'OTHER_ACCOUNT_PRIVATE' not in screen()
    assert not (b / 'browser-opened').exists()
    assert not (b / 'auth/session.json').exists()
    print('PASS: real hn starts signed out beside another user daemon, with distinct ports and no browser login', flush=True)
    outer('send-keys', '-t', 'guest', 'C-b', 'N')
    wait(lambda: 'New Harness' in screen() and 'Project' in screen(), 'signed-out New Harness popup', 15)
    assert 'OTHER_ACCOUNT_PRIVATE' not in screen()
    print('PASS: local New Harness opens; old unscoped account cache is ignored; first daemon stays running', flush=True)
finally:
    (BASE / 'guest-screen.txt').write_text(outer('capture-pane', '-p', '-t', 'guest', check=False).stdout)
    for root, env in reversed(environments):
        subprocess.run([HN, '-L', env['HN_SOCKET_NAME'], 'kill-server'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        subprocess.run([*CLI, 'stop'], cwd=REPO / 'cli', env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
    for child in children:
        if child.poll() is None: child.terminate()
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired: child.kill(); child.wait()
    outer('kill-server', check=False)
    for root, _ in environments:
        subprocess.run([TMUX, '-L', PREFIX + '-' + root.name, 'kill-server'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for log in logs: log.close()
    print('Isolated logs:', BASE, flush=True)
