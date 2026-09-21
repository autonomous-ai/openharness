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

/** Every machine this daemon can reach, the current one flagged. `harness` not on PATH is an answer,
 *  not a crash: the caller falls back to reading this machine's registry directly. */
export async function machines(env = process.env) {
  try {
    const { stdout } = await exec('harness', ['machines', '--json'], { timeout: 20_000, maxBuffer: 512 * 1024, env })
    return stdout.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter((row) => row && typeof row.machineId === 'string')
      .map((row) => ({
        machineId: row.machineId,
        name: String(row.name || row.hostname || row.machineId).slice(0, 240),
        current: row.current === true,
        online: row.status === 'running',
      }))
  } catch { return [] }
}

/**
 * One socket, one machine, however many calls the caller needs, then closed.
 *
 * `fn` receives `rpc(type, payload)`. Any failure — no daemon, an unlinked machine, a timeout —
 * arrives as an Error whose message is a sentence a person can act on, because these end up in a
 * pane header and a CLI's stderr rather than a log nobody reads.
 */
export async function withBridge(machineId, fn, { env = process.env, timeoutMs = 20_000, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (!WebSocketImpl) throw new Error('Node 22 or newer is required to reach the Harness bridge.')
  const socket = new WebSocketImpl(bridgeUrl(env))
  const pending = new Map()
  let closed = null
  const fail = (message) => {
    closed ??= new Error(message)
    for (const [, entry] of pending) entry.reject(closed)
    pending.clear()
  }

  const ready = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('The Harness daemon did not answer on the local bridge. Is Harness running?')), Math.min(timeoutMs, 15_000))
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1, relayIsolation: true } })))
    socket.addEventListener('error', () => { clearTimeout(deadline); reject(new Error('Could not open the local Harness bridge. Start Harness and try again.')) })
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
      if (payload.error) {
        // Keep the daemon's own code and sentence: `RESUME_UNAVAILABLE` plus why is something a person can
        // act on; a bare code is not.
        const error = new Error(payload.detail ? `${payload.detail}` : String(payload.error))
        error.code = String(payload.error)
        error.detail = payload.detail ?? null
        entry.reject(error)
      } else entry.resolve(payload)
    })
  })

  const rpc = (type, payload = {}, { callTimeoutMs = timeoutMs } = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(closed); return }
    const requestId = randomUUID()
    // Marked, because for some requests no answer yet is not a failure: a resume the daemon is still
    // confirming has a receipt to ask about instead.
    const deadline = setTimeout(() => {
      pending.delete(requestId)
      reject(Object.assign(new Error(`The daemon did not answer ${type} in time.`), { timedOut: true }))
    }, callTimeoutMs)
    pending.set(requestId, { type, resolve, reject, deadline })
    socket.send(JSON.stringify({ type, payload: { ...payload, requestId } }))
  })

  try {
    await ready
    return await fn(rpc)
  } finally {
    for (const [, entry] of pending) clearTimeout(entry.deadline)
    try { socket.close() } catch { /* already gone */ }
  }
}

/**
 * The fleet as the daemon sees it: running rows, and — `includeStopped` — every saved harness whose engine
 * has exited, as `status: 'stopped'` with no pane. An older daemon ignores the flag and sends live rows only;
 * the caller tells the two apart by whether stopped rows ever appear, never by guessing a version.
 */
export function listAgents(machineId, { includeStopped = true, ...options } = {}) {
  return withBridge(machineId, async (rpc) => {
    const reply = await rpc('agents_list', includeStopped ? { includeStopped: true } : {})
    return Array.isArray(reply.agents) ? reply.agents : []
  }, options)
}

/**
 * Resume a saved harness through the daemon.
 *
 * The daemon rebuilds the launch itself — the engine's own resume command plus the profile, permissions,
 * folder and provider the harness was created with — in a new pane, under the same agent id. A
 * `creationId` makes it idempotent: a repeated click, a second client or a lost reply all land on the same
 * operation, so at most one engine is started. The reply's `state` is `created`, `unconfirmed` (started,
 * conversation not confirmed yet) or `failed`, with the daemon's own `error` and `detail`.
 */
export function resumeAgent(machineId, agentId, { creationId = randomUUID(), replyMs = 120_000, ...options } = {}) {
  return withBridge(machineId, (rpc) => rpc('agent_resume', { agentId, creationId }, { callTimeoutMs: replyMs }), options)
}

/**
 * Stop a harness on the machine it lives on, through that machine's daemon: `agent_delete`, which is the
 * app's own Stop Harness. On a daemon with `agent_resume` it SAVES the conversation and launch settings
 * before it touches anything ("saving precedes every mutation"), then closes the pane and ends the engine —
 * so what it leaves is exactly a paused harness, listed as `stopped` and resumable with `agent_resume`.
 * On an older daemon the same request deletes for real, which is why callers send it only to a machine
 * that answered the `agent_resume` probe.
 */
export function stopAgent(machineId, agentId, options) {
  return withBridge(machineId, (rpc) => rpc('agent_delete', { agentId }, { callTimeoutMs: 60_000 }), options)
}

/** How an earlier resume, named by its `creationId`, turned out. */
export function resumeStatus(machineId, creationId, options) {
  return withBridge(machineId, (rpc) => rpc('agent_create_status', { creationId }), options)
}
