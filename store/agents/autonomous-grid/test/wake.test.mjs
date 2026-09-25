// grid-reads-without-waking issue 03, the viewer's half: "Wake now" is the one thing in the viewer that
// may start a sleeping grid, and only on a person's click. It asks the Harness daemon for its explicit
// wake over the loopback bridge, answers the page at once, and shows how the wake ended — while every
// automatic read stays credential-less (`--no-wake`) and never reaches the bridge at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { atomicJson, PACKAGE } from '../lib/fleet.mjs';
import { daemonWake } from '../lib/wake.mjs';
import { createViewer } from '../viewer.mjs';
import { config } from './fixtures.mjs';
import { awakeVerbs, fakeBridge, fakeGrid, logged, READS, replan, verbOf } from './fakes.mjs';

const MACHINE = 'this-computer';
const WAKING = 'Starting up… usually 15–40 s';
// Named as the desktop names them (resting_model_words.dart): the account's own grid is "your models",
// a shared one goes by its name.
const OWN_NOT_STARTED = "Couldn't start your models right now — it will start on your next message";
const TEAM_NOT_STARTED = "Couldn't start team right now — it will start on your next message";
const NOBODY = 'Nobody is serving a model here right now';
const SERVING = [{ id:'Qwen3.5-27B', node:'Mac Studio' }];
/** The fake `grid`'s answers for a workspace looking at [grid], its status [status]. */
const verbsFor = (grid, status) => ({ ...awakeVerbs, use:{stdout:{mode:'remote',active:grid}}, ls:{stdout:[{grid,type:'permissioned-public'}]},
  info:{stdout:{grid,type:'permissioned-public',status,grid_url:'https://relay.example'}} });
// Retried: a poll that was already out when its viewer closed may still be writing into the workspace.
const remove = dir => rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});
const eventually = async (check, ms = 5000) => { const end=Date.now()+ms; while(!check()){ if(Date.now()>end)throw new Error('timed out'); await new Promise(r=>setTimeout(r,10)); } };
const section = extra => ({ name:'test-grid', type:'permissioned-public', own:true, models:[], seenAt:null, lastKnownAge:null, ...extra });
const shared = extra => section({ name:'team', type:'domain-restricted', own:false, ...extra });
/** This ticket's sentences never say "grid" — whichever grid it is, and however the wake went. */
const saysNoGrid = s => { for (const x of s.seen.snapshots) if (x.wake) assert.doesNotMatch(x.wake.message, /grid/i); };

/** The daemon's side of 03-wire-contract.md: the wake's own reply says `waking` at once, and every later
 *  ask says `waking` until the test hands over how it ended (`ending()`, null while it runs). */
function daemon({ ending = () => null, base = section, first = base({ state:'waking' }), handshakes = 1 } = {}) {
  return (frame, send) => {
    const { type, payload } = frame;
    if (type === 'machine_select') for (let i = 0; i < handshakes; i++) send({ type:'connected', payload:{ machineId:payload.machineId, transport:'local', localProtocolVersion:1 } });
    if (type !== 'grid_models_list') return;
    const grid = payload.wake ? first : ending() || base({ state:'waking' });
    send({ type:'grid_models_list_result', payload:{ requestId:payload.requestId, gridName:'test-grid', models:grid.models, grids:[grid] } });
  };
}

/** The page's event stream, every snapshot kept in order, and a wait for the first that matches. */
async function listen(t, base) {
  const abort = new AbortController(); t.after(() => abort.abort());
  const reader = (await fetch(`${base}/events`, { signal:abort.signal })).body.getReader(), decoder = new TextDecoder();
  const snapshots = []; let buffer = '';
  void (async () => { try { for (;;) {
    const { value, done } = await reader.read(); if (done) return;
    buffer += decoder.decode(value, { stream:true });
    for (let cut = buffer.indexOf('\n\n'); cut >= 0; cut = buffer.indexOf('\n\n')) {
      const data = buffer.slice(0, cut).split('\n').find(line => line.startsWith('data: ')); buffer = buffer.slice(cut + 2);
      if (data) snapshots.push(JSON.parse(data.slice(6)));
    }
  } } catch { /* aborted */ } })();
  const until = async (match, ms) => { await eventually(() => snapshots.some(match), ms); return snapshots.find(match); };
  return { snapshots, until };
}

