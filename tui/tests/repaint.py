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
           HARNESS_TUI_KITTY_KEYS='off')
VERIFY = BASE / 'verify.log'
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
    match = re.search(r'REPAINT_ANIM=([⠋⠙⠸⢰⣠⣄⡆⠇])', screen())
    return match[1] if match else None


def clock():
    match = re.search(r'REPAINT_CLOCK=\d\d:\d\d:\d\d', screen())
    return match[0] if match else None


RAW = BASE / 'raw.bin'
SYNC = re.compile(rb'\x1b\[\?2026([hl])')
CLEAR, ERASE_ROW = b'\x1b[2J', b'\x1b[2K'
ROW_START, CUP = re.compile(rb'\x1b\[(\d+);1H'), re.compile(rb'\x1b\[(\d+);(\d+)H')


def mark():
    """A position in what hn has written so far (the outer pane's raw output)."""
    return RAW.stat().st_size if RAW.exists() else 0


def written(since, until=None):
    with RAW.open('rb') as f:
        f.seek(since)
        return f.read() if until is None else f.read(until - since)


def updates(data):
    """The synchronized updates in [data]: the bytes between each ?2026h and its ?2026l.

    Asserts the pairs are balanced, never nested, that every hard clear is inside one, and that no
    row is erased before its text is written (a row written whole is its text, then \\e[K).
    """
    assert ERASE_ROW not in data, 'a row erased before its text'
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


def row_starts(update):
    """The rows (1-based) [update] writes from their first column."""
    return {int(m[1]) for m in ROW_START.finditer(update)}


def cup_rows(data):
    """The rows (1-based) [data] places the cursor on: every row a frame writes a cell in."""
    return {int(m[1]) for m in CUP.finditer(data)}


def settle_rewrite(data, rows, label):
    """[data] is a change, then its settle rewrite (the last update): the rows the change touched,
    each written from its first column — never the whole screen, never a hard clear."""
    found = updates(data)
    assert len(found) >= 2, f'{label}: no settle rewrite after the change ({len(found)} updates)'
    settle = found[-1]
    rewritten = row_starts(settle)
    touched = cup_rows(data[:data.rfind(b'\x1b[?2026h')])
    assert rewritten, f'{label}: the settle rewrite wrote no row'
    assert rewritten <= touched, f'{label}: rows {sorted(rewritten - touched)} rewritten that the change did not touch'
    assert len(rewritten) < rows, f'{label}: the whole screen was rewritten'
    assert not hard_clears(data) and not soft_repaints(data, rows), f'{label}: repainted'
    return sorted(rewritten)


def soft_repaints(data, rows):
    """Updates that write every row from its first column, and do not erase the screen: a soft repaint."""
    return [u for u in updates(data) if row_starts(u) >= set(range(1, rows + 1)) and CLEAR not in u]


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


def tui_pid():
    tui = ' '.join(COMMAND)
    listing = subprocess.run(['ps', '-axo', 'pid=,ppid=,command='], text=True, capture_output=True).stdout
    found = [l.split(None, 2) for l in listing.splitlines() if l.strip().endswith(tui)]
    pids = [int(pid) for pid, _, _ in found if not any(ppid == pid for _, ppid, _ in found)] # the child of the shell
    assert len(pids) == 1, ('the TUI process', found)
    return pids[0]


def check_replay():
    """HARNESS_TUI_VERIFY replays every byte into a reference terminal: SIGUSR2 and a frame
    log its screen against what hn drew; no cell may differ, here or in any earlier frame."""
    os.kill(tui_pid(), signal.SIGUSR2)
    keys('-H', '1b', '5b', '49') # the dump is taken at the next frame; focus-in asks for one
    wait(lambda: VERIFY.exists() and re.search(r'### .* dump: SIGUSR2 .* 0 cells differ', VERIFY.read_text()),
         'the replayed screen was not dumped')
    bad = re.findall(r'(?:===|###) .* [1-9][0-9]* cells differ', VERIFY.read_text())
    assert not bad, bad


def start_session(*extra):
    """A fresh hn in the outer terminal (with [extra] env), its output copied to raw.bin."""
    run(COMMAND + ['kill-server'], ok=False)
    run(OUTER + ['kill-server'], ok=False)
    RAW.unlink(missing_ok=True)
    VERIFY.unlink(missing_ok=True)
    launch = ['env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'HN_SOCKET',
              *[f'{k}={v}' for k, v in ENV.items()], *extra, *COMMAND]
    outer('new-session', '-d', '-s', 'view', '-x', '120', '-y', '32', shlex.join(launch))
    wait(lambda: 'Mock terminal' in screen(), 'frame of the fresh session')
    outer('pipe-pane', '-t', 'view', f'cat >> {RAW}')
    keys('C-g') # the startup notice
    settled()


def complete(data):
    """[data] without an update still being written (the pipe can end between its halves)."""
    cut = data.rfind(b'\x1b[?2026h')
    return data[:cut] if cut >= 0 and SYNC.search(data, cut + 8) is None else data


def burst(act, seen=lambda data: len(data) > 0):
    """Run [act]; wait for the bytes it causes ([seen] of the whole updates written so far),
    then for hn to go quiet, so a second, unwanted repaint would show; return the bytes."""
    return burst_after(act, seen)[0]


def burst_after(act, seen):
    """As burst, with the seconds from the key (delivered) to the first sight of [seen]."""
    at = mark()
    act()
    begun = time.monotonic()
    wait(lambda: seen(complete(written(at))), 'the expected bytes were not written')
    took = time.monotonic() - begun
    settled()
    return written(at), took


