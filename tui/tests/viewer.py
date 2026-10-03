#!/usr/bin/env python3
"""Exercise hn's public viewer commands against a private mock and a recording browser opener."""
import json
import os
import signal
from pathlib import Path
import shutil
import shlex
import socket
import threading
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

root = Path(__file__).resolve().parents[1]
source = Path(os.environ.get('HN_VIEWER_TEST_BINARY', root / 'target/release/harness-tui')).resolve()
port = int(os.environ.get('HN_VIEWER_TEST_PORT', '19671'))
if not 19000 <= port <= 19999 or port in (18473, 18907):
    raise SystemExit('Viewer tests require an isolated port in 19000–19999')
prefix = f'hn-viewer-test-{os.getpid()}'
with tempfile.TemporaryDirectory(prefix='hnv-', dir='/tmp') as tmp:
    home = Path(tmp)
    binary = home / 'hn'
    shutil.copy2(source, binary)
    bin_dir = home / 'bin'
    bin_dir.mkdir()
    log = home / 'browser.jsonl'
    for name in ('open', 'xdg-open'):
        opener = bin_dir / name
        opener.write_text('#!' + sys.executable + '\nimport json,os,sys,time\nwith open(os.environ["HN_VIEWER_OPENER_LOG"],"a") as f: f.write(json.dumps(sys.argv[1:])+"\\n")\ntime.sleep(float(os.environ.get("HN_VIEWER_OPENER_DELAY","0")))\nsys.exit(int(os.environ.get("HN_VIEWER_OPENER_EXIT","0")))\n')
        opener.chmod(0o700)
    env = {k: v for k, v in os.environ.items() if k not in ('TMUX', 'TMUX_PANE', 'HN_SOCKET', 'SSH_TTY', 'SSH_CONNECTION', 'SSH_CLIENT')}
    env.update(HOME=tmp, PORT=str(port), HN_SOCKET_NAME=prefix, HN_TMPDIR=tmp,
               HARNESS_TUI_DESK='off', HARNESS_TUI_NOTIFY='off', HN_DESKTOP='off',
               HN_VIEWER_OPENER_LOG=str(log), PATH=str(bin_dir) + os.pathsep + env.get('PATH', ''),
               MOCK_VIEWER='1', MOCK_VIEWER_EDGES='1', MOCK_WEB_URL='https://harness.example', DISPLAY=':hn-test')
    def hn(*args, extra=None, ok=True):
        result = subprocess.run([str(binary), '-L', prefix, '--port', str(port), *args],
                                env={**env, **(extra or {})}, text=True, capture_output=True, timeout=20)
        if ok and result.returncode:
            raise AssertionError(f'{args}: {result.returncode}: {result.stderr}')
        return result
    def opened():
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    def web_link(result, agent):
        uri = urllib.parse.urlparse(result.stdout.strip())
        assert uri.scheme == 'https' and uri.netloc == 'harness.example', result.stdout
        assert uri.path == '/', result.stdout
        assert urllib.parse.parse_qs(uri.query) == {
            'viewer': ['1'], 'machine': ['mock000000000000000000000000000' + ('2' if agent.startswith('remote') or agent.endswith('-remote') else '1')],
            'agent': [agent]}, result.stdout
    mock = subprocess.Popen(['node', str(root / 'tests/mock-daemon.mjs'), str(port)], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for _ in range(100):
            if mock.poll() is not None: raise AssertionError(mock.stderr.read().decode())
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/status', timeout=.2): break
            except OSError: time.sleep(.05)
        else: raise AssertionError('Mock did not start')
        local = f'http://127.0.0.1:{port}/test-viewer?file=model.glb'
        assert hn('view', '-p', '-t', 'Mock Blender').stdout.strip() == local
        assert not opened()
        hn('view', '-t', 'Mock Blender')
        assert opened() == [[local]], opened()
        web_link(hn('view', '-t', 'Mock Blender', extra={'SSH_CONNECTION': 'fixture ssh'}), 'mock-blender')
        assert opened() == [[local]], 'SSH must never launch a server-side browser'
        web_link(hn('view', '-p', '-t', 'Remote Blender'), 'remote-blender')
        web_link(hn('view', '-pw', '-t', 'Mock Blender'), 'mock-blender')
        assert hn('view', '-p', '-t', 'Mock Claude', ok=False).returncode == 1
        assert hn('view', '-p', '-t', 'Missing', ok=False).returncode == 1
        assert hn('view', '--unknown', ok=False).returncode == 2
        assert hn('view', '-t', ok=False).returncode == 2
        assert hn('view', '-t', 'Mock Blender', extra={'HN_VIEWER_OPENER_EXIT': '1'}).stdout.strip() == local
        assert hn('view', '-t', 'Mock Blender', extra={'PATH': ''}).stdout.strip() == local
        started = time.monotonic()
        assert hn('view', '-t', 'Mock Blender', extra={'HN_VIEWER_OPENER_DELAY': '12'}).stdout.strip() == local
        assert time.monotonic() - started < 10, 'a stuck browser opener must not hold the terminal'
        if sys.platform.startswith('linux'):
            count = len(opened())
            assert hn('view', '-t', 'Mock Blender', extra={'DISPLAY': '', 'WAYLAND_DISPLAY': ''}).stdout.strip() == local
            assert len(opened()) == count
            hn('view', '-t', 'Mock Blender', extra={'DISPLAY': '', 'WAYLAND_DISPLAY': 'fixture'})
            assert len(opened()) == count + 1
        assert 'usage: hn view' in hn('view', '--help').stdout
        assert hn('view', ok=False).returncode == 1
        assert hn('view', '-t', '', ok=False).returncode == 2
        assert hn('view', '-p', '-t', 'Mock B', ok=False).returncode == 1
        assert 'more than one harness' in hn('view', '-p', '-t', 'Duplicate Viewer', ok=False).stderr
        for key in ('SSH_CLIENT', 'SSH_TTY', 'SSH_CONNECTION'):
            count = len(opened())
            web_link(hn('view', '-t', 'mock-blender', extra={key: 'fixture'}), 'mock-blender')
            assert len(opened()) == count
        web_link(hn('view', '-c', '-t', 'mock-blender'), 'mock-blender')
        web_link(hn('view', '-pcw', '-t', 'Waiting Viewer'), 'waiting-viewer')
        assert 'Renderer could not start' in hn('view', '-p', '-t', 'Failed Viewer', ok=False).stderr
        assert 'invalid viewer address' in hn('view', '-p', '-t', 'Unsafe Viewer', ok=False).stderr
        assert hn('view', '-p', '-t', 'Quoted " viewer; $(false)').stdout.strip() == f'http://127.0.0.1:{port}/test-viewer?x=a&y=b'
        web_link(hn('view', '-p', '-t', 'mock0000000000000000000000000002:duplicate-remote'), 'duplicate-remote')
        print('PASS: standalone viewer, exact opener argv, SSH, remote target, print and browser-failure fallback')
        hn('new-session', '-d', '-s', 'viewer-test')
        hn('open-harness', '-s', 'Mock Blender')
        assert hn('view', '-p').stdout.strip() == local
        count = len(opened())
        web_link(hn('view', extra={'SSH_TTY': '/dev/fixture'}), 'mock-blender')
        assert len(opened()) == count
        assert hn('view', '-p', '-t', 'Mock Claude', ok=False).returncode == 1
        assert 'more than one harness' in hn('view', '-p', '-t', 'Duplicate Viewer', ok=False).stderr
        web_link(hn('view', '-pc', '-t', 'Waiting Viewer'), 'waiting-viewer')
        assert hn('view', '-p', '-t', 'Quoted " viewer; $(false)').stdout.strip() == f'http://127.0.0.1:{port}/test-viewer?x=a&y=b'
        assert 'invalid viewer address' in hn('view', '-p', '-t', 'Unsafe Viewer', ok=False).stderr
        assert 'open-viewer' in hn('list-commands').stdout
        print('PASS: active pane through hn IPC; caller SSH environment controls the handoff')

        # An hn client can disappear or lose its reply while a shell asks for a viewer.
        # A private Unix socket returning a damaged response exercises that recovery path.
        broken = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        broken_path = home / (prefix + '-broken.sock')
        broken.bind(str(broken_path))
        broken.listen()
        broken.settimeout(.1)
        stopped = threading.Event()
        def damaged_client():
            while not stopped.is_set():
                try: peer, _ = broken.accept()
                except socket.timeout: continue
                except OSError: return
                with peer:
                    peer.settimeout(1)
                    try:
                        if peer.recv(8192): peer.sendall(b'not-json\n')
                    except OSError: pass
        worker = threading.Thread(target=damaged_client, daemon=True)
        worker.start()
        try:
            result = hn('-S', str(broken_path), 'view', '-p', '-t', 'Mock Blender', ok=False)
            assert result.returncode == 1 and 'could not reach the hn client' in result.stderr, result
        finally:
            stopped.set()
            worker.join(timeout=2)
            broken.close()

        tmux = shutil.which('tmux')
        assert tmux, 'Viewer command-prompt tests need tmux'
        tmux_prefix = prefix + '-ui'
        def mux(*args, ok=True):
            result = subprocess.run([tmux, '-L', tmux_prefix, *args], env=env, capture_output=True, text=True, timeout=10)
            if ok: assert result.returncode == 0, result.stderr
            return result.stdout
        def until(label, predicate):
            end = time.monotonic() + 15
            while not predicate():
                if time.monotonic() > end: raise AssertionError(label + ': ' + mux('capture-pane', '-p', '-t', 'viewer-ui'))
                time.sleep(.05)
        def command(text):
            mux('send-keys', '-t', 'viewer-ui', 'C-b', ':')
            mux('send-keys', '-t', 'viewer-ui', '-l', text)
            mux('send-keys', '-t', 'viewer-ui', 'Enter')
        try:
            for mode in ('local', 'ssh', 'failed-opener'):
                extra = ['SSH_CONNECTION=fixture'] if mode == 'ssh' else ['HN_VIEWER_OPENER_EXIT=1'] if mode == 'failed-opener' else []
                launch = ['env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'HN_SOCKET', *extra,
                          str(binary), '-L', prefix, '--port', str(port), 'attach-session', '-t', 'viewer-test']
                mux('new-session', '-d', '-s', 'viewer-ui', '-x', '140', '-y', '35', shlex.join(launch))
                until('interactive viewer pane attached', lambda: 'Mock Blender' in mux('capture-pane', '-p', '-t', 'viewer-ui'))
                if mode == 'local':
                    before = len(opened())
                    command('view')
                    until('local command opens browser', lambda: len(opened()) > before)
                    command('view -c')
                    until('clipboard confirmation', lambda: 'terminal clipboard' in mux('capture-pane', '-p', '-t', 'viewer-ui'))
                    command('view -p')
                    until('print-only viewer modal', lambda: local in mux('capture-pane', '-p', '-t', 'viewer-ui'))
                else:
                    before = len(opened())
                    command('view')
                    until('viewer fallback link', lambda: 'Open this link in your browser' in mux('capture-pane', '-p', '-t', 'viewer-ui'))
                    if mode == 'ssh': assert len(opened()) == before
                # Detach normally so hn saves its session and coverage counters before tmux exits.
                mux('send-keys', '-t', 'viewer-ui', 'Escape')
                mux('send-keys', '-t', 'viewer-ui', 'C-b', 'd')
                until('interactive client detached', lambda: not mux('capture-pane', '-p', '-t', 'viewer-ui', ok=False))
                mux('kill-session', '-t', 'viewer-ui', ok=False)
            print('PASS: real TUI command prompt opens, prints, copies and falls back correctly locally and over SSH')
        finally:
            mux('kill-server', ok=False)

    finally:
        try:
            hn('kill-server', ok=False)
            # kill-server acknowledges before the headless client finishes saving. Deleting
            # HOME then races its final writes (rmtree: directory not empty on Linux).
            def clients():
                rows = subprocess.check_output(['ps', '-ax', '-o', 'pid=,command='], text=True).splitlines()
                return [int(pid) for row in rows if len(parts := row.strip().split(None, 1)) == 2
                        for pid, command in [parts] if any(command.startswith(str(path) + ' ') for path in (binary, binary.resolve()))
                        and f'-L {prefix} ' in command]
            deadline = time.monotonic() + 5
            while clients() and time.monotonic() < deadline:
                time.sleep(.05)
            for pid in clients():
                try: os.kill(pid, signal.SIGTERM)
                except ProcessLookupError: pass
            deadline = time.monotonic() + 5
            while clients() and time.monotonic() < deadline:
                time.sleep(.05)
            assert not clients(), 'viewer test clients did not exit'
        finally:
            mock.terminate()
            try: mock.wait(timeout=5)
            except subprocess.TimeoutExpired: mock.kill(); mock.wait(timeout=5)
