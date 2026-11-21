import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { ClientSocket } from '../../agentClient/daemon.js'
import { SESSION_EVENT_BYTES } from '../sessionEvents.js'
import { DeviceFeedPool, observeDeviceSessions, type DeviceSessionFeed } from './sessionFeed.js'

const feeds: DeviceSessionFeed[] = []
afterEach(() => { for (const feed of feeds.splice(0)) feed.close(); vi.useRealTimers() })
function deferred() {
  let resolve!: () => void
  return { promise: new Promise<void>(done => { resolve = done }), resolve: () => resolve() }
}

it.each([{ machineId: 'replacement' }, { transport: 'relay' }, { localProtocolVersion: 0 }])('refuses a foreign desk-capable feed welcome %j', async changed => {
  const socket = new EventEmitter() as EventEmitter & ClientSocket, sent: unknown[] = [], unavailable = vi.fn()
  socket.send = text => { sent.push(JSON.parse(text)) }
  socket.close = vi.fn(() => socket.emit('close', 1000))
  const feed = observeDeviceSessions({ port: 1, dataDir: '/fixture', machineId: 'machine' },
    { pool: new DeviceFeedPool(), receive: vi.fn(async () => {}), unavailable }, () => socket)
  feeds.push(feed); void feed.ready.catch(() => {})
  await Promise.resolve(); socket.emit('open')
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'connected', payload: {
    machineId: 'machine', transport: 'local', localProtocolVersion: 1, eventsProtocol: 1, ...changed,
  } })), false)
  expect(unavailable).toHaveBeenCalledExactlyOnceWith('SESSION_EVENTS_PROTOCOL')
  expect(sent).toHaveLength(1)
})
async function fixture(pool = new DeviceFeedPool(), receive = vi.fn(async (_agent: string, _frames: readonly Record<string, unknown>[], _current: () => boolean) => {}), handshake = true) {
  const socket = new EventEmitter() as EventEmitter & ClientSocket, sent: any[] = [], unavailable = vi.fn()
  Object.defineProperty(socket, 'bufferedAmount', { value: 0, writable: true, configurable: true })
  socket.send = (text, done) => { sent.push(JSON.parse(text)); done?.() }
  socket.close = vi.fn(() => socket.emit('close', 1000))
  const feed = observeDeviceSessions({ port: 1, dataDir: '/fixture', machineId: 'machine' }, { pool, receive, unavailable }, () => socket)
  feeds.push(feed)
  const frame = (type: string, payload: object) => socket.emit('message', Buffer.from(JSON.stringify({ type, payload })), false)
  await Promise.resolve(); socket.emit('open')
  if (handshake) {
    frame('connected', { machineId: 'machine', transport: 'local', localProtocolVersion: 1, eventsProtocol: 1 })
    frame('events_observe_result', { requestId: sent[1].payload.requestId, ok: true, generation: 'generation' })
    await feed.ready
  } else void feed.ready.catch(() => {})
  const event = (type: string, batch?: object, payload: object = {}, generation = 'generation') => frame('session_event', {
    generation, frame: { type, agentId: 'agent', payload }, ...(batch ? { batch } : {}),
  })
  return { feed, socket, sent, receive, unavailable, event, frame, pool }
}

it('uses owner-tool scope without legacy questions and assembles nested original batches in completion order', async () => {
  const f = await fixture()
  expect(f.sent[0]).toMatchObject({ type: 'machine_select', payload: { tool: true, eventsProtocol: 1, questionProtocol: 1 } })
  expect(f.sent[1]).toMatchObject({ type: 'events_observe', payload: { scope: 'all' } })
  f.event('turn_ended', { id: 1, index: 0, count: 2 })
  f.event('text_delta', { id: 2, index: 0, count: 1 }, { content: 'nested' })
  f.event('turn_started', { id: 1, index: 1, count: 2 }, { userMessage: 'next' })
  await vi.waitFor(() => expect(f.receive).toHaveBeenCalledTimes(2))
  expect(f.receive.mock.calls.map(call => call[1].map(frame => frame.type))).toEqual([['text_delta'], ['turn_ended', 'turn_started']])
  f.event('turn_ended', { id: 3, index: 0, count: 1, replay: true })
  f.event('agent_synced', undefined, { agent: { id: 'agent' } })
  await vi.waitFor(() => expect(f.pool.frames).toBe(0))
  expect(f.receive.mock.calls.at(-1)![1][0].type).toBe('agent_synced')
  expect(f.receive).toHaveBeenCalledTimes(3)
})

