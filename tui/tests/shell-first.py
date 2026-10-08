#!/usr/bin/env python3
"""Real hn + a shell in a private tmux server; no account or user's daemon is touched."""
import os
import json
from pathlib import Path
import re
import shlex
import shutil
import socket
import subprocess
import tempfile
import time

ROOT=Path(__file__).resolve().parents[1]
BASE=Path(tempfile.mkdtemp(prefix='hn-shell-first-',dir='/tmp')).resolve()
HN=BASE/'hn'
shutil.copy2(os.environ.get('HN_SHELL_TEST_BINARY',ROOT/'target/debug/harness-tui'),HN)
TMUX=shutil.which('tmux'); assert TMUX
NAME=f'hn-shell-first-{os.getpid()}'
PORT=19448
SHELL=os.environ.get('HN_SHELL_TEST_SHELL','/bin/zsh')
assert Path(SHELL).name in ('zsh','bash')
with socket.socket() as probe: probe.bind(('127.0.0.1',PORT))
ENV={k:os.environ[k] for k in ('PATH','LANG','LC_ALL','TZ') if k in os.environ}
ENV.update(HOME=str(BASE),HN_TMPDIR=str(BASE),HN_SOCKET_NAME=NAME,PORT=str(PORT),SHELL=SHELL,TERM='xterm-256color',COLORTERM='truecolor',HN_DESKTOP='off',HARNESS_TUI_DESK='off',HARNESS_TUI_NOTIFY='off')
# These fixtures install their own widgets; Ubuntu's global compinit must not
# ask about completion directories supplied by the runner's unrelated tools.
ENV['skip_global_compinit']='1'
CLI=os.environ.get('HN_SHELL_TEST_CLI')
daemon=None; daemon_log=None
if CLI:
    binary=BASE/'bin'; binary.mkdir()
    wrapper=binary/'tmux'
    wrapper.write_text('#!/bin/sh\nfor arg in "$@"; do case "$arg" in -L*|-S*) exit 125;; esac; done\nexec '+shlex.join([TMUX,'-L',NAME+'-daemon'])+' "$@"\n')
    wrapper.chmod(0o700)
    ENV.update(PATH=str(binary)+':'+ENV['PATH'],ADAPTER_DATA_DIR=str(BASE/'data'),ADAPTER_CLI_DIR=str(BASE/'cli'),
        HARNESS_AUTH_DIR=str(BASE/'auth'),ADAPTER_COMPUTER_ID='c'*32,ADAPTER_COMPUTER_ID_FILE=str(BASE/'computer-id'),
        ADAPTER_RUNTIME_DIR=str(BASE/'runtime'),DSH_DIR=str(BASE/'dsh'),HARNESS_GRID_BIN=str(BASE/'no-grid'),
        BACKEND_WS_URL='ws://127.0.0.1:1',WEB_URL='http://127.0.0.1:1',HARNESS_STORE_CATALOG_URL='http://127.0.0.1:1/catalog',
        DISABLE_GRID_INSTALL='true',DISABLE_HOOK_INSTALL='true',ADAPTER_UPDATE_DISABLE='true',ANALYTICS_ENABLED='false',
        RECAP_FORCE='false',RECAP_WITHOUT_DEVICE='false',CABLE_DISABLE='true',CABLE_FW_DISABLE='true',HARNESS_DAEMONS='0',TERMINAL_BACKENDS='tmux')
    launch_cli=binary/'harness-fixture'
    launch_cli.write_text('#!/bin/sh\nexec '+shlex.join([shutil.which('node'),CLI])+' "$@"\n')
    launch_cli.chmod(0o700)
    ENV['HARNESS_SHELL_CLI']=str(launch_cli)
    notify=Path(CLI).parent/'notify.mjs'
    if not notify.exists(): notify=ROOT.parent/'cli/hook/notify.mjs'
    assert notify.is_file()
    ENV['HN_FIXTURE_NOTIFY']=str(notify)
FZF=shutil.which('fzf') if os.environ.get('HN_SHELL_TEST_FZF','1')!='0' else None
if not FZF: print('SKIP external fzf widgets: unavailable or HN_SHELL_TEST_FZF=0; native hn pickers are still tested',flush=True)
rc="PS1='SHELL_READY> '\n"
if os.environ.get('HN_SHELL_TEST_VI')=='1' and Path(SHELL).name=='zsh': rc+='bindkey -v\n'
rc+="export FZF_DEFAULT_OPTS=\"--height 45% --layout=reverse --border=rounded --info=inline --preview 'cat {}' --preview-window 'right:50%'\"\n"
if FZF:
    # Use fzf's documented startup for each shell. Bash 3.2 cannot reliably
    # source this generated script through process substitution.
    rc+=('source <('+shlex.quote(FZF)+' --zsh)\n' if Path(SHELL).name=='zsh'
         else 'eval "$('+shlex.quote(FZF)+' --bash)"\n')
    rc+="export FZF_CTRL_R_OPTS='--no-preview'\n"
    rc+="function vim { printf 'VIM_FILE=<%s>\\n' \"$@\"; }\n"
(BASE/'.zshrc').write_text(rc)
(BASE/'.bashrc').write_text(rc)
CONF=BASE/'tmux.conf'; CONF.write_text('set -g default-shell '+shlex.quote(SHELL)+'\nset -g automatic-rename off\n')
PROJECT=BASE/'project ü %'; PROJECT.mkdir()
(PROJECT/'日本語 notes.txt').write_text('FZF_REAL_FILE_PREVIEW\n')
FOLDER=PROJECT/'code'/'client 日本'/'empty folder'
FOLDER.mkdir(parents=True)
(PROJECT/'code'/'cool-project').mkdir()
NESTED_PROJECT=PROJECT/'code'/'work'/'autonomous-harness'
NESTED_PROJECT.mkdir(parents=True)
(NESTED_PROJECT/'src'/'日本語').mkdir(parents=True)
SIBLING_PROJECT=BASE/'other work'/'sibling-project'
SIBLING_PROJECT.mkdir(parents=True)
if os.environ.get('HN_SHELL_TEST_LARGE_FOLDERS')=='1':
    # More than 512 KiB as picker rows: a valid catalog must not disconnect the
    # local socket, and matches beyond the first response must remain findable.
    for index in range(1700):
        (BASE/'catalog-fixture'/f'{index:04}-unvisited-project-with-a-long-folder-name').mkdir(parents=True)
