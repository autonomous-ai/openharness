#!/usr/bin/env python3
"""Welcome composer: native keyboard/mouse, machine scoping, spacing and resize.
Uses only a disposable mock daemon, UI home and named tmux servers.
"""
import json, os, re, shlex, shutil, socket, subprocess, tempfile, time, urllib.request, uuid
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
BASE = Path(tempfile.mkdtemp(prefix='hn-welcome-composer-', dir='/tmp'))
PROJECT = BASE / 'autonomous-harness'; PROJECT.mkdir()
PORT = int(os.environ.get('HN_WELCOME_TEST_PORT', '19788'))
assert 19780 <= PORT <= 19789
NAME = 'hn-welcome-composer-' + str(os.getpid())
HN = BASE / 'hn'; shutil.copy2(os.environ.get('HN_WELCOME_TEST_BINARY', ROOT / 'target/release/harness-tui'), HN)
TMUX = shutil.which('tmux'); assert TMUX
LOCAL_LABEL = 'This Mac' if os.uname().sysname == 'Darwin' else 'This Computer'
ENV = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TZ') if k in os.environ}
ENV.update(HOME=str(BASE), HN_TMPDIR=str(BASE), HN_SOCKET_NAME=NAME, PORT=str(PORT),
           TERM='xterm-256color', COLORTERM='truecolor', SHELL='/bin/sh', HN_DESKTOP='off',
           HARNESS_TUI_DESK='off', HARNESS_TUI_NOTIFY='off', MOCK_DEMO='1', MOCK_NEW_UI='1', MOCK_RECONNECT='1')
OUTPUT = Path(os.environ.get('HN_WELCOME_OUTPUT', BASE / 'captures')); OUTPUT.mkdir(parents=True, exist_ok=True)
SIGNIN = os.environ.get('HN_WELCOME_SIGNIN_CLI')
if SIGNIN:
    # Optional live authorization handshake; the browser launcher records only
    # host/path and never opens or completes a provider login. All auth files,
    # spawn locks and the computer identity belong to this disposable fixture.
    binary = BASE/'bin'; binary.mkdir()
    ENV['PATH'] = str(binary)+':'+ENV['PATH']
    auth_env = dict(PORT=str(PORT), ADAPTER_DATA_DIR=str(BASE/'data'), ADAPTER_CLI_DIR=str(BASE/'cli'),
        HARNESS_AUTH_DIR=str(BASE/'auth'), ADAPTER_COMPUTER_ID=uuid.uuid4().hex,
        ADAPTER_COMPUTER_ID_FILE=str(BASE/'computer-id'), BACKEND_WS_URL='wss://harness-api.autonomous.ai',
        WEB_URL='https://harness.autonomous.ai', ANALYTICS_ENABLED='false')
    wrapper = binary/'harness-account'
    wrapper.write_text('#!/bin/sh\n'+''.join('export '+key+'='+shlex.quote(value)+'\n' for key,value in auth_env.items())+
        'unset HOME\nexec '+shlex.join([shutil.which('node'),SIGNIN])+' "$@"\n'); wrapper.chmod(0o700)
    ENV['HARNESS_CLI'] = str(wrapper)
    browser = BASE/'browser.cjs'
    browser.write_text('const fs=require("fs"); const u=new URL(process.argv[2]); if(u.protocol!=="https:")process.exit(2); '+
        'fs.appendFileSync('+json.dumps(str(BASE/'browser.jsonl'))+',JSON.stringify({host:u.host,path:u.pathname})+"\\n");')
    opener = binary/('open' if os.uname().sysname=='Darwin' else 'xdg-open')
    opener.write_text('#!/bin/sh\nexec '+shlex.join([shutil.which('node'),str(browser)])+' "$@"\n'); opener.chmod(0o700)
def run(args, ok=True):
    r = subprocess.run(list(map(str,args)), env=ENV, cwd=PROJECT, capture_output=True, text=True, timeout=12)
    if ok: assert r.returncode == 0, (args, r.stderr)
    return r.stdout

