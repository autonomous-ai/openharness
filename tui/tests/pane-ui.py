#!/usr/bin/env python3
"""Pane presentation with real hn keys, mouse input, copy mode and tiny PTYs.

Uses only guarded reconnect-fixture ports 19783..19789 and disposable hn/tmux servers.
HN_PANE_UI_OUTPUT optionally keeps ANSI captures for rendering a visual review.
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
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get('HN_PANE_UI_PORT', '19783'))
assert 19783 <= PORT <= 19789, 'refusing non-test pane UI port'
PREFIX = f'hn-pane-ui-{os.getpid()}'
BASE = Path(tempfile.mkdtemp(prefix='hnpu-', dir='/tmp')).resolve()
HN = BASE / 'hn'
shutil.copy2(os.environ.get('HN_PANE_UI_BINARY', ROOT / 'target/release/harness-tui'), HN)
TMUX = shutil.which('tmux')
assert TMUX
ENV = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TZ') if k in os.environ}
ENV.update(HOME=str(BASE), HN_TMPDIR=str(BASE), HN_SOCKET_NAME=PREFIX, PORT=str(PORT),
           TERM='xterm-256color', COLORTERM='truecolor', SHELL='/bin/sh', HARNESS_TUI_DESK='sync',
           HARNESS_TUI_NOTIFY='off', HN_DESKTOP='off', MOCK_DEMO='1', MOCK_RECONNECT='1', MOCK_USAGE='100')
CONF = BASE / 'tmux.conf'
# Box panes are the default; this suite covers the blurred surfaces (`@hn-look panes`).
CONF.write_text('set -g automatic-rename off\n'
                'set -g @hn-look panes\n'
                'set -g status-right \'  #{usage_remaining_mark}  #{s/ /  /:fleet}  "#{=/21/…:local_machine}"  20:41 \'\n')
OUTPUT = Path(os.environ['HN_PANE_UI_OUTPUT']) if os.environ.get('HN_PANE_UI_OUTPUT') else None
if OUTPUT:
    OUTPUT.mkdir(parents=True, exist_ok=True)


def hn(*args, ok=True, strip=True):
    assert 19783 <= PORT <= 19789 and PREFIX.startswith('hn-pane-ui-')
    p = subprocess.run([str(HN), '-L', PREFIX, '--port', str(PORT), '-f', str(CONF), *args], env=ENV,
                       cwd=BASE, text=True, capture_output=True, timeout=12)
    if ok:
        assert p.returncode == 0, (args, p.stdout, p.stderr)
    return p.stdout.strip() if strip else p.stdout.rstrip('\n')


def tmux(*args, ok=True):
    p = subprocess.run([TMUX, '-L', PREFIX + '-outer', *args], env=ENV, cwd=BASE,
                       text=True, capture_output=True, timeout=10)
    if ok:
        assert p.returncode == 0, (args, p.stderr)
    return p.stdout


def api():
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/test/reconnect', timeout=2) as r:
        return json.load(r)['data']


def wait(fn, label, seconds=8):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if fn():
            return
        time.sleep(.05)
    raise AssertionError(label + '\n' + tmux('capture-pane', '-p', '-t', 'test', ok=False))


def value(fmt, target=None):
    return hn('display-message', '-p', *(['-t', target] if target else []), fmt)


def keys(*args):
    tmux('send-keys', '-t', 'test', *args)


def mouse(code, x, y, release=False):
    raw = f'\x1b[<{code};{x + 1};{y + 1}{"m" if release else "M"}'.encode()
    tmux('send-keys', '-H', '-t', 'test', *[f'{b:02x}' for b in raw])


def color_at(x, y, foreground=False):
    row = tmux('capture-pane', '-p', '-e', '-t', 'test', '-S', str(y), '-E', str(y)).splitlines()[0]
    col, bg = 0, 'default'
    rgb_code, base_code, reset_code = (38, 30, 39) if foreground else (48, 40, 49)
    for token in re.findall(r'\x1b\[[0-9;:]*m|.', row):
        if token.startswith('\x1b['):
            codes = [int(v or 0) for v in token[2:-1].split(';')]
            i = 0
            while i < len(codes):
                c = codes[i]
                if c in (0, reset_code): bg = 'default'
                elif c in (38, 48) and i + 4 < len(codes) and codes[i + 1] == 2:
                    if c == rgb_code: bg = '#%02x%02x%02x' % tuple(codes[i + 2:i + 5])
                    i += 4
                elif c in (38, 48) and i + 2 < len(codes) and codes[i + 1] == 5:
                    if c == rgb_code: bg = f'colour{codes[i + 2]}'
                    i += 2
                elif base_code <= c <= base_code + 7: bg = f'colour{c - base_code}'
                elif base_code + 60 <= c <= base_code + 67: bg = f'colour{c - base_code - 52}'
                i += 1
        else:
            width = 0 if unicodedata.combining(token) else (2 if unicodedata.east_asian_width(token) in ('W', 'F') else 1)
            if col <= x < col + width: return bg
            col += width
    return bg


def background_at(x, y):
    return color_at(x, y)


def background(hex_value):
    raw = f'\x1b]11;{hex_value}\x07'.encode()
    tmux('send-keys', '-H', '-t', 'test', *[f'{b:02x}' for b in raw])


# A surface is the program's cells and one cell around them, its title in the top one: the
# space between two panes is the one cell tmux keeps between them.
def pane_edge_background(pane, colour):
    x, y, w, h = map(int, value('#{pane_left} #{pane_top} #{pane_width} #{pane_height}', pane).split())
    points = ((x - 1, y - 1), (x + w, y - 1), (x - 1, y + h),
              (x + w, y + h), (x + w // 2, y - 1), (x + w, y + h // 2),
              (x - 1, y + h // 2), (x + w // 2, y + h))
    return all(background_at(col, row) == colour for col, row in points)


def pane_background(pane):
    x, y, height = map(int, value('#{pane_left} #{pane_top} #{pane_height}', pane).split())
    return background_at(x, y + height - 2)


def pane_outline(pane, kind=None):
    x, y, w, h = map(int, value('#{pane_left} #{pane_top} #{pane_width} #{pane_height}', pane).split())
    screen = tmux('capture-pane', '-p', '-t', 'test').splitlines()
    styles = {'thin': '┌┐└┘', 'heavy': '┏┓┗┛', 'double': '╔╗╚╝'}
    points = ((x - 1, y - 1), (x + w, y - 1), (x - 1, y + h), (x + w, y + h))
    return any(all(0 <= row < len(screen) and 0 <= col < len(screen[row]) and screen[row][col] == glyph
                   for (col, row), glyph in zip(points, glyphs))
               for glyphs in ([styles[kind]] if kind else styles.values()))


def pane_title_color(pane, foreground=True):
    x, y = map(int, value('#{pane_left} #{pane_top}', pane).split())
    return color_at(x, y - 1, foreground=foreground)


def snapshot(name):
    if OUTPUT:
        (OUTPUT / (name + '.ansi')).write_text(tmux('capture-pane', '-p', '-e', '-t', 'test'))


mock = None
started = False
try:
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', PORT))
    mock = subprocess.Popen(['node', str(ROOT / 'tests/mock-daemon.mjs'), str(PORT)], env=ENV,
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
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'test', '-x', '150', '-y', '42', command)
    started = True
    wait(lambda: 'Fix flaky login test' in tmux('capture-pane', '-p', '-t', 'test'), 'demo panes')
    background('#000000')
    wait(lambda: 'bg=#181818' in hn('show', '-gwv', 'window-active-style'), 'focused pane lifted above the black terminal background')
    hn('select-layout', 'even-horizontal')
    panes = hn('list-panes', '-F', '#{pane_id}').splitlines()
    assert len(panes) == 3
    first, second, third = panes
    hn('select-pane', '-t', first)
    keys('C-b', 'Right')
    keys('C-b', 'Left')
    wait(lambda: value('#{pane_id}') == first, 'focus before visual capture')
    time.sleep(.2)
    original = value('#{window_layout}')
    active_bg = hn('show', '-gwv', 'window-active-style').split('bg=')[1]
    inactive_bg = hn('show', '-gwv', 'window-style').split('bg=')[1]
    assert active_bg != inactive_bg
    assert active_bg == '#181818' and inactive_bg == '#404040'
    wait(lambda: not any(pane_outline(p) for p in (first, second, third)), 'pane backgrounds without outlines')
    wait(lambda: pane_background(first) == active_bg and pane_background(second) == inactive_bg, 'whole-pane focus contrast')
    assert background_at(149, 0) == inactive_bg, 'panes reach the window edges: no outer margin'
    wait(lambda: pane_edge_background(first, active_bg), 'focused background fills through the pane edges')
    assert background_at(49, 20) == background_at(99, 20) == 'default', 'pane gaps use the native terminal background'
    assert pane_edge_background(second, inactive_bg)
    tab = value(hn('show', '-gwv', 'window-status-current-format'))
    label = value('#{window_index}:#{window_short_name}')
    assert tab.startswith(label + '* '), (tab, label)
    assert value('#{window_agent_icon}') in tab[len(label):]
    assert '*' in value('#{window_flags}')
    selected_bg = hn('show', '-gwv', 'window-status-current-style').split('bg=')[1].split(',')[0]
    normal_bg = hn('show', '-gwv', 'window-status-style').split('bg=')[1].split(',')[0]
    assert selected_bg == normal_bg, 'the star identifies the active tab without a second filled highlight'
    current = value('#{window_id}')
    other = next(w for w in hn('list-windows', '-F', '#{window_id}').splitlines() if w != current)
    hn('select-window', '-t', other)
    previous = value(hn('show', '-gwv', 'window-status-format'), current)
    assert previous.startswith(label + '-'), (previous, label)
    hn('select-window', '-t', current)
    assert 'reverse' not in value('#{fleet}')
    assert 'reverse' not in value('#{tree_mode_format}')
    assert 'reverse' not in value('#{pane_agent_mark}', second)
    custom_status = hn('show', '-gv', 'status-right', strip=False)
    assert 'reverse' not in custom_status
    title = value('#{pane_title}', first)
    header = value(hn('show', '-gwv', 'pane-border-format'), first)
    plain_header = re.sub(r'#\[[^]]*\]', '', header).strip()
    assert plain_header.startswith(title + ' '), (title, plain_header)
    hn('set', '-gu', 'status-right')
    default_status = hn('show', '-gv', 'status-right', strip=False)
    assert all(part not in default_status for part in ('pane_branch', 'pane_where', 'pane_machine', 'pane_current_path', 'pane_project', 'git:'))
    assert value('#{host}') == socket.gethostname(), 'standard host format keeps its hostname meaning'
    assert value('#{local_machine}') == 'studio', 'status uses the local machine name configured in the app'
    machine_label = '"studio"'
    assert machine_label in value(default_status), (machine_label, value(default_status))
    def local_machine_status():
        line = tmux('capture-pane', '-p', '-t', 'test').splitlines()[-1]
        return re.search(re.escape(machine_label) + r'  \d{2}:\d{2}$', line.rstrip()) and '[' + session + ']' not in line
    def aligned_status_edges():
        line = tmux('capture-pane', '-p', '-t', 'test').splitlines()[-1]
        return re.match(r' \d+:', line) and len(line.rstrip()) == 149
    wait(lambda: 'Claude 0%  Codex 89%' in tmux('capture-pane', '-p', '-t', 'test').splitlines()[-1], 'default status includes both subscription allowances')
    wait(aligned_status_edges, 'default status text has one outer space matching the pane margins')
    default_left = hn('show', '-gv', 'status-left', strip=False)
    session = value('#{session_name}')
    assert session == value('#{pane_machine}'), 'desk session is named for the local machine'
    for target in (third, second, first):
        hn('select-pane', '-t', target)
        assert value(default_left).strip() == ''
        wait(local_machine_status, 'quoted local machine stays beside the clock across local and remote panes; no machine label on the left')
        if target in (first, third):
            snapshot('status-local' if target == first else 'status-remote')
    for window in hn('list-windows', '-F', '#{window_id}').splitlines():
        hn('select-window', '-t', window)
        assert value(default_left).strip() == ''
        wait(local_machine_status, 'quoted local machine stays beside the clock in every window')
    hn('select-window', '-t', current)
    hn('select-pane', '-t', first)
    keys('C-b')
    wait(lambda: tmux('capture-pane', '-p', '-t', 'test').splitlines()[-1].startswith(' › '), 'prefix cue remains before the window tabs')
    keys('Escape')
    hn('rename-session', 'work-review')
    assert value(default_left).strip() == '', 'renaming a session does not add a left label'
    wait(local_machine_status, 'renaming a session does not change the quoted machine name')
    hn('set', '-g', 'status-left', '[custom] ')
    assert value(hn('show', '-gv', 'status-left')).strip() == '[custom]'
    hn('set', '-gu', 'status-left')
    hn('rename-session', session)
    hn('set', '-g', 'status-right', custom_status)
    for option in ('window-status-activity-style', 'window-status-bell-style'):
        assert hn('show', '-gwv', option) == 'bold'
    assert 'reverse' not in hn('show', '-gv', 'status-format[1]')
    wait(lambda: 'Claude 0%  Codex 89%' in tmux('capture-pane', '-p', '-t', 'test').splitlines()[-1], 'all subscription allowances reach the status row, even below the warning threshold')
    assert value('#{usage_remaining}') == 'Claude 0%  Codex 89%', 'accounts shared across fixture machines appear once'
    assert value('#{usage_high}') == 'claude 5h 100%', 'existing custom used-quota format is preserved'
    row = tmux('capture-pane', '-p', '-t', 'test').splitlines()[-1]
    assert color_at(row.index('0%'), 41, foreground=True) == '#ff9b8e', 'exhausted allowance uses red text'
    assert color_at(row.index('89%'), 41, foreground=True) == color_at(row.index('Codex'), 41, foreground=True), 'healthy allowance has no warning styling'
    assert background_at(row.index('0%'), 41) == background_at(row.index('Codex'), 41), 'subscription text keeps the continuous status background'
    hn('set', '-gw', 'pane-border-lines', 'double')
    wait(lambda: not pane_outline(first) and not pane_outline(second), 'border line options do not draw outlines in pane appearance')
    hn('set', '-g', '@hn-look', 'classic')
    wait(lambda: '║' in tmux('capture-pane', '-p', '-t', 'test'), 'classic appearance keeps explicit border lines')
    hn('set', '-g', '@hn-look', 'panes')
    hn('set', '-gwu', 'pane-border-lines')
    hn('set', '-w', 'pane-active-border-style', 'fg=#aabbcc,bg=#123456')
    hn('set', '-w', 'pane-border-style', 'fg=#778899,bg=#654321')
    wait(lambda: pane_title_color(first) == '#aabbcc' and pane_title_color(second) == '#778899', 'window border styles still customize pane titles')
    assert pane_title_color(first, foreground=False) == '#123456'
    assert pane_title_color(second, foreground=False) == '#654321'
    hn('set', '-wu', 'pane-active-border-style')
    hn('set', '-wu', 'pane-border-style')
    wait(lambda: not pane_outline(first) and not pane_outline(second) and pane_edge_background(first, active_bg), 'borderless pane appearance restored')
    snapshot('panes-columns')
    print('PASS pane UI: whole-pane focus contrast, name before status, compact quota and location', flush=True)

    original_title = value('#{pane_title}', second)
    long_title = 'Investigate the intermittent checkout failure across all supported browser versions (2)'
    hn('select-pane', '-t', second, '-T', long_title)
    x, y, w = map(int, value('#{pane_left} #{pane_top} #{pane_width}', second).split())
    def waiting_heading():
        return tmux('capture-pane', '-p', '-t', 'test').splitlines()[y - 1][x:x + w].strip()
    wait(lambda: waiting_heading().endswith('(2) ?'), 'long pane names retain their suffix and waiting indicator')
    assert '…' in waiting_heading()
    assert value('#{pane_title}', second) == long_title, 'raw pane title must remain unchanged'
    hn('select-pane', '-t', second, '-T', original_title)
    hn('select-pane', '-t', first)
    print('PASS pane UI: long pane titles keep the waiting mark visible', flush=True)

    keys('C-b', 'Right')
    wait(lambda: value('#{pane_id}') == second, 'C-b Right with insets')
    wait(lambda: pane_background(second) == active_bg and pane_background(first) == inactive_bg, 'keyboard focus moves pane contrast')
    wait(lambda: not pane_outline(second) and not pane_outline(first), 'keyboard focus leaves no outlines')
    wait(lambda: pane_edge_background(second, active_bg) and pane_edge_background(first, inactive_bg), 'background focus reaches all pane edges after keyboard selection')
    keys('C-b', 'Right')
    wait(lambda: value('#{pane_id}') == third, 'second C-b Right')
    keys('C-b', 'Right')
    wait(lambda: value('#{pane_id}') == first, 'directional wrap')
    for target in (first, third):
        hn('select-pane', '-t', target)
        keys('C-b', 'z')
        wait(lambda: value('#{window_zoomed_flag}') == '1', 'zoom')
        branch_context = value('#{pane_where}')
        assert branch_context.startswith(value('#{pane_machine}:#{pane_project}') + ' '), branch_context
        assert '⎇ ' + value('#{pane_branch}') in branch_context, branch_context
        assert 'git:(' not in branch_context
        wait(lambda: not pane_outline(target) and background_at(1, 1) == active_bg
             and background_at(0, 0) == background_at(149, 40) == active_bg,
             'a zoomed pane fills the window, to its edges')
        wait(lambda: background_at(0, 41) == normal_bg, 'status bar keeps its own color after transient completion notices')
        x, y, w = map(int, value('#{pane_left} #{pane_top} #{pane_width}', target).split())
        wait(lambda: tmux('capture-pane', '-p', '-t', 'test').splitlines()[y - 1][x:x + w].rstrip().endswith(branch_context), 'machine, project, branch and PR align to the right edge')
        snapshot('panes-zoomed' if target == first else 'panes-remote-zoomed')
        keys('C-b', 'z')
        wait(lambda: value('#{window_zoomed_flag}') == '0', 'unzoom')
    hn('select-pane', '-t', first)
    assert value('#{window_layout}') == original
    print('PASS pane UI: directional keys, wrap, zoom preserve layout structure', flush=True)

    # Switching presentation must not change the serialized split structure.
    hn('set', '-g', '@hn-look', 'classic')
    assert value('#{window_layout}') == original
    border = int(value('#{pane_left}', first)) + int(value('#{pane_width}', first))
    snapshot('classic-columns')
    hn('set', '-g', '@hn-look', 'panes')
    assert value('#{window_layout}') == original
    x, y, w, h = map(int, value('#{pane_left} #{pane_top} #{pane_width} #{pane_height}', first).split())
    assert x > 0 and y > 0 and w > 0 and h > 0
    hn('send-keys', '-t', first, '-l', '\x1b[?1000h\x1b[?1006h')
    wait(lambda: value('#{mouse_sgr_flag}', first) == '1', 'program mouse mode')
    before = len(api()['inputs'])
    mouse(0, x + 3, y + 2)
    mouse(0, x + 3, y + 2, release=True)
    wait(lambda: {'\x1b[<0;4;3M', '\x1b[<0;4;3m'} <= {i['text'] for i in api()['inputs'][before:]}, 'mouse press and release start inside the inset content')
    print('PASS pane UI: same layout across appearances; mouse coordinates match PTY content', flush=True)

    # Titles and padding focus the pane without sending a click to its program.
    before = len(api()['inputs'])
    second_x, second_y = map(int, value('#{pane_left} #{pane_top}', second).split())
    mouse(0, second_x, second_y - 1)
    mouse(0, second_x, second_y - 1, release=True)
    wait(lambda: value('#{pane_id}') == second, 'click the pane header')
    wait(lambda: pane_background(second) == active_bg and pane_background(first) == inactive_bg, 'mouse focus moves pane contrast')
    wait(lambda: not pane_outline(second) and not pane_outline(first), 'mouse focus leaves no outlines')
    assert len(api()['inputs']) == before, api()['inputs'][before:]
    mouse(0, border, 10)
    mouse(32, border + 3, 10)
    mouse(0, border + 3, 10, release=True)
    wait(lambda: value('#{window_layout}') != original, 'drag the blank divider gutter')
    print('PASS pane UI: header focus and gutter dragging', flush=True)

    hn('select-pane', '-t', first)
    keys('C-b', '[')
    wait(lambda: value('#{pane_in_mode}') == '1', 'copy mode')
    hn('send-keys', '-X', 'history-top')
    hn('send-keys', '-X', 'start-of-line')
    hn('send-keys', '-X', 'begin-selection')
    for _ in range(5):
        hn('send-keys', '-X', 'cursor-right')
    hn('send-keys', '-X', 'copy-selection-and-cancel')
    wait(lambda: value('#{pane_in_mode}') == '0', 'leave copy mode')
    assert hn('show-buffer'), 'copy selection should retain terminal text'
    print('PASS pane UI: copy mode and selection', flush=True)

    # Layout targets and percentages operate on the split tree, not inset content.
    targets = ('top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right')
    layouts = ('even-horizontal', 'even-vertical', 'main-horizontal', 'main-vertical', 'tiled',
               'main-horizontal-mirrored', 'main-vertical-mirrored')
    for status in ('top', 'bottom', 'off'):
        hn('set', '-gw', 'pane-border-status', status)
        for layout in layouts:
            hn('set', '-g', '@hn-look', 'classic')
            hn('select-layout', layout)
            shape = value('#{window_layout}')
            expected = [value('#{pane_id}', '.' + t) for t in targets]
            hn('set', '-g', '@hn-look', 'panes')
            assert value('#{window_layout}') == shape, (status, layout)
            assert [value('#{pane_id}', '.' + t) for t in targets] == expected, (status, layout)
    hn('set', '-gw', 'pane-border-status', 'top')
    hn('select-layout', 'even-horizontal')
    shape = value('#{window_layout}')
    def structure(layout):
        return re.sub(r'(\d+x\d+,\d+,\d+),\d+', r'\1,P', layout[5:])
    for axis in ('-h', '-v'):
        resulting = []
        for look in ('classic', 'panes'):
            hn('set', '-g', '@hn-look', look)
            hn('select-layout', shape)
            new_pane = hn('split-window', axis, '-l', '35%', '-t', first, '-P', '-F', '#{pane_id}')
            assert new_pane.startswith('%'), new_pane
            resulting.append(structure(value('#{window_layout}')))
            hn('kill-pane', '-t', new_pane)
        assert resulting[0] == resulting[1], (axis, resulting)
    print('PASS pane UI: seven layouts, eight position targets, top/bottom/off titles, percentage splits', flush=True)

    hn('select-layout', 'even-vertical')
    time.sleep(.2)
    snapshot('panes-rows')
    hn('select-layout', 'main-vertical')
    time.sleep(.2)
    snapshot('panes-main')
    # Extra status rows above the panes must not leak into application mouse coordinates.
    hn('set', '-g', 'status', '2')
    hn('set', '-g', 'status-position', 'top')
    hn('select-pane', '-t', first)
    x, y = map(int, value('#{pane_left} #{pane_top}', first).split())
    # The mock emits a terminal reset on resize, so enable its program mouse mode again.
    hn('send-keys', '-t', first, '-l', '\x1b[?1000h\x1b[?1006h')
    wait(lambda: value('#{mouse_sgr_flag}', first) == '1', 'mouse mode after resized keyframe')
    before = len(api()['inputs'])
    mouse(0, x + 2, y + 2 + 1)
    mouse(0, x + 2, y + 2 + 1, release=True)
    wait(lambda: {'\x1b[<0;3;2M', '\x1b[<0;3;2m'} <= {i['text'] for i in api()['inputs'][before:]}, 'top status rows and program mouse coordinates')
    hn('set', '-g', 'status-position', 'bottom')
    hn('set', '-g', 'status', 'on')
    # OSC replies are metadata, not keystrokes. Surface defaults follow live light/dark changes.
    layout_before_theme = value('#{window_layout}')
    before = len(api()['inputs'])
    background('#f7f7f7')
    wait(lambda: hn('show', '-gwv', 'window-active-style') == 'fg=#1a1a1a,bg=#eeeeee', 'light surface defaults')
    wait(lambda: pane_background(first) == '#eeeeee' and pane_background(second) == '#e5e5e5', 'light focus contrast')
    wait(lambda: pane_edge_background(first, '#eeeeee') and pane_title_color(first, foreground=False) == '#eeeeee', 'light surface fills the focused pane through its padding')
    assert background_at(149, 0) in ('#eeeeee', '#e5e5e5'), 'light theme: the panes reach the window edges too'
    light_status = hn('show', '-gv', 'status-style')
    assert value('#{window_layout}') == layout_before_theme
    snapshot('panes-light')
    hn('set', '-gw', 'window-style', 'fg=red,bg=blue')
    background('#101010')
    wait(lambda: hn('show', '-gv', 'status-style') != light_status, 'green status follows the dark theme')
    assert hn('show', '-gwv', 'window-style') == 'fg=red,bg=blue'
    assert hn('show', '-gwv', 'window-active-style') == 'default'
    wait(lambda: pane_background(first) == 'colour4' and pane_background(second) == 'colour4', 'custom backgrounds win on active and inactive panes')
    wait(lambda: pane_edge_background(first, 'colour4') and pane_title_color(first, foreground=False) == 'colour4', 'custom pane background fills the focused pane through its padding')
    assert len(api()['inputs']) == before, 'terminal query replies reached an application'
    hn('set', '-gwu', 'window-style')
    assert hn('show', '-gwv', 'window-active-style').startswith('fg=#f5f5f5,')
    wait(lambda: pane_background(first) == '#262626' and pane_background(second) == '#404040', 'dark focus contrast')
    print('PASS pane UI: live light/dark themes, reported defaults and custom style preservation', flush=True)

    hn('send-keys', '-t', first, '-l', '\x1b[H\x1b[31;44mHN_COLOR\x1b[0m')
    wait(lambda: 'HN_COLOR' in tmux('capture-pane', '-p', '-t', 'test'), 'explicit program colours')
    coloured = next(row for row in tmux('capture-pane', '-p', '-e', '-t', 'test').splitlines() if 'HN_COLOR' in row)
    assert '\x1b[31m' in coloured and '\x1b[44m' in coloured, repr(coloured)
    print('PASS pane UI: top status rows and explicit program foreground/background colours', flush=True)

    for width, height in [(80, 24), (24, 8), (6, 4), (1, 1), (150, 42)]:
        tmux('resize-window', '-t', 'test', '-x', str(width), '-y', str(height))
        wait(lambda: value('#{client_width} #{client_height}') == f'{width} {height}', 'terminal resize')
        assert value('#{window_panes}') == '3'
    print('PASS pane UI: compact and one-cell terminals, return to full size', flush=True)

    single = hn('new-window', '-n', 'single', '-P', '-F', '#{pane_id}', '/bin/sh')
    wait(lambda: value('#{pane_id}') == single and value('#{window_panes}') == '1', 'single-pane window')
    wait(lambda: not pane_outline(single) and background_at(1, 1) == '#262626'
         and background_at(0, 0) == background_at(149, 40) == '#262626',
         'a single pane fills the window, to its edges')
    snapshot('panes-single')
    hn('kill-window')
    wait(lambda: value('#{window_id}') == current, 'return from single-pane window')
    print('PASS pane UI: borderless pane surfaces, right-aligned context and single-pane presentation', flush=True)
finally:
    if started:
        if OUTPUT:
            snapshot('last-frame')
        hn('kill-server', ok=False)
        tmux('kill-server', ok=False)
    def clients():
        rows = subprocess.check_output(['ps', '-ax', '-o', 'pid=,command='], text=True).splitlines()
        return [int(parts[0]) for row in rows if len(parts := row.strip().split(None, 1)) == 2
                and parts[1].startswith(str(HN) + ' ') and f'-L {PREFIX} ' in parts[1]]
    for pid in clients():
        try:
            os.kill(pid, 15)
        except ProcessLookupError:
            pass
    try:
        deadline = time.monotonic() + 5
        while clients() and time.monotonic() < deadline:
            time.sleep(.05)
        assert not clients(), 'pane UI client did not exit'
    finally:
        if mock is not None:
            mock.terminate()
            mock.wait(timeout=5)
    shutil.rmtree(BASE)
