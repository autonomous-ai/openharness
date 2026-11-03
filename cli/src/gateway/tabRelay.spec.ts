import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { TabFrame } from '../core/api.js'

const liveness = vi.hoisted(() => ({ opts: [] as Array<{ onIdle?: (ms: number) => void; onWake?: (ms: number, givingUp: boolean) => void; peerGivesUpAfterMs?: number }>, stop: [] as Array<() => void> }))
vi.mock('../lib/wsLiveness.js', () => ({
  BACKEND_IDLE_DEADLINE_MS: 75_000,
  watchSocketLiveness: (_ws: unknown, opts: never) => { liveness.opts.push(opts); const stop = vi.fn(); liveness.stop.push(stop); return { stop } },
}))
import { SHARED_TAB_FRAME_MAX } from '../lib/e2ee/tabSession.js'
import { TAB_RELAY_MAX_FRAME, TAB_RELAY_QUEUE, TAB_RELAY_READY_WAIT_MS, TAB_RELAY_SEND_DEADLINE_MS, TabRelaySockets } from './tabRelay.js'
import { VERSION } from '../version.js'

const TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const TAB2 = 'b1b2c3d4e5f6a1b2c3d4e5f6'

interface Conn { ws: WebSocket; url: string; protocol: string; got: unknown[]; closed: boolean }

/**
 * A local relay standing in for the backend's `/api/agent-messages-ws`: it admits, or refuses an upgrade with a status
 * written as the backend writes it (backend/src/lib/agentMessagesWs.ts `refuse`: the bare status line, then the socket
 * destroyed, before any upgrade).
 */
async function serve(opts: { ready?: boolean; refuse?: () => string | null; onConnection?: (conn: Conn) => void } = {}) {
  const conns: Conn[] = []
  const wss = new WebSocketServer({ noServer: true })
  const http = createServer()
  http.on('upgrade', (req, socket, head) => {
    const status = opts.refuse?.() ?? null
    if (status) {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()))
  wss.on('connection', (ws, req) => {
    const conn: Conn = { ws, url: req.url ?? '', protocol: ws.protocol, got: [], closed: false }
    conns.push(conn)
    ws.on('message', (raw) => conn.got.push(JSON.parse(raw.toString())))
    ws.on('close', () => { conn.closed = true })
    if (opts.ready !== false) ws.send(JSON.stringify({ type: 'amsg_ready' }))
    opts.onConnection?.(conn)
  })
  servers.push({ wss, http })
  return { wss, conns, base: `ws://127.0.0.1:${(http.address() as AddressInfo).port}/` }
}

const servers: Array<{ wss: WebSocketServer; http: Server }> = []
const relays: TabRelaySockets[] = []

/** Real time, whatever the test faked: the sockets run on it. */
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(5)
  }
}

function relayFor(base: string, overrides: Partial<ConstructorParameters<typeof TabRelaySockets>[0]> = {}) {
  const emit = vi.fn<(event: TabFrame) => void>()
  const accessToken = vi.fn(async (_o?: { force?: boolean; failedToken?: string }) => 'tok-1')
  const relay = new TabRelaySockets({ base, environment: 'staging', machineId: () => 'bob-mini', accessToken, emit, ...overrides })
  relays.push(relay)
  return { relay, emit, accessToken }
}

const logged = (log: ReturnType<typeof vi.spyOn>, text: string) => log.mock.calls.some((call: unknown[]) => String(call[0]).includes(text))

afterEach(async () => {
  for (const relay of relays.splice(0)) relay.closeAll()
  vi.useRealTimers()
  vi.restoreAllMocks()
  liveness.opts.length = 0
  liveness.stop.length = 0
  for (const { wss, http } of servers.splice(0)) {
    for (const client of wss.clients) client.terminate()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }
})