def hn(*args, ok=True): return run([HN, '-L', NAME, '--port', str(PORT), '-f', '/dev/null', *args], ok)
def tm(*args, ok=True): return run([TMUX, '-L', NAME+'-outer', *args], ok)
def screen(): return tm('capture-pane', '-p', '-t', 'test')
def state():
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/test/dial', timeout=2) as r: return json.load(r)['data']
def created(): return [row for row in state().get('created', []) if row['engine'] != 'terminal']
def wait(fn, label, seconds=12):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if fn(): return
        time.sleep(.07)
    raise AssertionError(label+'\n'+re.sub(r'https://\S+', '[sign-in link]', screen()))
def shows(text): wait(lambda:text in screen(),text)
def keys(*args):
    for key in args: tm('send-keys','-t','test',key); time.sleep(.10)
def type_text(text): tm('send-keys','-l','-t','test',text)
def click(text):
    shows(text)
    for y,line in enumerate(screen().splitlines()):
        if text in line:
            x=line.index(text)
            tm('send-keys','-l','-t','test',f'\x1b[<0;{x+1};{y+1}M\x1b[<0;{x+1};{y+1}m')
            time.sleep(.15); return
    raise AssertionError(text)
def snapshot(name):
    time.sleep(.15)
    (OUTPUT/(name+'.txt')).write_text(screen())
    (OUTPUT/(name+'.ansi')).write_text(tm('capture-pane','-e','-p','-t','test'))
def header(): return next(line.strip() for line in screen().splitlines() if '[ ' in line and ' ▾ ]' in line)
def choose_machine(name):
    click(LOCAL_LABEL if LOCAL_LABEL in header() else 'gpu-box')
    shows('Choose a machine'); type_text(name); keys('Enter')
    wait(lambda:'Choose a machine' not in screen(),'machine accepted')