/** A viewer on a workspace looking at [grid], asleep, a fake `grid` it reads with, and a fake bridge. */
async function setup(t, respond, { grid = 'test-grid', verbs = verbsFor(grid, 'asleep'), bridgeUrl, giveUpMs = 5000, intervalMs = 50 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'grid-wake-')), log = join(dir, 'calls.log');
  const binary = await fakeGrid(dir, 'grid', { verbs }, log);
  const workspace = join(dir, 'ws');
  await atomicJson(join(workspace, 'grid-fleet.json'), { ...config, grid, machines:[{ ...config.machines[0], gridBinary:binary }] });
  const bridge = await fakeBridge(respond);
  const viewer = createViewer({ workspace, intervalMs, wakeOptions:{
    env:{ HARNESS_GRID_BRIDGE_URL:bridgeUrl || bridge.url }, discover:async () => [{ machineId:'another', current:false }, { machineId:MACHINE, current:true }], pollMs:10, giveUpMs,
  } });
  // One hook, in this order (hooks run first-in-first-out, and a failed one skips the rest): a viewer
  // left polling keeps the test process alive, and writes into the workspace being removed.
  t.after(async () => { await viewer.close(); await bridge.close(); await remove(dir); });
  const port = await viewer.start();
  const base = `http://127.0.0.1:${port}`;
  const seen = await listen(t, base);
  const click = (headers = {}) => fetch(`${base}/api/wake`, { method:'POST', headers:{ 'content-type':'application/json', ...headers }, body:'{}' });
  return { base, bridge, seen, click, awaken: () => replan(binary, { verbs:verbsFor(grid, 'running') }), calls: () => logged(log) };
}
const wakeFrames = bridge => bridge.frames().filter(f => f.type === 'grid_models_list' && 'wake' in f.payload);

test('Wake now asks the daemon once, answers "waking" at once, and a woken grid shows its engines', async t => {
  let ending = null;
  const s = await setup(t, daemon({ ending: () => ending }));
  await s.seen.until(x => x.status === 'asleep');

  const response = await s.click();
  assert.equal(response.status, 202);
  const { wake } = await response.json();
  assert.equal(wake.state, 'waking'); assert.equal(wake.message, WAKING); assert.equal(wake.grid, 'test-grid');
  await s.seen.until(x => x.wake?.state === 'waking');
  // The daemon is still starting it: asked again, each time without a wake, and nothing has ended.
  await eventually(() => s.bridge.frames().filter(f => f.type === 'grid_models_list').length >= 3);
  assert.ok(s.seen.snapshots.every(x => !x.wake || x.wake.state === 'waking'), 'the POST answered before the wake finished');

  await s.awaken();
  ending = section({ state:'awake', models:SERVING, seenAt:new Date().toISOString(), lastKnownAge:0 });
  const ended = await s.seen.until(x => x.wake && x.wake.state !== 'waking');
  assert.equal(ended.wake.state, 'awake'); assert.equal(ended.wake.message, 'Your models started');
  // Read at once, not at the resting pace (30 s): the woken grid's engines are drawn from that read.
  const live = await s.seen.until(x => x.status === 'live');
  assert.ok(live.nodes.length > 0); assert.equal(live.wake, undefined, 'a grid seen serving has had its start');

  assert.equal(s.bridge.connections.length, 1, 'one connection for the whole wake');
  const [connection] = s.bridge.connections;
  assert.deepEqual(connection.frames[0], { type:'machine_select', payload:{ machineId:MACHINE, localProtocolVersion:1, relayIsolation:true } });
  const lists = connection.frames.filter(f => f.type === 'grid_models_list');
  assert.deepEqual(wakeFrames(s.bridge).map(f => f.payload.wake), [['test-grid']], 'exactly one wake');
  assert.equal(lists[0], wakeFrames(s.bridge)[0], 'the wake is the first ask');
  assert.ok(lists.every(f => f.payload.rowState === true && typeof f.payload.requestId === 'string'));
  await eventually(() => connection.closed);
  const reads = (await s.calls()).filter(c => READS.includes(verbOf(c.argv)));
  assert.ok(reads.length > 0);
  for (const call of reads) assert.ok(call.argv.includes('--no-wake'), `ran ${call.argv.join(' ')} without --no-wake`);
  saysNoGrid(s);
});

