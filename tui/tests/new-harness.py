#!/usr/bin/env python3
"""New Harness's real terminal UI, desktop choices, launch payloads and recovery.

Only a private fixture backend, temporary HOME and explicitly named hn/tmux sockets.
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
PORT = int(os.environ.get('HN_NEW_UI_PORT', '19786'))
assert 19783 <= PORT <= 19789, 'refusing non-test popup port'
PREFIX = f'hn-new-ui-{os.getpid()}'
BASE = Path(tempfile.mkdtemp(prefix='hnnu-', dir='/tmp')).resolve()
HN = BASE / 'hn'
shutil.copy2(os.environ.get('HN_NEW_UI_BINARY', ROOT / 'target/release/harness-tui'), HN)
TMUX = shutil.which('tmux')
assert TMUX
ENV = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TZ', 'NODE_PATH', 'LLVM_PROFILE_FILE') if k in os.environ}
ENV.update(HOME=str(BASE), HN_TMPDIR=str(BASE), HN_SOCKET_NAME=PREFIX, PORT=str(PORT),
           RUST_BACKTRACE='1',
           TERM='xterm-256color', COLORTERM='truecolor', SHELL='/bin/sh', HARNESS_TUI_DESK='sync',
           HARNESS_TUI_NOTIFY='off', HN_DESKTOP='off', MOCK_DEMO='1', MOCK_RECONNECT='1', MOCK_NEW_UI='1',
           MOCK_PROJECT_SEARCH='1')
OUTPUT = Path(os.environ['HN_NEW_UI_OUTPUT']) if os.environ.get('HN_NEW_UI_OUTPUT') else None
if OUTPUT: OUTPUT.mkdir(parents=True, exist_ok=True)

def hn(*args, ok=True):
    p = subprocess.run([str(HN), '-L', PREFIX, '--port', str(PORT), '-f', '/dev/null', *args],
                       env=ENV, cwd=BASE, text=True, capture_output=True, timeout=12)
    if ok: assert p.returncode == 0, (args, p.stdout, p.stderr)
    return p.stdout.strip()

def tmux(*args, ok=True):
    p = subprocess.run([TMUX, '-L', PREFIX + '-outer', *args], env=ENV, cwd=BASE,
                       text=True, capture_output=True, timeout=10)
    if ok: assert p.returncode == 0, (args, p.stderr)
    return p.stdout

def state(route='dial'):
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/test/{route}', timeout=2) as r:
        result = json.load(r)
        return result.get('data', result)

def screen(): return tmux('capture-pane', '-p', '-t', 'test')
def form_bounds(lines):
    width, height = max(map(len, lines), default=0), len(lines) - 1
    form_w, form_h = min(60, max(0, width - 4)), min(19, max(5, height - 2))
    return (width - form_w) // 2, max(0, (height - form_h) // 2), form_w, form_h
def form_screen():
    lines = screen().splitlines()
    left, top, width, height = form_bounds(lines)
    return '\n'.join(line[left:left+width] for line in lines[top:top+height])
def settle_ui():
    # Wait for chooser content to redraw, not just tmux send-keys returning,
    # before taking mouse coordinates.
    # The panels are borderless; crop around the centered form and right-hand chooser
    # so animated working panes around them cannot keep the fixture unsettled.
    previous, changed = None, time.monotonic()
    deadline = changed + 3
    while time.monotonic() < deadline:
        lines = screen().splitlines()
        # Once the form/chooser closes, live panes are allowed to keep changing.
        if not any('›' in line for line in lines):
            return
        width = max(map(len, lines), default=0)
        height = len(lines) - 1  # hn's bottom status line
        left, top, form_w, form_h = form_bounds(lines)
        side = width - (left + form_w) - 4 >= 32
        signature = tuple(line[left:left+form_w] for line in lines[top:top+form_h])
        child_left = left + form_w + 2
        header = lines[top+2][child_left+2:].lstrip() if top + 2 < len(lines) else ''
        if side and (header.startswith('›') or header.startswith('Task (optional)')):
            child_right = child_left + min(60, width - left - form_w - 4)
            bottom = min(height - 1, top + 22)
            signature += tuple(line[child_left:child_right] for line in lines[top:bottom])
        if signature != previous:
            previous, changed = signature, time.monotonic()
        elif time.monotonic() - changed >= .15:
            return
        time.sleep(.025)
    raise AssertionError('popup did not settle\n' + screen())
def keys(*args):
    # Crossterm coalesces adjacent ESC bytes into one event; exercise separate back presses.
    if len(args) > 1 and 'Escape' in args:
        for key in args: keys(key)
        return
    tmux('send-keys', '-t', 'test', *args)
    settle_ui()
def type_text(text): tmux('send-keys', '-l', '-t', 'test', text)
def wait(fn, label, seconds=8):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if fn(): return
        time.sleep(.05)
    raise AssertionError(label + '\n' + screen())
def shows(text): wait(lambda: text in screen(), text)
def snapshot(name):
    time.sleep(.1)
    if OUTPUT:
        (OUTPUT / (name + '.ansi')).write_text(tmux('capture-pane', '-p', '-e', '-t', 'test'))
        (OUTPUT / (name + '.txt')).write_text(screen())
def create_count(): return len(state().get('created', []))
def click(x, y):
    for suffix in ['M', 'm']:
        raw = f'\x1b[<0;{x+1};{y+1}{suffix}'.encode()
        tmux('send-keys', '-H', '-t', 'test', *[f'{b:02x}' for b in raw])
    settle_ui()
def field_at(label):
    # A field's label: after a space, the pointer or an edge (the form is a borderless panel).
    return r'(?<![^\s│›])(' + label + r')(?= {2,}|$)'
def field_position(label):
    lines = screen().splitlines()
    left, top, width, height = form_bounds(lines)
    for y, line in enumerate(lines[top:top+height], top):
        # Labels begin at the field column; "Harness" in the dialog title is not a field.
        # Like field_at, accept alternatives such as Agent|Harness.
        m = re.match(r'^[ ›]{3}(' + label + r')(?= {2,}|$)', line[left:left+width])
        if m: return left + m.start(1), y
def field(label):
    wait(lambda: field_position(label), f'field {label}')
    click(*field_position(label))
def choose_field(label, query):
    field(label); type_text(query); keys('Enter')
    wait(lambda: re.search(r'› Start ', form_screen()), 'choice accepted; launch action focused')
def form_visible(): return re.search(field_at('Task'), form_screen()) is not None
def new_form():
    keys('C-b', 'N'); wait(form_visible, 'New Harness form')
def placement():
    window, windows, panes = hn('display-message', '-p', '#{window_id} #{session_windows} #{window_panes}').split()
    return window, int(windows), int(panes)
def placed_in_current_window(before):
    window, windows, panes = before
    assert placement() == (window, windows, panes + 1), 'New Harness must add a pane in the current window'
    # Keep room for the next launch as this suite creates several harnesses in one window.
    hn('select-layout', 'tiled')
def end_new_terminal(previous_agents, previous_placement):
    created = {a['id'] for a in state()['agents']} - previous_agents
    assert len(created) == 1, created
    agent = created.pop()
    wait(lambda: any(s['agent'] == agent for c in state('reconnect')['connections'] for s in c['streams']), 'new terminal stream is open')
    request = urllib.request.Request(f'http://127.0.0.1:{PORT}/test/reconnect',
        data=json.dumps({'action': 'close', 'agent': agent, 'reason': 'process exited'}).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=2) as response:
        assert json.load(response)['data']['ok']
    wait(lambda: placement() == previous_placement, 'exited terminal removes its pane')
    assert 'The terminal closed' not in screen(), 'an ordinary shell must not leave an agent error card'
def submit(count):
    # Git discovery is asynchronous. Wait for its answer before accepting the visible draft.
    time.sleep(.15)
    before = placement()
    keys('Enter')
    wait(lambda: create_count() == count and not form_visible(), 'created harness')
    placed_in_current_window(before)

def raw(data):
    tmux('send-keys', '-H', '-t', 'test', *[f'{b:02x}' for b in data.encode()])

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
    command = shlex.join(['env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'HN_SOCKET',
                          *[f'{k}={v}' for k, v in ENV.items()], str(HN), '-L', PREFIX,
                          '--port', str(PORT), '-f', '/dev/null'])
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-x', '150', '-y', '42', command)
    tmux('set-window-option', '-t', 'test', 'remain-on-exit', 'on')
    started = True
    shows('Fix flaky login test')
    first_window = hn('display-message', '-p', '#{window_id}')
    keys('C-b', 'n')
    wait(lambda: hn('display-message', '-p', '#{window_id}') != first_window, 'lowercase n remains next-window')
    keys('C-b', 'p'); new_form()
    anchor = field_position('Task')
    snapshot('new-harness-form')
    before = create_count()
    input_before = len(state('reconnect')['inputs'])
    keys('Right'); assert create_count() == before, 'Right on New Harness must not launch'
    field('Project'); type_text('office ml-lab'); keys('Enter'); shows('ml-lab @ office')
    field('Project'); type_text('m2 webapp'); keys('Enter'); shows('webapp @ local')
    assert create_count() == before, 'searching projects across machines only changes the draft'
    print('PASS New Harness: short local machine name and remote folders after a large local history', flush=True)
    # Moving over a field previews its choices beside the stationary form.
    keys('Down', 'Tab'); shows('Search agents and harnesses')
    assert field_position('Task') == anchor, 'a preview must not move or hide the form'
    assert any(line.find('Search agents and harnesses') > anchor[0] + 50 for line in screen().splitlines())
    keys('Right'); shows('Search agents and harnesses')
    assert field_position('Task') == anchor, 'entering a chooser keeps the form visible'
    assert 'Blender' in screen(), 'the agent chooser lists the harnesses'
    snapshot('new-harness-agent')
    type_text('codex'); keys('Escape')
    shows('Approvals'); keys('Right'); shows('Search agents and harnesses')
    keys('Escape'); type_text('codex'); keys('Enter'); shows('Start Codex')
    field('Project'); shows('Search projects'); snapshot('new-harness-project')
    type_text('clone'); keys('Enter'); shows('Choose a machine'); keys('Enter'); shows('GitHub URL')
    raw('\x1b[200~autonomous-ai/openharness\x1b[201~'); keys('Enter')
    shows('Clone: autonomous-ai/')
    assert create_count() == before, 'choosing fields must not launch'
    field('Project'); type_text('new folder'); keys('Enter'); shows('Choose a machine'); keys('Enter'); shows('Folder name')
    type_text('fail-once'); keys('Enter'); shows('New Folder: fail-once')
    shows('Approvals'); shows('Model'); shows('Profile')
    assert not re.search(field_at('Options|Machine'), form_screen()), 'settings are direct fields; machine belongs in Project'
    choose_field('Approvals', 'read only'); shows('Read only')
    task_text = 'Fix café login.\n\nKeep 界 and 🦀 intact.\nAdd a regression test.'
    field('Task'); shows('Enter start')
    assert field_position('Task') == anchor, 'the task editor keeps the form visible and fixed'
    raw('\x1b[200~Fix café login.\r\n\r\nKeep 界 and 🦀 intact.\x1b[201~')
    shows('Keep 界 and 🦀 intact.')
    keys('M-Enter'); type_text('Add a regression test.'); keys('BTab')
    assert create_count() == before, 'leaving the task editor does not launch'
    snapshot('new-harness-settings')
    keys('Enter', 'Enter'); shows('Fixture launch failure')
    assert create_count() == before + 1, 'busy popup prevents double submission'
    shows('fail-once'); shows('Read only')
    request = state()['created'][-1]
    assert request['engine'] == 'codex', request
    assert request['projectSource'] == 'new' and request['projectName'] == 'fail-once', request
    assert request['permissionMode'] == 'readOnly' and request['bypassPermission'] is False, request
    assert request['prompt'] == task_text, request
    snapshot('new-harness-retry')
    keys('Escape'); new_form(); shows('Fixture launch failure')
    submit(before + 2)
    retry = state()['created'][-1]
    assert retry['creationId'] != request['creationId'], 'confirmed refusal requires a fresh receipt'
    assert retry['cwd'] == '/home/demo/fail-once', 'reuse the already prepared folder'
    assert not any(k in retry for k in ('projectSource', 'projectName', 'gitSource', 'branchRef')), retry
    assert retry['prompt'] == task_text, 'retry retains the complete task'
    assert len(state('reconnect')['inputs']) == input_before, 'form input must never reach a working pane'
    print('PASS New Harness: desktop fields, keyboard, search, paste, retry and no duplicate/input leak', flush=True)

    new_form(); field('Project'); type_text('open folder'); keys('Enter'); shows('Choose a machine'); keys('Enter'); shows('Use this folder')
    type_text('projects'); keys('Enter'); shows('Use this folder'); keys('Enter'); shows('projects @ local')
    shows('[x]'); choose_field('Branch', 'feature')
    submit(before + 3)
    request = state()['created'][-1]
    assert request['projectSource'] == 'worktree' and request['gitSource'].endswith('/projects'), request
    assert request['branchRef'] == 'refs/heads/feature' and request['branchMode'] == 'existing', request
    print('PASS New Harness: browse folders, Git discovery and desktop worktree branch selection', flush=True)

    new_form(); choose_field('Profile', 'Work'); shows('Work')
    submit(before + 4)
    assert state()['created'][-1]['codexHome'] == '/home/demo/.codex-work'
    new_form(); choose_field('Model', 'demo-model'); shows('demo-model')
    submit(before + 5)
    request = state()['created'][-1]
    assert request['gridModel'] == 'demo-model' and request['gridName'] == 'studio', request
    assert 'codexHome' not in request, request
    print('PASS New Harness: machine-scoped profiles and explicit model routes', flush=True)

    # Blender asks for its coding agent next in the same side chooser.
    new_form(); field('Agent|Harness'); type_text('Blender'); keys('Enter'); shows('Choose a coding agent'); type_text('codex'); keys('Enter'); shows('Blender · Codex')
    submit(before + 6)
    assert state()['created'][-1]['dsh'] == 'example/blender'
    new_form()
    before_terminal = placement()
    previous_agents = {a['id'] for a in state()['agents']}
    field('Harness'); type_text('Terminal'); shows('No matches')
    keys('Escape', 'Escape', 'C-b', 'T')
    wait(lambda: create_count() == before + 7 and not form_visible(), 'Terminal shortcut opens a shell immediately')
    snapshot('new-harness-terminal')
    placed_in_current_window(before_terminal)
    request = state()['created'][-1]
    assert request['engine'] == 'terminal' and request.get('permissionMode') is None, request
    assert not any(k in request for k in ('dsh', 'prompt', 'gridModel', 'gitSource', 'codexHome')), request
    end_new_terminal(previous_agents, before_terminal)
    print('PASS New Harness: specialized harness compatibility, agents exclude Terminal, separate shell shortcut', flush=True)

    # The keyboard shortcut owns the same shell lifecycle on repeated use.
    # Its normal exit closes its view, rather than showing an agent error card.
    previous_agents = {a['id'] for a in state()['agents']}
    count = create_count()
    keys('C-b', 'T')
    wait(lambda: create_count() == count + 1 and not form_visible(), 'Ctrl+B T opens a terminal directly')
    placed_in_current_window(before_terminal)
    request = state()['created'][-1]
    assert request['engine'] == 'terminal' and 'prompt' not in request and 'dsh' not in request, request
    end_new_terminal(previous_agents, before_terminal)
    print('PASS New terminal: Ctrl+B T closes its view on normal shell exit', flush=True)

    new_form(); field('Agent|Harness'); type_text('claude'); keys('Enter'); choose_field('Approvals', 'plan'); shows('Plan first')
    keys('Escape'); new_form(); shows('Plan first')
    count = create_count()
    for w, h in [(80, 24), (45, 14), (22, 5), (1, 1), (150, 42)] * 3:
        tmux('resize-window', '-t', 'test', '-x', str(w), '-y', str(h)); time.sleep(.4)
        assert tmux('display-message', '-p', '-t', 'test', '#{pane_dead}').strip() == '0', f'hn client exited after resize to {w}x{h}\n' + tmux('capture-pane', '-p', '-S', '-100', '-t', 'test')
        assert hn('display-message', '-p', '#{window_panes}').isdigit(), 'hn survives tiny resizes'
    field('Project'); shows('Search projects')
    tmux('resize-window', '-t', 'test', '-x', '80', '-y', '24')
    shows('Search projects')
    snapshot('new-harness-narrow')
    keys('Escape', 'Escape'); assert create_count() == count
    tmux('resize-window', '-t', 'test', '-x', '150', '-y', '42'); new_form()

    # A review capture with the requested project label, through the real folder chooser.
    choose_field('Approvals', 'auto-approve')
    field('Project'); type_text('open folder'); keys('Enter'); shows('Choose a machine'); keys('Enter'); shows('Use this folder')
    keys('C-l', 'C-a', 'C-k'); type_text('/home/dev/autonomous-harness'); keys('Enter')
    shows('Use this folder'); keys('Enter')
    shows('autonomous-harness @ local'); shows('[x]')
    tmux('resize-window', '-t', 'test', '-x', '150', '-y', '42'); settle_ui()
    snapshot('new-harness-flat')
    field('Task'); shows('Enter start')
    raw('\x1b[200~Improve the New Harness keyboard flow.\nKeep the launch settings visible.\x1b[201~')
    shows('Keep the launch settings visible.'); snapshot('new-harness-task')
    keys('Escape'); new_form(); shows('Improve the New Harness keyboard flow.')
    snapshot('new-harness-flat-task')
    tmux('resize-window', '-t', 'test', '-x', '80', '-y', '24'); settle_ui()
    snapshot('new-harness-flat-narrow')
    # A terminal starts immediately and leaves the agent draft intact. Never run
    # the retained natural-language task as a shell command.
    keys('Escape', 'C-b', 'T')
    wait(lambda: create_count() == count + 1 and not form_visible(), 'terminal launch with retained agent draft')
    request = state()['created'][-1]
    assert request['engine'] == 'terminal' and 'prompt' not in request and 'command' not in request, request
    count += 1
    new_form(); shows('Improve the New Harness keyboard flow.')
    choose_field('Agent|Harness', 'cursor')
    field('Task'); keys('Enter'); shows('This agent cannot start with a task')
    assert create_count() == count, 'unsupported first tasks never reach the daemon'
    keys('Down')
    assert re.search(r'›\s+Agent\s+Cursor', form_screen()), 'Down leaves the rejected task for Agent even in a narrow terminal'
    keys('Right'); shows('Search agents and harnesses'); type_text('claude'); keys('Enter')
    shows('Start Claude Code')
    shows('Improve the New Harness keyboard flow.')
    assert 'This agent cannot start with a task' not in screen(), 'keyboard-only agent correction clears the live error'
    field('Task'); keys('C-Home', 'C-k', 'C-k', 'C-k', 'C-k', 'Tab'); choose_field('Agent|Harness', 'claude')
    field('Task'); type_text('x' * 2001); keys('Enter'); field('Start Claude Code'); shows('Task is too long')
    assert create_count() == count, 'an overlong task is rejected before creating a harness'
    field('Task'); keys('C-Home', 'C-k', 'BTab')
    tmux('resize-window', '-t', 'test', '-x', '150', '-y', '42'); settle_ui()
    # Supply actual terminal palette replies, as a light terminal would.
    raw('\x1b]10;rgb:2020/2020/2020\x1b\\\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
    snapshot('new-harness-light'); keys('Escape')
    print('PASS New Harness: draft restoration, narrow/light rendering and cancellation', flush=True)

    new_form(); field('Project'); type_text('new folder'); keys('Enter'); shows('Choose a machine'); keys('Enter'); shows('Folder name')
    type_text('lose-reply'); keys('Enter'); shows('New Folder: lose-reply')
    count = create_count()
    before_recovery = placement()
    keys('Enter'); shows('Check status'); shows('Launch not confirmed')
    assert create_count() == count + 1
    request = state()['created'][-1]
    # Changes cannot turn a lost reply into another launch, even across dismissal.
    keys('Down', 'a'); assert 'Search agents' not in screen()
    keys('Escape'); new_form(); shows('Check status')
    wait(lambda: any(c['machine'] == request.get('machineId', 'mock0000000000000000000000000001') for c in state('reconnect')['connections']), 'machine reconnected')
    time.sleep(.5)
    keys('Enter'); shows('Still starting your harness')
    assert create_count() == count + 1
    keys('Enter'); wait(lambda: not form_visible(), 'original harness recovered')
    placed_in_current_window(before_recovery)
    assert create_count() == count + 1, 'status recovery must never send a second create'
    checks = state()['creationChecks'][-2:]
    assert len(checks) == 2 and all(c['creationId'] == request['creationId'] for c in checks)

    new_form(); field('Project'); type_text('new folder'); keys('Enter'); shows('Choose a machine'); keys('Enter'); shows('Folder name')
    type_text('unknown-launch'); keys('Enter'); keys('Enter'); shows('Launch outcome unknown')
    count = create_count()
    keys('Enter'); shows('Launch outcome unknown')
    keys('Escape'); new_form(); shows('Check status')
    assert create_count() == count
    keys('Escape')
    print('PASS New Harness: lost reply, reconnect, pending status and uncertain launch never duplicate', flush=True)

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
        assert not clients(), 'New Harness test client did not exit'
    finally:
        if mock:
            mock.terminate()
            try: mock.wait(timeout=5)
            except subprocess.TimeoutExpired: mock.kill(); mock.wait()
        shutil.rmtree(BASE, ignore_errors=True)
