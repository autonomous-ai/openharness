#!/usr/bin/env python3
"""C-b Space and desk synchronization in real hn clients on private tmux servers.

Tests modern and legacy desk schemas, delayed writes, failures, and other clients.
HN_LAYOUT_TEST_BINARY selects the frozen build; ports are restricted to 19800..19809.
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
PORT = int(os.environ.get('HN_LAYOUT_TEST_PORT', '19801'))
assert 19800 <= PORT <= 19807, 'refusing non-test layout ports'
TMUX = shutil.which('tmux')
assert TMUX, 'tmux is required'
BINARY = os.environ.get('HN_LAYOUT_TEST_BINARY', ROOT / 'target/release/harness-tui')


def scenario(mode, port, read_only=False):
    base = Path(tempfile.mkdtemp(prefix='hnls-', dir='/tmp')).resolve()
    binary = base / 'hn'
    shutil.copy2(BINARY, binary)
    prefix = f'hn-layout-{os.getpid()}-{port}'
    env = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TZ') if k in os.environ}
    env.update(HOME=str(base), HN_TMPDIR=str(base), HN_SOCKET_NAME=prefix, PORT=str(port),
               ADAPTER_DATA_DIR=str(base / 'data'),
               TERM='xterm-256color', SHELL='/bin/sh', HARNESS_TUI_DESK='read' if read_only else 'sync',
               HN_DESKTOP='off', HARNESS_TUI_NOTIFY='off', MOCK_DEMO='1', MOCK_LAYOUT='1', MOCK_SHARED_LAYOUT='1', MOCK_DESK=mode)
    peer_env = dict(env, HOME=str(base / 'peer'), HN_SOCKET_NAME=prefix + '-peer')
    (base / 'peer').mkdir()
    config = base / 'tmux.conf'
    config.write_text('set -g automatic-rename off\n')
    mock = None
    started = False

    def hn(*args, peer=False, ok=True):
        client_env = peer_env if peer else env
        assert 19800 <= port <= 19809 and client_env['HN_SOCKET_NAME'].startswith('hn-layout-')
        p = subprocess.run([str(binary), '-L', client_env['HN_SOCKET_NAME'], '--port', str(port),
                            '-f', str(config), *args], env=client_env, cwd=base, text=True,
                           capture_output=True, timeout=12)
        if ok:
            assert p.returncode == 0, (args, p.stdout, p.stderr)
        return p.stdout.strip()

    def tmux(*args, ok=True):
        p = subprocess.run([TMUX, '-L', prefix + '-outer', *args], env=env, cwd=base,
                           text=True, capture_output=True, timeout=10)
        if ok:
            assert p.returncode == 0, (args, p.stderr)
        return p.stdout.strip()

    def api(path='/api/desk', body=None):
        req = urllib.request.Request(f'http://127.0.0.1:{port}{path}',
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=2) as response:
            return json.load(response)['data']

    def wait(fn, label, seconds=8):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if fn():
                return
            time.sleep(.05)
        raise AssertionError(label + '\n' + tmux('capture-pane', '-p', '-t', 'main', ok=False))

    def start(peer=False, count=3):
        client_env = peer_env if peer else env
        command = shlex.join(['env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'HN_SOCKET',
                              *[f'{k}={v}' for k, v in client_env.items()], str(binary), '-L',
                              client_env['HN_SOCKET_NAME'], '--port', str(port), '-f', str(config)])
        tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'peer' if peer else 'main',
             '-x', '96' if peer else '120', '-y', '32' if peer else '36', command)
        if count == 3:
            wait(lambda: 'api/handler.ts' in tmux('capture-pane', '-p', '-t', 'peer' if peer else 'main') or 'Fix flaky login test' in tmux('capture-pane', '-p', '-t', 'peer' if peer else 'main'), 'initial desk')
        wait(lambda: hn('display-message', '-p', '#{window_panes}', peer=peer, ok=False) == str(count), f'{count} desk panes')

    def layout(peer=False):
        return hn('display-message', '-p', '#{window_layout}', peer=peer)

    def placed(peer=False):
        cells = [r.split('|') for r in hn('list-panes', '-F',
            '#{pane_id}|#{pane_title}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}', peer=peer).splitlines()]
        return sorted(cells, key=lambda r: (int(r[3]), int(r[2])))

    def names(peer=False):
        return [r[1] for r in placed(peer)]

    def desk_names():
        return [titles[(p['machineId'], p['agentId'])] for p in api()['tabs'][0]['panes']]

    def columns(peer=False):
        rows = [row.split() for row in hn('list-panes', '-F', '#{pane_left} #{pane_top}', peer=peer).splitlines()]
        return len(rows) == 3 and len({r[0] for r in rows}) == 3 and len({r[1] for r in rows}) == 1

    def rows(peer=False):
        cells = [row.split() for row in hn('list-panes', '-F', '#{pane_left} #{pane_top}', peer=peer).splitlines()]
        return len(cells) == 3 and len({r[0] for r in cells}) == 1 and len({r[1] for r in cells}) == 3

    def unrelated_update():
        # A change on another computer, without changing this tab's layout.
        api('/api/desk/ops', {'ops': [{'op': 'tab.rename', 'id': 'demo-2', 'name': 'Remote rename', 'nameIsCustom': True}]})
        time.sleep(.25)

    def stable(expected, seconds=1):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            actual = layout()
            assert actual == expected, f'{mode}: layout reverted\nexpected {expected}\nactual   {actual}'
            time.sleep(.1)

    try:
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(('127.0.0.1', port))
        mock = subprocess.Popen(['node', str(ROOT / 'tests/mock-daemon.mjs'), str(port)], env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(100):
            assert mock.poll() is None, mock.stderr.read().decode() if mock.poll() is not None else ''
            try:
                api('/api/status')
                break
            except OSError:
                time.sleep(.05)
        else:
            raise AssertionError('mock startup timeout')
        started = True
        start()
        initial = api()['tabs'][0]['panes']
        titles = {(p['machineId'], p['agentId']): row[1] for p, row in zip(initial, placed())}
        assert len(titles) == 3
        before = layout()
        tmux('send-keys', '-t', 'main', 'C-b', 'Space')
        wait(columns, 'C-b Space must select even-horizontal and keep it')
        chosen = layout()
        assert chosen != before
        stable(chosen)
        unrelated_update()
        stable(chosen)
        print(f'PASS {mode}: real C-b Space, saved reply, unrelated desk update', flush=True)

        if read_only:
            assert not any(w for w in api('/test/layout')['writes'] if any(o['op'] == 'tab.layout' for o in w['ops']))
        else:
            expected_presets = {'even-vertical': 'rows', 'main-horizontal': 'oneOverTwo',
                                'main-horizontal-mirrored': 'twoOverOne', 'main-vertical': 'mainLeft',
                                'main-vertical-mirrored': 'mainRight', 'tiled': 'twoOverOne'}
            for name, desktop_preset in expected_presets.items():
                hn('select-layout', name)
                chosen = layout()
                stable(chosen, .25)
                wait(lambda: api()['tabs'][0]['layout'].get('presets', {}).get('3') == desktop_preset,
                     f'{name} publishes a desktop-compatible preset')
                wait(lambda: names() == desk_names(), f'{name} shares the same pane order as desktop')
            print(f'PASS {mode}: all seven named layouts survive acknowledgements and share their presets', flush=True)

            # The server delays the first save. Without serialization the newer save wins
            # briefly, then the older save lands and puts the previous layout back.
            api('/test/layout', {'delays': [700, 0]})
            count = len(api('/test/layout')['writes'])
            hn('select-layout', 'even-horizontal')
            wait(lambda: len(api('/test/layout')['writes']) > count, 'delayed write began')
            hn('select-layout', 'even-vertical')
            assert rows()
            chosen = layout()
            stable(chosen, 1.5)
            if mode == 'normal':
                assert api()['tabs'][0]['layout']['tmux'] == chosen
            unrelated_update()
            stable(chosen, .3)
            print(f'PASS {mode}: delayed older save cannot replace the last choice', flush=True)

            first = hn('list-panes', '-F', '#{pane_id}').splitlines()[0]
            hn('resize-pane', '-t', first, '-D', '3')
            resized = layout()
            assert resized != chosen
            stable(resized, .5)
            unrelated_update()
            stable(resized, .3)
            print(f'PASS {mode}: manual divider sizes survive sync', flush=True)

            if mode == 'normal':
                # A transient failure must not permanently disable tmux layout support.
                count = len(api('/test/layout')['writes'])
                api('/test/layout', {'failures': [500]})
                hn('select-layout', 'tiled')
                wait(lambda: len(api('/test/layout')['writes']) > count, 'failed save was attempted')
                chosen = layout()
                stable(chosen, .5)
                unrelated_update()
                stable(chosen, .3)
                assert len(api('/test/layout')['writes']) == count + 2, '500 incorrectly retried as legacy schema'
                hn('select-layout', 'even-horizontal')
                chosen = layout()
                wait(lambda: api()['tabs'][0]['layout'].get('tmux') == chosen, 'native layout still sent after 500')
                stable(chosen, .3)
                print('PASS normal: transient 500 keeps local geometry and native layout capability', flush=True)

                # Enough queued edits to cross the real backend's 200-operation limit.
                api('/test/layout', {'delays': [700]})
                count = len(api('/test/layout')['writes'])
                hn('rename-window', 'Queue start')
                wait(lambda: len(api('/test/layout')['writes']) > count, 'queue blocker began')
                commands = []
                for i in range(205):
                    if commands:
                        commands.append(';')
                    commands.extend(['rename-window', f'Queued {i}'])
                hn(*commands)
                wait(lambda: api()['tabs'][0]['name'] == 'Queued 204', 'all queued operations persisted')
                assert all(len(w['ops']) <= 200 for w in api('/test/layout')['writes'][count:])
                stable(chosen, .3)
                print('PASS normal: long edit bursts preserve order within backend batch limit', flush=True)

                count = len(api('/test/layout')['writes'])
                start(peer=True)
                wait(lambda: columns(peer=True), 'second client receives shared columns')
                tmux('resize-window', '-t', 'peer', '-x', '88', '-y', '28')
                stable(chosen, 1)
                assert len(api('/test/layout')['writes']) == count, 'fitting another terminal republished the shared layout'
                hn('select-layout', 'even-vertical', peer=True)
                wait(rows, 'explicit second-client layout reaches first client')
                stable(layout(), 1)
                assert len(api('/test/layout')['writes']) == count + 1, 'remote layout changes bounced between clients'
                print('PASS normal: two clients, different terminal sizes, deliberate remote layout change', flush=True)
                hn('kill-server', peer=True, ok=False)

        # A real remote layout choice must still apply (including in read-only mode).
        remote = {'presets': {'3': 'rows'}}
        api('/api/desk/ops', {'ops': [{'op': 'tab.layout', 'id': 'demo-1', 'layout': remote}]})
        wait(rows, 'remote preset must still apply')
        stable(layout(), .3)
        print(f'PASS {mode}: deliberate remote preset still applies', flush=True)

        # Desktop's drag sends pane.move without replacing the layout. This must
        # change the order, not rebuild equal dividers or change the focused harness.
        first, second = placed()[:2]
        hn('select-pane', '-t', second[0])
        hn('resize-pane', '-t', first[0], '-D', '2')
        time.sleep(.4)
        slots = [r[2:] for r in placed()]
        focused = hn('display-message', '-p', '#{pane_id}')
        moved = api()['tabs'][0]['panes'][-1]
        before_names = names()
        api('/api/desk/ops', {'ops': [{'op': 'pane.move', 'tabId': 'demo-1', **moved, 'index': 0}]})
        wait(lambda: names() == desk_names() and names() != before_names, 'remote pane order must follow desktop')
        assert [r[2:] for r in placed()] == slots, 'reordering changed divider sizes'
        assert hn('display-message', '-p', '#{pane_id}') == focused, 'reordering moved focus to a different harness'
        chosen = layout()
        unrelated_update()
        stable(chosen, .4)
        print(f'PASS {mode}: desktop reorder keeps unequal dividers, pane identities and focus', flush=True)

        # A simultaneous geometry change must use the new shared sequence too.
        moved = api()['tabs'][0]['panes'][-1]
        api('/api/desk/ops', {'ops': [
            {'op': 'pane.move', 'tabId': 'demo-1', **moved, 'index': 0},
            {'op': 'tab.layout', 'id': 'demo-1', 'layout': {'presets': {'3': 'cols3'}}}]})
        wait(lambda: columns() and names() == desk_names(), 'remote geometry and order apply together')

        # A removed/reopened harness can be inserted at the front rather than appended.
        removed = api()['tabs'][0]['panes'][-1]
        api('/api/desk/ops', {'ops': [{'op': 'pane.remove', 'tabId': 'demo-1', **removed}]})
        wait(lambda: hn('display-message', '-p', '#{window_panes}') == '2', 'pane removed before reinsertion')
        api('/api/desk/ops', {'ops': [{'op': 'pane.add', 'tabId': 'demo-1', **removed, 'index': 0}]})
        wait(lambda: len(names()) == 3 and names() == desk_names(), 'reopened pane appears at the shared index')
        print(f'PASS {mode}: simultaneous order/layout changes and insertion at the front', flush=True)

        # Keyboard reordering travels in the other direction without bouncing back.
        before_names = names()
        tmux('send-keys', '-t', 'main', 'C-b', 'C-o')
        wait(lambda: names() != before_names, 'C-b C-o rotates the panes')
        chosen = layout()
        if not read_only:
            wait(lambda: names() == desk_names(), 'keyboard rotation publishes pane order')
        unrelated_update()
        stable(chosen, .5)
        if not read_only:
            source, target = [r[0] for r in placed()[:2]]
            hn('swap-pane', '-s', source, '-t', target, '-d')
            wait(lambda: names() == desk_names(), 'pane swap publishes pane order')
        print(f'PASS {mode}: keyboard rotation and swaps preserve the shared sequence', flush=True)

        if mode == 'normal' and not read_only:
            # A fresh client may reuse numeric pane IDs in a different sequence.
            # The shared identities, not the saved tmux IDs, decide placement.
            start(peer=True)
            wait(lambda: names(peer=True) == desk_names(), 'reopened client follows shared order')
            hn('kill-server', peer=True, ok=False)
            print('PASS normal: fresh client agrees with desktop after reorder', flush=True)

        # The reported case: a two-pane window, with the desktop serializing only
        # presets/sizes and dropping hn's native geometry a few seconds later.
        removed = api()['tabs'][0]['panes'][-1]
        api('/api/desk/ops', {'ops': [{'op': 'pane.remove', 'tabId': 'demo-1', **removed}]})
        wait(lambda: hn('display-message', '-p', '#{window_panes}') == '2', 'two-pane desk window')
        hn('select-layout', 'even-horizontal')
        tmux('send-keys', '-t', 'main', 'C-b', 'Space')
        def two_rows():
            cells = [r.split() for r in hn('list-panes', '-F', '#{pane_left} #{pane_top}').splitlines()]
            return len(cells) == 2 and len({r[0] for r in cells}) == 1 and len({r[1] for r in cells}) == 2
        wait(two_rows, 'C-b Space changes two panes to rows')
        # An unequal divider makes an accidental reconstruction visible even when
        # desktop's coarse preset describes the same orientation.
        first = hn('list-panes', '-F', '#{pane_id}').splitlines()[0]
        hn('resize-pane', '-t', first, '-D', '3')
        chosen = layout()
        if not read_only:
            wait(lambda: api()['tabs'][0]['layout'].get('presets', {}).get('2') == 'rows',
                 'two-pane rows preset saved')
            if mode == 'normal':
                wait(lambda: api()['tabs'][0]['layout'].get('tmux') == chosen, 'two-pane divider saved')
        stable(chosen, .4)
        desktop = api()['tabs'][0]['layout']
        desktop.pop('tmux', None)
        desktop['sizes'] = {}
        api('/api/desk/ops', {'ops': [{'op': 'tab.layout', 'id': 'demo-1', 'layout': desktop}]})
        stable(chosen, 1)
        desktop.setdefault('presets', {})['4'] = 'quad'
        api('/api/desk/ops', {'ops': [{'op': 'tab.layout', 'id': 'demo-1', 'layout': desktop}]})
        stable(chosen, .5)
        desktop['presets']['2'] = 'columns'
        api('/api/desk/ops', {'ops': [{'op': 'tab.layout', 'id': 'demo-1', 'layout': desktop}]})
        wait(lambda: not two_rows(), 'an intentional two-pane remote layout still applies')
        print(f'PASS {mode}: two-pane C-b Space and unequal divider survive desktop round-trip', flush=True)

        if mode == 'normal' and not read_only:
            fixtures = json.loads((ROOT.parent / 'tests/fixtures/shared-pane-layouts.json').read_text())
            local = initial[0]['machineId']

            def exact_geometry(tiles, peer=False):
                native = layout(peer)
                w, h = map(int, re.match(r'[^,]+,(\d+)x(\d+)', native).groups())
                ids = {int(r.split('|')[0][1:]): r.split('|')[1] for r in hn('list-panes', '-F', '#{pane_id}|#{pane_title}', peer=peer).splitlines()}
                cells = re.findall(r'(\d+)x(\d+),(\d+),(\d+),(\d+)(?=[,}\]]|$)', native)
                if len(cells) != len(tiles):
                    return False
                for sx, sy, x, y, pane in (map(int, cell) for cell in cells):
                    index = int(ids[pane].rsplit(' ', 1)[1]) - 1
                    got = [x / (w + 1), y / (h + 1), (x + sx + 1) / (w + 1), (y + sy + 1) / (h + 1)]
                    if any(abs(a - b) > 1.01 / (w if axis % 2 == 0 else h) for axis, (a, b) in enumerate(zip(got, tiles[index]))):
                        return False
                return True

            for count, preset in [(5, 'middleMain'), (6, 'mainAndGrid'), (9, 'balanced5')]:
                tiles = next(f['tiles'] for f in fixtures if f['count'] == count and f['preset'] == preset)
                wire = {'presets': {str(count): preset}, 'sizes': {f'{count}:manual': tiles}, 'tmux': 'stale-native-layout'}
                ops = [{'op': 'pane.remove', 'tabId': 'demo-1', **p} for p in api()['tabs'][0]['panes']]
                ops += [{'op': 'pane.add', 'tabId': 'demo-1', 'machineId': local, 'agentId': f'shared-layout-{i + 1}', 'index': i} for i in range(count)]
                ops.append({'op': 'tab.layout', 'id': 'demo-1', 'layout': wire})
                api('/api/desk/ops', {'ops': ops})
                wait(lambda: exact_geometry(tiles), f'{count} panes match desktop rectangles and identities')
                writes = len(api('/test/layout')['writes'])
                original = layout()
                for width, height in [(84, 30), (180, 60), (120, 36)]:
                    tmux('resize-window', '-t', 'main', '-x', str(width), '-y', str(height))
                    wait(lambda: exact_geometry(tiles), f'{count} pane ratios survive {width}x{height}')
                wait(lambda: layout() == original, 'returning to original dimensions restores exact cells')
                hn('resize-pane', '-Z')
                hn('resize-pane', '-Z')
                assert len(api('/test/layout')['writes']) == writes, 'viewport or zoom published a layout'
                assert api()['tabs'][0]['layout'] == wire, 'rendering overwrote normalized ratios'
                print(f'PASS normal: {count} panes use desktop slots at three viewport sizes, with no resize/zoom writes', flush=True)

            start(peer=True, count=9)
            wait(lambda: exact_geometry(tiles, peer=True), 'fresh smaller client receives all nine desktop slots')
            source = hn('list-panes', '-F', '#{pane_id}').splitlines()[0]
            hn('resize-pane', '-t', source, '-R', '4')
            wait(lambda: api()['tabs'][0]['layout']['sizes']['9:manual'] != tiles, 'TUI divider publishes normalized slots')
            changed = api()['tabs'][0]['layout']['sizes']['9:manual']
            wait(lambda: exact_geometry(changed, peer=True), 'TUI divider reaches peer at different dimensions')
            hn('kill-server', peer=True, ok=False)
            print('PASS normal: nine-pane divider edit reaches another client without preset approximation', flush=True)
    finally:
        if started:
            hn('kill-server', ok=False)
            hn('kill-server', peer=True, ok=False)
            tmux('kill-server', ok=False)
        def clients():
            found = []
            for row in subprocess.check_output(['ps', '-ax', '-o', 'pid=,command='], text=True).splitlines():
                match = re.match(r'\s*(\d+)\s+(.*)', row)
                if match and match[2].startswith(str(binary) + ' ') and f'-L {prefix}' in match[2]:
                    found.append(int(match[1]))
            return found
        for pid in clients():
            try:
                os.kill(pid, 15)
            except ProcessLookupError:
                pass
        try:
            deadline = time.monotonic() + 5
            while clients() and time.monotonic() < deadline:
                time.sleep(.05)
            assert not clients(), 'layout test client did not exit'
        finally:
            if mock is not None:
                mock.terminate()
                mock.wait(timeout=5)
        shutil.rmtree(base)


scenario('strict', PORT)
scenario('normal', PORT + 1)
scenario('normal', PORT + 2, read_only=True)