it.each(['gap', 'wrong-agent', 'count', 'oversized-count'] as const)('fails an incomplete batch with %s without delivering a partial result', async problem => {
  const f = await fixture()
  f.event('turn_ended', { id: 1, index: 0, count: 3 })
  if (problem === 'wrong-agent') f.frame('session_event', { generation: 'generation', frame: { type: 'turn_started', agentId: 'other', payload: {} }, batch: { id: 1, index: 1, count: 3 } })
  else f.event('turn_started', { id: 1, index: problem === 'gap' ? 2 : 1, count: problem === 'count' ? 2 : problem === 'oversized-count' ? 4097 : 3 })
  expect(f.receive).not.toHaveBeenCalled()
  expect(f.unavailable).toHaveBeenCalledOnce()
  expect(f.pool.frames).toBe(0)
  expect(f.socket.close).toHaveBeenCalledOnce()
})

it('keeps actual handler charges after close and refuses late work from its revoked connection', async () => {
  const wait = deferred(), receive = vi.fn(async (_agent: string, _frames: readonly Record<string, unknown>[], current: () => boolean) => {
    await wait.promise
    expect(current()).toBe(false)
  })
  const pool = new DeviceFeedPool(), old = await fixture(pool, receive)
  old.event('text_delta', { id: 1, index: 0, count: 1 }, { content: 'old' })
  await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
  old.event('turn_ended', { id: 2, index: 0, count: 1 })
  const retained = pool.bytes
  vi.useFakeTimers()
  const stopping = old.feed.stop()
  await vi.advanceTimersByTimeAsync(2_000); await stopping
  expect(old.unavailable).toHaveBeenCalledExactlyOnceWith('SESSION_EVENTS_DRAIN_PENDING')
  expect(pool.active).toBe(1); expect(pool.frames).toBe(1)
  expect(pool.bytes).toBeLessThan(retained)
  const fresh = await fixture(pool)
  fresh.event('turn_started', { id: 1, index: 0, count: 1 }, { userMessage: 'new' })
  await vi.advanceTimersByTimeAsync(0)
  expect(fresh.receive).toHaveBeenCalledOnce()
  wait.resolve(); await vi.advanceTimersByTimeAsync(0)
  expect(pool.frames).toBe(0); expect(pool.active).toBe(0)
  expect(receive).toHaveBeenCalledOnce()
})

it('bounds all queued frame references and discards unsent work while retaining the actual handler', async () => {
  const wait = deferred(), f = await fixture(undefined, vi.fn(async () => { await wait.promise }))
  f.event('text_delta', { id: 1, index: 0, count: 1 }, { content: 'first' })
  await vi.waitFor(() => expect(f.receive).toHaveBeenCalledOnce())
  for (let index = 1; index < 4096; index++) f.event('turn_ended', { id: index + 1, index: 0, count: 1 })
  expect(f.pool.frames).toBe(4096)
  f.event('turn_ended', { id: 4097, index: 0, count: 1 })
  expect(f.unavailable).toHaveBeenCalledExactlyOnceWith('SESSION_EVENTS_BACKPRESSURE')
  expect(f.pool.frames).toBe(1)
  wait.resolve()
  await vi.waitFor(() => expect(f.pool.frames).toBe(0))
  expect(f.receive).toHaveBeenCalledOnce()
})

it('ignores foreign generations and times out a missing batch tail visibly', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  f.event('turn_ended', { id: 1, index: 0, count: 1 }, {}, 'stale')
  expect(f.pool.frames).toBe(0)
  f.event('turn_ended', { id: 2, index: 0, count: 2 })
  await vi.advanceTimersByTimeAsync(15_000)
  expect(f.unavailable).toHaveBeenCalledExactlyOnceWith('SESSION_EVENTS_DRAIN_TIMEOUT')
  expect(f.receive).not.toHaveBeenCalled()
  expect(f.pool.frames).toBe(0)
})

