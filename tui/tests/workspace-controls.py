#!/usr/bin/env python3
"""Real PTY journeys for quiet workspace controls, with a disposable protocol peer.

No account, physical device, model server, or agent CLI is used. All mutations target this
fixture's private HOME/socket. HN_WORKSPACE_OUTPUT retains ANSI captures and request traces.
"""
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get('HN_WORKSPACE_PORT', '19920'))
assert 19920 <= PORT <= 19929, 'refusing a non-test workspace port'
PREFIX = f'hn-workspace-{os.getpid()}'
TARGET = 'test'
BASE = Path(tempfile.mkdtemp(prefix='hn-workspace-', dir='/tmp')).resolve()
HN = BASE / 'hn'
shutil.copy2(os.environ.get('HN_WORKSPACE_BINARY', ROOT / 'target/release/harness-tui'), HN)
TMUX = shutil.which('tmux')
assert TMUX, 'tmux is required for the outer PTY'
ENV = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TZ') if k in os.environ}
ENV.update(HOME=str(BASE), HN_TMPDIR=str(BASE), HN_SOCKET_NAME=PREFIX, PORT=str(PORT),
           TERM='xterm-256color', COLORTERM='truecolor', SHELL='/bin/sh', HARNESS_TUI_DESK='sync',
           HARNESS_TUI_NOTIFY='off', HN_DESKTOP='off', SSH_CONNECTION='disposable-fixture',
           HARNESS_CLI=sys.executable, HARNESS_CLI_ARGS=json.dumps([str(BASE / 'cli.py')]))
CONF = BASE / 'tmux.conf'
CONF.write_text('set -g automatic-rename off\n')
OUTPUT = Path(os.environ['HN_WORKSPACE_OUTPUT']) if os.environ.get('HN_WORKSPACE_OUTPUT') else None
if OUTPUT:
    OUTPUT.mkdir(parents=True, exist_ok=True)

# The actual account subprocess adapter is exercised, including EOF cancellation and the
# affirmative response. These NDJSON events are the CLI's public login protocol.
(BASE / 'cli.py').write_text(r'''
import json, os, select, sys, time
from pathlib import Path
home = Path(os.environ['HOME'])
def emit(value): print(json.dumps(value), flush=True)
def record(word):
    with (home / 'login-events').open('a') as out: out.write(word + '\n')
args = sys.argv[1:]
if args[:2] == ['auth', 'status']:
    try: value = json.loads((home / 'account.json').read_text())
    except (FileNotFoundError, ValueError): value = {'loggedIn': False}
    emit(value)
elif args[:2] == ['remote-password', 'status']:
    emit({'hasPassword': (home / 'password-set').exists()})
elif args[:2] in (['remote-password', 'set'], ['remote-password', 'clear']):
    if args[1] == 'set':
        secret = sys.stdin.readline().rstrip('\n')
        if secret != 'fixture pasted password': sys.exit(4)
        (home / 'password-set').touch()
    else: (home / 'password-set').unlink(missing_ok=True)
    with (home / 'machine-actions').open('a') as out: out.write(args[1] + '\n')
    emit({'ok': True})
elif args == ['link', 'list']:
    print('No machines linked yet.')
elif args and args[0] == 'login':
    record('start')
    if '--qr' in args: emit({'type': 'qr', 'url': 'https://example.test/login/fixture', 'expiresIn': 120})
    else: emit({'type': 'authorize_url', 'url': 'https://example.test/login/fixture'})
    until = time.monotonic() + 30
    while not (home / 'approve').exists():
        if select.select([sys.stdin], [], [], .05)[0] and not sys.stdin.readline():
            record('cancel'); sys.exit(1)
        if time.monotonic() > until: sys.exit(2)
    emit({'type': 'confirm', 'email': 'review@example.test'})
    if sys.stdin.readline().strip() != 'yes': record('cancel'); sys.exit(1)
    (home / 'account.json').write_text(json.dumps({'loggedIn': True, 'offline': False}))
    record('commit')
    emit({'type': 'result', 'status': 'success', 'email': 'review@example.test'})
else:
    emit({'error': 'UNEXPECTED_FIXTURE_COMMAND', 'args': args}); sys.exit(3)
''')


def hn(*args, ok=True):
    assert PREFIX.startswith('hn-workspace-') and 19920 <= PORT <= 19929
    p = subprocess.run([str(HN), '-L', PREFIX, '--port', str(PORT), '-f', str(CONF), *args],
                       env=ENV, cwd=BASE, text=True, capture_output=True, timeout=12)
    if ok:
        assert p.returncode == 0, (args, p.stdout, p.stderr)
    return p.stdout.strip()


def tmux(*args, ok=True):
    p = subprocess.run([TMUX, '-L', PREFIX + '-outer', *args], env=ENV, cwd=BASE,
                       text=True, capture_output=True, timeout=10)
    if ok:
        assert p.returncode == 0, (args, p.stderr)
    return p.stdout


def api(update=None):
    request = urllib.request.Request(f'http://127.0.0.1:{PORT}/test',
                                    data=json.dumps(update).encode() if update is not None else None,
                                    headers={'content-type': 'application/json'})
    with urllib.request.urlopen(request, timeout=2) as response:
        return json.load(response)['data']


def screen():
    return tmux('capture-pane', '-p', '-t', TARGET)


last_mouse_target = None
recent_mouse_targets = []


def wait(fn, label, seconds=8):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if fn():
            return
        time.sleep(.05)
    raise AssertionError(label + '\n' + screen() + '\nLast mouse target: ' + str(last_mouse_target)
                         + '\nRecent mouse targets: ' + str(recent_mouse_targets))


def shown(text, seconds=8):
    wait(lambda: text in screen(), 'expected visible: ' + text, seconds)


def keys(*args):
    tmux('send-keys', '-t', TARGET, *args)


def value(fmt, target=None):
    return hn('display-message', '-p', *(['-t', target] if target else []), fmt)


def click(x, y, button=0):
    for ending in ('M', 'm'):
        raw = f'\x1b[<{button};{x + 1};{y + 1}{ending}'.encode()
        tmux('send-keys', '-H', '-t', TARGET, *[f'{b:02x}' for b in raw])