test('each way a wake can end is shown in the published snapshot, naming the grid as the desktop does', async t => {
  // The daemon's own section says whose it is: the viewer's label for a grid can be "Your grid".
  const endings = [
    ['your own did not come up', section, section({ state:'asleep', wakeOutcome:'not_started' }), 'not_started', OWN_NOT_STARTED],
    ['a shared one did not come up', shared, shared({ state:'asleep', wakeOutcome:'not_started' }), 'not_started', TEAM_NOT_STARTED],
    ['it came up and nobody serves', section, section({ state:'awake', wakeOutcome:'nobody_serving' }), 'nobody_serving', NOBODY],
    ['your own started', section, section({ state:'awake', models:SERVING }), 'awake', 'Your models started'],
    ['a shared one started', shared, shared({ state:'awake', models:SERVING }), 'awake', 'team started'],
    ['the daemon never said, for your own (the viewer gives up)', section, null, 'not_started', OWN_NOT_STARTED],
    ['the daemon never said, for a shared one', shared, null, 'not_started', TEAM_NOT_STARTED],
  ];
  for (const [name, base, ending, state, message] of endings) {
    await t.test(name, async t => {
      const s = await setup(t, daemon({ ending: () => ending, base }), { grid:base({}).name, giveUpMs:ending ? 5000 : 200 });
      await s.seen.until(x => x.status === 'asleep');
      assert.equal((await (await s.click()).json()).wake.state, 'waking');
      const ended = await s.seen.until(x => x.wake && x.wake.state !== 'waking');
      assert.equal(ended.wake.state, state); assert.equal(ended.wake.message, message);
      assert.deepEqual(wakeFrames(s.bridge).map(f => f.payload.wake), [[base({}).name]]);
      await eventually(() => s.bridge.connections[0].closed);
      saysNoGrid(s);
    });
  }
});

test('a second click while a wake runs joins it, and a repeated handshake sends no second wake', async t => {
  let ending = null;
  const s = await setup(t, daemon({ ending: () => ending, handshakes:2 }));
  await s.seen.until(x => x.status === 'asleep');
  const answers = await Promise.all([s.click(), s.click()]);
  await eventually(() => wakeFrames(s.bridge).length === 1);
  answers.push(await s.click());
  for (const answer of answers) { assert.equal(answer.status, 202); assert.equal((await answer.json()).wake.state, 'waking'); }
  ending = section({ state:'asleep', wakeOutcome:'not_started' });
  await s.seen.until(x => x.wake?.state === 'not_started');
  assert.equal(s.bridge.connections.length, 1); assert.equal(wakeFrames(s.bridge).length, 1);
  saysNoGrid(s);
});