it('keeps the oldest batch deadline when a nested batch completes before its enclosing batch', async () => {
  vi.useFakeTimers()
  const wait = deferred(), f = await fixture(undefined, vi.fn(async () => { await wait.promise }))
  f.event('turn_ended', { id: 1, index: 0, count: 2 })
  await vi.advanceTimersByTimeAsync(5_000)
  f.event('text_delta', { id: 2, index: 0, count: 1 })
  await vi.advanceTimersByTimeAsync(1_000)
  f.event('text_delta', { id: 3, index: 0, count: 1 })
  f.event('turn_started', { id: 1, index: 1, count: 2 })
  await vi.advanceTimersByTimeAsync(9_000)
  expect(f.unavailable).toHaveBeenCalledExactlyOnceWith('SESSION_EVENTS_DRAIN_TIMEOUT')
  expect(f.pool.frames).toBe(1)
  wait.resolve(); await vi.advanceTimersByTimeAsync(0)
  expect(f.pool.frames).toBe(0)
})

it('hands a cancel activity its unchanged concrete identity through the real event decoder', async () => {
  const f = await fixture()
  const frame = { type: 'agent_activity', agentId: 'agent', dbSessionId: 'session', payload: {
    cause: 'cancel', activity: { epoch: 'core', revision: 9, state: 'idle', validForMs: 0 },
  } }
  f.frame('session_event', { generation: 'generation', frame })
  await vi.waitFor(() => expect(f.receive).toHaveBeenCalledWith('agent', [frame], expect.any(Function), undefined))
  expect(f.unavailable).not.toHaveBeenCalled()
})

it('drains the preceding normalized batch before releasing a summary barrier on the same observation socket', async () => {
  const waiting = deferred(), f = await fixture(undefined, vi.fn(async () => { await waiting.promise }))
  f.event('turn_ended', { id: 1, index: 0, count: 1 })
  await vi.waitFor(() => expect(f.receive).toHaveBeenCalledOnce())
  let settled = false
  const barrier = (f.feed as any).barrier('agent').then(() => { settled = true })
  const query = f.sent.at(-1)
  expect(query).toMatchObject({ type: 'agent_recent', payload: { agentId: 'agent', n: 1, requestId: expect.any(String) } })
  f.frame('agent_recent_result', { requestId: query.payload.requestId, turns: [{ text: 'not the captured summary' }] })
  await Promise.resolve()
  expect(settled).toBe(false)
  waiting.resolve(); await barrier
  expect(settled).toBe(true)
  expect(f.pool.frames).toBe(0)
})

it('keeps unanswered summary-barrier credit across logical timeout and replacement until physical close', async () => {
  vi.useFakeTimers()
  const pool = new DeviceFeedPool(), old = await fixture(pool)
  old.socket.close = vi.fn()
  const held = Array.from({ length: 4 }, () => (old.feed as any).barrier('agent').catch((error: Error) => error.message))
  await expect((old.feed as any).barrier('agent')).rejects.toThrow('SESSION_EVENTS_BACKPRESSURE')
  await vi.advanceTimersByTimeAsync(15_000)
  expect(await Promise.all(held)).toEqual(Array(4).fill('SESSION_EVENTS_DRAIN_TIMEOUT'))
  const fresh = await fixture(pool)
  await expect((fresh.feed as any).barrier('agent')).rejects.toThrow('SESSION_EVENTS_BACKPRESSURE')
  old.socket.emit('close', 1000)
  const resumed = (fresh.feed as any).barrier('agent')
  fresh.frame('agent_recent_result', { requestId: fresh.sent.at(-1).payload.requestId, turns: [] })
  await resumed
  expect(pool.frames).toBe(0)
})

async function desk(f: Awaited<ReturnType<typeof fixture>>) {
  const ready = f.feed.deskReady(), requestId = f.sent.at(-1).payload.requestId
  f.frame('harness_device_step_result', { requestId, protocol: 1, machineId: 'machine' })
  expect(await ready).toBe(true)
}