def width(text):
    return sum(0 if unicodedata.combining(c) else 2 if unicodedata.east_asian_width(c) in ('W', 'F') else 1 for c in text)


def click_text(text, occurrence=0, button=0, row=None, before=None):
    def locate():
        global last_mouse_target
        hits = []
        captured = screen()
        for y, line in enumerate(captured.splitlines()):
            if row is not None and y != row:
                continue
            start = 0
            while (index := line.find(text, start)) >= 0:
                x = width(line[:index]) + max(0, width(text) // 2)
                if before is None or x < before:
                    hits.append((x, y))
                start = index + len(text)
        last_mouse_target = {'text': text, 'hits': hits, 'occurrence': occurrence, 'screen': captured}
        return hits
    wait(lambda: len(locate()) > occurrence, 'mouse target ' + text)
    target = locate()[occurrence]
    recent_mouse_targets.append(last_mouse_target)
    del recent_mouse_targets[:-3]
    click(*target, button=button)


def painted_workspace(alpha, beta):
    # A layout/window command is acknowledged before its next frame is drawn.
    # Read mouse coordinates only after both titles occupy their current panes;
    # an old full-width Alpha title can otherwise land on Beta's new controls.
    positions = [(name, tuple(map(int, value('#{pane_left} #{pane_top} #{pane_width}', pane).split())))
                 for pane, name in [(alpha, 'Alpha task'), (beta, 'Beta task')]]
    lines = screen().splitlines()
    return all(0 < y < len(lines) and name in lines[y - 1][x:x + w]
               for name, (x, y, w) in positions)


MENU = '⋮'


def pane_menu_item(item, row):
    """The first pane's menu (⋮) in title row [row], then [item]: the agent and the model change there."""
    click_text(MENU, row=row)
    shown(item)
    click_text(item)


def close_from_menu(row, occurrence=0):
    """A pane's menu (⋮) in title row [row], then its close item (x): Stop Harness or Close. The
    title has no close button."""
    click_text(MENU, occurrence=occurrence, row=row)
    shown('Move to new tab')
    keys('x')


def alpha_agent_picker():
    wait(lambda: any('Change agent' in line and 'Alpha task' in line for line in screen().splitlines()),
         'the visible agent picker belongs to Alpha')


def requests(kind):
    return [r for r in api()['requests'] if r['type'] == kind]


def snapshot(name):
    if OUTPUT:
        (OUTPUT / (name + '.ansi')).write_text(tmux('capture-pane', '-p', '-e', '-t', TARGET))


def login_events():
    path = BASE / 'login-events'
    return path.read_text().splitlines() if path.exists() else []


def machine_prompt_journey():
    def actions():
        path = BASE / 'machine-actions'
        return path.read_text().splitlines() if path.exists() else []

    def paste_password():
        raw = b'\x1b[200~fixture pasted password\x1b[201~'
        tmux('send-keys', '-H', '-t', TARGET, *[f'{b:02x}' for b in raw])
        shown('•' * len('fixture pasted password'))
        assert 'fixture pasted password' not in screen()

    def dialog(title, action):
        # The question is asked in its own box; the panel's search line stays the search.
        shown('┌─' + title)
        shown('[ Cancel ]  [ ' + action + ' ]')
        assert 'Search machines, links and steps' in screen()

    hn('devices')
    shown('Set password…')
    click_text('Set password…')
    shown('New remote password')
    dialog('Set Remote Password', 'Continue')
    paste_password()
    assert '│' + '•' * len('fixture pasted password') in screen(), 'the password is typed into the dialog input'
    # A list click used to become Enter and accept the unfinished password.
    click_text('Refresh links')
    shown('New remote password')
    assert 'Repeat password' not in screen()
    click_text('Continue')
    shown('Repeat password')
    paste_password()
    click_text('Continue')
    shown("Set this computer's remote password?")
    dialog('Set Remote Password', 'Yes')
    assert not actions()
    snapshot('machine-password-confirmation')
    click_text('Cancel')
    shown('Nothing changed')
    assert not actions() and 'fixture pasted password' not in screen()

    click_text('Set password…')
    paste_password()
    click_text('Continue')
    paste_password()
    click_text('Continue')
    click_text('[ Yes ]')
    wait(lambda: actions() == ['set'], 'one explicitly confirmed password write')
    shown('Clear password…')
    click_text('Clear password…')
    shown('Prevent new links')
    for cols, rows in [(80, 24), (40, 12)]:
        tmux('resize-window', '-t', 'test', '-x', str(cols), '-y', str(rows))
        wait(lambda: value('#{client_width}x#{client_height}') == f'{cols}x{rows}', 'client follows terminal resize')
        shown('Prevent new links')
        shown('┌─Clear Remote Password')
        shown('[ Cancel ]')
        shown('[ Yes ]')
        snapshot(f'machine-confirmation-{cols}x{rows}')
    click_text('Cancel')
    assert actions() == ['set']
    keys('Escape')
    tmux('resize-window', '-t', 'test', '-x', '170', '-y', '44')
    shown('Alpha task terminal')
    print('PASS workspace: machine prompts accept mouse confirmation, protect pasted passwords, cancel and resize', flush=True)


def placement_restart_journey(command, alpha):
    # Process creation and workspace publication have independent receipts. A client restart
    # during an outage must keep the acknowledged process in its original pane and retry only
    # its placement when the desk accepts writes again.
    api({'action': 'config', 'patch': {'pruneOnClose': True, 'deskFailures': 99}})
    original_layout = value('#{window_layout}')
    original_window = value('#{window_id}')
    original_panes = hn('list-panes', '-F', '#{pane_id}').splitlines()
    hn('change-agent', '-t', alpha)
    shown('Change agent')
    tmux('send-keys', '-l', '-t', TARGET, 'Claude')
    shown('› Claude')
    click_text('Claude Code', before=85)
    wait(lambda: value('#{pane_current_command}', alpha) == 'claude', 'acknowledged replacement attaches before restart')
    wait(lambda: api()['deskFailures'] < 99, 'workspace publication failed')
    assert len(requests('agent_create')) == 1
    made = requests('agent_create')[0]['payload']['creationId']
    replacement = next(a['id'] for a in api()['agents'][api()['local']] if a['name'] == 'Alpha task' and a['status'] != 'stopped')
    sessions_file = BASE / '.harness' / 'tui' / f'sessions-{PREFIX}.json'
    wait(lambda: sessions_file.exists() and any(r.get('agent') == replacement for r in json.loads(sessions_file.read_text()).get('pending_workspace', [])), 'pending view is saved before client exit')
    snapshot('placement-pending-before-restart')
    tmux('set-window-option', '-t', TARGET, 'remain-on-exit', 'on')
    for crash in (False, True):
        if crash:
            pid = int(value('#{pid}'))
            process = subprocess.check_output(['ps', '-p', str(pid), '-o', 'command='], text=True)
            assert pid > 1 and str(HN) in process, 'refusing to terminate a process outside this disposable fixture'
            os.kill(pid, signal.SIGKILL)
        else:
            hn('hn-hand-over')
        wait(lambda: tmux('display-message', '-p', '-t', TARGET, '#{pane_dead}').strip() == '1', 'client exits for placement restart')
        tmux('respawn-pane', '-k', '-t', TARGET, command)
        shown('Alpha task terminal')
        assert value('#{pane_current_command}', alpha) == 'claude'
        assert hn('list-panes', '-F', '#{pane_id}').splitlines() == original_panes
        assert value('#{window_id}') == original_window
        assert value('#{window_layout}') == original_layout
    hn('workspace-menu')
    shown('Retry workspace sync')
    api({'action': 'config', 'patch': {'deskFailures': 0}})
    click_text('Retry workspace sync')
    wait(lambda: any(any(p['agentId'] == replacement for p in t['panes']) for t in api()['desk']['tabs']), 'restart retries placement after connectivity returns')
    assert [r['payload']['creationId'] for r in requests('agent_create')] == [made]
    assert len([r for r in requests('agent_close') if r['payload']['mode'] != 'inspect']) == 1
    snapshot('placement-recovered-after-restart')
    print('PASS workspace: restart retains a launched replacement until workspace publication succeeds', flush=True)


def mirror_journey(command, source):
    global TARGET
    # Run setup inside the attached client, so the ordinary session belongs to that client.
    for text in ['new-session -d -s mirror-review', 'switch-client -t mirror-review',
                 shlex.join(['open-harness', '-s', source])]:
        keys('C-b', ':')
        tmux('send-keys', '-l', '-t', TARGET, text)
        keys('Enter')
        time.sleep(.15)
    shown(source)
    original_pane = value('#{pane_id}')
    original_geometry = value('#{window_layout}')
    original_size = tmux('display-message', '-p', '-t', TARGET, '#{pane_width} #{pane_height}').split()
    mirror_command = command + ' attach-session -t mirror-review'
    tmux('new-window', '-d', '-t', 'test', '-n', 'mirror', mirror_command)
    TARGET = 'test:mirror'
    # The earlier narrow-screen journey resized only the first outer window. A new
    # tmux window starts at the session's default size; give both hn clients the same
    # viewport before asserting unchanged geometry across the lifecycle operation.
    mirror_size = tmux('display-message', '-p', '-t', TARGET, '#{pane_width} #{pane_height}').split()
    if mirror_size != original_size:
        print(f'Fixture viewport: owner {original_size}, second client {mirror_size}; matching before switch', flush=True)
        tmux('resize-window', '-t', TARGET, '-x', original_size[0], '-y', original_size[1])
    shown(source)
    wait(lambda: value('#{client_width} #{client_height}') == ' '.join(original_size), 'second client reaches the owner viewport size')
    before_launches = len(requests('agent_create'))
    pane_menu_item('Change agent…', row=0)
    shown('Change agent')
    tmux('send-keys', '-l', '-t', TARGET, 'Claude')
    shown('› Claude')
    click_text('Claude Code', before=85)
    # (The title names no agent: the replacement is the daemon's new Claude harness, and the Stop
    # below, from the owner's same pane, reaches it.)
    wait(lambda: any(a['engine'] == 'claude' and a['name'] == source and a['status'] != 'stopped' for a in api()['agents'][api()['local']]),
         'agent replacement reaches session owner')
    assert len(requests('agent_create')) == before_launches + 1
    assert value('#{pane_id}') == original_pane
    assert value('#{window_layout}') == original_geometry, (original_geometry, value('#{window_layout}'))
    snapshot('second-client-agent-switch')
    print('PASS workspace: agent switch from a second client keeps both views and launches once', flush=True)
    # The replacement keeps the source name; only its new live agent receives the Stop request.
    replacement_agent = next(a['id'] for a in api()['agents'][api()['local']] if a['engine'] == 'claude' and a['name'] == source and a['status'] != 'stopped')
    api({'action': 'activity', 'agent': replacement_agent, 'activity': 'working'})
    before_stop = len(requests('agent_close'))
    close_from_menu(row=0)
    shown('Stop? Saved history will remain.')
    click_text('[ Stop ]')
    wait(lambda: original_pane not in hn('list-panes', '-s', '-t', 'mirror-review', '-F', '#{pane_id}').splitlines(), 'confirmed Stop closes the owning session view')
    wait(lambda: source not in tmux('capture-pane', '-p', '-t', 'test:0').splitlines()[0], 'owner no longer shows the stopped harness')
    stop_calls = [r['payload']['mode'] for r in requests('agent_close')[before_stop:] if r['payload']['agentId'] == replacement_agent]
    assert stop_calls == ['inspect', 'now'], stop_calls
    print('PASS workspace: confirmed Stop from a second client closes both views and sends one stop', flush=True)


def overlay_dismiss_journey(alpha):
    for command, title in [('workspace-menu', 'New Harness'), ('account', 'Your Harness account')]:
        hn(command)
        shown(title)
        before = len(api()['inputs'])
        x, y = map(int, value('#{pane_left} #{pane_top}', alpha).split())
        click(x + 4, y + 4)
        wait(lambda: title not in screen(), 'outside click dismisses ' + command)
        time.sleep(.1)
        assert len(api()['inputs']) == before, ('overlay dismissal leaked into the terminal', command, api()['inputs'][before:])
    for label, zoomed in [('Zoom pane', '1'), ('Restore pane size', '0')]:
        hn('pane-menu', '-t', alpha)
        shown(label)
        before = len(api()['inputs'])
        click_text(label)
        wait(lambda: value('#{window_zoomed_flag}') == zoomed, label)
        wait(lambda: 'New Harness beside' not in screen(), 'pane action dismisses its menu')
        time.sleep(.1)
        assert len(api()['inputs']) == before, ('menu action leaked into the terminal', label, api()['inputs'][before:])
    print('PASS workspace: overlay dismissal and pane actions consume the complete mouse click', flush=True)


def title_drag_journey(alpha, beta, look='line'):
    original = value('#{window_layout}')
    border = hn('show', '-gv', '@hn-border', ok=False)
    hn('set', '-g', '@hn-border', look)
    hn('select-layout', 'even-vertical')
    x, top = map(int, value('#{pane_left} #{pane_top}', beta).split())
    # The line look's title is the divider row above the pane; the box look's frame, with the title
    # in it, sits on that same row.
    corner = {'line': '─', 'box': '┌'}[look]
    wait(lambda: 'Beta task' in screen().splitlines()[top - 1] and corner in screen().splitlines()[top - 1],
         f'lower {look} title is painted at its divider')
    before = len(api()['inputs'])
    # The line right of the name (the name itself drags the pane).
    line = screen().splitlines()[top - 1]
    col = next(c for c in range(line.index('Beta task') + len('Beta task') + 1, x + int(value('#{pane_width}', beta)) - 7)
               if line[c] == '─')
    for code, row, ending in [(0, top - 1, 'M'), (32, top + 1, 'M'), (0, top + 1, 'm')]:
        raw = f'\x1b[<{code};{col + 1};{row + 1}{ending}'.encode()
        tmux('send-keys', '-H', '-t', TARGET, *[f'{b:02x}' for b in raw])
    wait(lambda: int(value('#{pane_top}', beta)) == top + 2, f'dragging the {look} title beside its name resizes its divider')
    assert len(api()['inputs']) == before, 'title drag must not reach the terminal program'
    hn('select-layout', original)
    if border:
        hn('set', '-g', '@hn-border', border)
    else:
        hn('set', '-gu', '@hn-border')
    hn('select-pane', '-t', alpha)
    wait(lambda: value('#{window_layout}') == original, 'restore layout after title drag')
    wait(lambda: painted_workspace(alpha, beta), 'restored layout paints both pane titles')
    print(f'PASS workspace: {"plain" if look == "line" else look} title divider drags retain tmux resize behavior', flush=True)


def pane_drag_journey(alpha, beta):
    original = value('#{window_layout}')
    border = hn('show', '-gv', '@hn-border', ok=False)
    hn('set', '-g', '@hn-border', 'box')
    hn('select-pane', '-t', alpha)

    def box(pane):
        return tuple(map(int, value('#{pane_left} #{pane_top} #{pane_width} #{pane_height}', pane).split()))

    def name_cell(pane, name):
        # The name in the pane's header, above its first row (the box frame adds one), once painted there.
        x, y, w, _ = box(pane)
        lines = screen().splitlines()
        for row in range(y - 1, max(y - 4, -1), -1):
            index = lines[row].find(name) if row < len(lines) else -1
            if index >= 0 and x - 1 <= width(lines[row][:index]) <= x + w:
                return width(lines[row][:index]) + 2, row
        return None

    def held(pane, name):
        wait(lambda: name_cell(pane, name), f'{name} title is painted over its pane')
        return name_cell(pane, name)

    def drag(start, end):
        (sx, sy), (ex, ey) = start, end
        for code, x, y, ending in [(0, sx, sy, 'M'), (32, sx + 2, sy + 1, 'M'), (32, ex, ey, 'M'), (0, ex, ey, 'm')]:
            raw = f'\x1b[<{code};{x + 1};{y + 1}{ending}'.encode()
            tmux('send-keys', '-H', '-t', TARGET, *[f'{b:02x}' for b in raw])

    def ids(*target):
        return hn('list-panes', *target, '-F', '#{pane_id}').splitlines()

    before = len(api()['inputs'])
    x, y, w, h = box(beta)
    drag(held(alpha, 'Alpha task'), (x + w // 2, y + h // 2))
    wait(lambda: ids() == [beta, alpha], 'dropping on the middle of Beta swaps the two panes')
    assert value('#{pane_active}', alpha) == '1', 'the held pane keeps the focus after a swap'
    hn('select-pane', '-t', beta)
    x, y, w, h = box(beta)
    drag(held(alpha, 'Alpha task'), (x + w // 2, y + h - 2))
    wait(lambda: box(alpha)[0] == box(beta)[0] and box(alpha)[1] > box(beta)[1],
         "dropping on Beta's bottom quarter puts Alpha below it")
    assert value('#{pane_active}', alpha) == '1', 'the held pane is focused where it lands'
    print('PASS workspace: dropping a pane by its name swaps it or puts it beside another', flush=True)

    # A tab: Beta in a window of its own is dropped on this window's name in the status bar.
    hn('swap-pane', '-s', alpha, '-t', beta)
    hn('select-layout', original)
    number = value('#{window_index}', alpha)
    hn('break-pane', '-d', '-n', 'Dragged', '-s', beta)
    hn('select-window', '-t', 'Dragged')

    def tab():
        # The status bar's " N:name" cell of this window (the clock's "10:17" is not one).
        lines = screen().splitlines()
        for row in range(len(lines) - 1, len(lines) - 3, -1):
            if (index := lines[row].find(f' {number}:')) >= 0:
                return width(lines[row][:index]) + 3, row
        return None
    wait(lambda: value('#{window_name}') == 'Dragged' and tab(), f'the status bar shows tab {number}')
    drag(held(beta, 'Beta task'), tab())
    wait(lambda: beta in ids('-t', f':{number}'), f'dropping on the tab moves Beta into window {number}')
    wait(lambda: 'Dragged' not in hn('list-windows', '-F', '#{window_name}').splitlines(),
         'the window Beta left, with no pane, closes')
    assert value('#{window_index}') == number and value('#{pane_active}', beta) == '1', \
        'the view follows the held pane into its window, focused there'
    assert ids('-t', f':{number}') == [alpha, beta], ids('-t', f':{number}')
    assert len(api()['inputs']) == before, ('a pane drag must not reach the terminal program', api()['inputs'][before:])
    hn('select-layout', original)
    if border:
        hn('set', '-g', '@hn-border', border)
    else:
        hn('set', '-gu', '@hn-border')
    hn('select-pane', '-t', alpha)
    wait(lambda: value('#{window_layout}') == original, 'restore layout after pane drags')
    wait(lambda: painted_workspace(alpha, beta), 'restored layout paints both pane titles')
    print('PASS workspace: dropping a pane on a tab moves it into that window', flush=True)


def side_bar_machines_journey():
    # In the side bar each machine lists its harnesses no window here shows: a click opens one in
    # a window, a right press on the machine offers what can be done on it, and a harness that
    # stops leaves the list.
    bar = hn('show', '-gv', '@hn-status-bar', ok=False)
    hn('set', '-g', '@hn-status-bar', 'left')
    width = 26
    windows = lambda: len(hn('list-windows', '-F', '#{window_id}').splitlines())
    shown('✓ Remote')
    api({'action': 'remote-agent', 'agent': 'delta', 'name': 'Delta remote task'})
    shown('Delta remote task')
    snapshot('side-bar-machines')
    before = windows()
    click_text('Delta remote task', before=width)
    wait(lambda: windows() == before + 1, 'a click opens the harness in a window')
    shown('Delta remote task terminal')
    # (The second: the first is the bar's top line, the machine this window is on.)
    click_text('✓ Remote', occurrence=1, button=2, before=width)
    shown('New Harness on Remote…')
    shown('Open its harnesses')
    snapshot('side-bar-machine-menu')
    keys('Escape')
    wait(lambda: 'New Harness on Remote…' not in screen(), 'Esc closes the machine menu')
    # Its window closed, the harness is a row under its machine again; stopped, it goes.
    hn('kill-window')
    wait(lambda: windows() == before, 'its window closes')
    shown('Delta remote task')
    api({'action': 'remote-agent', 'agent': 'delta', 'stop': True})
    wait(lambda: 'Delta remote task' not in screen(), 'a stopped harness leaves the side bar')
    if bar:
        hn('set', '-g', '@hn-status-bar', bar)
    else:
        hn('set', '-gu', '@hn-status-bar')
    print('PASS workspace: the side bar lists each machine\'s harnesses, opens one with a click, and offers its menu', flush=True)


mock = None
started = False
try:
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', PORT))
    mock = subprocess.Popen(['node', str(ROOT / 'tests/workspace-mock.mjs'), str(PORT)], env=ENV,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(100):
        assert mock.poll() is None, mock.stderr.read().decode() if mock.poll() is not None else ''
        try:
            api()
            break
        except OSError:
            time.sleep(.05)
    else:
        raise AssertionError('mock startup timeout')
    command = shlex.join(['env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'HN_SOCKET',
                         *[f'{k}={v}' for k, v in ENV.items()], str(HN), '-L', PREFIX,
                         '--port', str(PORT), '-f', str(CONF)])
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-x', '170', '-y', '44', command)
    started = True
    shown('Alpha task terminal')
    shown('Beta task terminal')
    shown('Sign in')
    local, remote = api()['local'], api()['remote']
    panes = hn('list-panes', '-F', '#{pane_id}').splitlines()
    assert len(panes) == 2, panes
    alpha, beta = panes
    workspace = value('#{window_id}')
    snapshot('workspace')
    if '--machine-prompts' in sys.argv:
        machine_prompt_journey()
        sys.exit(0)
    if '--placement-restart' in sys.argv:
        placement_restart_journey(command, alpha)
        sys.exit(0)
    if '--mirrors' in sys.argv:
        mirror_journey(command, 'Alpha task')
        sys.exit(0)
    if '--mouse-dismiss' in sys.argv:
        api({'action': 'terminal-mouse'})
        overlay_dismiss_journey(alpha)
        sys.exit(0)
    if '--title-drag' in sys.argv:
        api({'action': 'terminal-mouse'})
        title_drag_journey(alpha, beta)
        title_drag_journey(alpha, beta, 'box')
        sys.exit(0)
    if '--pane-drag' in sys.argv:
        api({'action': 'terminal-mouse'})
        pane_drag_journey(alpha, beta)
        sys.exit(0)
    if '--side-bar' in sys.argv:
        side_bar_machines_journey()
        sys.exit(0)

    machine_prompt_journey()
    side_bar_machines_journey()

    # Local use is complete before any sign-in. The tiny footer entry explains the benefit,
    # then lets the user return without starting an authentication request.
    click_text('Sign in', row=43)
    shown('Connect computers')
    shown('Keep using locally')
    snapshot('optional-sign-in')
    click_text('Keep using locally')
    assert not login_events()
    wait(lambda: 'Continue with Google' not in screen(), 'back to local workspace')

    # The title's agent and model labels act on the captured pane even if external focus changes.
    x, y = map(int, value('#{pane_left} #{pane_top}', alpha).split())
    click_text('Codex', row=y - 1)
    alpha_agent_picker()
    keys('Escape')
    click_text('GPT-6 Astra', row=y - 1)
    shown('Fixture local model')
    hn('select-pane', '-t', beta)
    click_text('Fixture local model', before=85)
    wait(lambda: len(requests('agent_retarget')) == 1, 'one model change')
    assert requests('agent_retarget')[0]['payload']['agentId'] == 'alpha'
    assert not any(r['payload']['agentId'] == 'beta' for r in requests('agent_retarget'))
    keys('Escape')

    # Counts are cached inventory and live owned harnesses, not subscription/API entries.
    hn('workspace-menu')
    shown('Harnesses  3')
    shown('Machines  2')
    shown('Models  1')
    snapshot('workspace-menu')
    click_text('Devices')
    shown('Harness device 1')
    shown('Remote')
    click_text('Harness device 1')
    shown('Brightness')
    shown('40%')
    click_text('Brightness')
    keys('3', '5')
    shown('› 35')
    click_text('35%')
    shown('Waiting for the device')
    wait(lambda: api()['hardware'][local]['devices'][0]['settings']['brightness'] == 35, 'device confirms brightness')
    shown('35%')
    assert api()['hardware'][remote]['devices'][0]['settings']['brightness'] == 70
    assert len(requests('harness_device_settings')) == 1
    snapshot('device-confirmed')
    api({'action': 'config', 'patch': {'deviceConfirm': False}})
    click_text('Sound')
    shown('Waiting for the device')
    shown('did not confirm', 10)
    assert api()['hardware'][local]['devices'][0]['settings']['muted'] is False
    assert len(requests('harness_device_settings')) == 2, 'no automatic replay after a timeout'
    snapshot('device-unconfirmed')
    keys('Escape')
    shown('Search devices and computers')
    keys('Escape')
    wait(lambda: 'Search devices and computers' not in screen(), 'close Devices')
    print('PASS workspace: stable model target, deduplicated counts, device acknowledgement and timeout', flush=True)

    # An outage cache that predates the remote computer cannot remove its live view.
    api({'action': 'machines', 'remote': False, 'stale': True})
    wait(lambda: value('#{local_machine}') == 'Studio cached', 'cached inventory applied')
    assert 'Remote' in hn('list-windows', '-F', '#{window_name}')
    assert remote in api()['peers']
    hn('workspace-menu')
    shown('Machines  2')
    shown('Harnesses  3')
    keys('Escape')

    # A fresh full machine list removes a computer and its views without stopping its sessions.
    # A delayed desk response must not revive the removed computer; a fresh inventory can.
    close_requests = len(requests('agent_close'))
    api({'action': 'machines', 'remote': False})
    wait(lambda: 'Remote' not in hn('list-windows', '-F', '#{window_name}'), 'removed computer leaves the workspace')
    wait(lambda: remote not in api()['peers'], 'removed computer connection closes')
    api({'action': 'desk-refresh'})
    hn('workspace-menu')
    shown('Machines  1')
    shown('Harnesses  2')
    assert 'Remote' not in hn('list-windows', '-F', '#{window_name}')
    assert len(requests('agent_close')) == close_requests
    keys('Escape')
    api({'action': 'machines', 'remote': True})
    wait(lambda: remote in api()['peers'], 'fresh machine inventory reconnects the computer')
    api({'action': 'desk-refresh'})
    wait(lambda: 'Remote' in hn('list-windows', '-F', '#{window_name}'), 'fresh shared desk restores its remote view')
    print('PASS workspace: removed computer drops views and resource counts without stopping its harness', flush=True)

    # A tab menu and its rename prompt retain the original tab across a focus change.
    # (Its tab shows the selected pane's title, the default tab name: found by its number.)
    click_text(value('#{window_index}', workspace) + ':', button=2, row=43)
    shown('Arrange panes')
    click_text('Rename')
    shown('Tab name')
    # hn's own rename is a dialog with an input box, not tmux's status-line prompt.
    shown('┌─Rename Tab ·')
    shown('[ Cancel ]  [ Rename ]')
    snapshot('rename-tab-dialog')
    hn('select-window', '-t', 'Remote')
    keys('C-u')
    tmux('send-keys', '-l', '-t', 'test', 'Renamed workspace')
    keys('Enter')
    wait(lambda: any(t['id'] == 'workspace' and t['name'] == 'Renamed workspace' for t in api()['desk']['tabs']), 'rename stays with original tab')
    assert next(t for t in api()['desk']['tabs'] if t['id'] == 'remote')['name'] == 'Remote'
    hn('select-window', '-t', workspace)

    # A phone approval is explicit. Closing its UI cancels the driver, and reopening never
    # accepts a previously selected row as consent to a different account.
    hn('account')
    click_text('Sign in with your phone')
    shown('Cancel sign-in')
    snapshot('phone-sign-in')
    keys('Escape')
    wait(lambda: login_events() == ['start', 'cancel'], 'closing account cancels the pending login')
    hn('account')
    click_text('Sign in with your phone')
    shown('Cancel sign-in')
    (BASE / 'approve').touch()
    shown('Sign in as review@example.test')
    assert not (BASE / 'account.json').exists()
    snapshot('confirm-account')
    click_text('Sign in as review@example.test')
    wait(lambda: 'commit' in login_events(), 'explicit account confirmation commits')
    shown('Connect a machine')
    assert json.loads((BASE / 'account.json').read_text())['loggedIn']
    snapshot('signed-in')
    click_text('Back to workspace')
    print('PASS workspace: tab identity survives focus changes; phone login requires explicit account confirmation', flush=True)

    # Save failures preserve the session, and a busy session needs an explicit Stop action.
    hn('select-window', '-t', workspace)
    hn('select-pane', '-t', beta)
    api({'action': 'config', 'patch': {'closeFailure': 'SAVE_FAILED'}})
    x, y, w = map(int, value('#{pane_left} #{pane_top} #{pane_width}', beta).split())
    close_from_menu(occurrence=1, row=y - 1)
    shown('Cancel')
    assert not [r for r in requests('agent_close') if r['payload'].get('mode') != 'inspect']
    snapshot('confirm-stop')
    keys('Enter')
    wait(lambda: 'Cancel' not in screen(), 'Cancel is the default stop action')
    assert len(hn('list-panes', '-F', '#{pane_id}').splitlines()) == 2
    close_from_menu(occurrence=1, row=y - 1)
    shown('Stop? Saved history will remain.')
    click_text('[ Stop ]')
    shown('could not save')
    assert len(hn('list-panes', '-F', '#{pane_id}').splitlines()) == 2
    snapshot('stop-save-failed')
    keys('Escape')
    wait(lambda: 'Stop not confirmed' not in screen(), 'dismiss stop failure')
    print('PASS workspace: busy stop defaults to Cancel and a save failure keeps its pane', flush=True)

    # Mouse reporting inside the program is still the program's. Header controls consume their
    # own press/release pair without leaking either into the terminal stream.
    api({'action': 'terminal-mouse'})
    overlay_dismiss_journey(alpha)
    title_drag_journey(alpha, beta)
    title_drag_journey(alpha, beta, 'box')
    pane_drag_journey(alpha, beta)
    x, y = map(int, value('#{pane_left} #{pane_top}', alpha).split())
    before = len(api()['inputs'])
    click(x + 4, y + 4)
    wait(lambda: len(api()['inputs']) >= before + 2, 'program receives mouse press and release')
    events = api()['inputs'][before:]
    assert all(e['agent'] == 'alpha' for e in events), events
    assert events[0]['text'] == '\x1b[<0;5;5M', events
    assert events[1]['text'] == '\x1b[<0;5;5m', events
    before = len(api()['inputs'])
    pane_menu_item('Change agent…', row=y - 1)
    shown('Change agent')
    assert len(api()['inputs']) == before, 'header clicks do not become program input'
    keys('Escape')
    keys('C-b', 'n')
    wait(lambda: value('#{window_name}') == 'Remote', 'tmux next-window is unchanged')
    shown('Gamma remote task terminal')
    keys('C-b', 'p')
    wait(lambda: value('#{window_id}') == workspace, 'tmux previous-window is unchanged')
    wait(lambda: painted_workspace(alpha, beta), 'previous window paints both pane titles before a header click')
    print('PASS workspace: program mouse input and tmux next/previous bindings remain intact', flush=True)

    # A peer prunes the stopped source before its close reply arrives. A failed desk write then
    # forces a view-only retry: exactly one new process, unchanged pane id, focus and geometry.
    api({'action': 'config', 'patch': {'closeFailure': None, 'pruneOnClose': True, 'closeDelay': 350, 'deskFailures': 1}})
    original_layout = value('#{window_layout}')
    pane_menu_item('Change agent…', row=y - 1)
    alpha_agent_picker()
    tmux('send-keys', '-l', '-t', 'test', 'Claude')
    shown('› Claude')
    click_text('Claude Code', before=85)
    wait(lambda: any(r['payload']['agentId'] == 'alpha' for r in requests('agent_handoff_prepare')),
         'the mouse selection starts its handoff before changing focus')
    hn('select-pane', '-t', beta)
    wait(lambda: value('#{pane_id}') == beta, 'focus changes while the original pane is switching')
    wait(lambda: len(requests('agent_create')) == 1, 'agent replacement is launched once')
    wait(lambda: value('#{pane_current_command}', alpha) == 'claude', 'replacement attaches in the same pane')
    new_id = next(a['id'] for a in api()['agents'][local] if a['id'] not in ('alpha', 'beta'))
    wait(lambda: any(t['id'] == 'workspace' and any(p['agentId'] == new_id for p in t['panes']) for t in api()['desk']['tabs']), 'workspace retry publishes replacement')
    assert value('#{pane_id}') == beta
    assert hn('list-panes', '-F', '#{pane_id}').splitlines() == panes
    assert value('#{window_layout}') == original_layout
    assert len(requests('agent_create')) == 1
    created = requests('agent_create')[0]['payload']
    assert created['cwd'] == '/work/alpha' and created['name'] == 'Alpha task'
    assert created['permissionMode'] == 'ask' and not created['bypassPermission']
    assert '.harness/handoff/alpha-' in created['prompt']
    assert len([r for r in requests('agent_close') if r['payload']['agentId'] == 'alpha' and r['payload']['mode'] != 'inspect']) == 1
    snapshot('agent-switched')

    # A lost launch acknowledgement requires checking its receipt after reconnect; it must not
    # create a second agent, even when the source has already disappeared from the roster.
    api({'action': 'config', 'patch': {'loseCreateReply': True, 'deskFailures': 0, 'deskNoops': 1}})
    hn('change-agent', '-t', alpha)
    shown('Change agent')
    tmux('send-keys', '-l', '-t', 'test', 'opencode')
    shown('› opencode')
    click_text('OpenCode', before=85)
    wait(lambda: len(requests('agent_create')) == 2, 'one uncertain launch')
    wait(lambda: local in api()['peers'], 'local daemon reconnects')
    keys('Escape')
    hn('change-agent', '-t', alpha)
    shown('Change agent')
    tmux('send-keys', '-l', '-t', 'test', 'opencode')
    shown('Check status')
    click_text('OpenCode', before=85)
    wait(lambda: value('#{pane_current_command}', alpha) == 'opencode', 'receipt recovers the existing launch')
    recovered_id = requests('agent_create')[-1]['payload']['creationId']
    recovered_agent = next(a['id'] for a in api()['agents'][local] if a['engine'] == 'opencode')
    wait(lambda: any(any(p['agentId'] == recovered_agent for p in t['panes']) for t in api()['desk']['tabs']), 'accepted workspace write without its pane is retried')
    assert len(requests('agent_create')) == 2
    checks = requests('agent_create_status')
    assert checks and checks[-1]['payload']['creationId'] == recovered_id
    assert value('#{window_layout}') == original_layout
    snapshot('recovered-switch')
    print('PASS workspace: agent handoff, peer pruning, failed desk write, and lost launch acknowledgement', flush=True)

    # Idle sessions stop directly; no second meaning of X is introduced for owned harnesses.
    hn('select-window', '-t', 'Remote')
    shown('Gamma remote task terminal')
    _, remote_y = map(int, value('#{pane_left} #{pane_top}').split())
    close_from_menu(row=remote_y - 1)
    wait(lambda: not any(t['id'] == 'remote' for t in api()['desk']['tabs']), 'idle remote session is stopped and removed')
    remote_close = [r['payload']['mode'] for r in requests('agent_close') if r['payload']['agentId'] == 'gamma']
    assert remote_close == ['inspect', 'idle'], remote_close
    # The peer removes its desk entry before the intentionally delayed stop acknowledgement.
    # Wait for the final painted workspace: the old footer still has a different + position,
    # and a missing progress phrase alone can also mean its frame has not been drawn yet.
    hn('select-window', '-t', workspace)
    wait(lambda: 'Alpha task terminal' in (painted := screen())
         and 'Stop Harness' not in painted and 'Remote' not in painted.splitlines()[-1],
         'idle stop paints the remaining workspace and dismisses its dialog')

    # Mouse creation keeps the GUI: + opens a harness dialog in this window;
    # New Tab opens the welcome composer in a separate window.
    click_text('+', row=43)
    shown('New Harness')
    assert value('#{window_id}') == workspace
    tmux('send-keys', '-l', '-t', 'test', 'A harness from the mouse')
    shown('A harness from the mouse')
    keys('Escape')
    hn('workspace-menu')
    click_text('New Tab')
    wait(lambda: value('#{window_id}') != workspace, 'New Tab opens a new window')
    shown('Recent harnesses')
    shown('New Terminal')
    added_window = value('#{window_id}')
    tmux('send-keys', '-l', '-t', 'test', 'Draft from the mouse')
    shown('Draft from the mouse')
    snapshot('new-tab-from-menu')
    hn('kill-window', '-t', added_window)
    hn('select-window', '-t', workspace)

    # Account and pane menus remain reachable with compact terminal sizes.
    hn('workspace-menu')
    for cols, rows in [(80, 24), (40, 12)]:
        tmux('resize-window', '-t', 'test', '-x', str(cols), '-y', str(rows))
        wait(lambda: value('#{client_width}') == str(cols), 'resize terminal')
        shown('New Harness')
        shown('Commands')
        snapshot(f'workspace-menu-{cols}x{rows}')
        click_text('Account')
        shown('Back to workspace')
        snapshot(f'account-{cols}x{rows}')
        keys('Escape')
        hn('workspace-menu')
    keys('Escape')
    print('PASS workspace: idle stop and compact 80x24 / 40x12 menus', flush=True)

    # Real sign-in changes the daemon's computer identity to its account identity. The UI
    # must keep local work, then discard account views on a later switch to another account.
    tmux('resize-window', '-t', 'test', '-x', '160', '-y', '44')
    wait(lambda: value('#{client_width}') == '160', 'restore terminal size')
    before_ids = hn('list-panes', '-F', '#{pane_id}').splitlines()
    before_layout = value('#{window_layout}')
    joined = 'workspace0000000000000000000003'
    (BASE / 'account.json').write_text(json.dumps({'loggedIn': True, 'machineId': joined}))
    api({'action': 'identity', 'machine': joined, 'keepLocal': True})
    wait(lambda: joined in api()['peers'], 'first sign-in reconnects the new daemon identity', seconds=12)
    wait(lambda: value('#{pane_current_command}', alpha) == 'opencode', 'local agent survives first sign-in')
    wait(lambda: any(any(p['machineId'] == joined and p['agentId'] == recovered_agent for p in t['panes']) for t in api()['desk']['tabs']), 'local workspace joins the account desk')
    assert hn('list-panes', '-F', '#{pane_id}').splitlines() == before_ids
    assert value('#{window_layout}') == before_layout
    assert value('#{window_id}') == workspace
    joined_writes = [w for w in api()['deskOwners'] if w['machine'] == joined]
    assert joined_writes and all(op.get('machineId', joined) == joined for w in joined_writes for op in w['ops'])
    snapshot('first-sign-in-keeps-local-work')

    other = 'workspace0000000000000000000004'
    (BASE / 'account.json').write_text(json.dumps({'loggedIn': True, 'machineId': other}))
    api({'action': 'identity', 'machine': other, 'keepLocal': False})
    wait(lambda: value('#{window_name}') == 'Other account', 'new account loads its own lower-revision desk', seconds=12)
    shown('Other account task')
    assert all(p not in hn('list-panes', '-a', '-F', '#{pane_id}').splitlines() for p in before_ids)
    hn('account')
    shown('other@example.test')
    assert 'review@example.test' not in screen()
    snapshot('other-account-workspace')
    print('PASS workspace: first sign-in preserves local work; account switch isolates the new desk', flush=True)

    # A cold start can find sessions written before an external account switch. The saved
    # public identity must scope those views before a lower-revision new desk is restored.
    keys('Escape')
    tmux('set-window-option', '-t', 'test', 'remain-on-exit', 'on')
    hn('hn-hand-over')
    wait(lambda: tmux('display-message', '-p', '-t', 'test', '#{pane_dead}').strip() == '1', 'client hands off for restart')
    sessions_file = BASE / '.harness' / 'tui' / f'sessions-{PREFIX}.json'
    saved = json.loads(sessions_file.read_text())
    old_identity = {'machine': joined, 'localOnly': False}
    stale = {'name': 'old-account-session', 'id': 90000, 'desk': False, 'owner': None,
             'harnessIdentity': old_identity, 'active': 0, 'windows': [{
                 'id': 'old-account-window', 'wid': 90000, 'name': 'Private old account task', 'num': 0,
                 'harnessIdentity': old_identity, 'layout': '160x42,0,0,89999',
                 'panes': [[joined, recovered_agent, False, 90000]], 'focus': 0}]}
    saved['harnessIdentity'] = old_identity
    saved['current'] = stale['name']
    saved['sessions'].append(stale)
    sessions_file.write_text(json.dumps(saved))
    tmux('respawn-pane', '-k', '-t', 'test', command)
    # The private control socket is absent briefly while the new client starts.
    wait(lambda: hn('display-message', '-p', '#{window_name}', ok=False) == 'Other account',
         'cold start switches to the current account desk', seconds=12)
    shown('Other account task')
    assert 'Private old account task' not in hn('list-windows', '-a', '-F', '#{window_name}')
    assert 'old-account-session' not in hn('list-sessions', '-F', '#{session_name}')
    snapshot('account-safe-restart')
    print('PASS workspace: cold restart does not restore the previous account session', flush=True)

    # An ordinary tmux session may be shown by two clients. A switch from its watcher must
    # replace the owning client's view too, without launching another process or taking it over.
    mirror_journey(command, 'Other account task')
finally:
    if started:
        if OUTPUT:
            try:
                snapshot('last-screen')
                (OUTPUT / 'trace.json').write_text(json.dumps(api(), indent=2))
            except (OSError, AssertionError):
                pass
        hn('kill-server', ok=False)
        tmux('kill-server', ok=False)
    def clients():
        rows = subprocess.check_output(['ps', '-ax', '-o', 'pid=,command='], text=True).splitlines()
        return [int(parts[0]) for row in rows if len(parts := row.strip().split(None, 1)) == 2
                and parts[1].startswith(str(HN) + ' ') and f'-L {PREFIX} ' in parts[1]]
    for pid in clients():
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        deadline = time.monotonic() + 5
        while clients() and time.monotonic() < deadline:
            time.sleep(.05)
        assert not clients(), 'workspace fixture client did not exit'
    finally:
        if mock:
            mock.terminate()
            try:
                mock.wait(timeout=3)
            except subprocess.TimeoutExpired:
                mock.kill()
                mock.wait(timeout=3)
    shutil.rmtree(BASE)
