#!/usr/bin/env python3
"""Drive the installed hn UI in a disposable, signed-out home with real agents.

`fresh-user.py start` runs the public curl installer and opens hn in a private
terminal. Subsequent commands use the printed --state path. All product actions
are terminal keys or mouse input; daemon requests are read-only verification.
Keep the state and captures as evidence, and run `stop` to close only this rig.
"""
import argparse
import http.client
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


class User:
    def __init__(self, state):
        self.path = Path(state).resolve()
        self.state = json.loads(self.path.read_text())
        self.root = self.path.parent
        assert self.root.name.startswith('hn-user-') and self.state['root'] == str(self.root)
        self.env = self.state['env']
        self.home = Path(self.env['HOME'])
        assert self.home.parent == self.root

    def outer(self, *args, check=True):
        return subprocess.run([self.state['tmux'], '-S', str(self.root / 'outer.sock'), *args],
                              env=self.env, cwd=self.home, capture_output=True, text=True,
                              check=check, timeout=15)

    def screen(self, ansi=False):
        return self.outer('capture-pane', '-p', *(['-e'] if ansi else []), '-t', 'user').stdout

    def keys(self, *keys):
        self.outer('send-keys', '-t', 'user', *keys)
        self.settle()

    def settle(self):
        previous, changed = None, time.monotonic()
        deadline = changed + 5
        while time.monotonic() < deadline:
            # Both the popup and pane chrome can be borderless. Ignore the animated
            # braille spinners while waiting for text and mouse targets to settle.
            signature = tuple(re.sub(r'[\u2800-\u28ff]', ' ', line)
                              for line in self.screen().splitlines())
            if signature != previous:
                previous, changed = signature, time.monotonic()
            elif time.monotonic() - changed >= .15:
                return
            time.sleep(.025)
        raise AssertionError('Popup did not settle\n' + self.screen())

    def native(self, *args):
        return subprocess.check_output([str(self.home / '.harness/bin/harness-tui'), *args],
                                       env=self.env, cwd=self.home, text=True, timeout=15).strip()

    def zoom(self):
        if self.native('display-message', '-p', '#{window_zoomed_flag}') != '1':
            self.keys('C-b', 'z')

    def text(self, text):
        self.outer('send-keys', '-l', '-t', 'user', text)

    def click(self, x, y):
        for suffix in ('M', 'm'):
            self.outer('send-keys', '-H', '-t', 'user',
                       *[f'{b:02x}' for b in f'\x1b[<0;{x+1};{y+1}{suffix}'.encode()])

    def field(self, label):
        self.settle()
        for y, line in enumerate(self.screen().splitlines()):
            match = re.search(r'(?<![^\s│›])(' + re.escape(label) + r')(?: {2,}|$)', line)
            if match:
                self.click(match.start(1), y)
                self.settle()
                return
        raise AssertionError(f'No visible field {label}\n{self.screen()}')

    def wait(self, text, seconds=30):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            screen = self.screen()
            # Messages can wrap across popup rows, with the working panes visible beside them.
            popup = ' '.join(line[line.index('│') + 1:line.rindex('│')].strip()
                             for line in screen.splitlines() if line.count('│') >= 2)
            # The current form is borderless. Read wrapped messages inside its
            # centered surface, without interleaving text from the panes beside it.
            lines = screen.splitlines()
            width = int(self.outer('display-message', '-p', '-t', 'user', '#{pane_width}').stdout.strip())
            panel_width = min(60, max(0, width - 4))
            left = (width - panel_width) // 2
            panel = ' '.join(' '.join(line[left:left+panel_width].split()) for line in lines)
            if text in screen or text in popup or text in panel or text in ' '.join(screen.split()):
                return screen
            time.sleep(.1)
        raise AssertionError(f'Did not see {text!r}\n{screen}')

    def snapshot(self, name):
        assert re.fullmatch(r'[a-zA-Z0-9_-]+', name)
        directory = self.root / 'captures'
        directory.mkdir(exist_ok=True)
        for ansi, suffix in [(False, 'txt'), (True, 'ansi')]:
            (directory / f'{name}.{suffix}').write_text(self.screen(ansi))

    def check(self, predicate, label, seconds=30):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            value = predicate()
            if value:
                return value
            time.sleep(.1)
        raise AssertionError(label + '\n' + self.screen())

    def record(self, name, **details):
        self.snapshot(name)
        path = self.root / 'results.json'
        rows = json.loads(path.read_text()) if path.exists() else {}
        rows[name] = dict(result='pass', evidence=f'captures/{name}.txt', **details)
        path.write_text(json.dumps(rows, indent=2) + '\n')
        print('PASS ' + name, flush=True)

    def choose(self, label, query, hint):
        self.field(label)
        self.wait(hint)
        self.text(query)
        self.keys('Enter')

    def form(self, engine=None):
        self.keys('C-b', 'N')
        self.wait('Task')
        if engine:
            self.choose('Agent', engine, 'Search agents')

    def project(self, action, value):
        self.choose('Project', action, 'Search projects')
        self.wait('Choose a machine')
        self.keys('Enter')
        if action == 'open folder':
            self.wait('Use this folder')
            self.keys('C-l', 'C-u')
            self.wait('/path/to/project')
            self.text(value)
            self.keys('Enter')
            self.wait('Use this folder')
            self.keys('Enter')
        else:
            self.wait('Folder name' if action == 'new folder' else 'GitHub URL')
            self.text(value)
            self.keys('Enter')
        self.wait('Task')

    def launch(self, engine, label, double_enter=False, click_create=False):
        before = {s['id'] for s in self.status()['sessions']}
        if click_create:
            self.field('Start ' + {'codex': 'Codex', 'claude': 'Claude Code', 'terminal': 'Terminal'}[engine])
        else:
            self.keys(*(['Enter', 'Enter'] if double_enter else ['Enter']))
        added = self.check(lambda: [s for s in self.status()['sessions'] if s['id'] not in before],
                           'A new harness should become available', 180)
        assert len(added) == 1 and added[0]['engine'] == engine, added
        self.check(lambda: not re.search(r'(?<![^\s│›])Task {2,}', self.screen()), 'Form closes after launch')
        self.zoom()
        markers = {'codex': ['Welcome to Codex'],
                   'claude': ['Choose the text style', 'Select login method'],
                   'terminal': ['Terminal on']}[engine]
        self.check(lambda: any(marker in self.screen() for marker in markers),
                   'Real agent onboarding or terminal prompt', 180)
        assert 'TERMINAL_OPEN_INVALID' not in self.screen()
        self.record(label, engine=engine, cwd=added[0]['cwd'])
        return added[0]

    def close_view(self):
        pane = self.native('display-message', '-p', '#{pane_id}')
        def closed():
            return pane not in self.native('list-panes', '-s', '-F', '#{pane_id}').splitlines()
        self.keys('C-b', 'x')
        self.check(lambda: closed() or '(s)' in self.screen() or 'kill-pane' in self.screen(),
                   'Stop completes or offers confirmation')
        if not closed():
            self.keys('s' if '(s)' in self.screen() else 'y')
        self.check(closed, 'Confirmed Stop removes its pane', 60)

    def status(self):
        conn = http.client.HTTPConnection('localhost', timeout=3)
        conn.sock = socket.socket(socket.AF_UNIX)
        conn.sock.settimeout(3)
        try:
            conn.sock.connect(str(self.home / '.harness/cli/data' / f'daemon-{self.env["PORT"]}.sock'))
            conn.request('GET', '/api/status')
            response = conn.getresponse()
            assert response.status == 200
            return json.load(response)
        finally:
            conn.close()

    def stop(self):
        native = self.home / '.harness/bin/harness-tui'
        if native.exists():
            subprocess.run([str(native), 'kill-server'], env=self.env, cwd=self.home,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        launcher = self.home / '.local/bin/harness'
        if launcher.exists():
            subprocess.run([str(launcher), 'stop'], env=self.env, cwd=self.home,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=25)
        self.outer('kill-server', check=False)
        marker = self.home / '.harness/runtime/current-tmux'
        if marker.exists():
            subprocess.run([marker.read_text().strip(), 'kill-server'], env=self.env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)


def start():
    root = Path(tempfile.mkdtemp(prefix='hn-user-', dir='/tmp')).resolve()
    home = root / 'home'
    for path in (home, root / 'tmp', root / 'tmux', root / 'hn'):
        path.mkdir(mode=0o700)
    tmux = shutil.which('tmux')
    assert tmux, 'tmux is needed only to drive the outer test terminal'
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    env = dict(HOME=str(home), TMPDIR=str(root / 'tmp'), PATH='/usr/bin:/bin:/usr/sbin:/sbin',
               SHELL='/bin/zsh' if Path('/bin/zsh').exists() else '/bin/bash',
               LANG='en_US.UTF-8', TERM='xterm-256color', COLORTERM='truecolor',
               PORT=str(port), TMUX_TMPDIR=str(root / 'tmux'), HN_TMPDIR=str(root / 'hn'),
               HN_SOCKET_NAME='fresh-user', HARNESS_HOMEBREW_PREFIXES=str(root / 'no-homebrew'),
               ANALYTICS_ENABLED='false', HARNESS_DAEMONS='0', HN_DESKTOP='off',
               HARNESS_TUI_NOTIFY='off', ADAPTER_UPDATE_DISABLE='true',
               GIT_TERMINAL_PROMPT='0', CABLE_DISABLE='true', CABLE_FW_DISABLE='true')
    path = root / 'state.json'
    path.write_text(json.dumps(dict(root=str(root), env=env, tmux=tmux), indent=2))
    print(f'State: {path}', flush=True)
    with (root / 'install.log').open('w') as log:
        result = subprocess.run(['/bin/bash', '-o', 'pipefail', '-c',
                                 'curl -fsSL https://autonomous.ai/harness.sh | bash'],
                                env=env, cwd=home, stdout=log, stderr=subprocess.STDOUT, timeout=600)
    assert result.returncode == 0, (root / 'install.log').read_text()
    # Optional local candidates are applied only after the real public installer completes.
    for variable, destination in [('HN_FRESH_USER_CLI', home / '.harness/cli/cli.js'),
                                  ('HN_FRESH_USER_BINARY', home / '.harness/bin/harness-tui')]:
        if os.environ.get(variable):
            shutil.copy2(os.environ[variable], destination)
    env['PATH'] = f'{home}/.local/bin:' + env['PATH']
    path.write_text(json.dumps(dict(root=str(root), env=env, tmux=tmux), indent=2))
    user = User(path)
    versions = subprocess.run([str(home / '.local/bin/harness'), 'version'], env=env,
                              capture_output=True, text=True, check=True).stdout
    versions += subprocess.run([str(home / '.local/bin/hn'), '--version'], env=env,
                               capture_output=True, text=True, check=True).stdout
    (root / 'versions.txt').write_text(versions)
    command = shlex.join(['env', '-u', 'TMUX', '-u', 'TMUX_PANE', '-u', 'HN_SOCKET',
                          *[f'{k}={v}' for k, v in env.items()], str(home / '.local/bin/hn')])
    user.outer('-f', '/dev/null', 'new-session', '-d', '-s', 'user', '-x', '130', '-y', '38', command)
    print(versions, flush=True)
    print('Started the real installed hn; use --state for keys, text, screen, snapshot, and stop.', flush=True)
    return user


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state')
    parser.add_argument('action', choices=['start', 'run', 'screen', 'keys', 'text', 'field', 'wait', 'snapshot', 'status', 'resize', 'stop'])
    parser.add_argument('args', nargs='*')
    args = parser.parse_args()
    user = start() if args.action == 'start' or (args.action == 'run' and not args.state) else User(args.state)
    if args.action == 'run':
        import runpy
        runpy.run_path(str(Path(__file__).with_name('fresh-user-journeys.py')))['run'](user, args.args)
    if args.action == 'screen': print(user.screen(), end='')
    elif args.action == 'keys': user.keys(*args.args)
    elif args.action == 'text': user.text(' '.join(args.args))
    elif args.action == 'field': user.field(' '.join(args.args))
    elif args.action == 'wait': print(user.wait(' '.join(args.args)), end='')
    elif args.action == 'snapshot': user.snapshot(args.args[0])
    elif args.action == 'status': print(json.dumps(user.status(), indent=2))
    elif args.action == 'resize': user.outer('resize-window', '-t', 'user', '-x', args.args[0], '-y', args.args[1])
    elif args.action == 'stop': user.stop()


if __name__ == '__main__': main()