# Real native metadata + transcript files, read by the packaged CLI's real indexer.
# No vendor process, credentials, or personal history is needed.
if CLI:
    # Exercise the real daemon's agent launch/exit path with a deterministic
    # vendor executable. It never contacts a model or reads personal history.
    agent=binary/'claude'
    agent.write_text('#!'+shutil.which('node')+'\n'+'''
const fs = require('node:fs');
if (process.argv.includes('--help')) { console.log('--resume --permission-mode'); process.exit(0); }
if (process.argv.includes('--version')) { console.log('2.0.0'); process.exit(0); }
if (process.argv.includes('-p') || process.argv.includes('--print')) { console.log('{}'); process.exit(0); }
// Native Claude and the daemon's fakeEngine fixture advertise the engine name
// to process discovery; a generic Node title is not a stable engine identity.
process.title = ['claude'.padEnd(16), ...process.argv.slice(2)].join(' ').replace(/[\\x00-\\x1f\\x7f]/g, '?');
fs.writeFileSync(process.env.HOME+'/fixture-agent.json', JSON.stringify({pid:process.pid,args:process.argv.slice(2),cwd:process.cwd()}));
// Like the recorded Claude fixture in cli/e2e/harness/fakeEngine.mjs: discovery
// reads the native per-process record when SessionStart hooks are disabled.
const resumeAt = process.argv.indexOf('--resume');
if (resumeAt >= 0) {
  const sessions = process.env.HOME+'/.claude/sessions';
  fs.mkdirSync(sessions, { recursive: true });
  const procStart = require('node:child_process').execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)]).toString().trim();
  fs.writeFileSync(sessions+'/'+process.pid+'.json', JSON.stringify({pid:process.pid,sessionId:process.argv[resumeAt+1],cwd:process.cwd(),procStart}));
  // Claude waits for SessionStart before it accepts input. Use the packaged
  // hook and its real credential/transport, as the daemon E2E fixture does.
  require('node:child_process').execFileSync(process.execPath, [process.env.HN_FIXTURE_NOTIFY,
    '--port', process.env.PORT, '--data-dir', process.env.ADAPTER_DATA_DIR,
    '--claude-projects-dir', process.env.HOME+'/.claude/projects', '--engine', 'claude'], {
      input: JSON.stringify({hook_event_name:'SessionStart', source:'resume',
        session_id:process.argv[resumeAt+1], transcript_path:process.env.HOME+'/.claude/projects/fixture/'+process.argv[resumeAt+1]+'.jsonl', cwd:process.cwd()}),
      env:{...process.env, CLAUDE_PROJECT_DIR:process.cwd()}, stdio:['pipe','ignore','pipe'], timeout:5000,
    });
}
console.log('CLAUDE_FIXTURE_READY');
if (process.argv.includes('--resume') && fs.existsSync(process.env.HOME+'/fixture-exit-on-resume')) setTimeout(() => process.exit(130), 200);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', data => {
  if (data.includes(14)) console.log('CLAUDE_CTRL_N_RECEIVED');
  if (data.includes(3)) process.exit(130);
  if (data.includes(113)) process.exit(0);
  if (data.includes(101)) process.exit(17);
});
''')
    agent.chmod(0o700)
    # macOS login startup can replace PATH; this fixture rc explicitly keeps
    # the test executable ahead of any real, installed Claude command.
    for name in ('.zshrc','.bashrc'):
        with (BASE/name).open('a') as f: f.write('export PATH='+shlex.quote(str(binary))+':"$PATH"\n')
    claude=BASE/'.claude/projects/fixture';claude.mkdir(parents=True)
    claude_sid='6a7913ad-1f1a-4d30-8f56-267ee834b393'
    saved_user={'type':'user','sessionId':claude_sid,
        'cwd':str(PROJECT),'entrypoint':'cli','timestamp':'2026-09-20T10:00:00Z',
        'message':{'role':'user','content':'Claude shell lifecycle regression'}}
    saved_answer={'type':'assistant','sessionId':claude_sid,'cwd':str(PROJECT),
        'timestamp':'2026-09-20T10:00:01Z','message':{'role':'assistant',
        'content':[{'type':'text','text':'The fixture conversation is complete.'}],'stop_reason':'end_turn'}}
    (claude/(claude_sid+'.jsonl')).write_text(json.dumps(saved_user)+'\n'+json.dumps(saved_answer)+'\n')
    missing_sid='6a7913ad-1f1a-4d30-8f56-267ee834b394'
    (claude/(missing_sid+'.jsonl')).write_text(json.dumps({'type':'user','sessionId':missing_sid,
        'cwd':str(BASE/'removed-project'),'entrypoint':'cli','timestamp':'2026-09-20T10:00:00Z',
        'message':{'role':'user','content':'Missing folder resume regression'}})+'\n')
    codex=BASE/'.codex'; history=codex/'sessions/2026/09/20'; history.mkdir(parents=True)
    titles=[]
    for i in range(207):
        sid=f'01a0c4ad-de5e-7000-8000-{i:012d}'
        title='Fix workspace navigation' if i==206 else f'Archived example {i}'
        titles.append({'id':sid,'thread_name':title})
        entries=[{'timestamp':'2026-09-20T10:00:00Z','type':'session_meta','payload':{'id':sid,'cwd':str(PROJECT),'source':'cli','originator':'codex-tui'}},
            {'timestamp':'2026-09-20T10:00:01Z','type':'event_msg','payload':{'type':'user_message','message':'spectral kiwi regression' if i==206 else f'Example task {i}'}},
            {'timestamp':'2026-09-20T10:00:02Z','type':'event_msg','payload':{'type':'agent_message','message':'The fixture conversation is complete.'}},
            {'timestamp':'2026-09-20T10:00:03Z','type':'event_msg','payload':{'type':'task_complete'}}]
        (history/f'rollout-2026-09-20T10-00-00-{sid}.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in entries))
    (codex/'session_index.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in titles))
def run(args,check=True):
    r=subprocess.run(list(map(str,args)),env=ENV,cwd=PROJECT,text=True,capture_output=True,timeout=10)
    if check and r.returncode: raise AssertionError((args,r.stdout,r.stderr))
    return r.stdout
def tm(*args,check=True): return run([TMUX,'-L',NAME+'-outer',*args],check)
def hn(*args,check=True): return run([HN,'-L',NAME,'--port',PORT,'-f',CONF,*args],check)
def screen(): return tm('capture-pane','-p','-t','test',check=False)
def finder_text():
    pane=hn('capture-pane','-p',check=False)
    start=pane.find('╭')
    if start>=0: return pane[start:pane.find('╰',start)]
    # The composer has no box: its `›` query line, an `n/m ───` rule, the rows, then the keys line.
    lines=pane.splitlines()
    for i,line in enumerate(lines[:-1]):
        if '›' in line and re.match(r'\s*\d+/\d+\b',lines[i+1]):
            end=next((j for j in range(i+2,len(lines)) if 'esc back' in lines[j]),len(lines)-1)
            return '\n'.join(lines[i:end+1])
    return ''
def finder_ready():
    return re.search(r'\d+/\d+',finder_text())
def browsing(directory):
    # A recursive result already contains its descendants' names. Those names
    # alone do not prove Tab was handled or the destination's list was loaded.
    query=':~/'+directory.relative_to(BASE).as_posix()+'/'
    return '› '+query+' ' in finder_text()
def prompt_ready():
    lines=[line.strip() for line in hn('capture-pane','-p',check=False).splitlines() if line.strip()]
    return bool(lines) and lines[-1]=='SHELL_READY>'
def wait(fn,label,timeout=15):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        try:
            result=fn()
            if result: return result
        except (AssertionError,subprocess.TimeoutExpired): pass
        time.sleep(.08)
    (BASE/'failure-pane.txt').write_text(hn('capture-pane','-p','-S','-',check=False))
    raise AssertionError((label,screen()))
def type_line(text):
    if Path(SHELL).name=='zsh' or os.environ.get('HN_SHELL_TEST_COMPOSER_WIDGET')=='1': text='\x1b[200~'+text+'\x1b[201~'
    tm('send-keys','-t','test','-l',text); tm('send-keys','-t','test','Enter')
def keys(*keys): tm('send-keys','-t','test',*keys)
def pane_count(): return len(hn('list-panes','-F','#{pane_id}',check=False).splitlines())
passed=False
try:
    if CLI:
        daemon_log=(BASE/'daemon.log').open('w')
        daemon=subprocess.Popen([shutil.which('node'),CLI,'__run'],env=ENV,cwd=BASE,stdout=daemon_log,stderr=subprocess.STDOUT)
        wait(lambda:(BASE/'data'/f'daemon-{PORT}.sock').exists(),'private CLI daemon',30)
    command=shlex.join(['env','-u','TMUX','-u','TMUX_PANE','-u','HN_SOCKET',str(HN),'-L',NAME,'--port',str(PORT),'-f',str(CONF)])
    tm('-f','/dev/null','new-session','-d','-s','test','-x','130','-y','38',command)
    wait(lambda:'SHELL_READY>' in screen(),'ordinary hn opens a shell')
    wait(lambda:'Agent default' in screen(),'focused shell model context in status line')
    assert 'New Window' not in screen() and 'New Harness' not in screen()
    type_line("printf 'FIRST_%s\\n' OK")
    wait(lambda:'FIRST_OK' in screen(),'shell accepts input')
    if os.environ.get('HN_SHELL_TEST_CONNECTED_ONLY')=='1':
        assert CLI, 'connected validation requires a private daemon'
        wait(lambda:list((BASE/'data'/'shell-creations').glob('*.json')),'shell launched through the service')
        first=hn('display-message','-p','#{pane_id}').strip()
        second=hn('new-window','-P','-F','#{pane_id}').strip()
        assert second and second != first
        wait(prompt_ready,'connected new window shell')
        type_line("printf 'SECOND_%s\\n' OK")
        wait(lambda:'SECOND_OK' in screen(),'connected shell accepts input')
        keys('C-b','%')
        wait(lambda:pane_count()==2,'connected split creates a second view')
        wait(prompt_ready,'connected split shell is ready')
        type_line("printf 'SPLIT_%s\\n' OK")
        wait(lambda:'SPLIT_OK' in screen(),'connected split shell accepts input')
        assert len(list((BASE/'data'/'shell-creations').glob('*.json')))>=3
        passed=True
        print('PASS real hn connected to the private daemon: initial shell, new window, split and interactive input through shell_open',flush=True)
        raise SystemExit(0)
    if os.environ.get('HN_SHELL_TEST_FOLDERS')=='1':
        assert CLI
        # The real bug occurred from /private/tmp, which is outside the home
        # accepted by fs_list_dir. Search must still cover unvisited home projects.
        for directory in [BASE.parent, PROJECT]:
            type_line('cd '+shlex.quote(str(directory)))
            wait(prompt_ready,'shell moved before home-wide search')
            tm('send-keys','-t','test','-l','claude :')
            wait(finder_ready,'home-wide picker from '+str(directory))
            tm('send-keys','-t','test','-l','sblngprj')
            wait(lambda:finder_ready() and 'other work/sibling-project' in finder_text(),'fuzzy sibling project outside cwd subtree')
            keys('Enter')
            wait(lambda:not finder_ready() and 'other work/sibling-project' in hn('capture-pane','-p'),'sibling path inserted')
            assert not (BASE/'fixture-agent.json').exists(),'folder selection launched agent'
            keys('C-c'); wait(prompt_ready,'cancel preserves original shell')
        print('PASS home-wide fuzzy folders from outside home and from a different project subtree',flush=True)
        # A project never used by any agent must be discoverable by name from
        # the shell root, without knowing or entering its parent directories.
        tm('send-keys','-t','test','-l','claude :')
        wait(finder_ready,'recursive project picker')
        tm('send-keys','-t','test','-l','autonomous-harness')
        wait(lambda:finder_ready() and 'code/work/autonomous-harness' in finder_text(),'nested project found by name',15)
        keys('C-u')
        tm('send-keys','-t','test','-l','atnmhrns')
        wait(lambda:finder_ready() and 'code/work/autonomous-harness' in finder_text(),'nested project found by fuzzy abbreviation')
        keys('Enter')
        wait(lambda:not finder_ready() and 'code/work/autonomous-harness' in hn('capture-pane','-p'),'recursive result inserts its exact path')
        assert not (BASE/'fixture-agent.json').exists(),'fuzzy project choice executed the command'
        keys('Enter')
        wait(lambda:(BASE/'fixture-agent.json').exists(),'recursive-project agent launched',35)
        launched=json.loads((BASE/'fixture-agent.json').read_text())
        assert launched['cwd']==str(NESTED_PROJECT) and launched['args']==[],launched
        keys('q');wait(prompt_ready,'original shell after recursive project launch')
        (BASE/'fixture-agent.json').unlink()
        print('PASS recursive folder search: unvisited nested project, full name and fuzzy abbreviation, exact cwd, selection does not launch',flush=True)
        tm('send-keys','-t','test','-l','claude :')
        wait(finder_ready,'automatic folders')
        tm('send-keys','-t','test','-l','cd')
        # The temporary root name can also fuzzy-match "cd". The desired code
        # directory must rank first and open; the match count need not be one.
        wait(lambda:finder_ready() and '› :cd ' in finder_text() and '~/project ü %/code' in finder_text() and re.search(r'\b[1-9]\d*/\d+',finder_text()),'fuzzy folder search without full spelling')
        keys('Tab')
        wait(lambda:browsing(PROJECT/'code') and 'cool-project/' in finder_text() and 'client 日本/' in finder_text(),'Tab browses code')
        tm('send-keys','-t','test','-l','clpj')
        wait(lambda:finder_ready() and re.search(r'\b1/\d+',finder_text()),'fuzzy child name')
        keys('Right')
        wait(lambda:browsing(PROJECT/'code'/'cool-project') and re.search(r'\b1/1\b',finder_text()),'Right browses empty directory')
        keys('M-Up')
        wait(lambda:browsing(PROJECT/'code') and 'client 日本/' in finder_text(),'Alt-Up goes back')
        tm('send-keys','-t','test','-l','cl日')
        wait(lambda:finder_ready() and re.search(r'\b2/\d+',finder_text()),'fuzzy Unicode folder and descendant')
        keys('Tab')
        wait(lambda:browsing(FOLDER.parent) and 'empty folder/' in finder_text(),'Unicode folder entered')
        tm('send-keys','-t','test','-l','emp')
        keys('Tab')
        wait(lambda:browsing(FOLDER) and re.search(r'\b1/1\b',finder_text()),'empty folder remains selectable')
        keys('Enter')
        wait(lambda:not finder_ready() and 'empty folder' in hn('capture-pane','-p'),'Enter inserts full quoted path')
        assert not (BASE/'fixture-agent.json').exists(),'folder choice executed the command'
        keys('Enter')
        wait(lambda:(BASE/'fixture-agent.json').exists(),'nested-folder agent launched',35)
        launched=json.loads((BASE/'fixture-agent.json').read_text())
        assert launched['cwd']==str(FOLDER) and launched['args']==[],launched
        keys('q');wait(prompt_ready,'original shell after nested launch')
        (BASE/'fixture-agent.json').unlink()
        tm('send-keys','-t','test','-l','claude :')
        wait(finder_ready,'relative path folder picker')
        tm('send-keys','-t','test','-l','code/')
        wait(lambda:'› :code/ ' in finder_text() and 'cool-project/' in finder_text() and 'client 日本/' in finder_text(),'relative code/ resolves against shell cwd')
        tm('send-keys','-t','test','-l','missing/')
        wait(lambda:finder_ready() and ('unavailable' in finder_text() or 'Could not read' in finder_text()),'missing folder explains failure')
        assert re.search(r'\b0/0\b',finder_text()),screen()
        keys('Enter');assert finder_ready(),'empty match unexpectedly accepted'
        keys('M-Up')
        wait(lambda:browsing(PROJECT/'code') and 'client 日本/' in finder_text(),'go back from unavailable directory')
        # Picker teardown precedes zsh repainting its line. Wait for both, not
        # just the missing picker, before checking the original draft.
        keys('Escape');wait(lambda:not finder_ready() and 'SHELL_READY> claude :' in hn('capture-pane','-p'),'folder cancel restores original draft')
        assert 'SHELL_READY> claude :' in hn('capture-pane','-p'),'cancel changed the original draft'
        keys('C-c');wait(prompt_ready,'draft discarded without launch')
        assert not (BASE/'fixture-agent.json').exists()
        print('PASS folder browser: fuzzy names, Tab/Right descend, Alt-Up parent, relative code/, spaces/Unicode, empty/missing folders, exact launch cwd, no launch on selection, Escape restores draft',flush=True)
        if os.environ.get('HN_SHELL_TEST_FOLDERS_ONLY')=='1':
            passed=True
            raise SystemExit(0)
    if os.environ.get('HN_SHELL_TEST_GUI')=='1':
        def click_text(text):
            lines=screen().splitlines()
            for y,line in ([(len(lines)-1,lines[-1])] if text in ('+','⋮') else enumerate(lines)):
                if text in line:
                    x=line.index('  '+text+'  ')+2 if text in ('+','⋮') else line.index(text)
                    tm('send-keys','-t','test','-l',f'\x1b[<0;{x+1};{y+1}M\x1b[<0;{x+1};{y+1}m')
                    return
            raise AssertionError(('missing clickable text',text,screen()))
        original_window=hn('display-message','-p','#{window_id}').strip()
        click_text('+')
        wait(lambda:'New Harness' in screen() and 'Task' in screen(),'footer + opens GUI composer')
        assert pane_count()==1 and hn('display-message','-p','#{window_id}').strip()==original_window
        keys('Escape');wait(prompt_ready,'GUI composer cancels back to original shell')
        click_text('⋮');wait(lambda:'New Harness' in screen() and 'New Tab' in screen(),'workspace mouse menu')
        click_text('New Harness');wait(lambda:'Task' in screen(),'menu New Harness opens GUI')
        keys('Escape');wait(prompt_ready,'menu composer cancels')
        click_text('⋮');wait(lambda:'New Tab' in screen(),'workspace menu reopened')
        click_text('New Tab');wait(lambda:'New Harness' in screen() and 'Task' in screen() and 'machines connected' in screen(),'mouse New Tab opens welcome composer')
        gui_window=hn('display-message','-p','#{window_id}').strip()
        assert gui_window!=original_window
        hn('kill-window','-t',gui_window)
        wait(prompt_ready,'close GUI tab returns to shell')
        print('PASS mouse + / New Harness / New Tab: GUI forms, cancel returns to shell, no premature process creation',flush=True)
    if CLI and os.environ.get('HN_SHELL_TEST_STARTERS')=='1':
        start_window=hn('display-message','-p','#{window_id}').strip()
        keys('C-b','c')
        wait(lambda:finder_ready() and 'Claude Code' in screen(),'new keyboard tab opens agent picker',30)
        assert 'Search agents' in screen() and '› &' not in screen(),screen()
        for scope in ['@ computer',': project','% model','& agent']: assert scope in screen(),(scope,screen())
        tm('send-keys','-t','test','-l','cld')
        wait(lambda:finder_ready() and 'Claude Code' in screen() and re.search(r'\b1/\d+',screen()),'plain fuzzy agent search')
        keys('Enter')
        wait(lambda:not finder_ready() and 'SHELL_READY> claude' in hn('capture-pane','-p'),'agent selection only edits the fresh command')
        assert not (BASE/'fixture-agent.json').exists(),'agent choice ran prematurely'
        keys('C-c');wait(prompt_ready,'cancel composed command')
        for shortcut,default in [('C-p','Search sessions'),('C-n','Search agents')]:
            keys(shortcut);wait(lambda:finder_ready() and default in screen(),shortcut+' default scope')
            for prefix,expected in [('@','this computer'),('%','Use agent default'),(':','code')]:
                tm('send-keys','-t','test','-l',prefix)
                wait(lambda:finder_ready() and expected in screen(),shortcut+' '+prefix+' scope')
                keys('BSpace')
                wait(lambda:finder_ready() and default in screen(),shortcut+' returns to blank default')
            keys('Escape');wait(prompt_ready,shortcut+' cancels to unchanged shell')
        keys('C-b','N')
        wait(lambda:pane_count()==2 and finder_ready() and 'Search agents' in screen(),'new keyboard pane opens agent picker',30)
        keys('Escape');wait(prompt_ready,'Esc leaves usable shell in new pane')
        type_line("printf 'STARTER_%s\\n' OK")
        wait(lambda:'STARTER_OK' in screen(),'new pane shell after cancel')
        current=hn('display-message','-p','#{window_id}').strip()
        assert current!=start_window
        hn('kill-window','-t',current)
        wait(prompt_ready,'starter test returns to original shell')
        print('PASS shell starters: keyboard tab/pane auto-pick agents, blank Ctrl+P sessions / Ctrl+N agents, @ computer / : folder / % model, choose edits only, Escape restores shell',flush=True)
        if os.environ.get('HN_SHELL_TEST_STARTERS_ONLY')=='1':
            passed=True
            raise SystemExit(0)
    if CLI and os.environ.get('HN_SHELL_TEST_COMPOSER')=='1':
        (BASE/'fixture-agent.json').unlink(missing_ok=True)
        type_line("COMPOSER_KEEP=yes; printf 'COMPOSER_PID=%s\\n' \"$$\"")
        wait(prompt_ready,'composer source shell')
        original=wait(lambda:re.findall(r'^COMPOSER_PID=(\d+)$',hn('capture-pane','-p','-S','-'),re.M),'composer shell PID observed')[-1]
        composer_widgets=Path(SHELL).name=='zsh' or os.environ.get('HN_SHELL_TEST_COMPOSER_WIDGET')=='1'
        if composer_widgets:
            # A completed agent/folder followed by an automatic selector is
            # still the same shell draft. Erasing its prefix closes suggestions.
            keys('C-n');wait(lambda:finder_ready() and 'Search agents' in screen(),'Ctrl-N starts the Codex draft')
            tm('send-keys','-t','test','-l','codex');keys('Enter')
            wait(lambda:not finder_ready() and 'SHELL_READY> codex' in hn('capture-pane','-p'),'Codex chosen without launching')
            tm('send-keys','-t','test','-l',':');wait(finder_ready,'Codex folder autocomplete')
            tm('send-keys','-t','test','-l','atnmhrns')
            wait(lambda:finder_ready() and 'autonomous-harness' in finder_text(),'fuzzy project selected')
            keys('Enter');wait(lambda:not finder_ready(),'project choice returns to command')
            for prefix,expected in [('%','Use agent default'),('@','this computer'),(':','code')]:
                tm('send-keys','-t','test','-l',prefix)
                wait(lambda:finder_ready() and expected in finder_text(),'automatic '+prefix+' selector')
                keys('BSpace')
                wait(lambda:not finder_ready(),'erasing '+prefix+' closes suggestions instead of switching lists')
                assert 'Search sessions' not in hn('capture-pane','-p') and 'Search agents' not in hn('capture-pane','-p')
                assert not (BASE/'fixture-agent.json').exists(),'deleting a selector launched the agent'
            # Print the draft as data to inspect every argument; no agent runs.
            keys('C-a');tm('send-keys','-t','test','-l',"\x1b[200~printf 'DRAFT_ARG=<%s>\\n' \x1b[201~");keys('Enter')
            wait(prompt_ready,'retained draft inspected as literal arguments')
            text=hn('capture-pane','-p')
            expected_folder='DRAFT_ARG=<:~/'+NESTED_PROJECT.relative_to(BASE).as_posix()+'>'
            assert 'DRAFT_ARG=<codex>' in text and expected_folder in ''.join(text.splitlines()),text
            assert all('DRAFT_ARG=<'+prefix+'>' not in text for prefix in ['@',':','%']),text
            keys('C-c');wait(prompt_ready,'cancel retained Codex draft')
            print('PASS automatic selector deletion returns to the composed command without changing lists or launching',flush=True)
            for literal in ["printf '@:%'", "claude ':'", "claude --prompt :", "claude -- %"]:
                tm('send-keys','-t','test','-l',literal)
                wait(lambda:literal in hn('capture-pane','-p'),'literal command remains editable')
                assert not finder_ready(),('automatic picker stole literal input',literal)
                keys('C-c');wait(prompt_ready,'literal draft cancelled')
            keys('C-p');wait(finder_ready,'empty prompt composer')
            tm('send-keys','-t','test','-l','&clau')
            wait(lambda:finder_ready() and 'Claude Code' in screen(),'agent choice')
            keys('Escape');wait(prompt_ready,'Ctrl-P agent list cancellation')
            # Compose the folder first, then add the agent. The next typed model
            # must go after the folder, not into the middle of the command.
            tm('send-keys','-t','test','-l',shlex.quote(':'+str(PROJECT)))
            keys('C-n');wait(lambda:finder_ready() and 'Claude Code' in screen(),'Ctrl-N opens agents directly after folder')
            tm('send-keys','-t','test','-l','clau')
            wait(lambda:finder_ready() and 'Claude Code' in screen(),'Ctrl-N agent filter')
            keys('Enter');wait(lambda:'SHELL_READY> claude' in hn('capture-pane','-p') and not finder_ready(),'agent inserted into draft')
            assert not (BASE/'fixture-agent.json').exists(),'selection launched agent'
            tm('send-keys','-t','test','-l','%');wait(finder_ready,'automatic model list');tm('send-keys','-t','test','-l','son')
            wait(lambda:finder_ready() and 'sonnet' in screen(),'native model autocomplete')
            keys('Enter');wait(lambda:'%sonnet' in hn('capture-pane','-p') and not finder_ready(),'model inserted after folder')
            tm('send-keys','-t','test','-l','@')
            wait(finder_ready,'automatic computer list')
            keys('Escape');wait(lambda:not finder_ready(),'automatic computer choice cancelled')
            keys('BSpace')
            tm('send-keys','-t','test','-l',':')
            wait(lambda:finder_ready() and 'project ü' in screen(),'folder list')
            tm('send-keys','-t','test','-l','project ü')
            keys('Enter');wait(lambda:not finder_ready() and 'project ü' in screen(),'folder inserted and quoted')
            assert not (BASE/'fixture-agent.json').exists()
            keys('C-p');wait(finder_ready,'continue composing');keys('Escape')
            wait(lambda:not finder_ready(),'composer cancellation')
            keys('C-n');wait(lambda:finder_ready() and 'Claude Code' in screen(),'Ctrl-N reopens agents in composed draft');keys('Escape')
            wait(lambda:not finder_ready(),'Ctrl-N cancellation preserves composed draft')
            assert not (BASE/'fixture-agent.json').exists()
            keys('Enter')
        else:
            type_line('claude %sonnet '+shlex.quote(':'+str(PROJECT)))
        wait(lambda:(BASE/'fixture-agent.json').exists(),'composed agent started',35)
        launched=json.loads((BASE/'fixture-agent.json').read_text())
        assert launched['args']==['--model','sonnet'] and launched['cwd']==str(PROJECT),launched
        wait(lambda:'CLAUDE_FIXTURE_READY' in screen(),'agent ready for native keys')
        keys('C-n');wait(lambda:'CLAUDE_CTRL_N_RECEIVED' in screen(),'running agent retains its own Ctrl-N')
        keys('C-c');wait(prompt_ready,'composed agent Ctrl-C restores shell')
        type_line("printf 'COMPOSER_RETURN=%s_%s_%s\\n' \"$$\" \"$COMPOSER_KEEP\" \"$PWD\"")
        wait(lambda:'COMPOSER_RETURN='+original+'_yes_'+str(PROJECT) in screen(),'composer preserved PID variables cwd')
        (BASE/'fixture-agent.json').unlink()
        for invalid_command,error in [('claude %sonnet --model opus','Choose either'),('claude @missing-computer','missing or ambiguous'),('claude :/does/not/exist','does not exist'),('claude %sonnet %opus','one %model')]:
            type_line(invalid_command);wait(lambda:prompt_ready() and error in screen(),'refused '+invalid_command)
            assert not (BASE/'fixture-agent.json').exists(),'invalid draft launched'
        payload='$(touch SHOULD_NOT_EXIST); & 日本語'
        type_line('claude '+shlex.quote(':'+str(PROJECT))+' -- '+shlex.quote(payload)+' '+shlex.quote('%literal'))
        wait(lambda:(BASE/'fixture-agent.json').exists(),'literal passthrough launch')
        launched=json.loads((BASE/'fixture-agent.json').read_text())
        assert launched['args']==['--',payload,'%literal'],launched
        assert not (PROJECT/'SHOULD_NOT_EXIST').exists()
        keys('q');wait(prompt_ready,'normal composed exit')
        print('PASS composer:', 'editable agent/model/folder and cancellation;' if composer_widgets else 'typed selectors (Bash 3.2 has no bind-x draft API);', 'exact argv, literal passthrough, invalid choices, original shell PID/cwd/variables',flush=True)
        if os.environ.get('HN_SHELL_TEST_COMPOSER_ONLY')=='1':
            passed=True
            raise SystemExit(0)
    if CLI:
        # Reproduce the user journey, not just the picker request payload:
        # select a saved Claude session, exit its process, then pick again.
        type_line("HN_RETURN_MARKER=preserved; printf 'SOURCE_PID=%s\\n' \"$$\"")
        wait(prompt_ready,'source shell marker')
        source_pid=wait(lambda:re.findall(r'^SOURCE_PID=(\d+)$',hn('capture-pane','-p','-S','-'),re.M),'source shell PID observed')[-1]
        if os.environ.get('HN_SHELL_TEST_RETIRED_SOURCE')=='1':
            type_line("printf 'SOURCE_PANE=%s\\n' \"$TMUX_PANE\"")
            source_pane=wait(lambda:re.findall(r'^SOURCE_PANE=(%\d+)$',hn('capture-pane','-p','-S','-'),re.M),'source physical pane observed')[-1]
            def registry_rows(): return json.loads((BASE/'data/registry.json').read_text())
            source=wait(lambda:next((r for r in registry_rows() if r.get('tmuxPane')==source_pane and r.get('active')),None),'original shell registry identity')
            (BASE/'fixture-agent.json').unlink(missing_ok=True)
            # This process names its own as-yet-unwritten conversation so
            # discovery cannot adopt the separate saved-session fixture.
            type_line('claude --resume 6a7913ad-1f1a-4d30-8f56-267ee834b395')
            wait(lambda:(BASE/'fixture-agent.json').exists() and 'CLAUDE_FIXTURE_READY' in screen(),'inline source agent launched')
            wait(lambda:any(r.get('agentId')==source['agentId'] and r.get('engine')=='claude' for r in registry_rows()),'source shell promoted to an agent',30)
            keys('q');wait(prompt_ready,'inline source agent returned')
            wait(lambda:any(r.get('tmuxPane')==source_pane and r.get('agentId')!=source['agentId'] and r.get('engine')=='terminal' and r.get('active') and r.get('registeredAt')==source['registeredAt'] for r in registry_rows()),'same physical shell retained under new identity',30)
            print('PASS regression setup: original shell promoted, conversation archived, same shell assigned a new ID',flush=True)
        if os.environ.get('HN_SHELL_TEST_EARLY_EXIT')=='1':
            (BASE/'fixture-agent.json').unlink(missing_ok=True)
            early=BASE/'fixture-exit-on-resume';early.touch()
            type_line('hn pick Claude shell lifecycle regression')
            wait(lambda:finder_ready() and re.search(r'\b1/\d+',finder_text()) and 'Claude shell lifecycle regression' in finder_text(),'saved session for immediate exit',35)
            keys('Enter')
            wait(lambda:(BASE/'fixture-agent.json').exists(),'immediately exiting agent launched',35)
            wait(lambda:prompt_ready() and 'SOURCE_PID='+source_pid in hn('capture-pane','-p','-S','-'),'immediate resume exit restores original shell',15)
            type_line("printf 'EARLY_RETURN_%s_%s\\n' \"$$\" \"$HN_RETURN_MARKER\"")
            wait(lambda:'EARLY_RETURN_'+source_pid+'_preserved' in screen(),'early exit preserves PID and variables')
            early.unlink()
            print('PASS immediate resume exit: original shell PID, variables and prompt survive exit during startup',flush=True)
            if os.environ.get('HN_SHELL_TEST_EARLY_ONLY')=='1':
                passed=True
                raise SystemExit(0)
        for attempt,exit_key in enumerate(('C-c','q','e')):
            (BASE/'fixture-agent.json').unlink(missing_ok=True)
            draft="printf 'SESSION_DRAFT_%s\\n' LRIGHT"
            if attempt==0:
                type_line('hn pick Claude shell lifecycle regression')
            else:
                if attempt==2: tm('send-keys','-t','test','-l',draft);keys(*(['Left']*5))
                keys('C-p');wait(finder_ready,'Ctrl-P chooses session directly')
                tm('send-keys','-t','test','-l','Claude shell lifecycle regression')
            wait(lambda:finder_ready() and re.search(r'\b1/\d+',screen()) and screen().count('Claude shell lifecycle regression')>=2,'saved Claude in inline finder',35)
            keys('Enter');wait(lambda:(BASE/'fixture-agent.json').exists() and 'CLAUDE_FIXTURE_READY' in screen(),'real daemon resumed Claude fixture',35)
            launched=json.loads((BASE/'fixture-agent.json').read_text())
            assert launched['args']==['--resume',claude_sid],launched
            assert launched['cwd']==str(PROJECT),launched
            exited_at=time.monotonic()
            keys(exit_key)
            wait(lambda:'SOURCE_PID='+source_pid in hn('capture-pane','-p','-S','-'),'Claude exit returns to source shell',25)
            elapsed=time.monotonic()-exited_at
            print(f'PASS {exit_key}: original prompt returned in {elapsed:.2f}s',flush=True)
            assert elapsed<3.0,('exit handoff waited for periodic discovery',elapsed)
            if attempt==2:
                wait(lambda:'SHELL_READY> '+draft in hn('capture-pane','-p'),'session exit restores editable draft')
                assert 'SESSION_DRAFT_LRIGHT' not in screen(),'session selection executed the draft'
                tm('send-keys','-t','test','-l','M');keys('Enter')
                wait(lambda:'SESSION_DRAFT_LMRIGHT' in screen(),'session exit preserves draft cursor')
            wait(prompt_ready,'original prompt ready')
            type_line("printf 'RETURN"+str(attempt)+"_%s_%s_%s\\n' \"$$\" \"$HN_RETURN_MARKER\" \"$PWD\"")
            expected='RETURN'+str(attempt)+'_'+source_pid+'_preserved_'+str(PROJECT)
            wait(lambda:expected in screen(),'same original shell and cwd after '+exit_key,10)
            type_line('hn pick :default')
            wait(lambda:finder_ready() and 'Use agent default' in screen(),'hn pick works after '+exit_key)
            keys('Escape');wait(prompt_ready,'picker cancel after '+exit_key)
            keys('C-p');wait(finder_ready,'Ctrl-P still bound after '+exit_key)
            keys('Escape');wait(prompt_ready,'widget cancel after '+exit_key)
            type_line("ch local; printf 'CH_STATUS"+str(attempt)+"=%s\\n' \"$?\"")
            wait(lambda:prompt_ready() and 'CH_STATUS'+str(attempt)+'=0' in screen(),'ch still works after '+exit_key)
        print('PASS saved Claude lifecycle: Ctrl-C, normal exit, nonzero exit; same shell PID/cwd/variables, hn pick, Ctrl-P and ch after each exit',flush=True)
        if os.environ.get('HN_SHELL_TEST_SHARED_STOP')=='1':
            (BASE/'fixture-agent.json').unlink(missing_ok=True)
            type_line('hn pick Claude shell lifecycle regression')
            wait(lambda:finder_ready() and 'Claude shell lifecycle regression' in finder_text(),'session for multiple views',35)
            keys('Enter')
            wait(lambda:(BASE/'fixture-agent.json').exists() and 'CLAUDE_FIXTURE_READY' in screen(),'shared fixture running',35)
            launched=json.loads((BASE/'fixture-agent.json').read_text())
            def shared_rows(): return json.loads((BASE/'data/registry.json').read_text())
            target=wait(lambda:next((r for r in shared_rows() if r.get('sessionId')==claude_sid and r.get('active')),None),'live conversation owner')
            peer_name=NAME+'-peer'
            peer=lambda *args:run([HN,'-L',peer_name,'--port',PORT,'-f',CONF,*args])
            peer_command=shlex.join(['env','-u','TMUX','-u','TMUX_PANE','-u','HN_SOCKET',str(HN),'-L',peer_name,'--port',str(PORT),'-f',str(CONF)])
            try:
                tm('new-window','-d','-n','peer',peer_command)
                wait(lambda:'SHELL_READY>' in tm('capture-pane','-p','-t','test:peer'),'second independent TUI view')
                peer('open-harness','-s',target['agentId'])
                wait(lambda:'CLAUDE_FIXTURE_READY' in peer('capture-pane','-p'),'second TUI attached to existing process')
                assert json.loads((BASE/'fixture-agent.json').read_text())['pid']==launched['pid'],'attachment relaunched agent'
                assert len([r for r in shared_rows() if r.get('sessionId')==claude_sid and r.get('active')])==1,'duplicate conversation process'
                os.kill(launched['pid'],0)
                peer('kill-server')
                wait(lambda:'CLAUDE_FIXTURE_READY' in screen(),'original view survives closing second TUI')
                os.kill(launched['pid'],0)
                print('PASS two independent TUI views share one agent/PID; closing one leaves the other alive',flush=True)
            finally:
                run([HN,'-L',peer_name,'--port',PORT,'-f',CONF,'kill-server'],check=False)
            hn('close-harness')
            wait(lambda:'Stop? Saved history will remain.' in screen() or prompt_ready(),'stop activity check',35)
            if not prompt_ready(): keys('s')
            wait(lambda:prompt_ready() and 'SOURCE_PID='+source_pid in hn('capture-pane','-p','-S','-') and not any(r.get('agentId')==target['agentId'] for r in shared_rows()),'explicit stop confirmed and original shell restored',35)
            assert 'changed while pausing' not in screen(),screen()
            try: os.kill(launched['pid'],0)
            except ProcessLookupError: pass
            else: raise AssertionError('stop acknowledged with agent still alive')
            assert (BASE/'.claude/projects/fixture'/(claude_sid+'.jsonl')).exists(),'stop lost history'
            type_line("printf 'STOP_RETURN_%s_%s\\n' \"$$\" \"$HN_RETURN_MARKER\"")
            wait(lambda:'STOP_RETURN_'+source_pid+'_preserved' in screen(),'stop preserved source shell PID and variables')
            print('PASS Stop Harness: real process exits, terminal retires, history remains, original shell restored, no exit-observer race',flush=True)
        (BASE/'fixture-agent.json').unlink(missing_ok=True)
        keys('C-p');wait(finder_ready,'Ctrl-P resume failure case')
        tm('send-keys','-t','test','-l','Missing folder resume regression')
        wait(lambda:finder_ready() and re.search(r'\b1/\d+',screen()),'unavailable-folder conversation selected',35)
        keys('Enter')
        wait(lambda:'SHELL_READY>' in screen() and 'folder it ran in is gone' in screen(),'failed resume explains why at original prompt',35)
        assert not (BASE/'fixture-agent.json').exists(),'resumed in a fallback directory'
        type_line("printf 'AFTER_FAILED_RESUME_%s\\n' OK")
        wait(lambda:prompt_ready() and 'AFTER_FAILED_RESUME_OK' in screen(),'shell remains usable after visible resume error')
        print('PASS session failure: unavailable folder shows the resume error and preserves the original prompt',flush=True)
        if os.environ.get('HN_SHELL_TEST_LIFECYCLE_ONLY')=='1':
            passed=True
            raise SystemExit(0)
    # One direct shortcut, with picker-only scopes. No text from the pending
    # shell draft is treated as a search or executed while changing a context.
    draft="printf 'SHORTCUT_DRAFT_%s\\n' LRIGHT"
    tm('send-keys','-t','test','-l',draft);keys(*(['Left']*5),'C-p')
    wait(finder_ready,'Ctrl-P inline finder from middle of draft')
    tm('send-keys','-t','test','-l','%default')
    wait(lambda:'Use agent default' in screen(),'model scope in shared finder')
    assert 'SHORTCUT_DRAFT_LRIGHT' not in screen(),'opening the finder executed the draft'
    keys('Enter')
    wait(lambda:'SHELL_READY> '+draft in hn('capture-pane','-p') and not finder_ready(),'model selection preserves draft')
    tm('send-keys','-t','test','-l','M');keys('Enter')
    wait(lambda:'SHORTCUT_DRAFT_LMRIGHT' in screen(),'model selection preserves cursor')
    # Simulate a terminal reporting Cmd-P via the Kitty protocol, not a claim
    # that every macOS terminal forwards that physical shortcut by default.
    tm('send-keys','-t','test','-l',"printf 'CMD_PICKER_%s\\n' OK")
    tm('send-keys','-t','test','-l','\x1b[112;9u')
    wait(finder_ready,'reported Cmd-P reaches shell widget')
    tm('send-keys','-t','test','-l','@')
    wait(lambda:'this computer' in screen(),'computer scope in shared finder')
    keys('Enter')
    wait(lambda:"SHELL_READY> printf 'CMD_PICKER_" in hn('capture-pane','-p') and not finder_ready(),'computer selection preserves draft')
    assert 'CMD_PICKER_OK' not in screen()
    keys('Enter');wait(lambda:'CMD_PICKER_OK' in screen(),'computer shortcut returns usable draft')
    keys('C-p');wait(finder_ready,'scope-switch cancellation')
    tm('send-keys','-t','test','-l','@');wait(lambda:'this computer' in screen(),'computer scope ready')
    sessions_placeholder='Search sessions' if Path(SHELL).name=='zsh' or os.environ.get('HN_SHELL_TEST_COMPOSER_WIDGET')=='1' else '@ computer'
    keys('BSpace');wait(lambda:sessions_placeholder in hn('capture-pane','-p'),'removing scope returns to sessions')
    tm('send-keys','-t','test','-l',':')
    wait(lambda:('project ü' if Path(SHELL).name=='zsh' or os.environ.get('HN_SHELL_TEST_COMPOSER_WIDGET')=='1' else 'Use agent default') in screen(),'folder/model scope ready')
    keys('BSpace');wait(lambda:sessions_placeholder in hn('capture-pane','-p'),'folder backspace returns to sessions')
    if CLI:
        tm('send-keys','-t','test','-l','fxwsp')
        wait(lambda:'Fix workspace navigation' in screen(),'shared finder retains complete session catalog',35)
    keys('Escape');wait(prompt_ready,'shared finder Escape restores prompt')
    if FZF:
        # The user's original fzf widgets still own file/history insertion.
        tm('send-keys','-t','test','-l','vim ');keys('C-t')
        wait(finder_ready,'real fzf Ctrl-T')
        tm('send-keys','-t','test','-l','日本語')
        wait(lambda:'FZF_REAL_FILE_PREVIEW' in screen(),'real fzf right file preview')
        keys('Enter');wait(lambda:'SHELL_READY> vim ' in hn('capture-pane','-p') and '╭' not in hn('capture-pane','-p'),'file inserted without running vim')
        assert 'VIM_FILE=' not in screen()
        keys('Enter');wait(lambda:'VIM_FILE=<日本語 notes.txt>' in screen(),'quoted filename passed intact to vim')
        # Ordinary Tab completion must still reach the original fzf widget.
        tm('send-keys','-t','test','-l','vim 日本');keys('Tab')
        wait(lambda:'SHELL_READY> vim 日本語' in hn('capture-pane','-p'),'ordinary file completion still works')
        keys('C-c');wait(prompt_ready,'cancel file completion draft')
        type_line("printf 'FZF_HISTORY_%s\\n' OK");wait(prompt_ready,'history command ready')
        tm('send-keys','-t','test','-l','FZF_HISTORY');keys('C-r')
        wait(finder_ready,'real fzf Ctrl-R');keys('Enter')
        wait(lambda:'SHELL_READY> printf' in hn('capture-pane','-p') and '╭' not in hn('capture-pane','-p'),'history selection returns to editable draft')
        keys('C-c');wait(prompt_ready,'cancel history draft')
    # Complete while the shell line is still being edited. Enter in the finder
    # accepts a value; only the NEXT Enter invokes cm.
    defaults_before=hn('capture-pane','-p','-S','-').count("Using the agent's own defaults.")
    tm('send-keys','-t','test','-l','cm ');keys('Tab')
    wait(lambda:'Use agent default' in screen(),'model completion widget')
    keys('Enter')
    wait(lambda:'SHELL_READY> cm default' in hn('capture-pane','-p'),'selection returns to editable command')
    assert hn('capture-pane','-p','-S','-').count("Using the agent's own defaults.")==defaults_before, 'completion executed the command'
    keys('Enter');wait(prompt_ready,'completed command executes')
    tm('send-keys','-t','test','-l','ch local');keys('Tab')
    wait(finder_ready,'computer completion widget');keys('Escape')
    wait(lambda:'SHELL_READY> ch local' in hn('capture-pane','-p'),'Escape preserves command draft')
    keys('C-c');wait(prompt_ready,'cancel draft')
    # Escape must close both helpers, with a working prompt immediately afterwards.
    type_line("printf 'INLINE_ANCHOR_%s\\n' OK");wait(prompt_ready,'fresh scrollback anchor')
    type_line('cm'); wait(lambda:'Use agent default' in screen(),'model picker')
    assert finder_ready(), 'picker must be inside the shell PTY'
    assert 'INLINE_ANCHOR_OK' in screen(), 'inline picker hid earlier shell output'
    keys('Escape'); wait(prompt_ready,'picker closed'); type_line("printf 'CANCEL_%s\\n' OK")
    wait(lambda:'CANCEL_OK' in screen(),'model cancel restores shell')
    type_line('hn sessions'); wait(finder_ready,'session picker inside shell PTY')
    if CLI:
        # Search beyond the first two catalog pages, then by words that occur only
        # inside its transcript. Both modes share C-b s's matching and backend.
        tm('send-keys','-t','test','-l','fxwsp')
        wait(lambda:'Fix workspace navigation' in screen(),'inline fuzzy match beyond 200 sessions',35)
        keys('C-u'); tm('send-keys','-t','test','-l','spectral kiwi')
        # Both searches return the same row and preview. The October 6 Linux
        # run read those from the previous query while only "spectra" had been
        # consumed, then asserted against its cleared interim results.
        def full_text_preview():
            capture=hn('capture-pane','-p')
            return capture if '> spectral kiwi ' in capture and re.search(r'\b1/\d+',capture) and 'Fix workspace navigation' in capture and 'conversation is complete' in capture else None
        capture=wait(full_text_preview,'inline full-text match and conversation preview for the new query',20)
        # The shared layout takes the user's 45%, right:50% and inline count.
        box=[i for i,line in enumerate(capture.splitlines()) if '╭' in line or '╰' in line]
        assert box and 12 <= max(box)-min(box)+1 <= 18, capture
        assert any(line.find('conversation')>55 for line in capture.splitlines()),capture
        assert '[bat error]' not in capture and 'No such file' not in capture
        assert 'C-t new window' not in capture and 'without permission' not in capture, 'inline preview advertised workspace-only actions'
        keys('C-_'); wait(lambda:'conversation is complete' not in screen(),'hide conversation preview')
        keys('C-_'); wait(lambda:'conversation is complete' in screen(),'restore conversation preview')
        # Resize the OPEN finder, not just the shell before opening it. Keep the
        # query, hide the unusably small side preview, then restore it on widening.
        tm('resize-window','-t','test','-x','44','-y','13')
        wait(lambda:'spectral kiwi' in hn('capture-pane','-p') and 'conversation is complete' not in hn('capture-pane','-p'),'live narrow resize preserves search')
        tm('resize-window','-t','test','-x','130','-y','38')
        wait(lambda:'spectral kiwi' in hn('capture-pane','-p') and 'conversation is complete' in hn('capture-pane','-p'),'live wide resize restores preview')
        # Cancel an in-flight search and immediately type another command.
        keys('C-u'); tm('send-keys','-t','test','-l','no such session')
    keys('Escape'); wait(prompt_ready,'picker closed'); type_line("printf 'SESSION_CANCEL_%s\\n' OK")
    wait(lambda:'SESSION_CANCEL_OK' in screen(),'session cancel restores shell')
    # A pasted Unicode query is one edit, and Enter with no result must return
    # to the prompt rather than execute a stale selection or reopen a modal.
    type_line('cm');wait(lambda:'Use agent default' in screen(),'empty-result paste test')
    tm('send-keys','-t','test','-l','\x1b[200~no-route-日本語-café\x1b[201~')
    wait(lambda:'no-route-日本語-café' in hn('capture-pane','-p') and '0/1' in hn('capture-pane','-p'),'pasted Unicode query')
    keys('Enter');wait(prompt_ready,'Enter with no matches')
    # A widget has a draft above the picker. Resizing cannot lose or execute it.
    tm('send-keys','-t','test','-l','cm default');keys('Tab')
    wait(finder_ready,'resize completion widget')
    tm('resize-window','-t','test','-x','44','-y','13')
    wait(lambda:'default' in hn('capture-pane','-p') and '╭' in hn('capture-pane','-p'),'narrow completion widget')
    keys('Escape');wait(lambda:'SHELL_READY> cm default' in hn('capture-pane','-p') and '╭' not in hn('capture-pane','-p'),'resized widget restores draft')
    keys('C-c');wait(prompt_ready,'cancel resized draft')
    tm('resize-window','-t','test','-x','130','-y','38')
    # Inline finders stay inside a narrow pane and leave terminal input usable.
    type_line('ch'); wait(finder_ready,'inline computer list')
    keys('Escape'); wait(prompt_ready,'computer picker closed')
    tm('resize-window','-t','test','-x','44','-y','13')
    type_line('cm'); wait(lambda:'Use agent default' in screen(),'narrow inline picker')
    keys('C-c'); wait(prompt_ready,'narrow picker closed'); type_line("printf 'NARROW_%s\\n' OK")
    wait(lambda:'NARROW_OK' in screen(),'narrow Ctrl-C restores shell')
    tm('resize-window','-t','test','-x','130','-y','38')
    keys('C-b','%'); wait(lambda:pane_count()==2,'horizontal split')
    paths=hn('list-panes','-F','#{pane_current_path}').splitlines()
    assert paths==[str(PROJECT)]*2,paths
    keys('C-b','N'); wait(lambda:pane_count()==3,'Shift-N opens pane')
    assert hn('list-panes','-F','#{pane_current_path}').splitlines()==[str(PROJECT)]*3
    if Path(SHELL).name=='zsh' or os.environ.get('HN_SHELL_TEST_COMPOSER_WIDGET')=='1':
        wait(lambda:finder_ready() and 'Claude Code' in screen(),'split agent picker');keys('Escape');wait(prompt_ready,'cancel split agent picker')
    keys('C-b','c'); wait(lambda:len(hn('list-windows','-F','#{window_id}').splitlines())==2,'new window')
    wait(lambda:pane_count()==1,'new window creation completed')
    if Path(SHELL).name=='zsh' or os.environ.get('HN_SHELL_TEST_COMPOSER_WIDGET')=='1':
        wait(lambda:finder_ready() and 'Claude Code' in screen(),'tab agent picker');keys('Escape');wait(prompt_ready,'cancel tab agent picker')
    else:
        wait(prompt_ready,'new window shell ready')
    assert hn('display-message','-p','#{pane_current_path}').strip()==str(PROJECT)
    keys('C-b','"'); wait(lambda:pane_count()==2,'vertical split')
    wait(lambda:hn('capture-pane','-p').count('SHELL_READY>')>=1,'vertical shell ready')
    type_line('ch local'); wait(lambda:hn('capture-pane','-p').count('SHELL_READY>')>=2,'same-host ch finished')
    type_line("printf 'LOCAL_%s\\n' OK")
    wait(lambda:'LOCAL_OK' in screen(),'same-host ch is no-op')
    keys('C-b','d')
    # Reattach restores shells, including their integration, rather than a welcome form.
    # The outer fixture exits when its only client command detaches. It is separate
    # from hn's own persistent server, which must remain running.
    wait(lambda:not tm('list-sessions',check=False).strip(),'outer fixture detached')
    tm('-f','/dev/null','new-session','-d','-s','test','-x','130','-y','38',command)
    wait(lambda:'SHELL_READY>' in screen(),'reattach')
    type_line('cm'); wait(lambda:'Use agent default' in screen(),'cm after reattach')
    keys('Escape')
    print('PASS', SHELL, 'packaged CLI' if CLI else 'local supervisor', 'external fzf widgets' if FZF else 'native widgets only', 'Ctrl-P and reported Cmd-P, scoped picker, direct model/computer choices preserve draft and cursor, ordinary shell, Tab completion and draft recovery, inline model/computer/session lists, 207 saved sessions, fuzzy/full-text search, preview, live resizing, Unicode paste, empty selection, Escape/Ctrl-C, narrow pane, 3 split bindings, local window cwd, ch local, reattach')
    passed=True
finally:
    hn('kill-server',check=False)
    tm('kill-server',check=False)
    if daemon:
        daemon.terminate()
        try: daemon.wait(timeout=10)
        except subprocess.TimeoutExpired: daemon.kill(); daemon.wait(timeout=5)
        run([TMUX,'-L',NAME+'-daemon','kill-server'],check=False)
    if daemon_log: daemon_log.close()
    if passed: shutil.rmtree(BASE,ignore_errors=True)
    else: print('Failure artifacts:',BASE,flush=True)
