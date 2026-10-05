import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { MasterChannel } from '../harnessd/coreLink.js'
import { runServiceProcess, serviceFaults, type ServiceProcessOptions } from './process.js'

/** A socket that records what it is sent, and is told what the core says. */
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING
  readonly sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  closed = false
  constructor(readonly url: string, private readonly failSend = false) { super() }
  send(data: string): void {
    if (this.failSend) throw new Error('gone')
    this.sent.push(JSON.parse(data))
  }
  close(): void { this.closed = true }
  open(): void { this.readyState = WebSocket.OPEN; this.emit('open') }
  say(frame: unknown): void { this.emit('message', Buffer.from(typeof frame === 'string' ? frame : JSON.stringify(frame))) }
  drop(): void { this.readyState = WebSocket.CLOSED; this.emit('error', new Error('reset')); this.emit('close') }
}

class FakeChannel extends EventEmitter implements MasterChannel {
  readonly beats: unknown[] = []
  readonly parentPid = 1
  send = (message: unknown) => { this.beats.push(message) }
  memoryUsage() { return { rss: 10, heapUsed: 5 } }
}

describe('a service in its own process', () => {
  let sockets: FakeSocket[]
  let exits: number[]
  let lines: string[]
  const socket = () => sockets[sockets.length - 1]
  const run = (over: Partial<ServiceProcessOptions> = {}) => runServiceProcess({
    name: 'search',
    socketPath: '/data/daemon-1.sock',
    machineId: 'machine-1',
    token: 'token-1',
    requests: {},
    channel: new FakeChannel(),
    env: {},
    connect: (url) => { const next = new FakeSocket(url); sockets.push(next); return next as unknown as WebSocket },
    exit: (code) => exits.push(code),
    loopDelay: { take: () => 4, stop: vi.fn() },
    log: (line) => lines.push(line),
    initialBackoffMs: 100,
    maxBackoffMs: 400,
    ...over,
  })

  beforeEach(() => { vi.useFakeTimers(); sockets = []; exits = []; lines = [] })
  afterEach(() => vi.useRealTimers())

  it('connects to the core\'s socket as the service it is, with the master\'s token', () => {
    const service = run()
    expect(socket().url).toBe('ws+unix:///data/daemon-1.sock:/api/local-ws')
    socket().open()
    expect(socket().sent).toEqual([{ type: 'machine_select', payload: { machineId: 'machine-1', localProtocolVersion: 1, role: 'service', service: 'search', token: 'token-1' } }])
    service.stop()
    expect(socket().closed).toBe(true)
  })

  it('beats to the master as the core does, and exits when the master goes', () => {
    const channel = new FakeChannel()
    const loopDelay = { take: () => 4, stop: vi.fn() }
    run({ channel, loopDelay, env: { HARNESSD_WATCHDOG_MS: '3000' } })
    expect(channel.beats).toEqual([{ type: 'harnessd:heartbeat', rssBytes: 10, heapUsedBytes: 5, loopDelayMs: 4 }])
    vi.advanceTimersByTime(1_000)
    expect(channel.beats).toHaveLength(2)
    channel.emit('disconnect')
    expect(exits).toEqual([0])
    expect(loopDelay.stop).toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(channel.beats).toHaveLength(2)
  })

  it('without a master to beat to, runs all the same', () => {
    const channel = new FakeChannel()
    ;(channel as { send?: unknown }).send = undefined
    const service = run({ channel })
    expect(channel.beats).toEqual([])
    service.stop()
  })

  it('answers the requests routed to it under their own request, failures included', async () => {
    const requests = {
      session_search: vi.fn((payload: Record<string, unknown>) => ({ hits: [payload.query] })),
      session_tail: vi.fn(async () => { throw new Error('index gone') }),
      session_other: vi.fn(() => { throw 'not an error' }),
    }
    run({ requests })
    socket().open()
    socket().say({ type: 'session_search', payload: { query: 'zebra', requestId: 'r1' } })
    socket().say({ type: 'session_tail', payload: { requestId: 'r2' } })
    socket().say({ type: 'session_other', payload: { requestId: 'r3' } })
    // Not a request it answers, not JSON, no payload: nothing.
    socket().say({ type: 'agents_list', payload: { requestId: 'r4' } })
    socket().say('{not json')
    socket().say({ type: 'toString' })
    socket().say({ type: 7, payload: { requestId: 'r5' } })
    await vi.waitFor(() => expect(socket().sent).toHaveLength(4))
    expect(socket().sent.slice(1)).toEqual(expect.arrayContaining([
      { type: 'session_search_result', payload: { hits: ['zebra'], requestId: 'r1' } },
      { type: 'session_tail_result', payload: { error: 'SERVICE_FAILED', detail: 'index gone', requestId: 'r2' } },
      { type: 'session_other_result', payload: { error: 'SERVICE_FAILED', detail: 'not an error', requestId: 'r3' } },
    ]))
  })

  it('hears what the core tells it, and asks the core what it needs to know', async () => {
    const onEvent = vi.fn()
    let core: Parameters<NonNullable<ServiceProcessOptions['onConnected']>>[0] | null = null
    run({ onEvent, onConnected: (connection) => { core = connection } })
    socket().open()
    socket().say({ type: 'connected', payload: { service: 'search' } })
    expect(lines).toContain('[service search] connected to the core')
    socket().say({ type: 'service_event', payload: { kind: 'touch', sessionId: 's1' } })
    socket().say({ type: 'service_event' })
    expect(onEvent).toHaveBeenCalledWith({ kind: 'touch', sessionId: 's1' })
    expect(onEvent).toHaveBeenCalledWith({})
    const asked = core!.query('agents')
    expect(socket().sent.at(-1)).toEqual({ type: 'service_query', payload: { query: 'agents', requestId: 'search-1' } })
    // An answer to nothing it asked is ignored.
    socket().say({ type: 'service_query_result', payload: { requestId: 'search-9', agents: [] } })
    socket().say({ type: 'service_query_result', payload: { requestId: 'search-1', agents: [{ agentId: 'a' }] } })
    await expect(asked).resolves.toEqual({ agents: [{ agentId: 'a' }] })
    // Asked with no connection, or when the connection goes first: rejected, not left hanging.
    const pending = core!.query('agents', { since: 1 })
    socket().drop()
    await expect(pending).rejects.toThrow('the core went away')
    await expect(core!.query('agents')).rejects.toThrow('not connected to the core')
  })

  it('reconnects with a backoff that doubles and caps while the core is away, and resets once connected', () => {
    const service = run()
    socket().drop()
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(100)
    expect(sockets).toHaveLength(2)
    socket().drop()
    vi.advanceTimersByTime(199)
    expect(sockets).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(3)
    socket().drop()
    vi.advanceTimersByTime(400)
    socket().drop()
    vi.advanceTimersByTime(400)
    expect(sockets).toHaveLength(5)
    socket().open()
    socket().say({ type: 'connected' })
    socket().drop()
    vi.advanceTimersByTime(100)
    expect(sockets).toHaveLength(6)
    // Stopped: no reconnecting, and a socket that closes afterwards changes nothing.
    service.stop()
    socket().drop()
    vi.advanceTimersByTime(10_000)
    expect(sockets).toHaveLength(6)
  })

  it('stops a reconnect it had scheduled, and stopping twice is stopping once', () => {
    const service = run()
    socket().drop()
    service.stop()
    service.stop()
    vi.advanceTimersByTime(10_000)
    expect(sockets).toHaveLength(1)
  })

  it('a socket that cannot be written to costs nothing: the core answers for it', async () => {
    run({
      requests: { session_search: () => ({ hits: [] }) },
      connect: (url) => { const next = new FakeSocket(url, true); sockets.push(next); return next as unknown as WebSocket },
    })
    socket().open()
    socket().say({ type: 'session_search', payload: { requestId: 'r1' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket().sent).toEqual([])
  })

  it('reads its test faults from the environment, its own only', () => {
    expect([...serviceFaults({ HARNESSD_TEST_FAULTS: 'search.crash, search.hang,search.leak,devices.crash,search.other,search' }, 'search')]).toEqual(['crash', 'leak'])
    expect(serviceFaults({}, 'search').size).toBe(0)
  })

  it('crashes or leaks on purpose when a test asks it to', () => {
    run({ env: { HARNESSD_TEST_FAULTS: 'search.crash' } })
    vi.advanceTimersByTime(200)
    expect(exits).toEqual([1])
    const leaking = run({ env: { HARNESSD_TEST_FAULTS: 'search.leak' } })
    vi.advanceTimersByTime(300)
    leaking.stop()
    // Without a fault, connecting is just connecting.
    run({ env: {} })
    socket().open()
    socket().say({ type: 'connected' })
    expect(lines.at(-1)).toBe('[service search] connected to the core')
  })

  it('says it connected on the console by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const service = runServiceProcess({
      name: 'search', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't', requests: {}, env: {},
      channel: Object.assign(new FakeChannel(), { send: undefined }),
      connect: (url) => { const next = new FakeSocket(url); sockets.push(next); return next as unknown as WebSocket },
      loopDelay: { take: () => 0, stop: () => {} },
    })
    socket().open()
    socket().say({ type: 'connected' })
    expect(log).toHaveBeenCalledWith('[service search] connected to the core')
    service.stop()
    log.mockRestore()
  })

  it('runs on this process by default: its channel, its exit, its sockets', () => {
    // No beat may reach the test runner's own channel: this process's `send` is set aside.
    const send = process.send
    ;(process as { send?: unknown }).send = undefined
    const on = vi.spyOn(process, 'once').mockImplementation(() => process)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const service = runServiceProcess({ name: 'search', socketPath: '/nonexistent/daemon.sock', machineId: 'm', token: 't', requests: {} })
      expect(on).toHaveBeenCalledWith('disconnect', expect.any(Function))
      const leave = on.mock.calls.find(([event]) => event === 'disconnect')![1] as () => void
      leave()
      expect(exit).toHaveBeenCalledWith(0)
      service.stop()
    } finally {
      ;(process as { send?: unknown }).send = send
      on.mockRestore()
      exit.mockRestore()
      log.mockRestore()
    }
  })
})