it('keeps desk probing separate from events and recovers on the same socket for a new gesture', async () => {
  const f = await fixture()
  expect(f.feed.scroll('down', 0, 0)).toBe(false)
  const first = f.feed.deskReady(), shared = f.feed.deskReady()
  expect(shared).toBe(first)
  expect(f.sent.at(-1)).toEqual({ type: 'harness_device_step', payload: { machineId: 'machine', requestId: expect.any(String), probe: true } })
  f.frame('harness_device_step_result', { requestId: f.sent.at(-1).payload.requestId, error: 'UNSUPPORTED' })
  expect(await first).toBe(false)
  expect(f.feed.scroll('move', 1, 2)).toBe(false)
  f.event('agent_activity')
  await vi.waitFor(() => expect(f.receive).toHaveBeenCalledOnce())
  await desk(f)
  const count = f.sent.length
  expect(await f.feed.deskReady()).toBe(true)
  expect(f.sent).toHaveLength(count)
  for (const phase of ['down', 'move', 'up'] as const) expect(f.feed.scroll(phase, 2, 3)).toBe(true)
  expect(f.sent.slice(-3).map(frame => frame.payload)).toEqual(['down', 'move', 'up'].map(phase => ({ machineId: 'machine', phase, dy: 2, velocity: 3 })))
  expect(f.feed.scroll('move', 4097, 0)).toBe(false)
  expect(f.pool.outgoing.snapshot()).toEqual({ bytes: 0, frames: 0 })
  f.feed.close()
  expect(await f.feed.deskReady()).toBe(false)
  expect(f.feed.scroll('down', 0, 0)).toBe(false)
})

it.each(['wrong-type', 'wrong-machine', 'wrong-version', 'extra'])('refuses exact probe mismatch %s without disabling event observation', async why => {
  const f = await fixture(), ready = f.feed.deskReady(), requestId = f.sent.at(-1).payload.requestId
  f.frame(why === 'wrong-type' ? 'unexpected_result' : 'harness_device_step_result', { requestId,
    protocol: why === 'wrong-version' ? 2 : 1, machineId: why === 'wrong-machine' ? 'other' : 'machine', ...(why === 'extra' ? { extra: true } : {}) })
  expect(await ready).toBe(false); expect(f.unavailable).not.toHaveBeenCalled()
  await desk(f)
})

it('times out an unanswered probe without accepting a stale id for a later probe', async () => {
  vi.useFakeTimers()
  const f = await fixture(), first = f.feed.deskReady(), old = f.sent.at(-1).payload.requestId
  f.frame('harness_device_step_result', { requestId: 'foreign', protocol: 1, machineId: 'machine' })
  await vi.advanceTimersByTimeAsync(5000); expect(await first).toBe(false)
  const next = f.feed.deskReady(), id = f.sent.at(-1).payload.requestId
  expect(id).not.toBe(old)
  f.frame('harness_device_step_result', { requestId: old, protocol: 1, machineId: 'machine' })
  expect(f.feed.scroll('down', 0, 0)).toBe(false)
  f.frame('harness_device_step_result', { requestId: id, protocol: 1, machineId: 'machine' })
  expect(await next).toBe(true)
})

it.each([undefined, -1, NaN, 0.5])('refuses unavailable physical buffer accounting %s before sending', async buffered => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const f = await fixture()
  Object.defineProperty(f.socket, 'bufferedAmount', { value: buffered })
  expect(await f.feed.deskReady()).toBe(false)
  expect(f.sent).toHaveLength(2)
  expect(f.pool.outgoing.snapshot()).toEqual({ bytes: 0, frames: 0 })
  expect(console.warn).toHaveBeenCalledWith('[wifi] DESK_TRANSPORT_UNSUPPORTED')
})

it('refuses socket and shared byte/frame pressure without queueing a stroke', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const f = await fixture(); await desk(f)
  Object.defineProperty(f.socket, 'bufferedAmount', { value: 65536, writable: true })
  expect(f.feed.scroll('down', 0, 0)).toBe(false)
  Object.defineProperty(f.socket, 'bufferedAmount', { value: 0 })
  const releases = Array.from({ length: 256 }, () => f.pool.outgoing.reserve(1)!)
  expect(f.feed.scroll('down', 0, 0)).toBe(false)
  releases.forEach(release => release())
  const bytes = f.pool.outgoing.reserve(65536)!
  expect(f.feed.scroll('down', 0, 0)).toBe(false); bytes()
  expect(f.feed.scroll('up', 0, 0)).toBe(true)
  expect(f.sent.filter(frame => frame.type === 'harness_device_scroll')).toHaveLength(1)
})

