#!/usr/bin/env python3
"""Real hn in a private tmux PTY, with controlled stream/connection failures.

HN_RECONNECT_TEST_BINARY overrides the build. Ports are restricted to 19780..19789.
--repro-heartbeat and --repro-open isolate the two original regressions.
"""
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get('HN_RECONNECT_TEST_PORT', '19781'))
PREFIX = f'hn-reconnect-{os.getpid()}'
if not 19780 <= PORT <= 19789:
    raise SystemExit('refusing non-test reconnect port')
TMUX = shutil.which('tmux')
if not TMUX:
    raise SystemExit('tmux is required')
LOCAL = 'mock0000000000000000000000000001'
REMOTE = 'mock0000000000000000000000000002'
BASE = Path(tempfile.mkdtemp(prefix='hnrc-', dir='/tmp')).resolve()
HN = BASE / 'hn'
shutil.copy2(os.environ.get('HN_RECONNECT_TEST_BINARY', ROOT / 'target/release/harness-tui'), HN)
ENV = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TZ') if k in os.environ}
ENV.update(HOME=str(BASE), HN_TMPDIR=str(BASE), HN_SOCKET_NAME=PREFIX, PORT=str(PORT),
           TERM='xterm-256color', SHELL='/bin/sh', HARNESS_TUI_DESK='off',
           HARNESS_TUI_NOTIFY='off', HN_DESKTOP='off', MOCK_RECONNECT='1')
CONF = BASE / 'tmux.conf'
CONF.write_text('set -g @hn-new-window shell\nset -g automatic-rename off\nset -g pane-border-status off\n')


def hn(*args, ok=True):
    assert 19780 <= PORT <= 19789 and PREFIX.startswith('hn-reconnect-')
    p = subprocess.run([str(HN), '-L', PREFIX, '--port', str(PORT), '-f', str(CONF), *args],
                       env=ENV, cwd=BASE, text=True, capture_output=True, timeout=12)
    if ok and p.returncode:
        raise AssertionError((args, p.returncode, p.stdout, p.stderr))
    return p.stdout.strip()


def tmux(*args, ok=True):
    p = subprocess.run([TMUX, '-L', PREFIX + '-outer', *args], env=ENV, cwd=BASE,
                       text=True, capture_output=True, timeout=10)
    if ok and p.returncode:
        raise AssertionError((args, p.stderr))
    return p.stdout


def api(path='/test/reconnect', body=None):
    req = urllib.request.Request(f'http://127.0.0.1:{PORT}{path}',
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=2) as response:
        return json.load(response)['data']


def fault(action, **kw):
    return api(body={'action': action, **kw})


def wait(fn, label, seconds=8):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if fn():
            return
        time.sleep(.05)
    raise AssertionError(label + '\n' + tmux('capture-pane', '-p', '-t', 'test'))


def live(machine=None):
    return {s['agent'] for c in api()['connections'] if machine is None or c['machine'] == machine for s in c['streams']}


def screen():
    return tmux('capture-pane', '-p', '-t', 'test')


panes = {}


def pane_for(agent):
    return panes[agent]


def echo(agent, marker):
    pane = pane_for(agent)
    hn('select-window', '-t', pane)
    hn('select-pane', '-t', pane)
    hn('send-keys', '-t', pane, '-l', marker)
    wait(lambda: marker in hn('capture-pane', '-p', '-t', pane), 'input should echo after recovery')


