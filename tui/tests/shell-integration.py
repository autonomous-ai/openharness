#!/usr/bin/env python3
"""Private PTYs: real zsh/bash startup, helper protocol, native argv and tty recovery."""
import faulthandler
faulthandler.enable()
faulthandler.dump_traceback_later(120, exit=True)
import base64
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import tempfile
import time
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
TOKEN = '8c73ea55-683a-4207-a9aa-ab8a9e813bea'
REQUEST = re.compile(rb'\x1b\]633;hn;([^;]+);([^;]+);([^;]+);([^\x07]*)\x07')
PICKED = b'\x1b]633;picked\x07'
# Removes the progress line's two rows and returns to the row it started on.
ERASE = b'\r\x1b[2K\x1b[1A\x1b[2K\x1b[1A'
AGENTS = ('codex', 'claude', 'cursor-agent', 'opencode', 'pi', 'hermes', 'cmd', 'devin', 'muse', 'amp', 'kilo', 'grok', 'agy', 'copilot')

class Shell:
    def __init__(self, root, shell, custom=False):
        self.root = root
        self.capture = root / 'calls'
        binpath = root / 'bin'
        binpath.mkdir()
        for name in (*AGENTS, 'harness'):
            path = binpath / name
            path.write_text('#!/usr/bin/env python3\nimport os,sys,json\nwith open(os.environ["CALLS"],"a") as f: f.write(json.dumps(sys.argv)+"\\n")\n')
            path.chmod(0o755)
        picker=binpath/'native-picker'
        # With picker-mark, it also marks on the terminal the moment the choice is made.
        picker.write_text('#!/bin/sh\n[ -f "$HOME/picker-choice" ] || exit 130\n'
                          '[ ! -f "$HOME/picker-mark" ] || printf \'\\033]633;picked\\007\' >&2\ncat "$HOME/picker-choice"\n')
        picker.chmod(0o755)
        # With slow-od, making a request id takes a while (a busy machine).
        od=binpath/'od'
        od.write_text('#!/bin/sh\n[ ! -f "$HOME/slow-od" ] || sleep 3\nexec /usr/bin/od "$@"\n')
        od.chmod(0o755)
        for rc in ('.zshenv', '.zprofile', '.zshrc', '.zlogin', '.bashrc'):
            text = f"printf '%s\\n' '{rc}' >> \"$STARTUP\"\n"
            if rc in ('.zshrc', '.bashrc'):
                text += "PS1='READY> '\nPATH=\"$HOME/bin:/usr/bin:/bin:/usr/sbin:/sbin\"\nexport PATH\n"
                # These bindings stand in for existing user/fzf widgets. Harness
                # completion may wrap Tab but must never take over Ctrl-T/Ctrl-R.
                if rc=='.zshrc':
                    text += "_test_ctrl_t() { LBUFFER+='KEPT_T'; }; zle -N _test_ctrl_t; bindkey '^T' _test_ctrl_t\n"
                    text += "_test_ctrl_r() { LBUFFER+='KEPT_R'; }; zle -N _test_ctrl_r; bindkey '^R' _test_ctrl_r\n"
                else:
                    text += "bind '\"\\C-t\": \"KEPT_T\"'\nbind '\"\\C-r\": \"KEPT_R\"'\n"
                if custom:
                    text += "alias codex='printf ALIAS_CODEX\\\\n'\n"
                    text += "claude() { printf '%s\\n' 'FUNCTION_CLAUDE'; }\n"
                    text += "alias pi='printf ALIAS_PI\\\\n'\n"
            (root / rc).write_text(text)
        bootstrap = (ROOT / 'src/shell_bootstrap.sh').read_text().replace('@INTEGRATION@', (ROOT / 'src/shell_integration.sh').read_text())
        self.pid, self.fd = pty.fork()
        if not self.pid:
            # A terminal (tmux too) starts its shell with default signals. A runner
            # started with `&` ignores SIGINT, and a shell can never trap a signal
            # ignored on entry, so Ctrl-C could not cancel anything.
            signal.signal(signal.SIGINT, signal.SIG_DFL)
            signal.signal(signal.SIGQUIT, signal.SIG_DFL)
            os.chdir(root)
            env = {k:v for k,v in os.environ.items() if k in ('LANG','LC_ALL','TZ')}
            env.update(HOME=str(root), SHELL=shell, PATH=str(binpath)+':/usr/bin:/bin:/usr/sbin:/sbin', _HN_CLI=str(binpath/'harness'),
                       TERM='xterm-256color', STARTUP=str(root/'startup'), CALLS=str(self.capture),
                       TMPDIR=str(root), _HN_CONTEXT=TOKEN, _HN_PICKER=str(picker), skip_global_compinit='1')
            os.execve('/bin/sh', ['/bin/sh','-c',bootstrap], env)
        self.data = b''
        self.request_ids = set()
        self.read_until(b'READY> ')
    def send(self, text): os.write(self.fd, text.encode() if isinstance(text,str) else text)
    def read_until(self, pattern, seconds=5):
        end = time.monotonic()+seconds
        while time.monotonic()<end:
            hit = re.search(pattern, self.data) if hasattr(pattern, 'search') else (pattern in self.data)
            if hit:
                got,self.data = self.data,b''
                return got
            if select.select([self.fd],[],[],0.05)[0]:
                try: self.data += os.read(self.fd,65536)
                except OSError: break
        raise AssertionError((pattern,self.data[-6000:]))
    def request(self, command, verb, reply='', code=0):
        print('request',command,flush=True)
        self.send(command+'\r')
        data = self.read_until(REQUEST)
        match = REQUEST.search(data)
        assert match[1].decode()==TOKEN and match[3].decode()==verb, data
        assert match[2] not in self.request_ids, 'successive commands reused a request id'
        self.request_ids.add(match[2])
        self.reply(match, reply, code)
        return self.read_until(b'READY> ')
    def result(self, marker):
        # Bash bind-x may redraw PS1 while a command containing '%' is still
        # being edited. Only the expanded output line proves it ran.
        pattern=re.compile(rb'(?:^|\r?\n)(?:\r|\x1b\[[0-?]*[ -/]*[@-~])*'+re.escape(marker)+rb'\r?\n')
        data=self.read_until(pattern)
        if b'READY> ' not in data[pattern.search(data).end():]: self.read_until(b'READY> ')
        return data
    def reply(self, match, reply='', code=0):
        path = self.root/'.harness/shell-requests'/TOKEN/match[2].decode()
        with path.open('w') as out:
            out.write('HN:'+match[2].decode()+':'+str(code)+':'+base64.b64encode(reply.encode()).decode()+'\n')
    def calls(self): return [json.loads(s) for s in self.capture.read_text().splitlines()] if self.capture.exists() else []
    def close(self):
        self.send('exit\r')
        end=time.monotonic()+2
        while time.monotonic()<end:
            if os.waitpid(self.pid,os.WNOHANG)[0]: break
            if select.select([self.fd],[],[],.02)[0]:
                try: os.read(self.fd,65536)
                except OSError: pass
        else:
            os.close(self.fd)
            os.killpg(self.pid,signal.SIGKILL)
            return
        os.close(self.fd)