it('holds physical writes through logical timeout and replacement, releasing on actual callback or close', async () => {
  vi.useFakeTimers()
  const pool = new DeviceFeedPool(), f = await fixture(pool); await desk(f)
  const callbacks: Array<(error?: Error) => void> = []
  f.socket.send = (text, done) => { f.sent.push(JSON.parse(text)); callbacks.push(done!) }
  f.socket.close = vi.fn()
  expect(f.feed.scroll('down', 1, 2)).toBe(true)
  expect(pool.outgoing.snapshot().frames).toBe(1)
  await vi.advanceTimersByTimeAsync(15000)
  expect(f.unavailable).toHaveBeenCalledExactlyOnceWith('SESSION_EVENTS_DRAIN_TIMEOUT')
  expect(pool.outgoing.snapshot().frames).toBe(1)
  const fresh = await fixture(pool); await desk(fresh)
  expect(pool.outgoing.snapshot().frames).toBe(1)
  callbacks[0](); callbacks[0]()
  expect(pool.outgoing.snapshot()).toEqual({ bytes: 0, frames: 0 })
  fresh.socket.send = (text, done) => { fresh.sent.push(JSON.parse(text)); callbacks.push(done!) }
  fresh.socket.close = vi.fn()
  expect(fresh.feed.scroll('up', 0, 0)).toBe(true)
  fresh.feed.close(); expect(pool.outgoing.snapshot().frames).toBe(1)
  fresh.socket.emit('close', 1000); callbacks[1]()
  expect(pool.outgoing.snapshot()).toEqual({ bytes: 0, frames: 0 })
})

it.each(['throw', 'callback'])('revokes a failed %s write without replay or freeing unclosed transport early', async how => {
  const f = await fixture(); await desk(f)
  f.socket.close = vi.fn()
  f.socket.send = (_text, done) => { if (how === 'throw') throw new Error('private'); done!(new Error('private')) }
  expect(f.feed.scroll('move', 1, 2)).toBe(false)
  expect(f.unavailable).toHaveBeenCalledExactlyOnceWith('DESK_WRITE_UNAVAILABLE')
  expect(f.pool.outgoing.snapshot().frames).toBe(how === 'throw' ? 1 : 0)
  f.socket.emit('close', 1000)
  expect(f.pool.outgoing.snapshot()).toEqual({ bytes: 0, frames: 0 })
})

it('settles a pending probe as unavailable on physical close', async () => {
  const f = await fixture(), ready = f.feed.deskReady()
  f.socket.emit('close', 1000)
  expect(await ready).toBe(false)
})

it.each(['', 'm'.repeat(201)])('refuses an invalid effect-bearing machine identity %#', async machineId => {
  const socket = new EventEmitter() as EventEmitter & ClientSocket, unavailable = vi.fn()
  socket.send = vi.fn(); socket.close = vi.fn(() => socket.emit('close', 1000))
  const feed = observeDeviceSessions({ port: 1, dataDir: '/fixture', machineId }, { pool: new DeviceFeedPool(), receive: vi.fn(async () => {}), unavailable }, () => socket)
  feeds.push(feed); void feed.ready.catch(() => {})
  await Promise.resolve(); socket.emit('open')
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'connected', payload: { machineId, transport: 'local', localProtocolVersion: 1, eventsProtocol: 1 } })), false)
  expect(unavailable).toHaveBeenCalledExactlyOnceWith('SESSION_EVENTS_PROTOCOL')
})

it.each([
  null, {}, { type: 7, payload: {} }, { type: 'session_event', payload: [] },
])('refuses malformed envelope %# without interpreting payloads', async value => {
  const f = await fixture()
  f.socket.emit('message', Buffer.from(JSON.stringify(value)), false)
  expect(f.unavailable).toHaveBeenCalledWith('SESSION_EVENTS_PROTOCOL')
})

it.each(['binary', 'buffer-limit', 'string-limit', 'json', 'socket-error', 'socket-pressure', 'select-error', 'frame-limit'] as const)('reports feed transport failure %s without retaining input', async why => {
  const f = await fixture()
  if (why === 'binary') f.socket.emit('message', Buffer.from('x'), true)
  else if (why === 'buffer-limit') f.socket.emit('message', Buffer.alloc(SESSION_EVENT_BYTES + 1), false)
  else if (why === 'string-limit') f.socket.emit('message', { toString: () => 'x'.repeat(SESSION_EVENT_BYTES + 1) }, false)
  else if (why === 'json') f.socket.emit('message', Buffer.from('{'), false)
  else if (why === 'socket-error') f.socket.emit('error', new Error('private'))
  else if (why === 'socket-pressure') f.socket.emit('close', 1013)
  else f.frame(why === 'select-error' ? 'machine_select_error' : 'frame_too_large', {})
  expect(f.unavailable).toHaveBeenCalledOnce()
  expect(f.pool.frames).toBe(0)
})