test('a bridge that is not there, or a daemon too old for the wake, is said plainly — nothing else is tried', async t => {
  await t.test('no bridge to connect to', async t => {
    const closed = createServer(); await new Promise(r => closed.listen(0, '127.0.0.1', r)); const { port } = closed.address(); await new Promise(r => closed.close(r));
    const s = await setup(t, daemon(), { bridgeUrl:`ws://127.0.0.1:${port}/api/local-ws` });
    await s.seen.until(x => x.status === 'asleep');
    assert.equal((await (await s.click()).json()).wake.state, 'waking');
    const ended = await s.seen.until(x => x.wake && x.wake.state !== 'waking');
    assert.equal(ended.wake.state, 'failed'); assert.match(ended.wake.message, /^Couldn't reach Harness, so nothing was started/);
    saysNoGrid(s);
  });
  await t.test('a daemon that answers without "waking" (it predates the wake)', async t => {
    const s = await setup(t, daemon({ first:section({ state:'asleep' }) }));
    await s.seen.until(x => x.status === 'asleep');
    await s.click();
    const ended = await s.seen.until(x => x.wake && x.wake.state !== 'waking');
    assert.equal(ended.wake.state, 'failed'); assert.match(ended.wake.message, /^Update Harness to start it from here/);
    await eventually(() => s.bridge.connections[0].closed);
    assert.equal(s.bridge.frames().filter(f => f.type === 'grid_models_list').length, 1, 'asked once, never again');
    saysNoGrid(s);
  });
  await t.test('a controller reached over SSH, or a computer Harness cannot name, has no daemon to ask', async t => {
    const bridge = await fakeBridge(daemon()); t.after(() => bridge.close());
    const options = { grid:'test-grid', env:{ HARNESS_GRID_BRIDGE_URL:bridge.url }, pollMs:10, giveUpMs:300 };
    const ssh = await daemonWake({ ...options, controller:{ id:'rig', name:'Rig', transport:'ssh', host:'rig.example' } });
    assert.equal(ssh.state, 'failed'); assert.match(ssh.message, /^Couldn't start it from here/);
    const unnamed = await daemonWake({ ...options, controller:{ id:'local', name:'This machine', transport:'local' }, discover:async () => { throw new Error('harness: not found'); } });
    assert.equal(unnamed.state, 'failed'); assert.match(unnamed.message, /^Couldn't reach Harness/);
    assert.equal(bridge.connections.length, 0);
    // A Harness-linked controller is asked by its own machine id, relayed by this computer's bridge.
    const linked = await daemonWake({ ...options, controller:{ id:'rig', name:'Rig', transport:'harness', machineId:'rig-id' }, discover:async () => assert.fail('a linked machine names itself') });
    assert.equal(linked.state, 'not_started'); assert.equal(linked.message, OWN_NOT_STARTED);
    assert.equal(bridge.frames()[0].payload.machineId, 'rig-id');
    for (const { message } of [ssh, unnamed, linked]) assert.doesNotMatch(message, /grid/i);
  });
});

test('no automatic read reaches the bridge, and the wake is refused unless a resting grid is on screen', async t => {
  const s = await setup(t, daemon(), { verbs:awakeVerbs, intervalMs:20 });
  await s.seen.until(x => x.status === 'live');
  await eventually(() => s.seen.snapshots.filter(x => x.status === 'live').length >= 4);
  for (let i = 0; i < 3; i++) await (await fetch(`${s.base}/api/snapshot`)).json();
  assert.equal((await s.click()).status, 409, 'nothing to start on an awake grid');
  assert.equal((await s.click({ origin:'https://evil.example' })).status, 403);
  assert.equal(s.bridge.connections.length, 0, 'polls never open the bridge');
  const reads = (await s.calls()).filter(c => READS.includes(verbOf(c.argv)));
  assert.ok(reads.length >= 3);
  for (const call of reads) assert.ok(call.argv.includes('--no-wake'), `ran ${call.argv.join(' ')} without --no-wake`);
});

/** viewer/wake.js in a sandbox — the shipped file, not a copy. Views go through JSON: they are objects
 *  of another realm. */
async function loadWake() {
  const sandbox = {}; runInNewContext(await readFile(join(PACKAGE, 'viewer', 'wake.js'), 'utf8'), sandbox);
  const api = sandbox.harnessViewerWake;
  return { RESTING:api.RESTING, view:snapshot => JSON.parse(JSON.stringify(api.wakeView(snapshot))) };
}

test('the page offers Wake now while asleep, holds it while waking, and says how the wake ended', async t => {
  const { RESTING, view } = await loadWake();
  const ended = (state, message) => ({ grid:'test-grid', state, message, at:new Date().toISOString() });
  assert.equal(RESTING, 'Resting to save resources. It starts by itself when you send a message.');
  assert.deepEqual(view({ status:'asleep' }), { hidden:false, message:RESTING, button:true, disabled:false });
  assert.deepEqual(view({ status:'asleep', wake:ended('waking', WAKING) }), { hidden:false, message:WAKING, button:true, disabled:true });
  assert.deepEqual(view({ status:'asleep', wake:ended('not_started', OWN_NOT_STARTED) }), { hidden:false, message:OWN_NOT_STARTED, button:true, disabled:false });
  assert.deepEqual(view({ status:'asleep', wake:ended('failed', 'Update Harness') }), { hidden:false, message:'Update Harness', button:true, disabled:false });
  assert.deepEqual(view({ status:'live', wake:ended('nobody_serving', NOBODY) }), { hidden:false, message:NOBODY, button:false, disabled:false });
  // Started: the engines on the map are the answer. Until the read that draws them lands, say it.
  assert.deepEqual(view({ status:'asleep', wake:ended('awake', 'Your models started') }), { hidden:false, message:'Your models started', button:false, disabled:true });
  assert.deepEqual(view({ status:'live', wake:ended('awake', 'Your models started') }), { hidden:true });
  assert.deepEqual(view({ status:'live' }), { hidden:true });
  assert.deepEqual(view(null), { hidden:true });

  // Wired: the page loads it before app.js, has the button, and the button posts to the wake route.
  const dir = await mkdtemp(join(tmpdir(), 'grid-wake-'));
  const viewer = createViewer({ workspace:dir, intervalMs:1000, collect:async () => ({ spec:1, status:'asleep', grid:'test-grid', nodes:[], machines:[], models:[], events:[], operations:[], history:{}, sources:{}, summary:{}, pollIntervalMs:30_000 }) });
  t.after(async () => { await viewer.close(); await remove(dir); });
  const port = await viewer.start();
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.ok(page.indexOf('src="wake.js"') > 0 && page.indexOf('src="wake.js"') < page.indexOf('src="app.js"'));
  assert.match(page, /<button[^>]*id="wake-now"[^>]*>Wake now<\/button>/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/wake.js`)).status, 200);
  assert.match(await readFile(join(PACKAGE, 'viewer', 'app.js'), 'utf8'), /fetch\('api\/wake',\{method:'POST'/);
});