mock = None
try:
    # Binding first catches another test using our port, before any request is made.
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', PORT))
    mock = subprocess.Popen(['node', str(ROOT / 'tests/mock-daemon.mjs'), str(PORT)], env=ENV,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(100):
        if mock.poll() is not None:
            raise AssertionError(mock.stderr.read().decode())
        try:
            api('/api/status')
            break
        except OSError:
            time.sleep(.05)
    else:
        raise AssertionError('mock startup timeout')
    command = shlex.join(['env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'HN_SOCKET',
                          *[f'{k}={v}' for k, v in ENV.items()], str(HN), '-L', PREFIX,
                          '--port', str(PORT), '-f', str(CONF)])
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-x', '120', '-y', '36', command)
    wait(lambda: 'Mock terminal (mock)' in screen(), 'initial shell')
    agents = {a['name']: a['id'] for a in api('/test/dial')['agents']}
    shell, claude, codex, remote = (agents[n] for n in ('Mock terminal', 'Mock Claude', 'Mock Codex', 'Remote shell'))

    panes[shell] = hn('display-message', '-p', '#{pane_id}')
    if '--repro-open' not in sys.argv:
        hn('open-harness', '-s', 'Mock Claude')
        panes[claude] = hn('display-message', '-p', '#{pane_id}')
        hn('open-harness', '-h', '-s', 'Mock Codex')
        panes[codex] = hn('display-message', '-p', '#{pane_id}')
        hn('open-harness', '-d', '-s', 'Remote shell')
        panes[remote] = next(p for p in hn('list-panes', '-a', '-F', '#{pane_id}').splitlines() if p not in panes.values())
        wait(lambda: {shell, claude, codex, remote} <= live(), 'all foreground/background panes live')
        before = api()
        fault('close', machine=LOCAL, reason='heartbeat timeout')
        wait(lambda: {shell, claude, codex} <= live(LOCAL), 'heartbeat expiry should reopen every pane, including inactive shell')
        after = api()
        assert [c['id'] for c in before['connections'] if c['machine'] == REMOTE] == [c['id'] for c in after['connections'] if c['machine'] == REMOTE], 'unrelated machine was redialled'
        assert len([c for c in after['connections'] if c['machine'] == LOCAL]) == 1, 'old connection leaked'
        retries = after['opens'][len(before['opens']):]
        assert retries and all(o['takeover'] is False for o in retries), retries
        echo(claude, 'RECOVERED_HEARTBEAT')
        assert set(panes.values()) == set(hn('list-panes', '-a', '-F', '#{pane_id}').splitlines()), 'recovery lost a pane'
        print('PASS: heartbeat expiry, all panes, inactive shell, machine isolation, no takeover, input echo', flush=True)
        if '--repro-heartbeat' in sys.argv:
            sys.exit(0)

        # A connection reset uses the same recovery; a stale stream event must not win later.
        fault('disconnect', machine=LOCAL)
        wait(lambda: {shell, claude, codex} <= live(LOCAL), 'socket close should recover')
        echo(codex, 'RECOVERED_SOCKET')
        print('PASS: dropped socket recovery', flush=True)

        # One deliberate claim reclaims every tab, including the hidden remote pane.
        def watched(agent):
            return hn('display-message', '-p', '-t', pane_for(agent), '#{pane_watched}') == '1'

        def displace_all():
            start = len(api()['opens'])
            for agent in panes:
                fault('watch', agent=agent)
                fault('close', agent=agent, takenBy='another app')
            wait(lambda: all(watched(a) for a in panes), 'every pane is watching')
            assert all(o['takeover'] is False for o in api()['opens'][start:]), 'ownership notifications reclaimed control'

        displace_all()
        focus = hn('display-message', '-p', '#{window_id}:#{pane_id}')
        layouts = hn('list-windows', '-F', '#{window_id}:#{window_layout}')
        before = api()
        hn('take-control')
        wait(lambda: len(api()['opens']) == len(before['opens']) + len(panes) and all(not watched(a) for a in panes), 'one command reclaims all local and remote tabs')
        claims = api()['opens'][len(before['opens']):]
        assert len(claims) == len(panes) and all(o['takeover'] is True for o in claims), claims
        assert {o['agent'] for o in claims} == set(panes)
        assert hn('display-message', '-p', '#{window_id}:#{pane_id}') == focus
        assert hn('list-windows', '-F', '#{window_id}:#{window_layout}') == layouts
        assert api()['inputs'] == before['inputs'], 'take-control typed into a terminal'
        hn('take')
        assert len(api()['opens']) == len(before['opens']) + len(panes), 'repeat claim reopened controlled panes'
        displace_all()
        before = api()
        hn('send-keys', '-t', pane_for(claude), '-l', 'CLAIMED_ALL_TABS')
        wait(lambda: all(not watched(a) for a in panes), 'typing in a watcher reclaims every tab')
        wait(lambda: 'CLAIMED_ALL_TABS' in hn('capture-pane', '-p', '-t', pane_for(claude)), 'claim preserves typed input')
        assert {i['agent'] for i in api()['inputs'][len(before['inputs']):]} == {claude}, 'typed input leaked to another pane'
        print('PASS: app-wide control, hidden local/remote tabs, stable focus, idempotence and isolated input', flush=True)

        # Genuine terminal/process closure remains a card; it must not restart the program.
        before_count = len(api()['opens'])
        fault('close', machine=LOCAL, agent=claude, reason='process exited')
        hn('select-window', '-t', pane_for(claude))
        wait(lambda: 'The terminal closed' in screen(), 'real exit should remain closed')
        time.sleep(1.5)
        assert len(api()['opens']) == before_count, 'real exit retried automatically'
        assert claude not in live()
        print('PASS: genuine process exit stays closed', flush=True)

        # Reconnect a watch-only pane and ensure it never asks for control.
        fault('watch', agent=codex)
        before_count = len(api()['opens'])
        fault('close', machine=LOCAL, agent=codex, reason='heartbeat timeout')
        wait(lambda: {shell, codex} <= live(LOCAL), 'watch-only recovery')
        assert claude not in live(), 'reconnect reopened a genuinely closed pane'
        assert all(o['takeover'] is False for o in api()['opens'][before_count:])
        assert hn('display-message', '-p', '-t', pane_for(codex), '#{pane_dead}') == '0'
        print('PASS: recovery preserves ended panes and watch-only ownership', flush=True)

    # Hold terminal_open while the WebSocket continues answering pings. A fresh connection
    # is required; reopening against the old route would just hit the same 45-second stall.
    fault('hang', machine=REMOTE)
    if '--repro-open' not in sys.argv:
        hn('kill-pane', '-t', pane_for(remote))
    before = api()
    hn('open-harness', '-s', 'Remote shell')
    panes[remote] = hn('display-message', '-p', '#{pane_id}')
    wait(lambda: any(o['hung'] for o in api()['opens'][len(before['opens']):]), 'stalled open requested')
    started = time.monotonic()
    wait(lambda: remote in live(REMOTE), 'timed-out open should redial and recover', seconds=55)
    assert time.monotonic() - started >= 40, 'test did not exercise the real 45-second deadline'
    retries = api()['opens'][len(before['opens']):]
    assert retries[-1]['connection'] != retries[0]['connection']
    assert retries[-1]['takeover'] is False
    assert len([c for c in api()['connections'] if c['machine'] == REMOTE]) == 1
    echo(remote, 'RECOVERED_OPEN_TIMEOUT')
    assert not api()['counts'].get('agent_restart', 0), 'transport recovery restarted a program'
    print('PASS: real 45-second timeout despite live WS pongs, fresh route, no restart, input echo', flush=True)
finally:
    hn('kill-server', ok=False)
    tmux('kill-server', ok=False)
    # Kill only processes using this test's frozen binary and explicit socket prefix.
    for row in subprocess.check_output(['ps', '-ax', '-o', 'pid=,command='], text=True).splitlines():
        match = re.match(r'\s*(\d+)\s+(.*)', row)
        if match and match[2].startswith(str(HN) + ' ') and f'-L {PREFIX} ' in match[2]:
            try:
                os.kill(int(match[1]), 15)
            except ProcessLookupError:
                pass
    def clients():
        rows = subprocess.check_output(['ps', '-ax', '-o', 'pid=,command='], text=True).splitlines()
        return [row for row in rows if len(parts := row.strip().split(None, 1)) == 2
                and parts[1].startswith(str(HN) + ' ') and f'-L {PREFIX} ' in parts[1]]
    try:
        deadline = time.monotonic() + 5
        while clients() and time.monotonic() < deadline:
            time.sleep(.05)
        assert not clients(), 'recovery test clients did not exit'
    finally:
        if mock is not None:
            mock.terminate()
            mock.wait(timeout=5)
    shutil.rmtree(BASE)
