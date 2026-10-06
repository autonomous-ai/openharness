#!/usr/bin/env python3
"""Real shell widgets and native picker in private PTYs; two-computer catalogs.

The fixture answers only completion requests. Starting an agent is a failure.
HN_COMPOSER_TEST_BINARY and optional HN_COMPOSER_TEST_BASH name built executables.
"""
import base64
import faulthandler
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shlex
import signal
import struct
import tempfile
import termios
import time

faulthandler.enable()
faulthandler.dump_traceback_later(120, exit=True)
ROOT = Path(__file__).resolve().parents[1]
TOKEN = 'a7dbb7d9-5a19-43ae-84cc-fc35b0ff2b02'
REQUEST = re.compile(rb'\x1b\]633;hn;([^;]+);([^;]+);([^;]+);([^\x07]*)\x07')
BINARY = str(Path(os.environ['HN_COMPOSER_TEST_BINARY']).resolve())


class Shell:
    def __init__(self, root, shell):
        self.root, self.data, self.wire = root, b'', b''
        self.requests, self.answered = [], set()
        self.snapshot = root / 'snapshot'
        self.done = root / 'done'
        # Test-only observation/loading widgets preserve the exact Readline/ZLE
        # buffer. All completion keys still run the shipped shell integration.
        zsh = """PS1='READY> '
_test_load() { IFS= read -r BUFFER < "$HOME/draft"; CURSOR=${#BUFFER}; }
_test_snapshot() { printf '%s\\0%s\\0' "$BUFFER" "$CURSOR" > "$HOME/snapshot"; }
zle -N _test_load; zle -N _test_snapshot
bindkey '^X^V' _test_load; bindkey '^X^B' _test_snapshot
"""
        bash = """PS1='READY> '
_test_load() { IFS= read -r READLINE_LINE < "$HOME/draft"; READLINE_POINT=${#READLINE_LINE}; }
_test_snapshot() { printf '%s\\0%s\\0' "$READLINE_LINE" "$READLINE_POINT" > "$HOME/snapshot"; }
bind -x '"\\C-x\\C-v": _test_load'
bind -x '"\\C-x\\C-b": _test_snapshot'
"""
        (root / '.zshrc').write_text(zsh)
        (root / '.bashrc').write_text(bash)
        wrapper = root / 'picker'
        wrapper.write_text('#!/bin/sh\n' + shlex.quote(BINARY) + ' "$@"\ncode=$?\nprintf "done\\n" >> "$HOME/done"\nexit "$code"\n')
        wrapper.chmod(0o755)
        bootstrap = (ROOT / 'src/shell_bootstrap.sh').read_text().replace('@INTEGRATION@', (ROOT / 'src/shell_integration.sh').read_text())
        self.pid, self.fd = pty.fork()
        if not self.pid:
            os.chdir(root)
            env = dict(HOME=str(root), SHELL=shell, PATH='/usr/bin:/bin:/usr/sbin:/sbin',
                       TERM='xterm-256color', COLORTERM='truecolor', LANG='en_US.UTF-8',
                       TMPDIR=str(root), _HN_CONTEXT=TOKEN, _HN_PICKER=str(wrapper), skip_global_compinit='1')
            os.execve('/bin/sh', ['/bin/sh', '-c', bootstrap], env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 34, 120, 0, 0))
        self.wait(lambda: b'READY> ' in self.data, 'shell startup')

    def send(self, text):
        os.write(self.fd, text.encode() if isinstance(text, str) else text)

    def pump(self):
        if not select.select([self.fd], [], [], .02)[0]:
            return
        chunk = os.read(self.fd, 65536)
        self.data += chunk
        self.wire += chunk
        # This fixture terminal reports the shell prompt's cursor position.
        while b'\x1b[6n' in self.wire:
            self.wire = self.wire.replace(b'\x1b[6n', b'', 1)
            self.send(b'\x1b[2;8R')
        while match := REQUEST.search(self.wire):
            self.wire = self.wire[match.end():]
            assert match[1].decode() == TOKEN
            request_id = match[2].decode()
            if request_id in self.answered:
                continue
            self.answered.add(request_id)
            verb = match[3].decode()
            if verb == 'close-picker':
                continue
            assert verb in ('list-compose', 'list-sessions'), ('completion launched or switched the shell', verb, base64.b64decode(match[4]))
            args = json.loads(base64.b64decode(match[4]))
            args.setdefault('kind', 'sessions')
            self.requests.append((verb, args))
            host = args.get('compose', {}).get('host')
            machine = 'remote-id' if host in ('Office', 'office', 'remote-id') else 'local-id'
            kind = args['kind']
            if kind == 'host':
                rows = [dict(id='M2', label='M2', extra='local-id'), dict(id='Office', label='Office', extra='remote-id')]
            elif kind == 'folder':
                path = '~/office-project' if machine == 'remote-id' else '~/mac-project'
                rows = [dict(id=path, label=path)]
            elif kind == 'agent':
                rows = [dict(id='codex', label='Codex'), dict(id='claude', label='Claude Code')]
            elif kind == 'sessions':
                rows = []
            else:
                raise AssertionError(('unexpected completion scope', kind))
            catalog = dict(rows=rows, machine=machine, folder='~')
            path = self.root / '.harness/shell-requests' / TOKEN / request_id
            data = path.with_suffix('.json')
            try:
                if not path.exists():
                    continue  # the user changed scope before this reply
                data.write_text(json.dumps(catalog))
                data.chmod(0o600)
                fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
                os.write(fd, ('HN:' + request_id + ':0:\n').encode())
                os.close(fd)
            except OSError:
                if path.exists():
                    raise

    def wait(self, predicate, label, seconds=6):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if predicate():
                return
            self.pump()
        raise AssertionError((label, self.data[-5000:], self.requests[-4:]))

    def count(self):
        return self.done.read_text().count('done') if self.done.exists() else 0

    def buffer(self):
        self.snapshot.unlink(missing_ok=True)
        self.send('\x18\x02')
        self.wait(lambda: self.snapshot.exists() and self.snapshot.read_bytes().count(b'\0') == 2, 'shell buffer snapshot')
        line, cursor, _ = self.snapshot.read_bytes().split(b'\0')
        return line.decode(), int(cursor)

    def load(self, line):
        (self.root / 'draft').write_text(line + '\n')
        self.send('\x18\x16')
        assert self.buffer() == (line, len(line))

    def scope(self, kind, start, host=None):
        self.wait(lambda: any(a['kind'] == kind and (host is None or a.get('compose', {}).get('host') == host)
                              for _, a in self.requests[start:]), kind + ' catalog')
        # Let the response be read and drawn before sending Enter.
        end = time.monotonic() + .12
        while time.monotonic() < end:
            self.pump()

    def host(self, name):
        start = len(self.requests)
        self.send('\x10')
        self.scope('sessions', start)
        self.send('@')
        self.scope('host', start)
        self.send(name + '\r')

    def close(self):
        os.close(self.fd)
        end = time.monotonic() + 2
        while time.monotonic() < end:
            if os.waitpid(self.pid, os.WNOHANG)[0]:
                return
            time.sleep(.02)
        os.kill(self.pid, signal.SIGKILL)
        os.waitpid(self.pid, 0)


