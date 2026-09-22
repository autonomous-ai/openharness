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
 *
 * ONE bridge socket per machine, kept open between polls. A poll used to open a socket, select the
 * machine, ask, and close — and behind that select Harness dialled its relay, ran an encryption
 * handshake and negotiated a WebRTC channel, all thrown away a second later, for every machine, every
 * tick (thousands of relay dials an hour across a few panes, 2026-09-22). Now the select happens once;
 * a poll is one `agents_list` frame on a socket that is already there. A socket that closes, or that
 * stops answering, is dropped and the next poll opens a fresh one.
 */
const sessions = new Map(); // WebSocketImpl -> Map<machineId, session>; keyed by impl so a test's scripted socket is its own world

function sessionsFor(WebSocketImpl) {
  let byMachine = sessions.get(WebSocketImpl);
  if (!byMachine) { byMachine = new Map(); sessions.set(WebSocketImpl, byMachine); }
  return byMachine;
}

/** Open the bridge to `machineId`: resolves once Harness has selected it, rejects with the same
 *  answers `listHarnesses` used to give when it cannot. The session stays in the map until its socket
 *  closes or errors, whichever comes first; every waiter still on it hears that as a failure. */
function openSession(machineId, { env, WebSocketImpl, timeoutMs, forceReconnect = false }) {
  const byMachine = sessionsFor(WebSocketImpl);
  let socket;
  try { socket = new WebSocketImpl(bridgeUrl(env)); }
  catch { return Promise.reject({ ok: false, error: DOWN }); }
  const session = { socket, waiters: new Map(), heartbeat: null };
  const fail = (answer) => {
    if (byMachine.get(machineId) === session) byMachine.delete(machineId);
    clearInterval(session.heartbeat);
    for (const waiter of session.waiters.values()) waiter(answer);
    session.waiters.clear();
    try { socket.close(); } catch { /* already gone */ }
  };
  session.close = () => fail({ ok: false, error: 'The connection to this machine closed before it answered.' });
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => { if (settled) return; settled = true; clearTimeout(deadline); fn(value); };
    const deadline = setTimeout(() => { settle(reject, { ok: false, error: 'This machine did not answer in time.' }); fail({ ok: false, error: 'This machine did not answer in time.' }); }, timeoutMs);
    // `forceReconnect` tells Harness the session it kept for this machine is dead (the machine's own
    // Harness restarted under it) and must be dialled fresh rather than handed back once more.
    socket.addEventListener('open', () => socket.send(JSON.stringify({
      type: 'machine_select',
      payload: { machineId, localProtocolVersion: 1, relayIsolation: true, ...(forceReconnect ? { forceReconnect: true } : {}) },
    })));
    socket.addEventListener('error', () => { settle(reject, { ok: false, error: DOWN }); fail({ ok: false, error: DOWN }); });
    socket.addEventListener('close', event => {
      const answer = event.code === 4404
        ? { ok: false, needsLink: true, error: 'This machine is not linked from this computer yet.' }
        : { ok: false, error: event.code === 4403 ? 'Harness would not connect to this machine.' : 'The connection to this machine closed before it answered.' };
      settle(reject, answer); fail(answer);
    });
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || event.data.length > 8 * 1024 * 1024) return;
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (frame?.type === 'connected') {
        session.heartbeat = setInterval(() => { try { socket.send(JSON.stringify({ type: 'ping', payload: {} })); } catch { /* closing */ } }, 15_000);
        session.heartbeat.unref?.();
        settle(resolve);
        return;
      }
      if (frame?.type === 'agents_list_result') {
        const waiter = session.waiters.get(frame.payload?.requestId);
        if (!waiter) return;
        session.waiters.delete(frame.payload.requestId);
        waiter({ ok: true, harnesses: Array.isArray(frame.payload.agents) ? frame.payload.agents : [] });
        return;
      }
      if (['error', 'connection_error', 'local_protocol_error', 'machine_link_required'].includes(frame?.type)) {
        const answer = { ok: false, needsLink: frame.type === 'machine_link_required', error: 'This machine is unavailable, or needs linking from this computer.' };
        settle(reject, answer); fail(answer);
      }
    });
  });
  session.ready = ready;
  byMachine.set(machineId, session);
  return ready.then(() => session);
}

/** One roster read on an open session; the whole call is bounded by `timeoutMs`. */
function ask(session, timeoutMs) {
  return new Promise(resolve => {
    const requestId = randomUUID();
    const deadline = setTimeout(() => {
      if (!session.waiters.delete(requestId)) return;
      resolve({ ok: false, timedOut: true, error: 'This machine did not answer in time.' });
    }, timeoutMs);
    session.waiters.set(requestId, answer => { clearTimeout(deadline); resolve(answer); });
    // The id rides in the payload — that is where the daemon reads it, and the reply carries it back.
    try { session.socket.send(JSON.stringify({ type: 'agents_list', payload: { requestId } })); }
    catch { session.waiters.delete(requestId); clearTimeout(deadline); resolve({ ok: false, error: 'The connection to this machine closed before it answered.' }); }
  });
}

export async function listHarnesses(machineId, { timeoutMs = 20_000, env = process.env, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (!WebSocketImpl) return { ok: false, error: 'Node 22 or newer is required to read a machine roster.' };
  const byMachine = sessionsFor(WebSocketImpl);
  const existing = byMachine.get(machineId);
  let session;
  try {
    session = existing
      ? await existing.ready.then(() => existing)
      : await openSession(machineId, { env, WebSocketImpl, timeoutMs });
  } catch (answer) {
    return answer?.ok === false ? answer : { ok: false, error: DOWN };
  }
  const reused = session === existing;
  let result = await ask(session, timeoutMs);
  if (result.timedOut) {
    // A socket that is open but no longer answers is the daemon's "transport alive, session dead"
    // case: never keep it. On a REUSED one, try ONCE more on a fresh socket before reporting the
    // machine silent; a fresh one that stayed silent has already had its chance.
    session.close();
    if (reused) {
      try { session = await openSession(machineId, { env, WebSocketImpl, timeoutMs, forceReconnect: true }); }
      catch (answer) { return answer?.ok === false ? answer : { ok: false, error: DOWN }; }
      result = await ask(session, timeoutMs);
      if (result.timedOut) session.close();
    }
    delete result.timedOut;
  }
  return result;
}

/** Drop every bridge session (the pane is closing). */
export function closeSessions() {
  for (const byMachine of sessions.values()) {
    for (const session of [...byMachine.values()]) session.close();
  }
  sessions.clear();
}
