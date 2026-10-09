import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { MasterChannel } from '../harnessd/coreLink.js'
import { heldOffFile, hostServices, LEAVE_GRACE_MS, REFUSED, runServiceProcess, serviceFaults, type ServiceHostOptions, type ServiceProcessOptions } from './process.js'

/** A socket that records what it is sent, and is told what the core says. */
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING
  readonly sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  readonly binary: Uint8Array[] = []
  closed = false
  constructor(readonly url: string, private readonly failSend = false) { super() }
  send(data: string | Uint8Array): void {
    if (this.failSend) throw new Error('gone')
    if (typeof data === 'string') this.sent.push(JSON.parse(data))
    else this.binary.push(data)
  }
  close(): void { this.closed = true }
  open(): void { this.readyState = WebSocket.OPEN; this.emit('open') }
  say(frame: unknown): void { this.emit('message', Buffer.from(typeof frame === 'string' ? frame : JSON.stringify(frame))) }
  drop(code = 1006): void { this.readyState = WebSocket.CLOSED; this.emit('error', new Error('reset')); this.emit('close', code) }
}

class FakeChannel extends EventEmitter implements MasterChannel {
  readonly beats: unknown[] = []
  readonly parentPid = 1
  send = (message: unknown) => { this.beats.push(message) }
  memoryUsage() { return { rss: 10, heapUsed: 5 } }
}

