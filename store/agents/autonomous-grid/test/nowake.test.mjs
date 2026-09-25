// grid-reads-without-waking issue 02, the viewer's half: every automatic read goes out with
// `--no-wake`, a sleeping grid is shown asleep instead of down, a `grid` too old for the flag leaves
// the last reading on screen, and a hidden page stops listening.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { atomicJson, gridJson, PACKAGE, stateDir } from '../lib/fleet.mjs';
import { assemble, createCollector } from '../lib/telemetry.mjs';
import { initializeWorkspace } from '../lib/connect.mjs';
import { createViewer } from '../viewer.mjs';
import { config, device, reads, remoteNodes } from './fixtures.mjs';
import { awakeVerbs, fakeGrid, logged, READS, verbOf } from './fakes.mjs';

const temporary = async t => { const dir=await mkdtemp(join(tmpdir(),'grid-nowake-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir; };
const asleepEnvelope = JSON.stringify({error:{code:'grid_asleep',message:'Grid test-grid is asleep: this grid is resting',status:503}});

test('gridJson carries the refusal code a program branches on, and tells an old grid from a failure',async t=>{
  const dir=await temporary(t),log=join(dir,'calls.json');
  const asleep=await fakeGrid(dir,'asleep',{verbs:{engines:{stderr:`${asleepEnvelope}\nGrid test-grid is asleep: this grid is resting\n`,exit:1}}},log);
  const result=await gridJson({transport:'local',gridBinary:asleep},'remote',['engines','test-grid','--no-wake']);
  assert.equal(result.ok,false);assert.equal(result.refusal,'grid_asleep');assert.equal(result.outdated,false);
  // A codeless refusal and a master that is down keep today's shape: no code a caller could act on.
  const down=await fakeGrid(dir,'down',{verbs:{engines:{stderr:'{"error":{"code":"grid_master_down","message":"down","status":503}}\n',exit:1}}},log);
  assert.equal((await gridJson({transport:'local',gridBinary:down},'remote',['engines','x'])).refusal,'grid_master_down');
  const old=await fakeGrid(dir,'old',{rejectsNoWake:true},log);
  const refused=await gridJson({transport:'local',gridBinary:old},'remote',['engines','test-grid','--no-wake']);
  assert.equal(refused.ok,false);assert.equal(refused.outdated,true);assert.equal(refused.refusal,null);
});

test('a grid too old for --no-wake leaves the last reading, stale, and is never asked again without the flag',async t=>{
  const dir=await temporary(t),log=join(dir,'calls.json');
  const old=await fakeGrid(dir,'grid-0.3.47',{rejectsNoWake:true,verbs:awakeVerbs},log);
  const current=await fakeGrid(dir,'grid-0.3.49',{verbs:awakeVerbs},log);
  const workspace=join(dir,'ws');
  await atomicJson(join(workspace,'grid-fleet.json'),config);
  // An earlier reading on disk, as a viewer that ran yesterday leaves it.
  const earlier=assemble(config,reads,null,'2026-09-24T08:05:00Z');
  await atomicJson(join(stateDir(workspace),'snapshot.json'),earlier);
  const saved=process.env.HARNESS_GRID_BIN;t.after(()=>{if(saved===undefined)delete process.env.HARNESS_GRID_BIN;else process.env.HARNESS_GRID_BIN=saved;});
  const collect=createCollector(workspace);

  process.env.HARNESS_GRID_BIN=old;
  const first=await collect();
  assert.equal(first.status,'updating');
  assert.equal(first.nodes.length,earlier.nodes.length);assert.ok(first.nodes.every(n=>n.stale));
  assert.match(first.notice,/^Test workstation is being updated — showing the reading from \d{2}:\d{2}$/);
  assert.equal(first.readingFrom,'2026-09-24T08:05:00Z');
  assert.ok(!first.events.some(e=>e.kind==='offline'));
  const firstCalls=(await logged(log)).filter(c=>READS.includes(verbOf(c.argv)));
  assert.deepEqual(firstCalls.map(c=>verbOf(c.argv)),['engines'],'one refused read, then nothing — no retry and no models/stats');

  process.env.HARNESS_GRID_BIN=current;
  const second=await collect();
  assert.equal(second.status,'live');assert.equal(second.summary.enginesOnline,7);assert.equal(second.notice,undefined);
  const calls=(await logged(log)).filter(c=>READS.includes(verbOf(c.argv)));
  assert.deepEqual(calls.filter(c=>c.binary==='grid-0.3.49').map(c=>verbOf(c.argv)).sort(),['engines','models','stats']);
  for(const call of calls)assert.ok(call.argv.includes('--no-wake'),`${call.binary} ran ${call.argv.join(' ')} without --no-wake`);
});

test('the own grid asleep is read from its status alone: nothing else is asked, and nothing it served is called gone',async t=>{
  const dir=await temporary(t);await atomicJson(join(dir,'grid-fleet.json'),config);
  const calls=[];let status='running';
  const collect=createCollector(dir,{runJson:async(_m,_mode,args)=>{calls.push(args);
    if(args[0]==='info')return {ok:true,value:{grid:'test-grid',status,grid_url:'https://relay.example'}};
    if(args[0]==='device-info')return {ok:true,value:device};if(args[0]==='use')return {ok:true,value:{active:'test-grid'}};
    return reads[args[0]]||{ok:true,value:[]};}});
  const awake=await collect();assert.equal(awake.status,'live');
  status='asleep';calls.length=0;
  const asleep=await collect();
  assert.deepEqual(calls.filter(a=>READS.includes(a[0])),[],'no engines/models/stats while the status says asleep');
  assert.equal(asleep.status,'asleep');assert.equal(asleep.pollIntervalMs,30_000);
  assert.equal(asleep.nodes.length,awake.nodes.length);assert.ok(asleep.nodes.every(n=>n.stale));
  assert.ok(!asleep.events.some(e=>e.kind==='offline'),'a resting grid did not lose its engines');
  assert.equal(asleep.readingFrom,awake.observedAt);
  const verdict=JSON.parse(await readFile(join(dir,'.harness/verdict.json'),'utf8'));
  assert.equal(verdict.ready,true);assert.doesNotMatch(verdict.summary,/grid/i);
});

test('the first reading after a sleep does not call a node that has not rejoined yet gone',async t=>{
  const dir=await temporary(t);await atomicJson(join(dir,'grid-fleet.json'),config);
  let status='running',engines=reads.engines;
  const collect=createCollector(dir,{runJson:async(_m,_mode,args)=>{
    if(args[0]==='info')return {ok:true,value:{grid:'test-grid',status,grid_url:'https://relay.example'}};
    if(args[0]==='device-info')return {ok:true,value:device};if(args[0]==='use')return {ok:true,value:{active:'test-grid'}};
    if(args[0]==='engines')return engines;
    return reads[args[0]]||{ok:true,value:[]};}});
  const awake=await collect();assert.ok(awake.nodes.length>1);
  status='asleep';await collect();
  // Woken, and only one engine has heard of it so far.
  status='running';engines={ok:true,value:remoteNodes.slice(0,1)};
  const woken=await collect();
  assert.equal(woken.status,'live');
  assert.ok(!woken.events.some(e=>e.kind==='offline'),'a cold wake is not every other engine leaving');
});

test('a member grid is asleep when engines answers grid_asleep, and models and stats are skipped',async t=>{
  const dir=await temporary(t),log=join(dir,'calls.json');
  const verbs={...awakeVerbs,info:{stdout:{grid:'test-grid',type:'domain-restricted',status:null,grid_url:'https://relay.example'}},
    engines:{stderr:`${asleepEnvelope}\nGrid test-grid is asleep: this grid is resting\n`,exit:1}};
  const binary=await fakeGrid(dir,'grid-0.3.49',{verbs},log);
  const workspace=join(dir,'ws');await atomicJson(join(workspace,'grid-fleet.json'),{...config,machines:[{...config.machines[0],gridBinary:binary}]});
  const earlier=assemble(config,reads,null,'2026-09-24T08:05:00Z');
  await atomicJson(join(stateDir(workspace),'snapshot.json'),earlier);
  const snapshot=await createCollector(workspace)();
  assert.equal(snapshot.status,'asleep');assert.equal(snapshot.pollIntervalMs,30_000);
  assert.ok(snapshot.nodes.length>0&&snapshot.nodes.every(n=>n.stale));
  assert.ok(!snapshot.events.some(e=>e.kind==='offline'));
  assert.equal(snapshot.sources.engines?.ok,true,'asleep is an answer, not a failed read');
  const read=(await logged(log)).map(c=>c.argv).filter(a=>READS.includes(verbOf(a)));
  assert.deepEqual(read,[['--remote','engines','test-grid','--no-wake','--json']]);
});

test('the viewer books its next read 30 s out while the grid is asleep, and at its own interval otherwise',async t=>{
  const workspace=await temporary(t);
  let asleep=false;const booked=[];
  const collect=async()=>({...assemble(config,reads),status:asleep?'asleep':'live',pollIntervalMs:asleep?30_000:50,machines:[],operations:[]});
  const timer=(fn,ms)=>{booked.push(ms);return setTimeout(fn,Math.min(ms,20));};
  const viewer=createViewer({workspace,intervalMs:50,collect,timer});
  const port=await viewer.start();t.after(()=>viewer.close());
  const abort=new AbortController();t.after(()=>abort.abort());
  const events=await fetch(`http://127.0.0.1:${port}/events`,{signal:abort.signal});const reader=events.body.getReader();await reader.read();
  await new Promise(r=>setTimeout(r,60));
  assert.ok(booked.length>0&&booked.every(ms=>ms===50),`live: ${booked}`);
  asleep=true;booked.length=0;
  await new Promise(r=>setTimeout(r,80));
  assert.ok(booked.includes(30_000),`asleep: ${booked}`);
});

/** stream.js in a sandbox with a fake document and EventSource — the shipped file, not a copy. */
async function loadStream() {
  const code=await readFile(join(PACKAGE,'viewer','stream.js'),'utf8');
  const listeners={},opened=[];
  const doc={hidden:false,addEventListener:(type,fn)=>{(listeners[type]||=[]).push(fn);}};
  class FakeEventSource{constructor(url){this.url=url;this.closed=false;this.handlers={};opened.push(this);}addEventListener(type,fn){this.handlers[type]=fn;}close(){this.closed=true;}}
  const sandbox={};runInNewContext(code,sandbox);
  return {api:sandbox.harnessViewerStream,doc,opened,FakeEventSource,flip:hidden=>{doc.hidden=hidden;for(const fn of listeners.visibilitychange||[])fn();}};
}

test('a hidden page closes its event stream and reopens it when shown again',async()=>{
  const {api,doc,opened,FakeEventSource,flip}=await loadStream();
  const received=[];
  const live=api.liveStream({doc,open:url=>new FakeEventSource(url),onSnapshot:e=>received.push(e),onError:()=>{}});
  assert.equal(opened.length,1);assert.equal(opened[0].url,'events');assert.equal(live.connected(),true);
  flip(true);assert.equal(opened[0].closed,true);assert.equal(live.connected(),false);
  flip(true);assert.equal(opened.length,1,'hidden twice is still one close, no reopen');
  flip(false);assert.equal(opened.length,2);assert.equal(opened[1].closed,false);assert.equal(live.connected(),true);
  opened[1].handlers.snapshot({data:'{}'});assert.equal(received.length,1);
  // A page that loads hidden (a background tab) does not open a stream until it is looked at.
  const late=await loadStream();late.doc.hidden=true;
  late.api.liveStream({doc:late.doc,open:url=>new late.FakeEventSource(url),onSnapshot:()=>{},onError:()=>{}});
  assert.equal(late.opened.length,0);late.flip(false);assert.equal(late.opened.length,1);
});

test('the viewer serves stream.js to the page that loads it',async t=>{
  const workspace=await temporary(t);
  const viewer=createViewer({workspace,intervalMs:1000,collect:async()=>({...assemble(config,reads),machines:[],operations:[]})});
  const port=await viewer.start();t.after(()=>viewer.close());
  const page=await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.ok(page.indexOf('src="stream.js"')>=0&&page.indexOf('src="stream.js"')<page.indexOf('src="app.js"'));
  assert.equal((await fetch(`http://127.0.0.1:${port}/stream.js`)).status,200);
});

test('a fresh workspace probes with --no-wake and takes a sleeping own grid as an answer',async t=>{
  const dir=await temporary(t);await atomicJson(join(dir,'grid-fleet.json'),{...config,grid:null,mode:'remote'});
  const calls=[];
  const runJson=async(_host,mode,args)=>{calls.push([mode,...args]);
    if(args[0]==='engines')return {ok:false,error:'grid engines failed (1): asleep',refusal:'grid_asleep',outdated:false};
    return {ok:true,value:args[0]==='mode'?{mode:'remote'}:args[0]==='use'?{mode:'remote',active:null}:args[0]==='ls'&&mode==='remote'?[{grid:'tuan-dev-991371e4',type:'permissioned-public'}]:[]};};
  const {config:result}=await initializeWorkspace(dir,{profilePath:join(dir,'defaults.json'),discover:async()=>[],runJson,select:async(_h,_m,grid)=>({ok:true,active:grid}),email:async()=>'tuan.dev@autonomous.ai',env:{}});
  assert.equal(result.grid,'tuan-dev-991371e4');
  const probes=calls.filter(c=>c[1]==='engines');
  assert.ok(probes.length>0);for(const probe of probes)assert.ok(probe.includes('--no-wake'),probe.join(' '));
});