def check(shell):
    with tempfile.TemporaryDirectory(prefix='hn-machine-composer-') as tmp:
        s = Shell(Path(tmp), shell)
        try:
            # The complete user path: Ctrl-N, Codex, local folder, then Office.
            start = len(s.requests); n = s.count()
            s.send('\x0e'); s.scope('agent', start); s.send('codex\r')
            s.wait(lambda: s.count() == n + 1, 'Codex chosen')
            assert s.buffer()[0] == 'codex '
            start = len(s.requests); n = s.count()
            s.send(':'); s.scope('folder', start); s.send('\r')
            s.wait(lambda: s.count() == n + 1, 'local folder chosen')
            assert ':~/mac-project' in s.buffer()[0]
            start = len(s.requests); n = s.count()
            s.send('@'); s.scope('host', start); s.send('Office\r')
            s.scope('folder', start, 'Office')
            assert s.count() == n, 'machine selection must continue to folders'
            s.send('\r'); s.wait(lambda: s.count() == n + 1, 'Office folder chosen')
            line, cursor = s.buffer()
            assert sorted(shlex.split(line)) == sorted(['codex', ':~/office-project', '@Office']), line
            assert cursor == len(line)

            # Implicit/local/name/id aliases all preserve the same-machine folder.
            for host in ('', '@local ', '@m2 ', '@local-id '):
                line = 'codex ' + host + "':~/日本語 old project' %gpt "
                s.load(line); start = len(s.requests); n = s.count()
                s.host('M2'); s.wait(lambda: s.count() == n + 1, 'same computer keeps folder')
                assert not any(a['kind'] == 'folder' for _, a in s.requests[start:]), s.requests[start:]
                words = shlex.split(s.buffer()[0])
                assert ':~/日本語 old project' in words and '@M2' in words and '%gpt' in words, words

            # Both spellings, no agent yet, literal native values, cancellation.
            for original in ("codex '@M2:~/日本語 old project' %gpt ",
                             "codex ':~/日本語 old project' %gpt ",
                             ":~/mac-project ",
                             "claude --prompt ':literal' :~/mac-project -- @literal :literal"):
                for cancel in ('\x1b', '\x03', '\x7f'):
                    s.load(original); n = s.count(); start = len(s.requests)
                    s.host('Office'); s.scope('folder', start, 'Office')
                    s.send(cancel); s.wait(lambda: s.count() == n + 1, 'cancel remote folders')
                    words = shlex.split(s.buffer()[0])
                    assert '@Office' in words and not any('old project' in w or 'mac-project' in w for w in words), words
                    if original.startswith('codex'):
                        assert words[0] == 'codex' and '%gpt' in words, words
                    if original.startswith('claude'):
                        assert words == ['claude', '--prompt', ':literal', '@Office', '--', '@literal', ':literal'], words
            assert b'No such widget' not in s.data, 'automatic completion displayed a missing ZLE widget error'
            print('PASS', shell, 'Ctrl-N agent -> folder -> different machine -> remote folder; same-machine aliases; Unicode; folder-first; native literals; Escape/Ctrl-C/backspace; no launch', flush=True)
        finally:
            s.close()


check('/bin/zsh')
if bash := os.environ.get('HN_COMPOSER_TEST_BASH'):
    check(bash)
