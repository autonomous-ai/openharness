/**
 * What the sandbox tests talk to harnessd with: its local WebSocket (`/api/local-ws`), over the daemon's Unix
 * socket the way a window does (the only way `daemon_*` frames are taken) or over loopback TCP the way a tool,
 * the CLI or an older window does; and its loopback HTTP (`/api/zoo`, `/api/status`).
 *
 * The frames are the desktop's own: `machine_select { machineId, localProtocolVersion: 1, tool? }`, then
 * requests `{ type, payload: { requestId, … } }` answered by `<type>_result`.
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = resolve(HERE, '..', '..')
const require = createRequire(join(REPO, 'cli', 'package.json'))
const { WebSocket } = require('ws')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function sandboxState(dir = process.env.E2E_DIR) {
  if (!dir) throw new Error('E2E_DIR is not set')
  return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
}

export function socketPath(state) {
  return join(state.dataLink, 'data', `daemon-${state.ports.daemon}.sock`)
}

export async function until(label, check, ms = 30_000, every = 100) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    try { last = await check(); if (last) return last } catch (err) { last = err }
    await sleep(every)
  }
  throw new Error(`timed out: ${label}${last instanceof Error ? ` (${last.message})` : ''}`)
}

/** harnessd's loopback HTTP, as the desktop calls it (`x-adapter-local: 1` on writes). */
export async function http(state, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${state.ports.daemon}${path}`, {
    method,
    headers: { 'x-adapter-local': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json = null
  try { json = await res.json() } catch { /* no body */ }
  return { status: res.status, body: json }
}

export async function machineId(state) {
  return (await http(state, 'GET', '/api/status')).body.machineId
}

/**
 * One connection to harnessd, like one window. `transport: 'unix'` (a window on this computer, the default) or
 * `'tcp'`. Every frame received is kept in `frames` with the time it arrived.
 */
export async function connect(state, { transport = 'unix', tool = false, machine } = {}) {
  const id = machine ?? await machineId(state)
  const url = transport === 'unix' ? `ws+unix://${socketPath(state)}:/api/local-ws` : `ws://127.0.0.1:${state.ports.daemon}/api/local-ws`
  const ws = new WebSocket(url)
  const frames = []
  const waiters = new Set()
  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    let frame
    try { frame = JSON.parse(data.toString()) } catch { return }
    frame.at = Date.now()
    frames.push(frame)
    for (const w of [...waiters]) if (w.match(frame)) { waiters.delete(w); w.resolve(frame) }
  })
  const closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })))
  await new Promise((resolveOpen, reject) => { ws.once('open', resolveOpen); ws.once('error', reject) })
  const client = {
    ws, frames, closed, machineId: id,
    send(type, payload = {}) { ws.send(JSON.stringify({ type, payload })) },
    /** The next frame (or one already received after `since`) that matches. */
    waitFor(match, ms = 15_000, since = 0) {
      const seen = frames.find((f) => f.at >= since && match(f))
      if (seen) return Promise.resolve(seen)
      return new Promise((resolveFrame, reject) => {
        const w = { match, resolve: (f) => { clearTimeout(timer); resolveFrame(f) } }
        const timer = setTimeout(() => { waiters.delete(w); reject(new Error('timed out waiting for a frame')) }, ms)
        waiters.add(w)
      })
    },
    async request(type, payload = {}, ms = 20_000) {
      const requestId = randomUUID()
      const answer = client.waitFor((f) => f.type === `${type}_result` && f.payload?.requestId === requestId, ms)
      client.send(type, { ...payload, requestId })
      return (await answer).payload
    },
    of(type, since = 0) { return frames.filter((f) => f.type === type && f.at >= since) },
    close() { try { ws.close() } catch { /* closed */ } return closed },
  }
  client.send('machine_select', { machineId: id, localProtocolVersion: 1, ...(tool ? { tool: true } : {}) })
  await client.waitFor((f) => f.type === 'connected', 10_000)
  return client
}
