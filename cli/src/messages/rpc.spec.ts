import { createServer, type Server } from 'node:http'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { localSocketPath } from '../lib/localSocket.js'
import { NOT_RUNNING, SANDBOXED } from '../lib/unreachable.js'
import { messagesRpc, RefusedError } from './rpc.js'

type Behave = (ws: WebSocket, frame: { type: string; payload: Record<string, unknown> }) => void

let dir: string
let server: Server
let wss: WebSocketServer
let behave: Behave
const PORT = 47_000 + Math.floor(Math.random() * 1000)

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rpc-'))
  server = createServer()
  wss = new WebSocketServer({ server, path: '/api/local-ws' })
  wss.on('connection', (ws) => ws.on('message', (raw) => behave(ws, JSON.parse(raw.toString()))))
  await new Promise<void>((done) => server.listen(localSocketPath(dir, PORT)!, done))
})
afterEach(async () => {
  for (const client of wss.clients) client.terminate()
  await new Promise((done) => wss.close(done))
  await new Promise((done) => server.close(done))
  rmSync(dir, { recursive: true, force: true })
})

const target = (over: Record<string, unknown> = {}) => ({ port: PORT, machineId: 'm2', dataDir: dir, ...over })
const answering: Behave = (ws, frame) => {
  if (frame.type === 'machine_select') ws.send(JSON.stringify({ type: 'connected', payload: {} }))
  if (frame.type === 'agent_messages') {
    ws.send(JSON.stringify({ type: 'agent_messages_result', payload: { requestId: 'someone-else', other: true } }))
    ws.send('not json at all, but ignored? no: it fails the request')
  }
}

describe('one Agent Messages request through the daemon', () => {
  it('selects the machine, sends the request, and resolves with the matching reply', async () => {
    behave = (ws, frame) => {
      if (frame.type === 'machine_select') {
        expect(frame.payload).toEqual({ machineId: 'm2', localProtocolVersion: 1 })
        ws.send(Buffer.from('binary is skipped'))
        ws.send(JSON.stringify({ type: 'connected', payload: {} }))
      }
      if (frame.type === 'agent_messages') {
        ws.send(JSON.stringify({ type: 'agent_messages_result', payload: { requestId: 'someone-else' } }))
        ws.send(JSON.stringify({ type: 'agent_messages_result', payload: { requestId: frame.payload.requestId, statuses: ['ok'] } }))
      }
    }
    expect(await messagesRpc(target(), { action: 'status' })).toMatchObject({ statuses: ['ok'] })
  })

  it('rejects with the daemon\'s own error code', async () => {
    behave = (ws, frame) => {
      if (frame.type === 'machine_select') ws.send(JSON.stringify({ type: 'connected', payload: {} }))
      else ws.send(JSON.stringify({ type: 'agent_messages_result', payload: { requestId: frame.payload.requestId, error: 'MESSAGES_OFF', detail: 'off here' } }))
    }
    await expect(messagesRpc(target(), { action: 'send' })).rejects.toMatchObject({ code: 'MESSAGES_OFF', message: 'off here' })
    // The machine answered: a refusal, told apart from one that could not be asked.
    await expect(messagesRpc(target(), { action: 'send' })).rejects.toBeInstanceOf(RefusedError)
    behave = (ws, frame) => {
      if (frame.type === 'machine_select') ws.send(JSON.stringify({ type: 'connected', payload: {} }))
      else ws.send(JSON.stringify({ type: 'agent_messages_result', payload: { requestId: frame.payload.requestId, error: 'BARE' } }))
    }
    await expect(messagesRpc(target(), { action: 'send' })).rejects.toMatchObject({ code: 'BARE', message: 'BARE' })
  })

  it('says when the machine is unavailable, unpaired, or the answer is not one', async () => {
    behave = (ws) => ws.send(JSON.stringify({ type: 'machine_select_error', payload: { error: 'NOT_PAIRED' } }))
    await expect(messagesRpc(target(), {})).rejects.toMatchObject({ code: 'NOT_PAIRED' })
    await expect(messagesRpc(target(), {}).catch((error: unknown) => error instanceof RefusedError)).resolves.toBe(false)
    behave = (ws) => ws.send(JSON.stringify({ type: 'machine_select_error', payload: {} }))
    await expect(messagesRpc(target(), {})).rejects.toMatchObject({ code: 'MACHINE_UNAVAILABLE' })
    behave = (ws) => ws.close(4404)
    await expect(messagesRpc(target(), {})).rejects.toMatchObject({ code: 'NO_PEER_LINK' })
    behave = (ws) => ws.close(1000)
    await expect(messagesRpc(target(), {})).rejects.toMatchObject({ code: 'DISCONNECTED' })
    behave = answering
    await expect(messagesRpc(target(), {})).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('times out, can be cancelled, and reports a daemon that is not there', async () => {
    behave = () => {}
    await expect(messagesRpc(target(), {}, 50)).rejects.toMatchObject({ code: 'UNCONFIRMED' })
    const controller = new AbortController()
    const pending = messagesRpc(target({ signal: controller.signal }), {}, 5_000)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    const aborted = new AbortController()
    aborted.abort()
    await expect(messagesRpc(target({ signal: aborted.signal }), {})).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(messagesRpc({ port: 1, machineId: 'm', dataDir: join(dir, 'none') }, {}, 2_000)).rejects.toMatchObject({ code: 'DAEMON_UNREACHABLE' })
    await expect(messagesRpc({ port: 1, machineId: 'm' }, {}, 2_000)).rejects.toMatchObject({ code: 'DAEMON_UNREACHABLE' })
  })

  // Root opens a socket whatever its mode, so the refusal cannot be made there.
  it.skipIf(process.getuid?.() === 0)('says a sandbox is in the way only when the daemon it was refused is there', async () => {
    const env = { CODEX_SANDBOX: process.env.CODEX_SANDBOX, CODEX_SANDBOX_NETWORK_DISABLED: process.env.CODEX_SANDBOX_NETWORK_DISABLED }
    delete process.env.CODEX_SANDBOX
    delete process.env.CODEX_SANDBOX_NETWORK_DISABLED
    try {
      // A socket this process may not open answers EACCES, as one a sandbox refuses does.
      chmodSync(localSocketPath(dir, PORT)!, 0)
      // No pid file in the daemon's folder: nothing to reach, whatever refused the connect.
      await expect(messagesRpc(target(), {}, 2_000)).rejects.toMatchObject({ code: 'DAEMON_UNREACHABLE', message: NOT_RUNNING })
      writeFileSync(join(dir, 'adapter.pid'), `${process.pid}\n`)
      await expect(messagesRpc(target(), {}, 2_000)).rejects.toMatchObject({ code: 'DAEMON_UNREACHABLE', message: SANDBOXED })
    } finally { for (const [name, value] of Object.entries(env)) if (value !== undefined) process.env[name] = value }
  })
})
