/**
 * The daemon, over the loopback bridge Harness already serves.
 *
 * Node's WebSocket talks only to `ws://127.0.0.1:18473/api/local-ws`; Harness owns pairing, encryption
 * and every remote machine behind it. The handshake is the one the Grid harness uses — `machine_select`,
 * wait for `connected`, then typed request/reply frames whose answer is `<type>_result` carrying the
 * same `requestId`. Nothing here reaches the network, and no credential passes through this file.
 *
 * Exactly one call is ever made: `agents_list` — who the agents are, where their panes are, what they
 * are on. Nothing on this socket writes: pausing is a signal to a process, and resuming is a line typed
 * into a pane (lib/actions.mjs). `agent_delete` and `agent_restart` exist on this protocol and are
 * deliberately never sent — the first destroys, and the second gives a released row a fresh shell
 * rather than its conversation, which is the whole reason resume does not use it.
 */

import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export const DEFAULT_BRIDGE = 'ws://127.0.0.1:18473/api/local-ws'

export function bridgeUrl(env = process.env) {
  const url = new URL(env.HPS_BRIDGE_URL || DEFAULT_BRIDGE)
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/api/local-ws' || url.username || url.password || url.search || url.hash) {
    throw new Error('The Harness bridge must be its local WebSocket endpoint.')
  }
  return url.href
}

/** Every machine this daemon can reach, the current one flagged, and — when the list could not be
 *  read — why. `harness` not on PATH is an answer, not a crash: the caller falls back to reading this
 *  machine's registry directly. The command runs from the home folder, never from this package's
 *  directory: a package update swaps that directory out from under a running viewer, and a CLI
 *  started in a directory that no longer exists fails in a way that reads exactly like a dead daemon. */
export async function machinesReport(env = process.env) {
  try {
    const { stdout } = await exec('harness', ['machines', '--json'], { timeout: 20_000, maxBuffer: 512 * 1024, env, cwd: homedir() })
    const machines = stdout.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter((row) => row && typeof row.machineId === 'string')
      .map((row) => ({
        machineId: row.machineId,
        name: String(row.name || row.hostname || row.machineId).slice(0, 240),
        current: row.current === true,
        online: row.status === 'running',
      }))
    return { machines, error: null }
  } catch (error) {
    const detail = error?.code === 'ENOENT'
      ? 'the `harness` command is not on PATH'
      : `the \`harness machines\` command failed${error?.stderr ? `: ${String(error.stderr).trim().split('\n')[0].slice(0, 200)}` : error?.message ? `: ${String(error.message).slice(0, 200)}` : ''}`
    return { machines: [], error: detail }
  }
}

/** The machine list alone, for callers that only need the rows. */
export async function machines(env = process.env) {
  return (await machinesReport(env)).machines
}

/**
 * One bridge socket per machine, opened on first use and kept for the next call.
 *
 * Behind a `machine_select` on this bridge, Harness dials its relay to that machine, runs an
 * encryption handshake and — until recently — negotiated a WebRTC channel; opening a socket per poll
 * threw all of that away every few seconds, for every machine, from every pane. So the select happens
 * once, and a poll is one `agents_list` frame on a socket that already exists. A socket that closes,
 * errors, or stops answering is dropped; the next call opens a fresh one.
 *
 * Any failure — no daemon, an unlinked machine, a timeout — arrives as an Error whose message is a
 * sentence a person can act on, because these end up in a pane header and a CLI's stderr rather than
 * a log nobody reads.
 */
const sessions = new Map() // WebSocketImpl -> Map<machineId, session>; keyed by impl so a test's scripted socket is its own world

function sessionsFor(WebSocketImpl) {
  let byMachine = sessions.get(WebSocketImpl)
  if (!byMachine) { byMachine = new Map(); sessions.set(WebSocketImpl, byMachine) }
  return byMachine
}

