// Since Harness 0.4.21 its loopback bridge wants the local credential; every socket here must show it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessExecute, localCredentialHeaders } from '../lib/harness.mjs';
import { daemonWake } from '../lib/wake.mjs';
import { fakeBridge } from './fakes.mjs';

const CREDENTIAL = `test-local-credential-${'a'.repeat(21)}`; // the CLI's shape: 43 base64url characters
const machine = { id:'rig', name:'GPU rig', transport:'harness', machineId:'machine-123' };

/** A data folder as the CLI leaves it: 0700, holding a 0600 `hook-credential` (or none). */
function dataDir({ credential = CREDENTIAL, mode = 0o600, folderMode = 0o700 } = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), 'grid-credential-')), 'data');
  mkdirSync(dir, { mode:0o700 });
  if (credential !== null) { writeFileSync(join(dir, 'hook-credential'), `${credential}\n`, { mode:0o600 }); chmodSync(join(dir, 'hook-credential'), mode); }
  chmodSync(dir, folderMode);
  return dir;
}
function daemon(frame, send) {
  if (frame.type === 'machine_select') send({ type:'connected', payload:{ relayIsolation:true } });
  if (frame.type === 'grid_fleet_capabilities') send({ type:`${frame.type}_result`, payload:{ requestId:frame.payload.requestId, protocol:1, gridCli:'managed' } });
  if (frame.type === 'grid_fleet_run') send({ type:`${frame.type}_result`, payload:{ requestId:frame.payload.requestId, ok:true, code:0, stdout:'answer', stderr:'' } });
}

test('the local credential is read the way the CLI reads it, and only then', () => {
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR:dataDir() }), { 'X-Harness-Local':CREDENTIAL });
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR:dataDir({ credential:null }) }), {});
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR:join(tmpdir(), 'grid-no-such-folder') }), {});
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR:dataDir({ mode:0o644 }) }), {}, 'a file others can read is not trusted');
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR:dataDir({ folderMode:0o777 }) }), {}, 'nor one in a folder others can write');
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR:dataDir({ credential:'too-short' }) }), {});
});

// Windows reports every file as 0o666 and every folder as 0o777, so the POSIX mode checks would refuse the
// credential the daemon wrote and the daemon, which wants it on TCP there, would answer 401 (cli hookAuth.ts).
test('on Windows the credential is read whatever mode the folder and file report', (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value:'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR:dataDir({ mode:0o666, folderMode:0o777 }) }), { 'X-Harness-Local':CREDENTIAL });
  assert.deepEqual(localCredentialHeaders({ ADAPTER_DATA_DIR:dataDir({ credential:'too-short', mode:0o666 }) }), {}, 'the value is still checked');
});

test('a fleet command shows the bridge the local credential', async t => {
  const bridge = await fakeBridge(daemon, { credential:CREDENTIAL }); t.after(() => bridge.close());
  const env = { HARNESS_GRID_BRIDGE_URL:bridge.url, ADAPTER_DATA_DIR:dataDir() };
  assert.deepEqual(await harnessExecute(machine, ['ls'], { env }), { ok:true, code:0, stdout:'answer', stderr:'', error:null });
  assert.deepEqual(bridge.shown, [CREDENTIAL]);
});

test('without a readable credential nothing is sent, and the refusal is named as one', async t => {
  const bridge = await fakeBridge(daemon, { credential:CREDENTIAL }); t.after(() => bridge.close());
  const env = { HARNESS_GRID_BRIDGE_URL:bridge.url, ADAPTER_DATA_DIR:dataDir({ credential:null }) };
  const result = await harnessExecute(machine, ['ls'], { env });
  assert.equal(result.ok, false); assert.match(result.error, /refused this process's local credential/);
  assert.ok(bridge.shown.length > 0 && bridge.shown.every(header => header === undefined));
});

test('the wake shows the credential too, and says so when it is refused', async t => {
  const bridge = await fakeBridge((frame, send) => { if (frame.type === 'machine_select') send({ type:'connected', payload:{} }); }, { credential:CREDENTIAL });
  t.after(() => bridge.close());
  const wake = ADAPTER_DATA_DIR => daemonWake({ controller:machine, grid:'test-grid', env:{ HARNESS_GRID_BRIDGE_URL:bridge.url, ADAPTER_DATA_DIR }, pollMs:10, giveUpMs:2000 });
  // Connected: this bridge then predates the wake, which is only said once the socket was let in.
  assert.match((await wake(dataDir())).message, /^Update Harness/);
  assert.deepEqual(bridge.shown, [CREDENTIAL]);
  const refused = await wake(dataDir({ credential:null }));
  assert.equal(refused.state, 'failed'); assert.match(refused.message, /refused this process's local credential/);
});