describe('the process the services run in', () => {
  let exits: number[]
  let sigterm: (() => void) | null
  const host = (over: Partial<ServiceHostOptions> = {}) => hostServices({
    name: 'edge',
    services: ['workspaces', 'usage'],
    channel: new FakeChannel(),
    env: {},
    exit: (code) => exits.push(code),
    loopDelay: { take: () => 4, stop: vi.fn() },
    onSignal: (signal, handler) => { if (signal === 'SIGTERM') sigterm = handler },
    ...over,
  })

  beforeEach(() => { vi.useFakeTimers(); exits = []; sigterm = null })
  afterEach(() => vi.useRealTimers())

  it('beats to the master as the core does, one beat for all it runs, and exits when the master goes', async () => {
    const channel = new FakeChannel()
    const loopDelay = { take: () => 4, stop: vi.fn() }
    const running = host({ channel, loopDelay, env: { HARNESSD_WATCHDOG_MS: '3000' } })
    const stops = [vi.fn(), vi.fn()]
    for (const stop of stops) running.add({ stop })
    expect(channel.beats).toEqual([{ type: 'harnessd:heartbeat', rssBytes: 10, heapUsedBytes: 5, loopDelayMs: 4 }])
    vi.advanceTimersByTime(1_000)
    expect(channel.beats).toHaveLength(2)
    channel.emit('disconnect')
    await vi.advanceTimersByTimeAsync(0)
    // Every service it runs is stopped before it goes.
    for (const stop of stops) expect(stop).toHaveBeenCalledOnce()
    expect(exits).toEqual([0])
    expect(loopDelay.stop).toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(channel.beats).toHaveLength(2)
  })

  it('without a master to beat to, runs all the same', () => {
    const channel = new FakeChannel()
    ;(channel as { send?: unknown }).send = undefined
    host({ channel })
    expect(channel.beats).toEqual([])
  })

  it('stops what it runs on the master\'s SIGTERM, waiting for a stop that takes a moment, and leaves once', async () => {
    const running = host()
    let stopped!: () => void
    const slow = vi.fn(() => new Promise<void>((done) => { stopped = done }))
    const failing = vi.fn(() => { throw new Error('would not stop') })
    running.add({ stop: slow })
    running.add({ stop: failing })
    sigterm!()
    running.leave(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(exits).toEqual([])
    stopped()
    await vi.advanceTimersByTimeAsync(0)
    expect(slow).toHaveBeenCalledOnce()
    expect(failing).toHaveBeenCalledOnce()
    expect(exits).toEqual([0])
    // The bound it had set on the stop is gone with it.
    await vi.advanceTimersByTimeAsync(LEAVE_GRACE_MS)
    expect(exits).toEqual([0])
  })

  it('exits all the same when a service never finishes stopping', async () => {
    const running = host({ leaveGraceMs: 300 })
    running.add({ stop: () => new Promise<void>(() => {}) })
    running.leave(0)
    await vi.advanceTimersByTimeAsync(299)
    expect(exits).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(exits).toEqual([0])
  })

  it('crashes or leaks on purpose when a test asks it to, of the process or of any service in it', async () => {
    host({ env: { HARNESSD_TEST_FAULTS: 'edge.crash' } })
    await vi.advanceTimersByTimeAsync(200)
    expect(exits).toEqual([1])
    host({ env: { HARNESSD_TEST_FAULTS: 'usage.crash' } })
    await vi.advanceTimersByTimeAsync(200)
    expect(exits).toEqual([1, 1])
    const leaking = host({ env: { HARNESSD_TEST_FAULTS: 'workspaces.leak' } })
    vi.advanceTimersByTime(300)
    leaking.leave(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(exits).toEqual([1, 1, 0])
    // A fault of a service it does not run is not its own.
    host({ env: { HARNESSD_TEST_FAULTS: 'search.crash' } })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(exits).toEqual([1, 1, 0])
  })

  it('runs on this process by default: its channel, its signal, its exit', async () => {
    // No beat may reach the test runner's own channel: this process's `send` is set aside.
    const send = process.send
    ;(process as { send?: unknown }).send = undefined
    const on = vi.spyOn(process, 'once').mockImplementation(() => process)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      hostServices({ name: 'search', services: ['search'] })
      expect(on).toHaveBeenCalledWith('disconnect', expect.any(Function))
      expect(on).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
      const leave = on.mock.calls.find(([event]) => event === 'disconnect')![1] as () => void
      leave()
      await vi.advanceTimersByTimeAsync(0)
      expect(exit).toHaveBeenCalledWith(0)
    } finally {
      ;(process as { send?: unknown }).send = send
      on.mockRestore()
      exit.mockRestore()
    }
  })
})

describe('a service in its own process', () => {
  let sockets: FakeSocket[]
  let lines: string[]
  const socket = () => sockets[sockets.length - 1]
  const run = (over: Partial<ServiceProcessOptions> = {}) => runServiceProcess({
    name: 'search',
    socketPath: '/data/daemon-1.sock',
    machineId: 'machine-1',
    token: 'token-1',
    requests: {},
    env: {},
    connect: (url) => { const next = new FakeSocket(url); sockets.push(next); return next as unknown as WebSocket },
    log: (line) => lines.push(line),
    initialBackoffMs: 100,
    maxBackoffMs: 400,
    ...over,
  })

  beforeEach(() => { vi.useFakeTimers(); sockets = []; lines = [] })
  afterEach(() => vi.useRealTimers())

  it('connects to the core\'s socket as the service it is, with the master\'s token', () => {
    const service = run()
    expect(socket().url).toBe('ws+unix:///data/daemon-1.sock:/api/local-ws')
    socket().open()
    expect(socket().sent).toEqual([{ type: 'machine_select', payload: { machineId: 'machine-1', localProtocolVersion: 1, role: 'service', service: 'search', token: 'token-1' } }])
    service.stop()
    expect(socket().closed).toBe(true)
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
      { type: 'session_tail_result', payload: { error: 'SERVICE_FAILED', service: 'search', requestId: 'r2' } },
      { type: 'session_other_result', payload: { error: 'SERVICE_FAILED', service: 'search', requestId: 'r3' } },
    ]))
    // What went wrong is logged here, as the core's host logs it, and not told to whoever asked.
    expect(lines).toEqual(expect.arrayContaining(['[service search] session_tail failed · index gone', '[service search] session_other failed · not an error']))
  })

  it('tells each handler who asked, as the core established it, and the least it could be when that is missing', async () => {
    const asked: unknown[] = []
    run({ requests: { session_search: (_payload: Record<string, unknown>, asker: unknown) => { asked.push(asker); return {} } } })
    socket().open()
    socket().say({ type: 'session_search', payload: { requestId: 'r1' }, asker: { local: true, owner: true } })
    socket().say({ type: 'session_search', payload: { requestId: 'r2' }, asker: { local: 'yes', owner: 1 } })
    socket().say({ type: 'session_search', payload: { requestId: 'r3' } })
    // The connection and the client's own request id, when the core gave them: what a grid command is a job of.
    socket().say({ type: 'session_search', payload: { requestId: 'r4' }, asker: { local: true, owner: true, connection: 'local:1', requestId: 'cmd-1' } })
    socket().say({ type: 'session_search', payload: { requestId: 'r5' }, asker: { local: true, owner: true, connection: 7, requestId: null } })
    await vi.waitFor(() => expect(asked).toHaveLength(5))
    expect(asked).toEqual([
      { local: true, owner: true }, { local: false, owner: false }, { local: false, owner: false },
      { local: true, owner: true, connection: 'local:1', requestId: 'cmd-1' }, { local: true, owner: true },
    ])
  })

  it('tells a handler when the connection that asked closes, and when the core that routed it goes', async () => {
    const asked: Array<{ asker: unknown; closed: AbortSignal; answer: () => void }> = []
    run({ requests: { command: (payload: Record<string, unknown>, asker: unknown, closed?: AbortSignal) => new Promise((resolve) => {
      asked.push({ asker, closed: closed!, answer: () => resolve({ id: payload.id }) })
    }) } })
    socket().open()
    const ask = (id: string, connection?: unknown) => socket().say({ type: 'command', payload: { id, requestId: id }, asker: { local: false, owner: true, connection } })
    ask('a1', 'conn-a')
    ask('a2', 'conn-a')
    ask('b1', 'conn-b')
    // Not a string: read as no connection, as from a core from before connections were given.
    ask('none', 7)
    await vi.waitFor(() => expect(asked).toHaveLength(4))
    expect(asked.map((one) => one.asker)).toEqual([
      { local: false, owner: true, connection: 'conn-a' },
      { local: false, owner: true, connection: 'conn-a' },
      { local: false, owner: true, connection: 'conn-b' },
      { local: false, owner: true },
    ])
    // A request already answered is forgotten: closing its connection reaches nothing.
    asked[2].answer()
    await vi.waitFor(() => expect(socket().sent.at(-1)).toEqual({ type: 'command_result', payload: { id: 'b1', requestId: 'b1' } }))
    socket().say({ type: 'service_connection_closed', payload: { connection: 'conn-b' } })
    expect(asked[2].closed.aborted).toBe(false)
    // Only the connection that closed: its two, not another's, not one with none.
    socket().say({ type: 'service_connection_closed', payload: { connection: 'conn-a' } })
    expect(asked.map((one) => one.closed.aborted)).toEqual([true, true, false, false])
    // Aborted or not, what a handler answers still goes back: the core drops what nobody can read.
    asked[0].answer()
    await vi.waitFor(() => expect(socket().sent.at(-1)).toEqual({ type: 'command_result', payload: { id: 'a1', requestId: 'a1' } }))
    // The core gone: nobody is left to read any answer, so all that is left is aborted.
    socket().drop()
    expect(asked[3].closed.aborted).toBe(true)
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

  it('tells the core without asking, carries bytes both ways, and hears when the core goes (the gateway)', () => {
    const onBinary = vi.fn()
    const onDisconnected = vi.fn()
    let core: Parameters<NonNullable<ServiceProcessOptions['onConnected']>>[0] | null = null
    run({ onBinary, onDisconnected, onConnected: (connection) => { core = connection } })
    // A socket that never got as far as the core taking it: its end is not a disconnection.
    socket().drop()
    expect(onDisconnected).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    socket().open()
    socket().say({ type: 'connected', payload: { service: 'gateway' } })
    core!.notice!('status', { connected: true })
    core!.notice!('linkDown')
    expect(socket().sent.slice(1)).toEqual([
      { type: 'service_notice', payload: { connected: true, kind: 'status' } },
      { type: 'service_notice', payload: { kind: 'linkDown' } },
    ])
    expect(core!.sendBinary!(Uint8Array.of(1, 2))).toBe(true)
    expect(socket().binary).toEqual([Uint8Array.of(1, 2)])
    socket().emit('message', Buffer.from([3, 4]), true)
    socket().emit('message', [Buffer.from([5]), Buffer.from([6])], true)
    expect(onBinary.mock.calls).toEqual([[new Uint8Array([3, 4])], [new Uint8Array([5, 6])]])
    // A binary frame its handler cannot take is logged, and the link goes on.
    onBinary.mockImplementationOnce(() => { throw new Error('bad bytes') })
    socket().emit('message', Buffer.from([7]), true)
    expect(lines).toContain('[service search] binary frame failed · bad bytes')
    socket().drop()
    expect(onDisconnected).toHaveBeenCalledOnce()
    // Gone: bytes cannot be sent, and a notice is dropped rather than thrown.
    expect(core!.sendBinary!(Uint8Array.of(9))).toBe(false)
    core!.notice!('linkDown')
    // A disconnection its handler cannot take is logged too.
    onDisconnected.mockImplementationOnce(() => { throw new Error('stuck') })
    vi.advanceTimersByTime(200)
    socket().open()
    socket().say({ type: 'connected', payload: {} })
    socket().drop()
    expect(lines).toContain('[service search] disconnect failed · stuck')
    // A socket that refuses the bytes as they are written: not sent.
    vi.advanceTimersByTime(400)
    const failing = new FakeSocket('x', true)
    Object.assign(socket(), { send: failing.send.bind(failing) })
    socket().open()
    socket().say({ type: 'connected', payload: {} })
    expect(core!.sendBinary!(Uint8Array.of(1))).toBe(false)
  })

  it('a binary frame with nobody to hear it is dropped', () => {
    run()
    socket().open()
    socket().emit('message', Buffer.from([1]), true)
    expect(lines).toEqual([])
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

  it('asks again only once a minute when the core refuses it: a core that does not run it out of its process', () => {
    const service = run({ refusedBackoffMs: 60_000 })
    socket().drop(REFUSED)
    vi.advanceTimersByTime(59_999)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(2)
    // Any other end is the usual backoff.
    socket().drop()
    vi.advanceTimersByTime(200)
    expect(sockets).toHaveLength(3)
    service.stop()
    // A minute by default.
    const refused = runServiceProcess({ name: 'store', socketPath: '/s', machineId: 'm', token: 't', requests: {}, env: {},
      connect: (url) => { const next = new FakeSocket(url); sockets.push(next); return next as unknown as WebSocket }, log: () => {} })
    socket().drop(REFUSED)
    vi.advanceTimersByTime(59_999)
    expect(sockets).toHaveLength(4)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(5)
    refused.stop()
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

  it('reads its test faults from the environment, its own only, in the names the core\'s host takes', () => {
    expect(serviceFaults({ HARNESSD_TEST_FAULTS: 'search.crash, search.hang,search.leak,devices.crash,search.session_search,search' }, 'search'))
      .toEqual({ start: true, crash: true, leak: true, calls: new Set(['hang', 'session_search']) })
    expect(serviceFaults({ HARNESSD_TEST_FAULTS: 'devices,searching' }, 'search')).toEqual({ start: false, crash: false, leak: false, calls: new Set() })
    expect(serviceFaults({}, 'search')).toEqual({ start: false, crash: false, leak: false, calls: new Set() })
  })

  it('waits to go to the core while the file a test names exists, its own only, and goes once it is gone', () => {
    expect(heldOffFile({ HARNESSD_TEST_HOLD_CONNECT: 'models:/tmp/a:b' }, 'models')).toBe('/tmp/a:b')
    expect(heldOffFile({ HARNESSD_TEST_HOLD_CONNECT: 'models:/tmp/a' }, 'search')).toBeNull()
    expect(heldOffFile({ HARNESSD_TEST_HOLD_CONNECT: 'models' }, 'models')).toBeNull()
    expect(heldOffFile({}, 'models')).toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'held-off-'))
    try {
      const file = join(dir, 'hold')
      writeFileSync(file, '')
      const service = run({ env: { HARNESSD_TEST_HOLD_CONNECT: `search:${file}` } })
      vi.advanceTimersByTime(1_000)
      expect(sockets).toHaveLength(0)
      rmSync(file)
      vi.advanceTimersByTime(200)
      expect(sockets).toHaveLength(1)
      service.stop()
      // Stopped while held: it never goes.
      writeFileSync(file, '')
      run({ env: { HARNESSD_TEST_HOLD_CONNECT: `search:${file}` } }).stop()
      vi.advanceTimersByTime(1_000)
      expect(sockets).toHaveLength(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('fails its start when a test asks it to, before it connects, as a service whose start throws', () => {
    expect(() => run({ env: { HARNESSD_TEST_FAULTS: 'search' } })).toThrow('injected fault: search')
    expect(sockets).toEqual([])
  })

  it('fails a request or an event on every call when a test asks it to, and answers and hears the rest', async () => {
    const onEvent = vi.fn()
    const requests = { session_search: vi.fn(() => ({ hits: [] })), session_tail: vi.fn(() => ({ tail: [] })) }
    run({ requests, onEvent, env: { HARNESSD_TEST_FAULTS: 'search.session_search,search.touch' } })
    socket().open()
    for (const id of ['r1', 'r2']) socket().say({ type: 'session_search', payload: { requestId: id } })
    socket().say({ type: 'session_tail', payload: { requestId: 'r3' } })
    socket().say({ type: 'service_event', payload: { kind: 'touch', sessionId: 's1' } })
    socket().say({ type: 'service_event', payload: { kind: 'deleteHistory', sessionId: 's1' } })
    await vi.waitFor(() => expect(socket().sent).toHaveLength(4))
    expect(socket().sent.slice(1)).toEqual(expect.arrayContaining([
      { type: 'session_search_result', payload: { error: 'SERVICE_FAILED', service: 'search', requestId: 'r1' } },
      { type: 'session_search_result', payload: { error: 'SERVICE_FAILED', service: 'search', requestId: 'r2' } },
      { type: 'session_tail_result', payload: { tail: [], requestId: 'r3' } },
    ]))
    expect(requests.session_search).not.toHaveBeenCalled()
    expect(onEvent.mock.calls).toEqual([[{ kind: 'deleteHistory', sessionId: 's1' }]])
    expect(lines).toEqual(expect.arrayContaining([
      '[service search] session_search failed · injected fault: search.session_search',
      '[service search] touch failed · injected fault: search.touch',
    ]))
  })

  it('logs an event that throws or rejects, and goes on to the next one', async () => {
    const heard: unknown[] = []
    run({ onEvent: (payload) => {
      heard.push(payload.kind)
      if (payload.kind === 'throws') throw new Error('bad row')
      if (payload.kind === 'rejects') return Promise.reject(new Error('index closed'))
      if (payload.kind === undefined) throw 'not an error'
    } })
    socket().open()
    for (const kind of ['throws', 'rejects', undefined, 'fine']) socket().say({ type: 'service_event', payload: kind ? { kind } : {} })
    await vi.waitFor(() => expect(lines).toContain('[service search] rejects failed · index closed'))
    expect(heard).toEqual(['throws', 'rejects', undefined, 'fine'])
    expect(lines).toEqual(expect.arrayContaining(['[service search] throws failed · bad row', '[service search] event failed · not an error']))
  })

  it('says it connected on the console by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const service = runServiceProcess({
      name: 'search', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't', requests: {}, env: {},
      connect: (url) => { const next = new FakeSocket(url); sockets.push(next); return next as unknown as WebSocket },
    })
    socket().open()
    socket().say({ type: 'connected' })
    expect(log).toHaveBeenCalledWith('[service search] connected to the core')
    service.stop()
    log.mockRestore()
  })

  it('runs on this process by default: its environment, its sockets', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const before = process.env.HARNESSD_TEST_FAULTS
    process.env.HARNESSD_TEST_FAULTS = 'search'
    try {
      expect(() => runServiceProcess({ name: 'search', socketPath: '/nonexistent/daemon.sock', machineId: 'm', token: 't', requests: {} })).toThrow('injected fault: search')
      delete process.env.HARNESSD_TEST_FAULTS
      const service = runServiceProcess({ name: 'search', socketPath: '/nonexistent/daemon.sock', machineId: 'm', token: 't', requests: {} })
      service.stop()
    } finally {
      if (before === undefined) delete process.env.HARNESSD_TEST_FAULTS
      else process.env.HARNESSD_TEST_FAULTS = before
      log.mockRestore()
    }
  })
})