mock=None
try:
    with socket.socket() as probe: probe.bind(('127.0.0.1',PORT))
    mock=subprocess.Popen(['node',str(ROOT/'tests/mock-daemon.mjs'),str(PORT)],env=ENV,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    for _ in range(100):
        assert mock.poll() is None
        try: state(); break
        except OSError: time.sleep(.05)
    command=shlex.join(['env','-u','TMUX','-u','TMUX_PANE',*[f'{k}={v}' for k,v in ENV.items()],str(HN),'-L',NAME,'--port',str(PORT),'-f','/dev/null'])
    tm('-f','/dev/null','new-session','-d','-s','test','-x','150','-y','48',command)
    tm('set-window-option','-t','test','remain-on-exit','on')
    wait(lambda:'studio' in screen(),'local fixture connected')
    hn('workspace-menu','new-tab'); shows('New Terminal'); shows('Recent harnesses')
    shows('gpu-box shell')  # Terminals remain recent harnesses, as in production.
    shows('What task should this agent work on?')
    snapshot('welcome-empty')
    initial_header=header()
    assert initial_header.index('OpenCode') < initial_header.index(LOCAL_LABEL) < initial_header.rfind('[ '), initial_header
    task='Keep this task while choosing computers'
    type_text(task); shows(task); keys('Enter')
    assert not created(), 'Task Enter must focus Start without submitting'
    snapshot('welcome-wide')

    choose_machine('gpu-box'); assert '[ gpu-box ▾ ]' in header(),header()
    click('New Folder'); shows('Search projects')
    snapshot('welcome-project-picker')
    # A side picker leaves the recent list visible. Check the picker column,
    # not unrelated local projects in that background list.
    project_lines=screen().splitlines()
    picker_x=next(line.index('Search projects') for line in project_lines if 'Search projects' in line)
    projects='\n'.join(line[picker_x:] for line in project_lines)
    assert 'ml-lab' in projects and 'billing' not in projects, 'projects must belong to the selected computer'
    type_text('ml-lab'); keys('Enter'); shows('[ ml-lab ▾ ]'); shows(task)
    choose_machine('studio'); assert header()==initial_header,(header(),initial_header)
    choose_machine('gpu-box'); shows('[ ml-lab ▾ ]'); shows(task)
    click('ml-lab'); shows('Search projects'); click('Open Folder'); shows('Use this folder')
    assert 'Choose a machine' not in screen(), 'Open Folder must use the header destination directly'
    keys('Escape','Escape'); shows(task)
    assert not created()
    snapshot('welcome-remote')
    print('PASS native mouse machine/project choices, scoped folders, restored per-machine drafts, no premature launch',flush=True)

    # Codex exposes every setting, including the account selector and Git group.
    click('OpenCode'); shows('Search agents'); type_text('codex'); keys('Enter')
    shows('Default account'); shows('Worktree')
    assert not created(), 'choosing an agent must not start the task'
    snapshot('welcome-codex-git')

    # Keyboard traversal includes the new computer control and returns to the draft.
    click(task); keys('Tab','Tab','Enter'); shows('Choose a machine')
    keys('Escape'); shows(task)
    click('All'); shows('Search harnesses'); keys('Escape'); shows(task)
    for width,height in [(94,34),(80,24),(58,23),(45,16),(150,48)]:
        tm('resize-window','-t','test','-x',str(width),'-y',str(height)); time.sleep(.25)
        assert tm('display','-p','-t','test','#{pane_dead}').strip()=='0'
        snapshot(f'welcome-{width}x{height}')
        if width>=58:
            for text in ['All','New Terminal','New Harness']: shows(text)
        if width>=80:
            lines=screen().splitlines()
            assert next(i for i,line in enumerate(lines) if 'Worktree' in line)==next(i for i,line in enumerate(lines) if 'OpenAI' in line), 'settings must stay on one row'
    shows(task)
    snapshot('welcome-final-dark')
    tm('send-keys','-l','-t','test','\x1b]10;rgb:2020/2020/2020\x1b\\\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
    snapshot('welcome-light')
    click('ml-lab'); shows('Search projects'); click('Open Folder'); shows('Use this folder')
    keys('C-l','C-a','C-k'); type_text('/home/demo/plain'); keys('Enter'); shows('Use this folder'); keys('Enter')
    wait(lambda:'Worktree' not in screen(),'non-Git folder hides Git controls')
    assert 'Not a Git repository' not in screen()
    shows('Default account'); shows(task)
    snapshot('welcome-codex-no-git')
    if SIGNIN:
        for index,provider in enumerate(['Google','Apple'],1):
            hn('account'); shows('Continue with '+provider); click('Continue with '+provider)
            shows('Finish signing in in your browser.')
            wait(lambda:(BASE/'browser.jsonl').exists() and len((BASE/'browser.jsonl').read_text().splitlines())==index,'browser handoff')
            keys('Escape'); shows(task)
            wait(lambda:not (BASE/'data/adapter.spawn.lock').exists(),'sign-in child exited and released its lock')
            assert not (BASE/'auth/session.json').exists(), 'Cancel saved credentials'
        metadata=[json.loads(line) for line in (BASE/'browser.jsonl').read_text().splitlines()]
        assert all(item=={'host':'auth.autonomous.ai','path':'/oauth2/authorize'} for item in metadata),metadata
        print('PASS native TUI Google/Apple live handoff and Escape cancellation; authentication not completed',flush=True)
    count=len(created()); click('New Terminal'); shows('dev@gpu-box')
    assert len(created())==count, 'New Terminal must not launch the chosen coding agent'
    print('PASS keyboard traversal, All action, wide/narrow/light rendering, preserved task, New Terminal',flush=True)
    hn('workspace-menu','new-tab'); shows('What task should this agent work on?')
    task="what's 1+1"
    type_text(task); keys('Enter')
    assert len(created())==count, 'first task Enter only highlights New Harness'
    snapshot('welcome-ready-to-start')
    keys('Enter')
    wait(lambda:len(created())==count+1 and 'New Terminal' not in screen(),'second Enter creates and opens the harness')
    assert created()[-1]['prompt']==task, created()[-1]
    snapshot('welcome-created')
    print('PASS task Enter highlights New Harness; second Enter creates exactly one harness with the task',flush=True)
    print('Captures: '+str(OUTPUT),flush=True)
finally:
    if HN.exists(): hn('kill-server',ok=False)
    tm('kill-server',ok=False)
    if mock:
        mock.terminate()
        try: mock.wait(timeout=5)
        except subprocess.TimeoutExpired: mock.kill(); mock.wait(timeout=5)
