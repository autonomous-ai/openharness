#!/usr/bin/env python3
"""Private Linux diagnostic: no Harness daemon, only a disposable tmux server."""
import json, os, shutil, subprocess, tempfile, time
from pathlib import Path

root = Path(tempfile.mkdtemp(prefix='hrp-', dir='/tmp'))
home = root / 'home'
home.mkdir()
(root / 'tmux').mkdir()
(root / 'tmux.conf').write_text('set -g default-shell /bin/sh\nset -g status off\nset -g automatic-rename off\n')
env = {key: value for key, value in os.environ.items() if key in ('PATH','LANG','LC_ALL')}
env.update(HOME=str(home), SHELL='/bin/sh', TERM='xterm-256color', TMUX_TMPDIR=str(root/'tmux'))
exe = shutil.which('tmux')
print(json.dumps({'version':subprocess.check_output([exe,'-V'],text=True).strip(),'fixture':str(root)}),flush=True)
results = []
trace = []

def call(*args, check=True):
    p = subprocess.run([exe,'-vv','-L','hnt19respawnprobe','-f',str(root/'tmux.conf'),*args],cwd=root,env=env,text=True,capture_output=True,timeout=12)
    trace.append({'args':args,'code':p.returncode,'out':p.stdout.strip(),'err':p.stderr.strip()})
    if check and p.returncode: raise AssertionError(trace[-1])
    return p.stdout.strip()

def wait(want, fn):
    end=time.monotonic()+5
    last=None
    while time.monotonic()<end:
        last=fn()
        if last==want:return
        time.sleep(.04)
    raise AssertionError({'expected':want,'actual':last})

try:
    for iteration in range(1,41):
        trace.clear()
        call('new-session','-d','-s','work')
        call('set','-g','@died','')
        call('set-hook','-g','pane-died','set -agF @died "#{window_index}:#{pane_dead_status}:#{pane_dead_signal},"')
        call('set','-g','remain-on-exit','on')
        call('new-window','-d','-t','work:4','printf "HISTORY_MARK\\n"; exit 7')
        wait('1:7',lambda:call('list-panes','-t','work:4','-F','#{pane_dead}:#{pane_dead_status}'))
        call('respawn-window','-t','work:4','printf "RESPAWN_MARK\\n"; exit 9')
        wait('1:9',lambda:call('list-panes','-t','work:4','-F','#{pane_dead}:#{pane_dead_status}'))
        call('respawn-pane','-t','work:4')
        wait('1:9',lambda:call('list-panes','-t','work:4','-F','#{pane_dead}:#{pane_dead_status}'))
        call('set','-g','remain-on-exit','failed')
        call('respawn-pane','-t','work:4','sleep 30')
        wait('0:',lambda:call('list-panes','-t','work:4','-F','#{pane_dead}:#{pane_dead_status}'))
        call('respawn-pane','-t','work:4','exit 8',check=False)
        call('split-window','-d','-t','work:4','sleep 30')
        first=call('list-panes','-t','work:4','-F','#{pane_id}').splitlines()[0]
        call('select-window','-t','work:0')
        call('respawn-window','-k','-t','work:4','printf "WHOLE_WINDOW\\n"; read answer; exit 9')
        wait(first+':0',lambda:call('list-panes','-t','work:4','-F','#{pane_id}:#{pane_dead}'))
        wait(True,lambda:'WHOLE_WINDOW' in call('capture-pane','-p','-t','work:4'))
        call('send-keys','-t','work:4','Enter')
        wait(first+':1:9',lambda:call('list-panes','-t','work:4','-F','#{pane_id}:#{pane_dead}:#{pane_dead_status}'))
        results.append({'round':iteration,'result':'passed'})
        call('kill-server',check=False)
    print(json.dumps({'rounds':len(results),'result':'passed'}),flush=True)
except BaseException as error:
    facts=call('list-panes','-a','-F','#{pane_id}|#{pane_pid}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}|#{pane_start_command}',check=False)
    hooks=call('show','-gv','@died',check=False)
    print(json.dumps({'round':len(results)+1,'error':repr(error),'panes':facts,'hooks':hooks,'trace':trace[-25:]}),flush=True)
    raise
finally:
    call('kill-server',check=False)
    artifacts=Path('.harness/validation/tmux-respawn-probe')
    artifacts.mkdir(parents=True,exist_ok=True)
    (artifacts/'results.json').write_text(json.dumps(results,indent=2))
    for file in root.glob('*.log'):
        if file.name.startswith('tmux-server'):
            shutil.copy2(file,artifacts/file.name)
    shutil.rmtree(root)
