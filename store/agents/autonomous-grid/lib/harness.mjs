import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const updateMessage = 'This machine needs a Harness version with Grid fleet support. Update Harness there, or configure an existing SSH target.';

export async function discoverMachines() {
  const { stdout } = await promisify(execFile)('harness', ['machines', '--json'], { timeout: 20_000, maxBuffer: 512 * 1024 });
  return stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => typeof row.machineId === 'string').map(row => ({
    id: row.machineId, machineId: row.machineId, name: String(row.name || row.hostname || row.machineId).slice(0,240),
    transport: row.current ? 'local' : 'harness', current: row.current === true, online: row.status === 'running',
  }));
}

/** Node's WebSocket talks only to Harness's loopback bridge; Harness owns pairing and encryption. */
export function bridgeUrl(env = process.env) {
  const url = new URL(env.HARNESS_GRID_BRIDGE_URL || 'ws://127.0.0.1:18473/api/local-ws');
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/api/local-ws' || url.username || url.password || url.search || url.hash) throw new Error('Harness bridge must be its local WebSocket endpoint.');
  return url.href;
}

/**
 * The headers every request to the daemon's loopback API carries: its local credential, or none.
 *
 * Since Harness 0.4.21 the loopback port (REST and `/api/local-ws`) answers 401 to a process that does
 * not show `X-Harness-Local: <credential>`, the 0600 `hook-credential` file in Harness's data folder
 * (`ADAPTER_DATA_DIR`, default `~/.harness/cli/data`) — so only the OS user Harness runs as gets in.
 * Read with the CLI's own checks (cli/src/lib/hookAuth.ts `readHookCredential`): a folder that is ours
 * and nobody else can write, a 0600 regular file of ours, a 43-character base64url value. Anything else
 * is no credential and no header (the CLI also tightens a 0755 folder; a reader leaves it alone).
 * The same function, by the same name, is in every Store package that talks to the daemon.
 */