function openSession(machineId, { env, timeoutMs, WebSocketImpl, forceReconnect = false }) {
  const byMachine = sessionsFor(WebSocketImpl)
  const socket = new WebSocketImpl(bridgeUrl(env))
  const pending = new Map()
  let closed = null
  const session = { socket, pending, ready: null, close: null }
  const fail = (message) => {
    closed ??= new Error(message)
    if (byMachine.get(machineId) === session) byMachine.delete(machineId)
    for (const [, entry] of pending) { clearTimeout(entry.deadline); entry.reject(closed) }
    pending.clear()
    try { socket.close() } catch { /* already gone */ }
  }
  session.close = () => fail('The Harness bridge closed the connection.')

  session.ready = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { const m = 'The Harness daemon did not answer on the local bridge. Is Harness running?'; fail(m); reject(new Error(m)) }, Math.min(timeoutMs, 15_000))
    // `forceReconnect` tells Harness the session it kept for this machine is dead (the machine's own
    // Harness restarted under it) and must be dialled fresh rather than handed back once more.
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1, relayIsolation: true, ...(forceReconnect ? { forceReconnect: true } : {}) } })))
    socket.addEventListener('error', () => { clearTimeout(deadline); const m = 'Could not open the local Harness bridge. Start Harness and try again.'; fail(m); reject(new Error(m)) })
    socket.addEventListener('close', (event) => {
      clearTimeout(deadline)
      const message = event?.code === 4404
        ? 'Link this machine in Harness ▸ Machines before managing it from Harness Monitor.'
        : 'The Harness bridge closed the connection.'
      fail(message); reject(new Error(message))
    })
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string' || event.data.length > 8 * 1024 * 1024) return
      let frame; try { frame = JSON.parse(event.data) } catch { return }
      const { type, payload = {} } = frame
      if (type === 'connected') { clearTimeout(deadline); resolve(); return }
      if (['error', 'connection_error', 'local_protocol_error', 'machine_link_required'].includes(type)) {
        const message = 'That machine is unavailable or needs linking in Harness ▸ Machines.'
        fail(message); reject(new Error(message)); return
      }
      const entry = pending.get(payload.requestId)
      if (!entry || type !== `${entry.type}_result`) return
      pending.delete(payload.requestId)
      clearTimeout(entry.deadline)
      if (payload.error) entry.reject(new Error(String(payload.error)))
      else entry.resolve(payload)
    })
  })
  session.ready.catch(() => {})

  session.rpc = (type, payload = {}, { callTimeoutMs = timeoutMs } = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(closed); return }
    const requestId = randomUUID()
    const deadline = setTimeout(() => {
      pending.delete(requestId)
      const error = new Error(`The daemon did not answer ${type} in time.`)
      error.timedOut = true
      reject(error)
    }, callTimeoutMs)
    pending.set(requestId, { type, resolve, reject, deadline })
    try { socket.send(JSON.stringify({ type, payload: { ...payload, requestId } })) }
    catch { pending.delete(requestId); clearTimeout(deadline); reject(closed ?? new Error('The Harness bridge closed the connection.')) }
  })

  byMachine.set(machineId, session)
  return session
}

/** The kept session for `machineId`, opening one if there is none. */
async function bridgeSession(machineId, { env = process.env, timeoutMs = 20_000, WebSocketImpl = globalThis.WebSocket, forceReconnect = false } = {}) {
  if (!WebSocketImpl) throw new Error('Node 22 or newer is required to reach the Harness bridge.')
  const existing = sessionsFor(WebSocketImpl).get(machineId)
  const session = existing ?? openSession(machineId, { env, timeoutMs, WebSocketImpl, forceReconnect })
  await session.ready
  return { session, reused: session === existing }
}

/**
 * One socket, one machine, however many calls the caller needs, then closed — for a one-off job
 * that must not share the kept session (a script, a test). `fn` receives `rpc(type, payload)`.
 */
export async function withBridge(machineId, fn, { env = process.env, timeoutMs = 20_000, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (!WebSocketImpl) throw new Error('Node 22 or newer is required to reach the Harness bridge.')
  // Its own world, never the shared map: a fresh key that nothing else will look up.
  const own = class extends WebSocketImpl {}
  const session = openSession(machineId, { env, timeoutMs, WebSocketImpl: own })
  try {
    await session.ready
    return await fn(session.rpc)
  } finally {
    session.close()
    sessions.delete(own)
  }
}

/** The fleet as the daemon sees it, for one machine — on the kept session. A kept socket that has
 *  gone quiet (the daemon behind it restarted without closing it) is dropped and the read retried
 *  ONCE on a fresh one before the machine is reported silent. */
export async function listAgents(machineId, options = {}) {
  const ask = async ({ session }) => {
    const reply = await session.rpc('agents_list', {})
    return Array.isArray(reply.agents) ? reply.agents : []
  }
  const first = await bridgeSession(machineId, options)
  try {
    return await ask(first)
  } catch (error) {
    if (!error?.timedOut) throw error
    first.session.close()
    if (!first.reused) throw error
    const second = await bridgeSession(machineId, { ...options, forceReconnect: true })
    try { return await ask(second) } catch (again) { if (again?.timedOut) second.session.close(); throw again }
  }
}

/** Drop every kept bridge session (the pane is closing). */
export function closeBridges() {
  for (const byMachine of sessions.values()) for (const session of [...byMachine.values()]) session.close()
  sessions.clear()
}