it.each([
  {}, { type: 7, payload: {} }, { type: 'agent_activity', payload: [] },
  { type: 'agent_activity', payload: {} }, { type: 'agent_activity', payload: { agentId: '' } },
  { type: 'agent_activity', payload: { agent: [] } }, { type: 'text_delta', agentId: 'agent', payload: {} },
])('refuses unreadable event identity or an unbatched streaming frame %#', async frame => {
  const f = await fixture()
  f.frame('session_event', { generation: 'generation', frame })
  expect(f.unavailable).toHaveBeenCalledWith('SESSION_EVENTS_PROTOCOL')
  expect(f.receive).not.toHaveBeenCalled()
})

it('reads both existing nested agent identity forms and refuses invalid source identity', async () => {
  const f = await fixture()
  f.frame('session_event', { generation: 'generation', frame: { type: 'agent_activity', payload: { agentId: 'agent' } } })
  f.frame('session_event', { generation: 'generation', frame: { type: 'agent_synced', payload: { agent: { id: 'agent' } } } })
  await vi.waitFor(() => expect(f.receive).toHaveBeenCalledTimes(2))
  f.frame('session_event', { generation: 'generation', source: '', frame: { type: 'agent_activity', agentId: 'agent', payload: {} } })
  expect(f.unavailable).toHaveBeenCalledWith('SESSION_EVENTS_PROTOCOL')
})

it('keeps incoming limits independent of outgoing desk capacity and releases each reservation once', async () => {
  const pool = new DeviceFeedPool(), credit = pool.reserve(SESSION_EVENT_BYTES)!
  const f = await fixture(pool); await desk(f)
  expect(f.feed.scroll('up', 0, 0)).toBe(true)
  f.event('agent_activity')
  expect(f.unavailable).toHaveBeenCalledWith('SESSION_EVENTS_BACKPRESSURE')
  expect(pool.bytes).toBe(SESSION_EVENT_BYTES)
  credit(); credit(); expect(pool.bytes).toBe(0)
})

it('refuses a fifth actual handler until a previous connection settles', async () => {
  const pool = new DeviceFeedPool(), waiting = deferred()
  const active = await Promise.all(Array.from({ length: 4 }, () => fixture(pool, vi.fn(async () => { await waiting.promise }))))
  for (const f of active) f.event('agent_activity')
  await vi.waitFor(() => expect(pool.active).toBe(4))
  const excess = await fixture(pool); excess.event('agent_activity')
  expect(excess.unavailable).toHaveBeenCalledWith('SESSION_EVENTS_BACKPRESSURE')
  waiting.resolve(); await vi.waitFor(() => expect(pool.active).toBe(0))
  const fresh = await fixture(pool); fresh.event('agent_activity')
  await vi.waitFor(() => expect(fresh.receive).toHaveBeenCalledOnce())
})

it('reports actual handler rejection while keeping its retained work bounded', async () => {
  const f = await fixture(undefined, vi.fn(async () => { throw new Error('private') }))
  f.event('agent_activity')
  await vi.waitFor(() => expect(f.unavailable).toHaveBeenCalledWith('SESSION_EVENTS_UNAVAILABLE'))
  expect(f.pool.bytes).toBe(0); expect(f.pool.active).toBe(0)
})

it.each(['timeout', 'unsupported', 'bad-observe', 'duplicate-observe'] as const)('refuses observation admission %s without desk readiness', async why => {
  vi.useFakeTimers()
  const f = await fixture(undefined, undefined, false)
  expect(await f.feed.deskReady()).toBe(false)
  await expect(f.feed.barrier('agent')).rejects.toThrow('SESSION_EVENTS_UNAVAILABLE')
  f.frame('session_event', { generation: 'generation', frame: { type: 'agent_activity', agentId: 'agent', payload: {} } })
  if (why === 'timeout') await vi.advanceTimersByTimeAsync(15000)
  else {
    f.frame('connected', { machineId: 'machine', transport: 'local', localProtocolVersion: 1, eventsProtocol: why === 'unsupported' ? 0 : 1 })
    if (why !== 'unsupported') {
      const requestId = f.sent.at(-1).payload.requestId
      f.frame('events_observe_result', { requestId, ok: why !== 'bad-observe', generation: 'generation' })
      if (why === 'duplicate-observe') f.frame('events_observe_result', { requestId, ok: true, generation: 'generation' })
    }
  }
  expect(f.unavailable).toHaveBeenCalledOnce()
  f.socket.emit('open'); f.frame('session_event', {})
  expect(f.feed.scroll('down', 0, 0)).toBe(false)
})