describe('the gateway\'s sockets to the shared tabs\' relay', () => {
  it('dials the tab\'s relay with the token as the first subprotocol, and only once for the tab', async () => {
    const server = await serve()
    const { relay } = relayFor(server.base)
    await relay.open(TAB)
    await relay.open(TAB)
    await until(() => server.conns.length === 1)
    // It says it is a daemon's relay, and which CLI (WebSocket roadmap Phase 0).
    expect(server.conns[0].url).toBe(`/api/agent-messages-ws?share=${TAB}&machine=bob-mini&autonomousEnv=staging`
      + `&client=relay&v=${encodeURIComponent(VERSION)}`)
    expect(server.conns[0].protocol).toBe('tok-1')
    await relay.open(TAB)
    await sleep(30)
    expect(server.conns).toHaveLength(1)
    // A tab id the relay would refuse before its upgrade is never dialled.
    await relay.open('tab-1')
    expect(await relay.send('tab-1', 'alice-mac', {})).toBe(false)
    await sleep(30)
    expect(server.conns).toHaveLength(1)
    // Watched for silence as the backend watches it, and the watch's words said under the tab.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(liveness.opts[0].peerGivesUpAfterMs).toBe(75_000)
    liveness.opts[0].onIdle!(61_000)
    liveness.opts[0].onWake!(90_000, true)
    liveness.opts[0].onWake!(30_000, false)
    expect(logged(log, '[shared-tabs] a1b2c3d4 no traffic for 61s')).toBe(true)
    expect(logged(log, 'woke after 90s asleep — giving up on the link')).toBe(true)
    expect(logged(log, 'woke after 30s asleep — re-probing')).toBe(true)
  })

  it('sends a frame once the relay is ready, waits for it a while before, and refuses what it could not send', async () => {
    let admit: (() => void) | null = null
    const server = await serve({ ready: false, onConnection: (conn) => { admit = () => conn.ws.send(JSON.stringify({ type: 'amsg_ready' })) } })
    const { relay } = relayFor(server.base)
    expect(await relay.send(TAB, 'alice-mac', { a: 1 })).toBe(false)
    await relay.open(TAB)
    await until(() => server.conns.length === 1)
    const sent = relay.send(TAB, 'alice-mac', { a: 1 })
    await sleep(30)
    expect(server.conns[0].got).toEqual([])
    admit!()
    expect(await sent).toBe(true)
    expect(await relay.send(TAB, 'carol-pc', { b: 2 })).toBe(true)
    await until(() => server.conns[0].got.length === 2)
    expect(server.conns[0].got).toEqual([{ type: 'amsg_frame', to: 'alice-mac', payload: { a: 1 } }, { type: 'amsg_frame', to: 'carol-pc', payload: { b: 2 } }])
    // Refused rather than have the relay close the socket on it: too big, nobody to send it to, or no payload.
    expect(await relay.send(TAB, 'alice-mac', { big: 'x'.repeat(TAB_RELAY_MAX_FRAME) })).toBe(false)
    // One ceiling for the frame, the cipher and the backend's relay (lib/e2ee/tabSession.ts `SHARED_TAB_FRAME_MAX`).
    expect(TAB_RELAY_MAX_FRAME).toBe(SHARED_TAB_FRAME_MAX)
    expect(await relay.send(TAB, '', { a: 1 })).toBe(false)
    expect(await relay.send(TAB, 'm'.repeat(129), { a: 1 })).toBe(false)
    expect(await relay.send(TAB, 'alice-mac', [] as never)).toBe(false)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(await relay.send(TAB, 'alice-mac', cyclic)).toBe(false)
    await sleep(30)
    expect(server.conns[0].got).toHaveLength(2)
    expect(server.conns[0].closed).toBe(false)
  })

  it('gives up waiting for the relay after five seconds', async () => {
    const server = await serve({ ready: false })
    const { relay } = relayFor(server.base)
    await relay.open(TAB)
    await until(() => server.conns.length === 1)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const sent = relay.send(TAB, 'alice-mac', { a: 1 })
    await vi.advanceTimersByTimeAsync(TAB_RELAY_READY_WAIT_MS - 1)
    let settled = false
    void sent.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await sent).toBe(false)
    expect(TAB_RELAY_READY_WAIT_MS).toBe(5_000)
    // Closed while one waits: it is told at once.
    const waiting = relay.send(TAB, 'alice-mac', { a: 1 })
    relay.close(TAB)
    expect(await waiting).toBe(false)
    expect(server.conns[0].got).toEqual([])
  })

  it('keeps to the relay\'s twenty frames a second, in order', async () => {
    const server = await serve()
    let now = 1_000_000
    const { relay } = relayFor(server.base, { now: () => now })
    await relay.open(TAB)
    await until(() => server.conns.length === 1)
    expect(await relay.send(TAB, 'warm', {})).toBe(true)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const sends = Array.from({ length: 22 }, (_, i) => relay.send(TAB, 'alice-mac', { i }))
    await vi.advanceTimersByTimeAsync(0)
    await until(() => server.conns[0].got.length === 20)
    await sleep(30)
    expect(server.conns[0].got).toHaveLength(20)
    now += 1_100
    await vi.advanceTimersByTimeAsync(1_100)
    expect(await Promise.all(sends)).toEqual(Array(22).fill(true))
    await until(() => server.conns[0].got.length === 23)
    expect(server.conns[0].got.slice(1).map((f) => (f as { payload: { i: number } }).payload.i)).toEqual(Array.from({ length: 22 }, (_, i) => i))
  })

  it('refuses a frame still waiting for its turn when the tab is closed', async () => {
    const server = await serve()
    let now = 5
    const { relay } = relayFor(server.base, { now: () => now })
    await relay.open(TAB)
    await until(() => server.conns.length === 1)
    expect(await relay.send(TAB, 'warm', {})).toBe(true)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const sends = Array.from({ length: 20 }, (_, i) => relay.send(TAB, 'alice-mac', { i }))
    await vi.advanceTimersByTimeAsync(0)
    relay.close(TAB)
    now += 1_100
    await vi.advanceTimersByTimeAsync(1_100)
    expect(await Promise.all(sends)).toEqual([...Array(19).fill(true), false])
  })

  it('answers a send no later than its deadline, and never sends it after', async () => {
    const server = await serve()
    let now = 1_000_000
    const { relay } = relayFor(server.base, { now: () => now })
    await relay.open(TAB)
    await until(() => server.conns.length === 1)
    expect(await relay.send(TAB, 'warm', {})).toBe(true)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const sends = Array.from({ length: 20 }, (_, i) => relay.send(TAB, 'alice-mac', { i }))
    await vi.advanceTimersByTimeAsync(0)
    await until(() => server.conns[0].got.length === 20)
    // The last waits for a slot; the loop stalled past its deadline before the slot came (a machine asleep).
    now += TAB_RELAY_SEND_DEADLINE_MS
    await vi.advanceTimersByTimeAsync(1_100)
    expect(await Promise.all(sends)).toEqual([...Array(19).fill(true), false])
    await sleep(30)
    expect(server.conns[0].got).toHaveLength(20)
    expect(TAB_RELAY_SEND_DEADLINE_MS).toBe(8_000)
    // Its turn sleeps no later than the deadline either: one sent in a full window is answered within it.
    const full = Array.from({ length: 21 }, (_, i) => relay.send(TAB, 'alice-mac', { i }))
    await vi.advanceTimersByTimeAsync(0)
    await until(() => server.conns[0].got.length === 40)
    let answered = false
    void full[20].then(() => { answered = true })
    await vi.advanceTimersByTimeAsync(1_099)
    expect(answered).toBe(false)
    now += 1_100
    await vi.advanceTimersByTimeAsync(1)
    expect(await full[20]).toBe(true)
  })

  it('refuses at once a frame beyond the frames already waiting for the tab', async () => {
    let admit: () => void = () => {}
    const server = await serve({ ready: false, onConnection: (conn) => { admit = () => conn.ws.send(JSON.stringify({ type: 'amsg_ready' })) } })
    const { relay } = relayFor(server.base)
    await relay.open(TAB)
    await until(() => server.conns.length === 1)
    const waiting = Array.from({ length: TAB_RELAY_QUEUE }, (_, i) => relay.send(TAB, 'alice-mac', { i }))
    expect(await relay.send(TAB, 'alice-mac', { i: 'one too many' })).toBe(false)
    expect(TAB_RELAY_QUEUE).toBe(40)
    admit()
    expect(await Promise.all(waiting)).toEqual(Array(TAB_RELAY_QUEUE).fill(true))
    await until(() => server.conns[0].got.length === TAB_RELAY_QUEUE)
    // Answered, they wait no more: the next is taken.
    expect(await relay.send(TAB, 'alice-mac', { i: 'next' })).toBe(true)
  })

  it('gives a frame refused in its turn no slot of the rate', async () => {
    const server = await serve()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    let now = 7
    const { relay } = relayFor(server.base, { now: () => now })
    await relay.open(TAB)
    await until(() => server.conns.length === 1)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const sent = Array.from({ length: 20 }, (_, i) => relay.send(TAB, 'alice-mac', { i }))
    expect(await Promise.all(sent)).toEqual(Array(20).fill(true))
    const late = Array.from({ length: 5 }, (_, i) => relay.send(TAB, 'alice-mac', { late: i }))
    await vi.advanceTimersByTimeAsync(0)
    // The socket drops while they wait their turn: woken, each finds it gone and is refused.
    server.conns[0].ws.close(1013, 'Shared tab temporarily unavailable')
    await until(() => logged(log, 'closed 1013 — retrying in 1s'))
    now += 1_100
    await vi.advanceTimersByTimeAsync(1_100)
    expect(await Promise.all(late)).toEqual(Array(5).fill(false))
    expect(server.conns[0].got).toHaveLength(20)
    // Dialled again and admitted: a whole window's frames go at once, none of its slots taken by the refused ones.
    await until(() => server.conns.length === 2)
    const again = Array.from({ length: 20 }, (_, i) => relay.send(TAB, 'alice-mac', { again: i }))
    expect(await Promise.all(again)).toEqual(Array(20).fill(true))
    await until(() => server.conns[1].got.length === 20)
  })

  it('hands on nothing the relay said after the tab was closed', async () => {
    const server = await serve()
    const { relay, emit } = relayFor(server.base)
    await relay.open(TAB)
    await until(() => emit.mock.calls.length === 1)
    server.conns[0].ws.send(JSON.stringify({ type: 'amsg_undeliverable', to: 'carol-pc' }))
    relay.close(TAB)
    await until(() => server.conns[0].closed)
    expect(emit.mock.calls).toEqual([[{ sharedTabId: TAB, ready: true }]])
  })

  it('hands on what the relay says: frames from the tab\'s machines, and frames nobody was there for', async () => {
    const server = await serve()
    const { relay, emit } = relayFor(server.base)
    await relay.open(TAB)
    await until(() => server.conns.length === 1)
    await until(() => emit.mock.calls.length === 1)
    expect(emit).toHaveBeenLastCalledWith({ sharedTabId: TAB, ready: true })
    const ws = server.conns[0].ws
    ws.send(JSON.stringify({ type: 'amsg_frame', from: { machineId: 'alice-mac', userId: 'u-alice' }, payload: { hello: 1 } }))
    ws.send(JSON.stringify({ type: 'amsg_undeliverable', to: 'carol-pc' }))
    // What is not the relay's word is not handed on.
    for (const odd of ['not json', '[]', 'null', JSON.stringify({ type: 'amsg_frame', from: { machineId: 'x' }, payload: {} }),
      JSON.stringify({ type: 'amsg_frame', from: 'x', payload: {} }), JSON.stringify({ type: 'amsg_frame', from: { machineId: 'x', userId: 'y' }, payload: [] }),
      JSON.stringify({ type: 'amsg_undeliverable', to: 3 }), JSON.stringify({ type: 'other' })]) ws.send(odd)
    ws.send(JSON.stringify({ type: 'amsg_undeliverable', to: 'last' }))
    await until(() => emit.mock.calls.length === 4)
    expect(emit.mock.calls.map((c) => c[0])).toEqual([
      { sharedTabId: TAB, ready: true },
      { sharedTabId: TAB, from: { machineId: 'alice-mac', userId: 'u-alice' }, payload: { hello: 1 } },
      { sharedTabId: TAB, undeliverable: 'carol-pc' },
      { sharedTabId: TAB, undeliverable: 'last' },
    ])
  })

  it('stops for good when the relay no longer admits this machine, or another socket of it took the tab', async () => {
    for (const code of [4403, 4409]) {
      const server = await serve({ onConnection: (conn) => conn.ws.close(code, 'Not in this shared tab') })
      const { relay, emit } = relayFor(server.base)
      vi.spyOn(console, 'log').mockImplementation(() => {})
      await relay.open(TAB)
      await until(() => emit.mock.calls.some((c) => c[0].closed !== undefined))
      expect(emit).toHaveBeenLastCalledWith({ sharedTabId: TAB, closed: { code, reason: 'Not in this shared tab' } })
      expect(await relay.send(TAB, 'alice-mac', {})).toBe(false)
      await sleep(50)
      expect(server.conns).toHaveLength(1)
      // Opened again on purpose, it dials again.
      await relay.open(TAB)
      await until(() => server.conns.length === 2)
    }
  })

  it('dials again after any other close, backing off to thirty seconds, and after a ready link from the start', async () => {
    let ready = false
    const server = await serve({ ready: false, onConnection: (conn) => {
      if (ready) conn.ws.send(JSON.stringify({ type: 'amsg_ready' }), () => conn.ws.close(1013, 'Shared tab temporarily unavailable'))
      else conn.ws.close(1013, 'Shared tab temporarily unavailable')
    } })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { relay } = relayFor(server.base)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await relay.open(TAB)
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
    for (const [n, delay] of delays.entries()) {
      await until(() => server.conns.length === n + 1)
      await until(() => logged(log, `retrying in ${delay / 1000}s (attempt ${n + 1})`))
      await vi.advanceTimersByTimeAsync(delay - 1)
      await sleep(20)
      expect(server.conns).toHaveLength(n + 1)
      await vi.advanceTimersByTimeAsync(1)
    }
    await until(() => server.conns.length === delays.length + 1)
    // Admitted, the next close starts from a second again.
    ready = true
    await until(() => logged(log, `retrying in 30s (attempt ${delays.length + 1})`))
    await vi.advanceTimersByTimeAsync(30_000)
    await until(() => server.conns.length === delays.length + 2)
    await until(() => logged(log, 'retrying in 1s (attempt 1)') && log.mock.calls.filter((c) => String(c[0]).includes('retrying in 1s (attempt 1)')).length === 2)
  })

  it('refreshes a token the relay answered 401 once, and dials again on the backoff', async () => {
    let refuse = 2
    const server = await serve({ refuse: () => (refuse-- > 0 ? '401 Unauthorized' : null) })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    let token = 'old'
    const accessToken = vi.fn(async (o?: { force?: boolean; failedToken?: string }) => {
      if (o?.force && token === 'old') { token = 'new'; return token }
      if (o?.force) throw new Error('refresh failed')
      return token
    })
    const { relay } = relayFor(server.base, { accessToken })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await relay.open(TAB)
    await until(() => logged(log, 'token refused, refreshed — retrying in 1s (attempt 1)'))
    expect(accessToken.mock.calls).toEqual([[], [{ force: true, failedToken: 'old' }]])
    // Not dialled again until the backoff is up, and then with the refreshed token.
    await vi.advanceTimersByTimeAsync(999)
    await sleep(20)
    expect(accessToken).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    // The second refusal: the refresh fails, and it backs off all the same.
    await until(() => logged(log, 'token refused, refresh failed — retrying in 2s (attempt 2)'))
    expect(accessToken.mock.calls.slice(2)).toEqual([[], [{ force: true, failedToken: 'new' }]])
    await vi.advanceTimersByTimeAsync(2_000)
    await until(() => server.conns.length === 1)
    expect(server.conns[0].protocol).toBe('new')
    // One forced refresh for each refusal, and none for the dial that was admitted.
    expect(accessToken).toHaveBeenCalledTimes(5)
    expect(accessToken.mock.calls.filter((c) => c[0]?.force)).toHaveLength(2)
  })

  it('backs off when it has no token to dial with, or one no socket can carry, or the relay answers otherwise', async () => {
    let refuse = 1
    const server = await serve({ refuse: () => (refuse-- > 0 ? '503 Service Unavailable' : null) })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const tokens = [Promise.reject('signed out'), Promise.resolve(''), Promise.resolve('tok')]
    const accessToken = vi.fn(() => tokens.shift()!)
    const { relay } = relayFor(server.base, { accessToken })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await relay.open(TAB)
    await until(() => logged(log, 'no token (signed out) — retrying in 1s'))
    await vi.advanceTimersByTimeAsync(1_000)
    await until(() => logged(log, 'retrying in 2s'))
    await vi.advanceTimersByTimeAsync(2_000)
    await until(() => logged(log, 'retrying in 4s'))
    expect(accessToken).toHaveBeenCalledTimes(3)
    expect(accessToken.mock.calls.every((c: unknown[]) => c.length === 0)).toBe(true)
  })

  it('stops dialling a tab it was told to close, and closes every socket when the gateway stops', async () => {
    const server = await serve({ ready: false, onConnection: (conn) => { if (server.conns.length === 1) conn.ws.close(1013, 'later') } })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { relay, emit } = relayFor(server.base)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await relay.open(TAB)
    await until(() => logged(log, 'retrying in 1s'))
    relay.close(TAB)
    await vi.advanceTimersByTimeAsync(60_000)
    await sleep(30)
    expect(server.conns).toHaveLength(1)
    // Closed while it fetched a token: no socket is made, and a token it could not get is not waited for again.
    let give: (token: string) => void = () => {}
    let refuse: (why: unknown) => void = () => {}
    const slow = relayFor(server.base, { accessToken: () => new Promise<string>((resolve) => { give = resolve }) })
    await slow.relay.open(TAB)
    slow.relay.close(TAB)
    give('tok')
    const failing = relayFor(server.base, { accessToken: () => new Promise<string>((_resolve, reject) => { refuse = reject }) })
    await failing.relay.open(TAB)
    failing.relay.close(TAB)
    refuse('signed out')
    await sleep(30)
    expect(server.conns).toHaveLength(1)
    expect(log.mock.calls.filter((c) => String(c[0]).includes('retrying')).length).toBe(1)
    // Two tabs open, both closed with the gateway; nothing said of either, the gateway asked for it.
    vi.useRealTimers()
    await relay.open(TAB)
    await relay.open(TAB2)
    await until(() => server.conns.length === 3)
    relay.close('never-opened')
    relay.closeAll()
    await until(() => server.conns.every((c) => c.closed))
    expect(liveness.stop.every((stop) => (stop as ReturnType<typeof vi.fn>).mock.calls.length > 0)).toBe(true)
    await sleep(30)
    expect(server.conns).toHaveLength(3)
    expect(emit).not.toHaveBeenCalled()
  })
})
