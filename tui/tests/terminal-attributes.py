#!/usr/bin/env python3
"""Compare pane SGR attributes and attribute-only repaints with an isolated real tmux.

Run from tui/: python3 tests/terminal-attributes.py [frozen-binary]
No daemon is started. Every process uses a private HOME and explicit guarded sockets.
"""
import os,pathlib,shlex,shutil,socket,subprocess,sys,tempfile,time,json,signal
port=int(os.environ.get('HN_ATTR_TEST_PORT','19412'))
assert 19410<=port<=19419, 'refusing port outside the test range'
name='hn-attrs-test-'+os.urandom(4).hex()
with socket.socket() as s:s.bind(('127.0.0.1',port))
root=pathlib.Path(tempfile.mkdtemp(prefix='hnattr-',dir='/tmp'))
home=root/'home';home.mkdir()
source=pathlib.Path(sys.argv[1]) if len(sys.argv)>1 else pathlib.Path(__file__).resolve().parents[1]/'target/release/harness-tui'
binary=root/'hn';shutil.copy2(source,binary)
tmux=shutil.which('tmux')
assert tmux, 'tmux must be on PATH'
env={'PATH':os.environ['PATH'],'HOME':str(home),'SHELL':'/bin/sh','TERM':'xterm-256color','LANG':'en_US.UTF-8','PORT':str(port),'HN_SOCKET_NAME':name,'HN_TMPDIR':str(root),'HARNESS_TUI_DESK':'off','HN_DESKTOP':'off','HARNESS_TUI_NOTIFY':'off'}
config=root/'tmux.conf';config.write_text('set -g default-shell /bin/sh\nset -g @hn-look tmux\nset -g status off\nset -g pane-border-status off\nset -g automatic-rename off\n')
program=root/'program.py';program.write_text('''import os,tty,time
# Attribute-only repaints must travel even when text and ratatui modifiers are unchanged.
tty.setraw(0)
os.write(1,b'\\x1b[H\\x1b[2J\\x1b[21mDOUBLE\\x1b[0m\\r\\n\\x1b[5mBLINK\\x1b[0m\\r\\n\\x1b[53mOVERLINE\\x1b[0m\\r\\n\\x1b[4:2mX\\x1b[0m')
while True:
 c=os.read(0,1)
 if c==b'u':os.write(1,b'\\x1b[4;1H\\x1b[4:3mX\\x1b[0m')
 if c==b'o':os.write(1,b'\\x1b[4;1H\\x1b[53mX\\x1b[0m')
 if c==b'p':os.write(1,b'\\x1b[4;1HX')
''')
base=[str(binary),'-L',name,'--port',str(port),'-f',str(config)]
outer=[tmux,'-L',name+'o','-f','/dev/null']
ref=[tmux,'-L',name+'r','-f',str(config)]
def run(args,check=True):return subprocess.run(args,env=env,check=check,capture_output=True,text=True,timeout=20)
def h(*a):
 assert env['PORT']==str(port) and env['HN_SOCKET_NAME']==name
 return run(base+list(a)).stdout
try:
 child=shlex.join(['env','-u','TMUX','-u','TMUX_PANE','-u','HN_SOCKET']+[k+'='+v for k,v in env.items()]+base+['new-session','-s','work',shlex.join(['python3',str(program)])])
 run(outer+['new-session','-d','-s','view','-x','80','-y','24',child])
 run(ref+['new-session','-d','-s','work','-x','80','-y','24',shlex.join(['python3',str(program)])])
 for _ in range(70):
  if 'OVERLINE' in run(outer+['capture-pane','-p','-t','view']).stdout:break
  time.sleep(.1)
 results={}
 for key in ['', 'u','o','p']:
  if key:
   h('send-keys','-t','work:0.0',key)
   run(ref+['send-keys','-t','work:0.0',key]);time.sleep(.25)
  native=h('capture-pane','-ep','-t','work:0.0','-S','0','-E','3')
  expected=run(ref+['capture-pane','-ep','-t','work:0.0','-S','0','-E','3']).stdout
  rendered=run(outer+['capture-pane','-ep','-t','view','-S','0','-E','3']).stdout
  results[key or 'initial']={'native':native,'reference':expected,'rendered':rendered,'native_match':native==expected,'rendered_match':rendered==expected}
 print(json.dumps({k:{'native_match':v['native_match'],'rendered_match':v['rendered_match']} for k,v in results.items()},indent=2))
 (root/'results.json').write_text(json.dumps(results,indent=2))
 assert all(v['native_match'] and v['rendered_match'] for v in results.values()),root
 print('PASS; evidence:',root)
finally:
 for command in [base+['kill-server'],outer+['kill-server'],ref+['kill-server']]:
  try:run(command,False)
  except subprocess.TimeoutExpired:print('Cleanup timed out:',command[0],file=sys.stderr)

 # A failed assertion must not leave this test's UI or PTY supervisor behind.
 rows=[line.strip().split(None,2) for line in subprocess.check_output(['ps','-axo','pid=,ppid=,command='],text=True).splitlines()]
 owned={int(row[0]) for row in rows if len(row)==3 and row[2].startswith(str(binary)+' ')}
 for _ in rows:
  children={int(row[0]) for row in rows if len(row)==3 and int(row[1]) in owned}
  if children<=owned:break
  owned.update(children)
 for pid in owned:
  try:os.kill(pid,signal.SIGTERM)
  except ProcessLookupError:pass