export function localCredentialHeaders(env = process.env) {
  const dir = env.ADAPTER_DATA_DIR || join(homedir(), '.harness', 'cli', 'data');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  // Windows reports every file as 0o666 and every folder as 0o777, so the mode checks below would always refuse
  // the credential the daemon wrote; there its protection is the profile folder's ACL (cli hookAuth.ts).
  const posixModes = process.platform !== 'win32';
  const opened = [];
  try {
    const folder = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    opened.push(folder);
    const where = fstatSync(folder);
    if (!where.isDirectory() || (uid !== null && where.uid !== uid) || (posixModes && (where.mode & 0o022) !== 0)) return {};
    const file = openSync(join(dir, 'hook-credential'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    opened.push(file);
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > 128 || (uid !== null && stat.uid !== uid) || (posixModes && (stat.mode & 0o777) !== 0o600)) return {};
    const value = readFileSync(file, 'utf8').trim();
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? { 'X-Harness-Local': value } : {};
  } catch {
    return {};
  } finally {
    for (const fd of opened) closeSync(fd);
  }
}

export const CREDENTIAL_REFUSED = "Harness refused this process's local credential. Run Model Manager as the same OS user as Harness.";

/** Whether the daemon behind a bridge socket that would not open refused the credential: a WebSocket
 *  cannot report the 401, so the same headers are shown once over plain HTTP, which can. */
export async function credentialRefused(url, headers) {
  try {
    const answer = await fetch(url.replace(/^ws:/, 'http:'), { headers, signal: AbortSignal.timeout(2000) });
    await answer.body?.cancel();
    return answer.status === 401;
  } catch {
    return false;
  }
}

export async function harnessExecute(machine, args, { timeoutMs = 15_000, inherit = false, signal, thinking, env = process.env, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (!WebSocketImpl) return { ok: false, code: 127, stdout: '', stderr: '', error: 'Node 22 or newer is required for Harness machine connections.' };
  let socket, url, headers;
  try { url = bridgeUrl(env); headers = localCredentialHeaders(env); socket = new WebSocketImpl(url, { headers }); }
  catch { return { ok: false, code: 127, stdout: '', stderr: '', error: 'Could not open the local Harness bridge.' }; }
  return await new Promise(resolve => {
    let done = false, running = false, selected = false, heartbeat, deadline;
    const commandId = randomUUID(), capabilityId = randomUUID();
    const send = (type, payload) => socket.send(JSON.stringify({ type, payload }));
    const finish = result => {
      if (done) return;
      done = true; clearTimeout(deadline); clearInterval(heartbeat); signal?.removeEventListener('abort', abort); socket.close();
      if (inherit) { if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr); }
      resolve(result);
    };
    const fail = error => finish({ ok: false, code: running ? 124 : 127, stdout: '', stderr: '', error });
    const abort = () => {
      if (running && socket.readyState === 1) send('grid_fleet_cancel', { requestId: randomUUID(), commandId });
      fail('Grid command interrupted. Verify the target state before retrying.');
    };
    deadline = setTimeout(() => fail('Harness did not connect to this machine. Check that it is online and linked.'), Math.min(timeoutMs, 20_000));
    // `refusal`: the credential check under way after a socket that never opened.
    let opened = false, refusal = null;
    socket.addEventListener('open', () => { opened = true; send('machine_select', { machineId: machine.machineId, localProtocolVersion: 1, relayIsolation: true }); });
    socket.addEventListener('error', () => {
      const message = 'Harness connection failed. Start Harness and check the machine link.';
      if (opened) { fail(message); return; }
      refusal = credentialRefused(url, headers).then(refused => fail(refused ? CREDENTIAL_REFUSED : message));
    });
    socket.addEventListener('close', event => {
      if (done || refusal) return; // a refusal answers once it knows whether the credential was refused
      if (event.code === 4404) fail('Link this machine in Harness Machines before managing it from Grid.');
      else fail(running ? 'Harness connection closed. The command may still be running; inspect the target before retrying.' : 'Harness could not connect. Check that this machine is online and linked.');
    });
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) return;
      let frame; try { frame = JSON.parse(event.data); } catch { return; }
      const { type, payload = {} } = frame;
      if (type === 'connected') {
        if (selected) return;
        selected = true;
        if (payload.relayIsolation !== true && payload.transport !== 'local') {
          fail('Update Harness on this controller to support independent Grid fleet connections.'); return;
        }
        clearTimeout(deadline);
        deadline = setTimeout(() => fail(updateMessage), Math.min(timeoutMs, 15_000));
        send('grid_fleet_capabilities', { requestId: capabilityId });
        heartbeat = setInterval(() => send('ping', {}), 15_000);
      } else if (type === 'grid_fleet_capabilities_result' && payload.requestId === capabilityId) {
        if (running) return;
        if (payload.protocol !== 1) { fail(updateMessage); return; }
        if (thinking !== undefined && payload.thinkingControl !== true) { fail('Update Harness on this machine to support explicit model thinking controls.'); return; }
        if (payload.gridCli === 'missing') { fail('Grid is not installed on this machine. Install the Grid Harness there first.'); return; }
        clearTimeout(deadline); running = true;
        const duration = Math.min(timeoutMs, payload.maxTimeoutMs || 1_800_000);
        deadline = setTimeout(() => { abort(); }, duration + 5000);
        send('grid_fleet_run', { requestId: commandId, args, timeoutMs: duration, ...(thinking === undefined ? {} : { thinking }) });
      } else if (type === 'grid_fleet_run_result' && payload.requestId === commandId) {
        finish({ ok: payload.ok === true, code: Number.isInteger(payload.code) ? payload.code : 1,
          stdout: typeof payload.stdout === 'string' ? payload.stdout : '', stderr: typeof payload.stderr === 'string' ? payload.stderr : '',
          error: payload.ok === true ? null : typeof payload.error === 'string' ? payload.error : 'Grid command failed.' });
      } else if (['error', 'connection_error', 'local_protocol_error', 'machine_link_required'].includes(type)) {
        fail('This machine is unavailable or needs linking in Harness Machines.');
      }
    });
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}
