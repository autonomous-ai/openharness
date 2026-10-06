#!/usr/bin/env python3
"""Native hn picker against paged protocol fixtures. No personal sessions are read."""
import json, os, shlex, shutil, socket, subprocess, tempfile, time, urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
BASE=Path(tempfile.mkdtemp(prefix='hn-workspace-sessions-',dir='/tmp')).resolve()
HN=BASE/'hn'; shutil.copy2(os.environ['HN_SESSION_TEST_BINARY'],HN)
TMUX=shutil.which('tmux'); NODE=shutil.which('node'); assert TMUX and NODE
NAME=f'hn-workspace-sessions-{os.getpid()}'; PORT=int(os.environ.get('HN_SESSION_TEST_PORT','19929'))
assert 19920 <= PORT <= 19929
with socket.socket() as probe: probe.bind(('127.0.0.1',PORT))
ENV={k:os.environ[k] for k in ('PATH','LANG','LC_ALL','TZ') if k in os.environ}
ENV.update(HOME=str(BASE),HN_TMPDIR=str(BASE),HN_SOCKET_NAME=NAME,PORT=str(PORT),SHELL='/bin/sh',TERM='xterm-256color',COLORTERM='truecolor',HN_DESKTOP='off',HARNESS_TUI_DESK='sync',HARNESS_TUI_NOTIFY='off',HN_SESSION_FIXTURE='1')
def run(args,check=True):
 r=subprocess.run(list(map(str,args)),env=ENV,cwd=BASE,text=True,capture_output=True,timeout=10)
 if check and r.returncode: raise AssertionError((args,r.stdout,r.stderr))
 return r.stdout
def tm(*args,check=True): return run([TMUX,'-L',NAME+'-outer',*args],check)
def hn(*args,check=True): return run([HN,'-L',NAME,'--port',PORT,'-f','/dev/null',*args],check)
def state():
 with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/test',timeout=2) as r: return json.load(r)['data']
def screen(): return tm('capture-pane','-p','-t','test',check=False)
def wait(fn,label,seconds=15):
 until=time.monotonic()+seconds
 while time.monotonic()<until:
  try:
   result=fn()
   if result: return result
  except (OSError,ValueError): pass
  time.sleep(.08)
 raise AssertionError((label,screen()))