with tempfile.TemporaryDirectory(prefix='hn-shell-test-') as tmp:
    # An empty HN_SHELL_TEST_ZSH skips zsh (a machine with only a bash 5).
    for shell in filter(None,(os.environ.get('HN_SHELL_TEST_ZSH','/bin/zsh'),os.environ.get('HN_SHELL_TEST_BASH','/bin/bash'))):
        for custom in (False,True):
            root=Path(tmp)/(Path(shell).name+str(custom)); root.mkdir()
            print('starting',shell,custom,flush=True)
            s=Shell(root,shell,custom)
            try:
                expected=['.zshenv','.zprofile','.zshrc','.zlogin'] if shell.endswith('zsh') else ['.bashrc']
                assert (root/'startup').read_text().splitlines()==expected
                assert not list(root.glob('hn-shell.*')), 'rc overlay leaked'
                # Cancelling either picker returns without swallowing the next command.
                s.send('ch\r'); s.read_until(b'READY> ')
                s.send('cm\r'); s.read_until(b'READY> ')
                s.send("printf 'AFTER_CANCEL\\n'\r"); s.read_until(b'READY> ')
                # A direct shortcut opens from the middle of a draft. Selecting
                # a context sends one literal request; it must never execute or
                # replace the draft, and the editor keeps its cursor position.
                for kind,verb,value in [('model','model-inline','default'),
                                        ('host','host-inline',"office ' ; $(touch SHORTCUT_EVAL); # 日本語"),
                                        ('sessions','session-inline','external:local:saved')]:
                    (root/'picker-choice').write_text(kind+'\n'+value+'\n')
                    s.send("printf 'DRAFT_%s\\n' LRIGHT")
                    s.send('\x02'*5+'\x10')
                    match=REQUEST.search(s.read_until(REQUEST))
                    assert match[3].decode()==verb and base64.b64decode(match[4]).decode()==value
                    assert not (root/'SHORTCUT_EVAL').exists()
                    s.reply(match,'Changed.\n')
                    s.read_until(b'READY> ')
                    s.send('M\r')
                    s.result(b'DRAFT_LMRIGHT')
                # A computer that never answers: the widget says at once what it waits
                # for, Ctrl-C gives the prompt back with the line unchanged, and the
                # next pick is served.
                # The wait starts once the choice is made, not while the picker starts.
                (root/'picker-choice').write_text('host\nGone\n')
                (root/'picker-mark').touch()
                s.send("printf 'GONE_%s\\n' LRIGHT")
                s.send('\x02'*5+'\x10')
                seen=s.read_until(PICKED).split(PICKED,1)[1]
                t0=time.monotonic()
                (root/'picker-mark').unlink()
                if not REQUEST.search(seen): seen+=s.read_until(REQUEST)
                first=REQUEST.search(seen)
                assert first[3]==b'host-inline' and base64.b64decode(first[4])==b'Gone'
                progress='Opening a shell on Gone… Ctrl-C to cancel'.encode()
                if progress not in seen: seen+=s.read_until(progress,seconds=1)
                assert time.monotonic()-t0<1,'the progress line came too late'
                time.sleep(.3)    # nobody answers: the line must stay as it is meanwhile
                s.send('\x03')
                t0=time.monotonic()
                said=s.read_until(b'READY> ',seconds=1)
                assert time.monotonic()-t0<1,'Ctrl-C did not give the prompt back within 1 s'
                assert re.search(rb'633;hn;'+TOKEN.encode()+b';'+re.escape(first[2])+b';cancel;',said),'the request was not cancelled'
                # The rows the progress line added are gone again: only the prompt is left.
                assert ERASE in said.split(b'cancel;',1)[1],('the progress line was left behind',said)
                s.send('M\r')
                s.result(b'GONE_LMRIGHT')       # the line is exactly what it was
                # Right after it, another choice is served (the TUI freed the picker),
                # and the progress line names this computer as such.
                (root/'picker-choice').write_text('host\nlocal\n')
                s.send('\x10')
                seen=s.read_until(REQUEST)
                match=REQUEST.search(seen)
                assert match[3]==b'host-inline' and match[2]!=first[2]
                if b'Ctrl-C to cancel' not in seen: seen+=s.read_until(b'Ctrl-C to cancel')
                assert 'Opening a shell on this computer… Ctrl-C to cancel'.encode() in seen,seen
                s.reply(match); done=s.read_until(b'READY> ')
                assert ERASE in done,('the progress line was left behind',done)
                if shell.endswith('zsh'):
                    # The widget's localtraps ends with it: a user function's trap still holds after it.
                    s.send("[[ -o localtraps ]] && printf 'LT_%s\\n' ON || printf 'LT_%s\\n' OFF\r")
                    said=s.read_until(LT:=re.compile(rb'[\r\n]LT_(ON|OFF)\r?\n'))
                    assert LT.search(said)[1]==b'OFF',('LOCAL_TRAPS leaked into the shell',said)
                    if b'READY> ' not in said[LT.search(said).end():]: s.read_until(b'READY> ')
                # The widget keeps its saved trap to itself.
                s.send("[ -z \"${_hn_saved_int+x}\" ] && printf 'SV_%s\\n' CLEAN || printf 'SV_%s\\n' LEAKED\r")
                said=s.read_until(SV:=re.compile(rb'[\r\n]SV_(CLEAN|LEAKED)\r?\n'))
                assert SV.search(said)[1]==b'CLEAN',('the widget left _hn_saved_int behind',said)
                if b'READY> ' not in said[SV.search(said).end():]: s.read_until(b'READY> ')
                # Ctrl-C while the request is still being made says Cancelled, not a failure.
                (root/'slow-od').touch()
                (root/'picker-choice').write_text('host\nGone\n')
                s.send('\x10')
                s.read_until(b'Ctrl-C to cancel')
                time.sleep(.3)    # od is running now
                s.send('\x03')
                said=s.read_until(b'Cancelled.',seconds=2)
                assert b'Could not create' not in said,said
                # zsh draws the prompt before its message; bash after it.
                if shell.endswith('bash') and b'READY> ' not in said.split(b'Cancelled.',1)[1]: s.read_until(b'READY> ')
                (root/'slow-od').unlink()
                if not custom:
                    # An answer that comes just as the shell gives up is used, not
                    # reported as missing. (picker-ready gives up after 5 s.)
                    s.send("_hn_request picker-ready; printf 'RC_%s\\n' $?\r")
                    late=REQUEST.search(s.read_until(REQUEST))
                    assert late[3]==b'picker-ready'
                    s.read_until(re.compile(rb'633;hn;'+TOKEN.encode()+b';'+re.escape(late[2])+b';cancel;'),seconds=8)
                    s.reply(late,'JUST_IN_TIME\n')
                    said=s.read_until(RC:=re.compile(rb'[\r\n]RC_(\d+)\r?\n'),seconds=3)
                    assert b'JUST_IN_TIME' in said and RC.search(said)[1]==b'0' and b'did not answer' not in said,said
                    if b'READY> ' not in said[RC.search(said).end():]: s.read_until(b'READY> ')
                # The widget's own Ctrl-C guard must not drop the user's INT trap.
                s.send("trap 'echo MINE' INT\r"); s.read_until(b'READY> ')
                s.send('\x10')
                match=REQUEST.search(s.read_until(REQUEST))
                s.reply(match); s.read_until(b'READY> ')
                show='trap' if shell.endswith('zsh') else 'trap -p INT'
                s.send("printf 'TRAP_%s\\n' BEGIN; "+show+"; printf 'TRAP_%s\\n' END\r")
                kept=s.read_until(re.compile(rb'\nTRAP_END'))
                assert b'echo MINE' in kept.split(b'TRAP_BEGIN',2)[-1],('the INT trap was lost',kept)
                if b'READY> ' not in kept.rsplit(b'TRAP_END',1)[1]: s.read_until(b'READY> ')
                s.send("trap - INT\r"); s.read_until(b'READY> ')
                (root/'picker-choice').unlink()
                (root/'picker-choice').write_text('sessions\nexternal:local:missing\n')
                s.send('\x10')
                match=REQUEST.search(s.read_until(REQUEST))
                assert match[3]==b'session-inline'
                s.reply(match,'Could not open it: fixture folder is unavailable.',code=1)
                failed=s.read_until(b'Could not open it: fixture folder is unavailable.')
                # Bash prints the explanation before bind-x returns to Readline.
                # Wait for that redraw before cancelling; an old prompt must not
                # acknowledge Ctrl-C and race the next draft's first characters.
                if shell.endswith('bash') and b'READY> ' not in failed.split(b'Could not open it: fixture folder is unavailable.',1)[1]:
                    s.read_until(b'READY> ')
                s.send('\x03');s.read_until(b'READY> ')
                (root/'picker-choice').unlink()
                s.send("printf 'CANCEL_DRAFT_%s\\n' LRIGHT")
                s.send('\x02'*5+'\x10')
                s.read_until(b'READY> ')
                s.send('M\r')
                # A bind-x redraw can leave an earlier prompt in the PTY. Wait
                # for the command's actual result, not that pending redraw.
                s.result(b'CANCEL_DRAFT_LMRIGHT')
                # Tab selects INTO the current shell line, without taking the
                # action. Shell quoting must preserve every byte as literal data.
                malicious="office ' ; $(touch SHOULD_NOT_EXIST); # 日本語"
                (root/'picker-choice').write_text(malicious+'\n')
                s.send('ch \t')
                ready=s.read_until(b'office')
                assert not REQUEST.search(ready), 'completion executed instead of editing the draft'
                s.send('\r')
                match=REQUEST.search(s.read_until(REQUEST))
                assert match[3]==b'host-inline' and base64.b64decode(match[4]).decode()==malicious
                assert not (root/'SHOULD_NOT_EXIST').exists(), 'completion evaluated selected text'
                s.reply(match);s.read_until(b'READY> ')
                (root/'picker-choice').write_text('grid one :: model/test\n')
                s.send('cm \t');s.read_until(b'model/test');s.send('\r')
                match=REQUEST.search(s.read_until(REQUEST))
                assert match[3]==b'model-inline' and base64.b64decode(match[4])==b'grid one :: model/test'
                s.reply(match);s.read_until(b'READY> ')
                (root/'picker-choice').write_text('external:local:chosen\n')
                s.send('hn sessions \t');s.read_until(b'external');s.send('\r')
                match=REQUEST.search(s.read_until(REQUEST))
                assert match[3]==b'session-inline' and base64.b64decode(match[4])==b'external:local:chosen'
                s.reply(match);s.read_until(b'READY> ')
                (root/'picker-choice').unlink()
                # Cancellation retains a draft; a normal subsequent space/Enter
                # takes the same text, with no fallback filename completion.
                s.send('ch local\t');time.sleep(.08);s.send('\r')
                match=REQUEST.search(s.read_until(REQUEST))
                assert match[3]==b'host-inline' and base64.b64decode(match[4])==b'local'
                s.reply(match);s.read_until(b'READY> ')
                s.send("printf '%s\\n' \x14\x12\r")
                s.result(b'KEPT_TKEPT_R')
                s.send('ch local\r')
                match = REQUEST.search(s.read_until(REQUEST))
                s.send("printf 'TYPEAHEAD_%s\\n' OK\r")
                s.reply(match)
                # Zsh may enable bracketed paste after drawing PS1. Check the
                # result line and its following prompt, not the buffer suffix.
                s.result(b'TYPEAHEAD_OK')
                s.request('cm default','model-inline','Using defaults.\n')
                # A reattach may drop the initial output event. Retrying keeps the
                # same id, leaves typeahead alone, and cleans up the response FIFO.
                s.send('cm default\r')
                first = REQUEST.search(s.read_until(REQUEST))
                retry = REQUEST.search(s.read_until(REQUEST))
                assert first.groups() == retry.groups()
                s.reply(retry, code=1)
                s.read_until(b'READY> ')
                assert not list((root/'.harness/shell-requests').glob('*/*'))
                (root/'picker-choice').write_text('external:local:old-task\n')
                s.request('hn sessions old task','session-inline')
                (root/'picker-choice').unlink()
                if custom:
                    s.send('codex\r'); assert b'ALIAS_CODEX' in s.read_until(b'READY> ')
                    s.send('claude\r'); assert b'FUNCTION_CLAUDE' in s.read_until(b'READY> ')
                    s.send('pi\r'); assert b'ALIAS_PI' in s.read_until(b'READY> ')
                    s.request('hn run codex "a task"','route','grid one\nmodel/test')
                else:
                    for agent in AGENTS:
                        s.request(agent+' "native task"','route')
                        assert Path(s.calls()[-1][0]).name == agent
                        assert s.calls()[-1][1:] == ['native task']
                    before = len(s.calls())
                    result = s.request('pi','route','grid one\nmodel/test')
                    assert b'cm routing is not supported for pi' in result
                    assert len(s.calls()) == before, 'Pi must not silently use a different model'
                    s.send('command pi --version\r'); s.read_until(b'READY> ')
                    assert Path(s.calls()[-1][0]).name == 'pi' and s.calls()[-1][1:] == ['--version']
                    s.request('codex "a task with spaces"','route')
                    assert s.calls()[-1][1:]==['a task with spaces']
                    s.request('claude "say $HOME literally"','route','grid one\nmodel/test')
                    assert s.calls()[-1][1:5]==['shell-launch','claude','grid one','model/test']
                    for command in ['claude -p "print a task"', 'codex exec "run a task"', 'printf input | claude -p']:
                        s.request(command,'route','grid one\nmodel/test')
                        assert s.calls()[-1][1]=='shell-launch', 'inference flags must not silently bypass cm'
                    before=len(s.calls())
                    s.request('codex','route',code=1)
                    assert len(s.calls())==before, 'cancel fell through to native login'
                    for command,args in [('codex --model chosen "my task"',['--model','chosen','my task']),('codex resume saved',['resume','saved']),('claude --resume saved',['--resume','saved'])]:
                        s.send(command+'\r'); s.read_until(b'READY> ')
                        assert s.calls()[-1][1:]==args
                if not custom:
                    for agent in AGENTS:
                        (root/'bin'/agent).unlink()
                        s.request(agent+' "fresh user"','route')
                        engine = {'cursor-agent':'cursor', 'cmd':'commandcode'}.get(agent,agent)
                        assert s.calls()[-1][1:]==['shell-launch',engine,'--native','--','fresh user']
                # Helpers restore echo and do not alter the user's prompt or cwd.
                weird=root/'folder ü % #'; weird.mkdir()
                s.send("cd '"+str(weird)+"'\r")
                # The '%' binding can redraw the prompt while cd is still being
                # edited. OSC 7, rather than that redraw, proves cd has finished.
                result=s.read_until(re.compile(rb'\x1b\]7;file://localhost[^\x07]+\x07'))
                if b'READY> ' not in result.rsplit(b'\x07',1)[-1]: s.read_until(b'READY> ')
                paths=re.findall(rb'\x1b\]7;file://localhost([^\x07]+)\x07',result)
                assert paths and urllib.parse.unquote(paths[-1].decode())==str(weird), result
                s.send("stty -a\r"); result=s.read_until(b'READY> ')
                assert re.search(rb'(?<!-)\becho\b',result), result
            finally: s.close()
            print('PASS',Path(shell).name,'custom aliases' if custom else 'native agents')
