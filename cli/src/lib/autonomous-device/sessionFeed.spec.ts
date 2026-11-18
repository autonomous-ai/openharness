import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { ClientSocket } from '../../agentClient/daemon.js'
import { DeviceFeedPool, observeDeviceSessions, type DeviceSessionFeed } from './sessionFeed.js'

const feeds: DeviceSessionFeed[] = []
afterEach(() => { for (const feed of feeds.splice(0)) feed.close(); vi.useRealTimers() })
function deferred() {
  let resolve!: () => void
  return { promise: new Promise<void>(done => { resolve = done }), resolve: () => resolve() }
}
async function fixture(pool = new DeviceFeedPool(), receive = vi.fn(async (_agent: string, _frames: readonly Record<string, unknown>[], _current: () => boolean) => {})) {
  const socket = new EventEmitter() as EventEmitter & ClientSocket, sent: any[] = [], unavailable = vi.fn()
  socket.send = text => sent.push(JSON.parse(text))
  socket.close = vi.fn(() => socket.emit('close', 1000))
  const feed = observeDeviceSessions({ port: 1, dataDir: '/fixture', machineId: 'machine' }, { pool, receive, unavailable }, () => socket)
  feeds.push(feed)
  const frame = (type: string, payload: object) => socket.emit('message', Buffer.from(JSON.stringify({ type, payload })), false)
  await Promise.resolve(); socket.emit('open')
  frame('connected', { eventsProtocol: 1 })
  frame('events_observe_result', { requestId: sent[1].payload.requestId, ok: true, generation: 'generation' })
  await feed.ready
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