it('ends a late connecting socket and reports connector failure without starting observation', async () => {
  let resolve!: (socket: ClientSocket) => void
  const socket = new EventEmitter() as EventEmitter & ClientSocket
  socket.send = vi.fn(); socket.close = vi.fn()
  const options = { pool: new DeviceFeedPool(), receive: vi.fn(async () => {}), unavailable: vi.fn() }
  const feed = observeDeviceSessions({ port: 1, dataDir: '/fixture', machineId: 'machine' }, options, () => new Promise(done => { resolve = done }))
  feeds.push(feed); void feed.ready.catch(() => {})
  feed.close(); resolve(socket); await Promise.resolve()
  expect(socket.close).toHaveBeenCalledOnce(); expect(socket.send).not.toHaveBeenCalled()
  const failed = observeDeviceSessions({ port: 1, dataDir: '/fixture', machineId: 'machine' }, options, () => { throw new Error('private') })
  feeds.push(failed); await expect(failed.ready).rejects.toThrow('Session observation is unavailable')
  expect(options.unavailable).toHaveBeenCalledWith('SESSION_EVENTS_UNAVAILABLE')
})

it.each(['partial', 'refused'])('refuses a barrier with %s prefix rather than confirming partial events', async why => {
  const f = await fixture()
  if (why === 'partial') f.event('turn_started', { id: 1, index: 0, count: 2 })
  const barrier = f.feed.barrier('agent'), failed = expect(barrier).rejects.toThrow('SESSION_EVENTS_GAP')
  f.frame('agent_recent_result', { requestId: 'unrelated', turns: [] })
  f.frame('agent_recent_result', { requestId: f.sent.at(-1).payload.requestId, ...(why === 'refused' ? { error: 'UNAVAILABLE' } : { turns: [] }) })
  await failed
  expect(f.unavailable).toHaveBeenCalledWith('SESSION_EVENTS_GAP')
  expect(f.pool.bytes).toBe(0)
})

it('keeps a barrier charged until a late actual reply or physical close after logical close', async () => {
  const f = await fixture()
  f.socket.close = vi.fn()
  const barrier = f.feed.barrier('agent'), failed = expect(barrier).rejects.toThrow('SESSION_EVENTS_CLOSED'), id = f.sent.at(-1).payload.requestId
  f.feed.close(); await failed
  f.frame('session_event', { generation: 'generation' })
  expect(f.pool.barriers).toBe(1)
  f.frame('agent_recent_result', { requestId: id, turns: [] })
  expect(f.pool.barriers).toBe(0); f.socket.emit('close', 1000)
  expect(f.pool.bytes).toBe(0)
})

it('refuses unavailable, byte-limited or failed barrier sends without borrowing outgoing desk credit', async () => {
  const f = await fixture()
  await expect(f.feed.barrier('')).rejects.toThrow('SESSION_EVENTS_UNAVAILABLE')
  const credit = f.pool.reserve(SESSION_EVENT_BYTES)!
  await expect(f.feed.barrier('agent')).rejects.toThrow('SESSION_EVENTS_BACKPRESSURE'); credit()
  f.socket.send = () => { throw new Error('private') }
  await expect(f.feed.barrier('agent')).rejects.toThrow('SESSION_EVENTS_UNAVAILABLE')
  expect(f.pool.barriers).toBe(0)
})

it('settles a failed synchronous probe once even if transport failure also revokes its feed', async () => {
  const f = await fixture()
  f.socket.send = (_text, done) => { done!(new Error('private')) }
  expect(await f.feed.deskReady()).toBe(false)
  expect(f.unavailable).toHaveBeenCalledExactlyOnceWith('DESK_WRITE_UNAVAILABLE')
})
