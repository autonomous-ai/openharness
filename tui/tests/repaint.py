#!/usr/bin/env python3
"""Animation, timed UI and idle-input checks in an isolated real terminal, then the
byte stream hn writes (?2026 pairs, soft and hard clears, the settle rewrite, idle).

Run after a release build. HARNESS_TUI_BIN can select a frozen comparison build.
Only a private HOME, named hn/tmux sockets, and a guarded mock port are used.
"""
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
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
           HARNESS_TUI_KITTY_KEYS='off', HARNESS_TUI_VERIFY=str(BASE / 'verify.log'))
CONF = BASE / 'tmux.conf'
CONF.write_text('set -g @hn-new-window shell\nset -g automatic-rename off\nset -g status-right "REPAINT_IDLE"\n'
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


RAW = BASE / 'raw.bin'
SYNC = re.compile(rb'\x1b\[\?2026([hl])')
CLEAR, ERASE_ROW = b'\x1b[2J', b'\x1b[2K'


def mark():
    """A position in what hn has written so far (the outer pane's raw output)."""
    return RAW.stat().st_size if RAW.exists() else 0


def written(since, until=None):
    with RAW.open('rb') as f:
        f.seek(since)
        return f.read() if until is None else f.read(until - since)


def updates(data):
    """The synchronized updates in [data]: the bytes between each ?2026h and its ?2026l.

    Asserts the pairs are balanced, never nested, and that every hard clear is inside one.
    """
    found, open_at, last = [], None, 0
    for m in SYNC.finditer(data):
        if m[1] == b'h':
            assert open_at is None, '?2026h inside an open update'
            assert CLEAR not in data[last:m.start()], 'a hard clear outside a synchronized update'
            open_at = m.end()
        else:
            assert open_at is not None, '?2026l with no update open'
            found.append(data[open_at:m.start()])
            open_at = None
        last = m.end()
    assert open_at is None, 'an update left open'
    assert CLEAR not in data[last:], 'a hard clear outside a synchronized update'
    return found


def soft_repaints(data, rows):
    """Updates that erase every row one by one, and not the screen: a soft repaint."""
    return [u for u in updates(data) if u.count(ERASE_ROW) >= rows and CLEAR not in u]


def hard_clears(data):
    return [u for u in updates(data) if CLEAR in u]


def settled(quiet=.8, within=8):
    """Wait until hn has written nothing for [quiet] seconds: an idle hn writes no bytes."""
    end = time.monotonic() + within
    while time.monotonic() < end:
        at = mark()
        time.sleep(quiet)
        if mark() == at:
            return
    raise AssertionError('hn keeps writing while idle:\n' + screen())


def keys(*args):
    outer('send-keys', '-t', 'view', *args)


def size():
    return [int(n) for n in outer('display-message', '-p', '-t', 'view', '#{window_width} #{window_height}').split()]


def resize(width, height):
    outer('resize-window', '-t', 'view', '-x', str(width), '-y', str(height))
    wait(lambda: size() == [width, height], 'outer resize')


def dump_screen():
    """SIGUSR2 to the TUI, then a frame: it logs its screen against the replayed bytes (HARNESS_TUI_VERIFY)."""
    tui = ' '.join(COMMAND)
    listing = subprocess.run(['ps', '-axo', 'pid=,ppid=,command='], text=True, capture_output=True).stdout
    found = [l.split(None, 2) for l in listing.splitlines() if l.strip().endswith(tui)]
    pids = [int(pid) for pid, _, _ in found if not any(ppid == pid for _, ppid, _ in found)] # the child of the shell
    assert len(pids) == 1, ('the TUI process', found)
    os.kill(pids[0], signal.SIGUSR2)
    keys('-H', '1b', '5b', '49') # the dump is taken at the next frame; focus-in asks for one


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
    wait(lambda: 'Mock terminal' in screen(), 'initial frame')
    # Loading this fixture's config shows a startup notice over the status line.
    # Dismiss it as a person would before testing the status timers themselves;
    # otherwise their five-second startup deadline races that unrelated notice.
    outer('send-keys', '-t', 'view', 'C-g')
    wait(lambda: 'REPAINT_IDLE' in screen(), 'initial status line')

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

    # The byte stream: what hn writes, as the terminal receives it (?2026 and all).
    outer('pipe-pane', '-t', 'view', f'cat >> {RAW}')
    keys('C-g')
    settled()
    rows = size()[1]

    def step(act, seconds=.9):
        at = mark()
        act()
        time.sleep(seconds)
        return written(at)

    def soft_within(act, limit=.4):
        """Run [act]; its soft repaint must be written within [limit] seconds of the key."""
        at = mark()
        act()
        begun = time.monotonic() # the key has been delivered; the settle delay runs from there
        while time.monotonic() - begun < limit:
            try:
                if soft_repaints(written(at), rows):
                    break
            except AssertionError:
                pass # caught between the two halves of an update
            time.sleep(.01)
        else:
            raise AssertionError(f'no soft repaint within {limit}s:\n' + screen())
        time.sleep(.7)
        return written(at)

    def one_soft(data, label):
        assert len(soft_repaints(data, rows)) == 1, f'{label}: not exactly one soft repaint'
        assert not hard_clears(data), f'{label}: a hard clear'

    assert step(lambda: None, 1.2) == b'', 'an idle hn wrote bytes'
    print('PASS repaint: an idle hn writes no bytes', flush=True)

    # Focus-in repaints softly, once; so does Ctrl-L in a picker (the command panel).
    data = step(lambda: keys('-H', '1b', '5b', '49'))
    one_soft(data, 'focus-in')
    assert len(updates(data)) == 1, 'focus-in: more than one update'
    keys('C-b', 'Enter')
    wait(lambda: 'Commands' in screen(), 'command panel opens')
    settled()
    data = step(lambda: keys('C-l'))
    one_soft(data, 'Ctrl-L')
    assert len(updates(data)) == 1, 'Ctrl-L: more than one update'
    # Two repaint requests in one loop pass (focus-in and Ctrl-L, one write) give one repaint.
    data = step(lambda: keys('-H', '1b', '5b', '49', '0c'))
    one_soft(data, 'focus-in with Ctrl-L')
    assert len(updates(data)) == 1, 'two requests in one pass wrote more than one update'
    print('PASS repaint: focus-in and Ctrl-L repaint softly, once per pass', flush=True)

    # Closing the command panel: one soft repaint, within 400 ms, never re-owed by itself.
    data = soft_within(lambda: keys('Escape'))
    one_soft(data, 'command panel close')
    assert 'Commands' not in screen()
    settled()
    print('PASS repaint: the command panel closes with one soft settle rewrite, then silence', flush=True)

    # New Harness: opening and typing write little; closing settles once.
    hn('workspace-menu', 'new-harness')
    wait(lambda: 'New Harness' in screen(), 'New Harness opens')
    settled()
    data = step(lambda: keys('-l', 'repaint check text'))
    assert not soft_repaints(data, rows) and not hard_clears(data) and len(data) < 1500, \
        f'typing in New Harness repainted: {len(data)} bytes'
    data = step(lambda: keys(*['BSpace'] * 20))
    assert not soft_repaints(data, rows) and not hard_clears(data) and len(data) < 1500, \
        f'20 backspaces repainted: {len(data)} bytes'
    data = soft_within(lambda: keys('Escape'))
    one_soft(data, 'New Harness close')
    assert 'New Harness' not in screen()
    settled()
    print('PASS repaint: New Harness open, typing and 20 backspaces, close', flush=True)

    # A real size change hard-clears, inside its update.
    for width, height in [(100, 30), (120, 32)]:
        data = step(lambda: resize(width, height))
        clears = hard_clears(data)
        assert len(clears) == 1, f'resize to {width}x{height}: {len(clears)} hard clears'
        settled()
    print('PASS repaint: a resize hard-clears inside one synchronized update', flush=True)

    # Over the whole run: balanced, never nested, every clear inside a pair; no stale cell.
    updates(written(0))
    dump_screen()
    wait(lambda: (BASE / 'verify.log').exists() and re.search(r'### .* dump: SIGUSR2 .* 0 cells differ', (BASE / 'verify.log').read_text()), 'dump header')
    bad = re.findall(r'(===|###) .* [1-9][0-9]* cells differ', (BASE / 'verify.log').read_text())
    assert not bad, bad
    print('PASS repaint: pairs balanced, no hard clear outside one, replayed screen matches', flush=True)

    # Without synchronized output: no ?2026 at all, the screen is still right.
    outer('pipe-pane', '-t', 'view')
    run(COMMAND + ['kill-server'], ok=False)
    run(OUTER + ['kill-server'], ok=False)
    RAW.unlink()
    (BASE / 'verify.log').unlink()
    launch.insert(launch.index('HARNESS_TUI_DESK=off'), 'HARNESS_TUI_SYNC=off')
    outer('new-session', '-d', '-s', 'view', '-x', '120', '-y', '32', shlex.join(launch))
    wait(lambda: 'Mock terminal' in screen(), 'frame without synchronized output')
    outer('pipe-pane', '-t', 'view', f'cat >> {RAW}')
    keys('C-g')
    settled()
    data = step(lambda: (keys('C-b', 'Enter'), wait(lambda: 'Commands' in screen(), 'panel')))
    data += step(lambda: keys('Escape'))
    data += step(lambda: resize(100, 30))
    data += step(lambda: resize(120, 32))
    assert b'2026' not in data, 'HARNESS_TUI_SYNC=off still wrote ?2026'
    assert CLEAR in data, 'a resize without ?2026 did not hard-clear'
    assert 'Commands' not in screen() and 'Mock terminal' in screen()
    settled()
    dump_screen()
    wait(lambda: (BASE / 'verify.log').exists() and re.search(r'### .* dump: SIGUSR2 .* 0 cells differ', (BASE / 'verify.log').read_text()), 'dump header')
    bad = re.findall(r'(===|###) .* [1-9][0-9]* cells differ', (BASE / 'verify.log').read_text())
    assert not bad, bad
    assert b'2026' not in written(0)
    print('PASS repaint: HARNESS_TUI_SYNC=off writes no ?2026 and the screen is correct', flush=True)
finally:
    if started:
        run(COMMAND + ['kill-server'], ok=False)
        run(OUTER + ['kill-server'], ok=False)
    if mock is not None:
        mock.terminate()
        mock.wait(timeout=5)
    shutil.rmtree(BASE)
