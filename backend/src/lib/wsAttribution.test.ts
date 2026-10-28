import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Roadmap Phase 0 (2026-10-28): the logs could not say which client opened a socket, how it closed or how long it
// lived, so 8,760 web-ws connects in 45 minutes could not be told apart. Every socket now says so, and each pod logs
// its counts once a minute, refusals apart from real connects.
const m = vi.hoisted(() => ({ info: vi.fn() }))
vi.mock('../utils/logger.js', () => ({ logger: { info: m.info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./instance.js', () => ({ INSTANCE_ID: 'pod-a-0' }))

import { declaredKind, refusedUpgrade, resetWsCountersForTest, trackSocket, watchUpgrade, wsCounterLine } from './wsAttribution.js'

/** A raw upgrade socket, and the `ws` socket over it once upgraded. */
const raw = () => new EventEmitter()
const upgraded = (socket: EventEmitter) => ({ _socket: socket }) as never
const lines = (message: string) => m.info.mock.calls.filter(c => c[0] === message).map(c => c[1])

beforeEach(() => { vi.clearAllMocks(); resetWsCountersForTest() })

describe('the client a socket declares', () => {
  it.each([
    ['client=relay&v=0.9.1', { client: 'relay', version: '0.9.1' }],
    ['client=group-sync&v=1.4.2', { client: 'group-sync', version: '1.4.2' }],
    ['client=link', { client: 'link', version: null }],
    ['client=desktop&v=1.3.0', { client: 'desktop', version: '1.3.0' }],
    ['client=web', { client: 'web', version: null }],
    // The phone has sent its release since before `v`.
    ['client=mobile&release=2.1.0', { client: 'mobile', version: '2.1.0' }],
    // Nothing declared: an older daemon or app. Anything else is not a kind this backend knows.
    ['', { client: 'unknown', version: null }],
    ['client=toaster&v=1', { client: 'unknown', version: '1' }],
    // A version is a short plain token or nothing: never free text into the logs.
    ['client=relay&v=1.0%20%3Cscript%3E', { client: 'relay', version: null }],
    [`client=relay&v=${'9'.repeat(41)}`, { client: 'relay', version: null }],
  ])('%s', (query, expected) => {
    expect(declaredKind(new URLSearchParams(query))).toEqual(expected)
  })
})

describe('a tracked socket', () => {
  it('logs its connect and its disconnect: code, reason, lifetime and what its selects were answered', () => {
    let now = 1_000
    const socket = trackSocket('web', 'web user', upgraded(raw()), { client: 'relay', version: '0.9.1', userId: 'u1' }, () => now)
    expect(lines('web user connected')).toEqual([{ endpoint: 'web', client: 'relay', version: '0.9.1', pod: 'pod-a-0', connId: socket.connId, userId: 'u1' }])
    socket.selected('MACHINE_OFFLINE')
    now += 400
    socket.closed(1000, 'handshake failed', { machineId: undefined })
    // A second close (an error, then the close) is the same socket's end: one line.
    socket.closed(1006, '')
    expect(lines('web user disconnected')).toEqual([{ endpoint: 'web', client: 'relay', version: '0.9.1', pod: 'pod-a-0', connId: socket.connId,
      userId: 'u1', code: 1000, reason: 'handshake failed', aliveMs: 400, selects: 1, select: 'MACHINE_OFFLINE' }])
  })

  it('says a socket that never selected so', () => {
    const socket = trackSocket('web', 'web user', upgraded(raw()), { client: 'web', version: null })
    socket.closed(1001, '')
    expect(lines('web user disconnected')[0]).toMatchObject({ selects: 0, select: 'none', code: 1001 })
    expect(lines('web user disconnected')[0]).not.toHaveProperty('reason')
  })

  it('gives every socket its own id', () => {
    const a = trackSocket('observer', 'observer', upgraded(raw()), { client: 'relay', version: null })
    const b = trackSocket('observer', 'observer', upgraded(raw()), { client: 'relay', version: null })
    expect(a.connId).not.toBe(b.connId)
  })
})

describe('the counters each pod logs', () => {
  it('count open sockets, connects by client, sockets that lived under 2 s, and refusals apart', () => {
    let now = 0
    const clock = () => now
    const refusedRaw = raw(); watchUpgrade('web', refusedRaw)
    const shortRaw = raw(); watchUpgrade('web', shortRaw)
    const longRaw = raw(); watchUpgrade('web', longRaw)
    const adapterRaw = raw(); watchUpgrade('adapter', adapterRaw)
    const short = trackSocket('web', 'web user', upgraded(shortRaw), { client: 'relay', version: null }, clock)
    trackSocket('web', 'web user', upgraded(longRaw), { client: 'mobile', version: '2.1.0' }, clock)
    trackSocket('adapter', 'adapter', upgraded(adapterRaw), { client: 'daemon', version: '0.9.1' }, clock)
    // Signed in badly: upgraded, then closed before anything tracked it. Not a connect.
    refusedRaw.emit('close')
    // Refused before any upgrade, by the server's handshake limit.
    refusedUpgrade('observer')
    now = 1_999
    short.closed(1000, '')
    shortRaw.emit('close')

    expect(wsCounterLine()).toEqual({
      pod: 'pod-a-0',
      web: { open: 1, connects: 2, clients: { relay: 1, mobile: 1 }, short: 1, refused: 1 },
      adapter: { open: 1, connects: 1, clients: { daemon: 1 }, short: 0, refused: 0 },
      observer: { open: 0, connects: 0, clients: {}, short: 0, refused: 1 },
      agentMessages: { open: 0, connects: 0, clients: {}, short: 0, refused: 0 },
    })
    // Each line counts since the one before; open sockets carry over.
    expect(wsCounterLine().web).toEqual({ open: 1, connects: 0, clients: {}, short: 0, refused: 0 })
  })
})

// The server's upgrade hook (server.ts) on a real HTTP server and real `ws` sockets: what the counters lean on is that
// an upgraded socket's raw socket is the one watched, so a tracked socket is never also counted refused.
describe('real upgrades', () => {
  it('count a socket destroyed before its upgrade and one closed right after it as refused, a tracked one as a connect', async () => {
    const { createServer } = await import('node:http')
    const { WebSocketServer, WebSocket } = await import('ws')
    const wss = new WebSocketServer({ noServer: true })
    const server = createServer()
    server.on('upgrade', (req, socket, head) => {
      watchUpgrade('web', socket)
      const how = new URL(req.url ?? '/', 'http://x').searchParams.get('how')
      if (how === 'destroy') { socket.destroy(); return }
      wss.handleUpgrade(req, socket, head, ws => {
        if (how === 'refuse') { ws.close(4401, 'auth expired'); return }
        const tracked = trackSocket('web', 'web user', ws, { client: 'relay', version: null })
        ws.once('close', (code, reason) => tracked.closed(code, reason.toString()))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const dial = (how: string) => new Promise<void>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?how=${how}`)
      ws.on('open', () => { if (how === 'track') ws.close(1000) })
      ws.on('error', () => resolve())
      ws.on('close', () => resolve())
    })
    for (const how of ['destroy', 'refuse', 'track']) await dial(how)
    // The server side's close events land a moment after the client's. Each line counts since the last, so add them up.
    const seen = { connects: 0, refused: 0, open: -1 }
    await vi.waitFor(() => {
      const web = wsCounterLine().web as { open: number; connects: number; refused: number }
      seen.connects += web.connects; seen.refused += web.refused; seen.open = web.open
      expect(seen).toEqual({ connects: 1, refused: 2, open: 0 })
    }, { timeout: 2_000 })
    server.close()
  })
})
