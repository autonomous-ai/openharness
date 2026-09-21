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
      if (payload.error) entry.reject(new Error(String(payload.error)))
      else entry.resolve(payload)
    })
  })

  const rpc = (type, payload = {}, { callTimeoutMs = timeoutMs } = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(closed); return }
    const requestId = randomUUID()
    const deadline = setTimeout(() => { pending.delete(requestId); reject(new Error(`The daemon did not answer ${type} in time.`)) }, callTimeoutMs)
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

/** The fleet as the daemon sees it, for one machine. */
export function listAgents(machineId, options) {
  return withBridge(machineId, async (rpc) => {
    const reply = await rpc('agents_list', {})
    return Array.isArray(reply.agents) ? reply.agents : []
  }, options)
}