def keys(*v): tm('send-keys','-t','test',*v)
def query(s): tm('send-keys','-t','test','-l',s)
def creates(): return [r for r in state()['requests'] if r['type'] in ('agent_create','shell_open')]
with (BASE/'fixture.log').open('w') as log:
 peer=subprocess.Popen([NODE,str(ROOT/'tests/workspace-mock.mjs'),str(PORT)],env=ENV,stdout=log,stderr=subprocess.STDOUT)
 try:
  wait(lambda:state(),'fixture start')
  command=shlex.join(['env','-u','TMUX','-u','TMUX_PANE','-u','HN_SOCKET',str(HN),'-L',NAME,'--port',str(PORT),'-f','/dev/null','sessions'])
  tm('-f','/dev/null','new-session','-d','-s','test','-x','115','-y','34',command)
  wait(lambda:'Sessions on this computer' in screen(),'standalone hn sessions')
  wait(lambda:any(r['type']=='session_search' and r['payload'].get('catalogAfter')=='external-199' for r in state()['requests']),'third metadata page')
  wait(lambda:'Fix workspace navigation' in screen(),'newest saved conversation from last catalog page is visible without searching')
  query('fxwsp')
  wait(lambda:'Fix workspace navigation' in screen(),'fuzzy match beyond first 200 sessions')
  before=len(creates()); keys('Escape')
  wait(lambda:'Sessions on this computer' not in screen(),'Escape')
  assert len(creates())==before
  # Enter on an existing running session focuses it; no second agent is created.
  hn('sessions','Alpha'); wait(lambda:'Sessions on this computer' in screen(),'reopen')
  keys('Enter'); wait(lambda:'Sessions on this computer' not in screen(),'focus running')
  assert len(creates())==before
  # Saved native conversations resume exactly once, with their recorded cwd/id.
  hn('sessions','fxwsp'); wait(lambda:'Fix workspace navigation' in screen(),'saved match')
  keys('Enter'); wait(lambda:len(creates())==before+1,'resume saved')
  p=creates()[-1]['payload']
  assert p['resumeSessionId']=='external-206' and p['cwd']=='/work/saved project' and p['engine']=='codex',p
  assert p['bypassPermission'] is False, 'shell browser must preserve native approval settings'
  wait(lambda:'Fix workspace navigation terminal' in screen(),'resumed pane')
  hn('sessions','fxwsp'); wait(lambda:'Fix workspace navigation' in screen(),'find resumed')
  keys('Enter'); wait(lambda:'Sessions on this computer' not in screen(),'focus resumed')
  assert len(creates())==before+1,'duplicated resumed conversation'
  tm('resize-window','-t','test','-x','62','-y','19')
  hn('sessions'); wait(lambda:'Sessions on this computer' in screen(),'narrow picker')
  query('fxwsp'); keys('Escape')
  wait(lambda:'Sessions on this computer' not in screen(),'narrow Escape')
  # Protocol simulation: real TUI state, two fixture computers, no remote login.
  def emit(agent,verb,query=''):
   data=json.dumps({'action':'shell-command','agent':agent,'verb':verb,'query':query}).encode()
   with urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{PORT}/test',data=data,headers={'Content-Type':'application/json'}),timeout=3) as r: json.load(r)
  def replies(): return [r for r in state()['requests'] if r['type']=='shell_context_reply']
  tm('resize-window','-t','test','-x','115','-y','34')
  hn('new-terminal'); wait(lambda:creates()[-1]['payload']['engine']=='terminal','context shell')
  local=state()['local']; remote=state()['remote']
  shell=wait(lambda:next((a['id'] for a in state()['agents'][local] if a['engine']=='terminal'),None),'local shell id')
  wait(lambda:'New terminal terminal' in screen(),'shell stream')
  # Recalling a completed cm command works before the model picker ever opened.
  n=len(replies()); emit(shell,'model-inline','Studio :: fixture-qwen')
  wait(lambda:len(replies())>n,'model route selection')
  assert 'fixture-qwen' in replies()[-1]['payload']['text'],replies()[-1]
  assert 'Reading available models' not in screen(), 'completed command opened a modal'
  n=len(replies()); emit(shell,'route'); wait(lambda:len(replies())>n,'route read')
  assert replies()[-1]['payload']['text']=='Studio\nfixture-qwen'
  n=len(creates()); emit(shell,'host','Remote')
  wait(lambda:len(creates())==n+1,'remote shell created')
  assert creates()[-1]['machine']==remote
  remote_shell=wait(lambda:next((a['id'] for a in state()['agents'][remote] if a['engine']=='terminal'),None),'remote shell id')
  wait(lambda:[r for r in state()['requests'] if r['type']=='terminal_open'][-1]['payload']['agentId']==remote_shell,'remote shell visible')
  n=len(replies()); emit(remote_shell,'route'); wait(lambda:len(replies())>n,'remote keeps route')
  assert replies()[-1]['payload']['text']=='Studio\nfixture-qwen'
  n=len(creates()); emit(remote_shell,'host','-')
  wait(lambda:[r for r in state()['requests'] if r['type']=='terminal_open'][-1]['payload']['agentId']==shell,'ch returns parked local shell')
  assert len(creates())==n
  n=len(replies()); emit(shell,'host'); wait(lambda:'Computer' in screen(),'host picker')
  keys('Escape'); wait(lambda:len(replies())>n,'host cancel response')
  assert replies()[-1]['payload']['code']==1
  # Composition reads the selected computer without changing the live shell.
  def command_reply(verb,payload):
   count=len(replies());emit(shell,verb,json.dumps(payload))
   wait(lambda:len(replies())>count,'composer reply '+verb,40)
   return replies()[-1]['payload']
  count=len(creates())
  chosen={'host':'Remote','engine':'claude','cwd':'/work/alpha'}
  result=command_reply('list-compose',{'kind':'host','query':'','compose':chosen})
  assert any(row['id']=='Remote' for row in result['data']['rows']),result
  assert result['data']['machine']==remote,result
  for name,expected in [(None,local),('local',local),('remote',remote),(remote,remote)]:
   result=command_reply('list-compose',{'kind':'host','query':'','compose':dict(chosen,host=name)})
   assert result['data']['machine']==expected,(name,result)
   assert any(row['extra']==expected for row in result['data']['rows']),(name,result)
  result=command_reply('list-compose',{'kind':'host','query':'','compose':dict(chosen,host='missing-old-computer')})
  assert result['data']['machine'] is None and any(row['id']=='Remote' for row in result['data']['rows']),result
  for kind in ('folder','model'):
   command_reply('list-compose',{'kind':kind,'query':'','compose':chosen})
   wait(lambda:any(r['machine']==remote and r['type']==('fs_list_dir' if kind=='folder' else 'models_list') for r in state()['requests']),'target-scoped '+kind)
  assert len(creates())==count,'completion created an agent'
  launch={'engine':'claude','host':None,'path':'/work/local','model':'sonnet','args':['--','a literal $(touch no)'],'cwd':'/work/alpha'}
  result=command_reply('compose-launch',launch)
  assert result['code']==0 and result['data']['args']==['--model','sonnet','--','a literal $(touch no)'],result
  assert len(creates())==count,'local composition replaced original shell'
  result=command_reply('route',{})
  assert result['text']=='Studio\nfixture-qwen','per-command model mutated cm'
  launch['host']='Remote';launch['path']='~/repo'
  result=command_reply('compose-launch',launch)
  assert result['code']==0 and result['data']['attached'],result
  assert len(creates())==count+1
  request=creates()[-1];assert request['machine']==remote
  assert request['payload']['cwd']=='/work/repo' and request['payload']['argv']==['harness','shell-launch','claude','--native','--','--model','sonnet','--','a literal $(touch no)'],request
  assert 'command' not in request['payload'], 'remote composition must use literal argv'
  agent=next(a['id'] for a in state()['agents'][remote] if a['engine']=='claude')
  body=json.dumps({'action':'composer-exit','agent':agent}).encode()
  with urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{PORT}/test',data=body,headers={'Content-Type':'application/json'})) as r:json.load(r)
  wait(lambda:[r for r in state()['requests'] if r['type']=='terminal_open'][-1]['payload']['agentId']==shell,'remote composed exit returns original shell',20)
  body=json.dumps({'action':'config','patch':{'oldComposer':True}}).encode()
  with urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{PORT}/test',data=body,headers={'Content-Type':'application/json'})) as r:json.load(r)
  result=command_reply('compose-launch',launch)
  assert result['code']==1 and 'Update the CLI' in result['text'],result
  assert len(creates())==count+1,'old remote silently discarded argv'
  print('PASS composer protocol: target-scoped completion, no early launch, local literal plan, cm preservation, exact remote argv/cwd/approvals, original shell restored, old CLI refused',flush=True)
  # Inline commands receive the very same paged rows without opening an app
  # modal, then choose through C-b s's exact resume implementation.
  def inline_rows():
   n=len(replies()); emit(shell,'list-sessions',json.dumps({'query':'','revision':''}))
   wait(lambda:len(replies())>n,'inline catalog response')
   data=replies()[-1]['payload'].get('data',{})
   return data.get('rows',[]) if len(data.get('rows',[]))>=207 else None
  rows=wait(inline_rows,'inline complete catalog')
  assert any(r['id']==f'external:{local}:external-205' for r in rows)
  assert 'Sessions on this computer' not in screen(), 'inline query opened a modal'
  n=len(creates()); k=len(replies())
  emit(shell,'session-inline',f'external:{local}:external-205')
  wait(lambda:len(creates())==n+1 and len(replies())>k,'inline saved session selection')
  assert replies()[-1]['payload']['code']==0,replies()[-1]
  p=creates()[-1]['payload']
  assert p['resumeSessionId']=='external-205' and p['engine']=='claude' and p['cwd']=='/work/saved project',p
  assert p['bypassPermission'] is False
  # A cached history row can become a desktop-owned harness without a pushed
  # roster update. Selection refreshes ownership and attaches instead of creating.
  for sid,expected_creates,expected_code in [('external-204',0,0),('external-203',1,0),('external-202',1,0),('external-201',1,1)]:
   before_shells={a['id'] for a in state()['agents'][local] if a['engine']=='terminal'}
   hn('new-window','-n','ownership-'+sid)
   shell=wait(lambda:next((a['id'] for a in state()['agents'][local] if a['engine']=='terminal' and a['id'] not in before_shells),None),'fresh source shell')
   wait(lambda:[r for r in state()['requests'] if r['type']=='terminal_open'][-1]['payload']['agentId']==shell and 'New terminal terminal' in screen(),'fresh shell visible')
   if sid=='external-204':
    body=json.dumps({'action':'session-owner','session':sid}).encode()
    with urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{PORT}/test',data=body,headers={'Content-Type':'application/json'})) as r:json.load(r)
   n=len(creates());k=len(replies());emit(shell,'session-inline',f'external:{local}:{sid}')
   wait(lambda:len(replies())>k,'resolved session '+sid)
   assert replies()[-1]['payload']['code']==expected_code,(sid,replies()[-1])
   assert len(creates())==n+expected_creates,(sid,creates()[n:])
   if expected_code==0:
    wait(lambda:f'Saved task {int(sid[-3:])} terminal' in screen(),'existing or resumed conversation visible '+sid)
    matches=[a for a in state()['agents'][local] if a['sessionId']==sid]
    assert len(matches)==1,(sid,matches)
    assert [r for r in state()['requests'] if r['type']=='terminal_open'][-1]['payload']['agentId']==matches[0]['id']
   else:
    assert 'native editor owns' in replies()[-1]['payload']['text'],replies()[-1]
    assert not any(a['sessionId']==sid for a in state()['agents'][local])
   assert all(not r['payload'].get('takeOver') for r in creates()[n:])
  print('PASS history-to-desktop attachment, stale open flag, concurrent desktop-open race, native-editor ownership refusal; no duplicate or takeover',flush=True)
  print('PASS standalone launch, 207-session pagination, fuzzy matching, Escape, running-session focus, precise resume, deduplication, narrow terminal; model route, remote switch, parked-shell return, host cancel; inline catalog and exact saved-session resume')
 finally:
  hn('kill-server',check=False); tm('kill-server',check=False)
  peer.terminate()
  try: peer.wait(timeout=5)
  except subprocess.TimeoutExpired: peer.kill(); peer.wait(timeout=5)
  shutil.rmtree(BASE,ignore_errors=True)
