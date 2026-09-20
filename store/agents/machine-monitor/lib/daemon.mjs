/**
 * The one door to Harness itself.
 *
 * Everything this package knows about machines comes through the local Harness daemon on loopback:
 * the control-plane reads it already proxies for the desktop app (`/api/machines`, `/api/auth/me`),
 * and its machine bridge (`/api/local-ws`), which is how the app reaches another of your computers
 * without this package ever holding a token, a key or a password. Harness owns the pairing and the
 * encryption; we ask it questions in the same words the app does.
 *
 * No credential is read here, and none is ever put in a snapshot. A machine's remote password is
 * typed into `harness link connect` on a terminal, never passed through this module.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The daemon's loopback control port. `harness status` prints it; 18473 is the fixed default. */
export function daemonBase(env = process.env) {
  const url = new URL(env.HARNESS_MACHINES_DAEMON || 'http://127.0.0.1:18473/');
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.search || url.hash || url.username || url.password) {
    throw new Error('The Harness daemon address must be a plain loopback http:// URL.');
  }
  return url;
}

/** Node's WebSocket talks only to Harness's loopback bridge; Harness owns pairing and encryption. */
export function bridgeUrl(env = process.env) {
  const base = daemonBase(env);
  return `ws://${base.host}/api/local-ws`;
}

/** Where the CLI keeps its own state. Read-only here, and only for facts the app shows too. */
export function dataDir(env = process.env) {
  return env.ADAPTER_DATA_DIR || join(homedir(), '.harness', 'cli', 'data');
}

const DOWN = 'Harness is not running on this computer. Start it (the app, or `harness start`) and ask again.';

async function call(method, path, { body, timeoutMs = 15_000, env = process.env } = {}) {
  let res;
  try {
    res = await fetch(new URL(path, daemonBase(env)), {
      method,
      headers: { 'x-adapter-local': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, status: 0, error: err?.name === 'TimeoutError' ? `Harness did not answer ${method} ${path} in time.` : DOWN };
  }
  let payload = {};
  try { payload = await res.json(); } catch { /* an empty or non-JSON body is an error body */ }
  if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, signedOut: true, error: 'Not signed in to Harness on this computer. Run `harness login`.' };
  if (!res.ok || payload?.success === false) {
    return { ok: false, status: res.status, error: payload?.error?.message || `Harness answered ${res.status} for ${method} ${path}.` };
  }
  return { ok: true, status: res.status, data: payload?.data ?? payload };
}

/** Every machine on the account, as the app sees them. `stale` means the daemon served its cache. */
export async function listMachines(env = process.env) {
  const result = await call('GET', '/api/machines', { env });
  if (!result.ok) return { ...result, machines: [] };
  const data = result.data ?? {};
  return { ok: true, machines: Array.isArray(data.machines) ? data.machines : [], stale: data.stale === true, staleSince: data.staleSince ?? null };
}

export async function authMe(env = process.env) {
  const result = await call('GET', '/api/auth/me', { env });
  return result.ok ? { ok: true, user: result.data?.user ?? result.data ?? null } : result;
}

/** The daemon's own view of this computer: its machine id, version, and the harnesses it watches. */
export async function daemonStatus(env = process.env) {
  const result = await call('GET', '/api/status', { env, timeoutMs: 5000 });
  return result.ok ? { ok: true, status: result.data } : result;
}

export async function sharedMachines(env = process.env) {
  const result = await call('GET', '/api/harness-shares', { env });
  if (!result.ok) return { ...result, machines: [] };
  return { ok: true, machines: Array.isArray(result.data?.machines) ? result.data.machines : [] };
}

export async function renameMachine(machineId, name, env = process.env) {
  return call('PATCH', `/api/machines/${encodeURIComponent(machineId)}`, { body: { name }, env });
}

export async function deleteMachine(machineId, env = process.env) {
  return call('DELETE', `/api/machines/${encodeURIComponent(machineId)}`, { env });
}

/**
 * The machines this computer has linked, from the CLI's own trust file.
 *
 * Only the machine id and when it was pinned are read; the peer's key stays on disk. A link is what
 * lets this computer reach another one's harnesses at all, so it is the difference between a machine
 * that can be looked inside and one that can only be named.
 */
export async function linkedPeers(env = process.env) {
  try {
    const raw = JSON.parse(await readFile(join(dataDir(env), 'e2e', 'machinePeers.json'), 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter(p => typeof p?.machineId === 'string').map(p => ({
      machineId: p.machineId,
      linkedAt: Number.isFinite(p.linkedAt) ? new Date(p.linkedAt).toISOString() : null,
    }));
  } catch { return []; }
}

/**
 * Whether this computer has a remote password set — what lets ANOTHER machine link to it.
 *
 * Asked of the daemon rather than read off disk: the file beside the peer list holds the stretched
 * verifier for that password, and nothing here should ever open it.
 */
export async function remotePasswordSet(env = process.env) {
  const result = await call('GET', '/api/remote-password/status', { env, timeoutMs: 5000 });
  return result.ok ? result.data?.hasPassword === true : false;
}

/**
 * The harnesses running on one machine, over Harness's own bridge.
 *
 * `relayIsolation` asks for a session of this package's own, so polling a machine never disturbs the
 * window the person is working in. Close code 4404 is the one answer that is not a failure: that
 * machine is not linked from here yet, which is a thing to offer, not an error to report.
 */
export async function listHarnesses(machineId, { timeoutMs = 20_000, env = process.env, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (!WebSocketImpl) return { ok: false, error: 'Node 22 or newer is required to read a machine roster.' };
  let socket;
  try { socket = new WebSocketImpl(bridgeUrl(env)); }
  catch { return { ok: false, error: DOWN }; }
  return await new Promise(resolve => {
    let done = false, deadline, heartbeat;
    const requestId = randomUUID();
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(deadline); clearInterval(heartbeat);
      try { socket.close(); } catch { /* already gone */ }
      resolve(value);
    };
    deadline = setTimeout(() => finish({ ok: false, error: 'This machine did not answer in time.' }), timeoutMs);
    socket.addEventListener('open', () => socket.send(JSON.stringify({
      type: 'machine_select',
      payload: { machineId, localProtocolVersion: 1, relayIsolation: true },
    })));
    socket.addEventListener('error', () => finish({ ok: false, error: DOWN }));
    socket.addEventListener('close', event => {
      if (event.code === 4404) finish({ ok: false, needsLink: true, error: 'This machine is not linked from this computer yet.' });
      else finish({ ok: false, error: event.code === 4403 ? 'Harness would not connect to this machine.' : 'The connection to this machine closed before it answered.' });
    });
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || event.data.length > 8 * 1024 * 1024) return;
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (frame?.type === 'connected') {
        heartbeat = setInterval(() => { try { socket.send(JSON.stringify({ type: 'ping', payload: {} })); } catch { /* closing */ } }, 15_000);
        // The id rides in the payload — that is where the daemon reads it, and the reply carries it back.
        socket.send(JSON.stringify({ type: 'agents_list', payload: { requestId } }));
        return;
      }
      if (frame?.type === 'agents_list_result' && frame.payload?.requestId === requestId) {
        finish({ ok: true, harnesses: Array.isArray(frame.payload.agents) ? frame.payload.agents : [] });
        return;
      }
      if (['error', 'connection_error', 'local_protocol_error', 'machine_link_required'].includes(frame?.type)) {
        finish({ ok: false, needsLink: frame.type === 'machine_link_required', error: 'This machine is unavailable, or needs linking from this computer.' });
      }
    });
  });
}