mock = None
started = False
try:
    with socket.socket() as probe:
        # As the mock sets it: a port in TIME_WAIT from the last run is free, a live listener is not.
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
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

    # The byte stream: what a fresh hn (verifying its output) writes, as the terminal receives it.
    start_session(f'HARNESS_TUI_VERIFY={VERIFY}')
    rows = size()[1]
    soft = lambda data: len(soft_repaints(data, rows)) >= 1
    hard = lambda data: len(hard_clears(data)) >= 1

    def one_soft(data, label):
        assert len(soft_repaints(data, rows)) == 1, f'{label}: {len(soft_repaints(data, rows))} soft repaints, {len(updates(data))} updates'
        assert len(updates(data)) == 1, f'{label}: more than one update'
        assert not hard_clears(data), f'{label}: a hard clear'

    def no_repaint(data, label):
        assert data and not soft_repaints(data, rows) and not hard_clears(data), f'{label}: repainted'

    at = mark()
    time.sleep(1.2)
    assert mark() == at, 'an idle hn wrote bytes'
    print('PASS repaint: an idle hn writes no bytes', flush=True)

    # Focus-in repaints softly, once; so does Ctrl-L in a picker (the command panel).
    one_soft(burst(lambda: keys('-H', '1b', '5b', '49'), soft), 'focus-in')
    keys('C-b', 'Enter')
    wait(lambda: 'Commands' in screen(), 'command panel opens')
    settled()
    one_soft(burst(lambda: keys('C-l'), soft), 'Ctrl-L')

    # (Two requests in one loop pass giving one repaint is decided inside hn's loop, which the
    # input thread's timing keeps a terminal from reproducing: `redraw_all` is one flag the loop
    # takes once per pass, and each check above asserts one update per request.)
    print('PASS repaint: focus-in and Ctrl-L repaint softly, once each', flush=True)

    # Closing the command panel: one settle rewrite of the rows it touched, within 400 ms of the
    # key (plus what delivering a key costs, measured here), not at once, and never again by itself.
    started_at = time.monotonic()
    for _ in range(3): outer('display-message', '-p', 'x')
    overhead = (time.monotonic() - started_at) / 3 + .05 # a tmux call, and wait()'s poll step
    data, took = burst_after(lambda: keys('Escape'), lambda d: len(updates(d)) >= 2)
    rewritten = settle_rewrite(data, rows, 'command panel close')
    assert len(updates(data)) == 2, f'command panel close: {len(updates(data))} updates, not the close and one settle'
    assert .1 <= took <= .4 + overhead, f'the settle rewrite came {took:.3f}s after the key (overhead allowed {overhead:.3f})'
    assert 'Commands' not in screen()
    print(f'PASS repaint: the command panel closes with one settle rewrite of {len(rewritten)} rows ({took:.2f}s), then silence', flush=True)

    # New Harness: opening and typing do not repaint; closing settles once.
    hn('workspace-menu', 'new-harness')
    wait(lambda: 'New Harness' in screen(), 'New Harness opens')
    settled()
    no_repaint(burst(lambda: keys('-l', 'repaint check text')), 'typing in New Harness')
    no_repaint(burst(lambda: keys(*['BSpace'] * 20)), '20 backspaces')
    data = burst(lambda: keys('Escape'), lambda d: len(updates(d)) >= 2)
    settle_rewrite(data, rows, 'New Harness close')
    assert 'New Harness' not in screen()
    print('PASS repaint: New Harness open, typing and 20 backspaces, close', flush=True)

    # Streaming output: lines the mock echoes back scroll the pane, a burst of cells written one by
    # one; once it rests, only the rows it wrote are rewritten — not the whole screen.
    text = ''.join(f'REPAINT_STREAM {i:02d} ' + 'x' * 60 + '\r' for i in range(40))
    data = burst(lambda: keys('-l', text), lambda d: len(updates(d)) >= 2)
    rewritten = settle_rewrite(data, rows, 'streaming output')
    assert 'REPAINT_STREAM 39' in screen()
    print(f'PASS repaint: streaming output settles with a rewrite of the {len(rewritten)} rows it wrote', flush=True)

    # A real size change hard-clears, inside its update.
    for width, height in [(100, 30), (120, 32)]:
        data = burst(lambda: resize(width, height), hard)
        assert len(hard_clears(data)) == 1, f'resize to {width}x{height}: {len(hard_clears(data))} hard clears'
    print('PASS repaint: a resize hard-clears inside one synchronized update', flush=True)

    # Over the whole run: balanced, never nested, every clear inside a pair; no stale cell.
    updates(written(0))
    check_replay()
    print('PASS repaint: pairs balanced, no hard clear outside one, replayed screen matches', flush=True)

    # Without synchronized output: no ?2026 at all, the screen is still right.
    start_session(f'HARNESS_TUI_VERIFY={VERIFY}', 'HARNESS_TUI_SYNC=off')
    data = burst(lambda: keys('C-b', 'Enter'))
    wait(lambda: 'Commands' in screen(), 'panel')
    data += burst(lambda: keys('Escape'))
    assert CLEAR not in data, 'opening and closing a panel erased the whole screen'
    for width, height in [(100, 30), (120, 32)]:
        data += burst(lambda: resize(width, height), lambda d: CLEAR in d) # the size changed: a hard clear
    assert b'2026' not in data, 'HARNESS_TUI_SYNC=off still wrote ?2026'
    assert 'Commands' not in screen() and 'Mock terminal' in screen()
    check_replay()
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
