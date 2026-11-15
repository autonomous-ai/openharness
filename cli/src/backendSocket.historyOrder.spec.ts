import { afterEach, expect, it, vi } from 'vitest'
import { BackendSocket } from './backendSocket.js'
import { ServiceUnavailableError } from './core/serviceHost.js'

const sockets: BackendSocket[] = []
afterEach(async () => { await Promise.all(sockets.splice(0).map(socket => socket.stop())); vi.useRealTimers(); vi.restoreAllMocks() })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  const socket = new BackendSocket('fixture'), frames: Record<string, any>[] = []
  sockets.push(socket)
  socket.registerLocalClient('local:history', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
  const send = (type: string, payload: Record<string, unknown>) => socket.handleLocalFrame('local:history', { type, payload })
  return { socket, frames, send }
}

it('a held history read cannot delay ordered input and Stop on the same connection', async () => {
  const { socket, frames, send } = fixture(), read = deferred<Record<string, unknown>>()
  const trace: string[] = []
  socket.historyProvider = vi.fn(() => read.promise)
  socket.messageProvider = payload => { trace.push(String(payload.content)) }
  socket.cancelProvider = () => { trace.push('cancel') }
  send('session_get', { requestId: 'history', sessionId: 'one' })
  send('message', { agentId: 'two', content: 'first' })
  send('cancel', { sessionId: 'two' })
  send('message', { agentId: 'two', content: 'second' })
  try {
    await vi.waitFor(() => expect(trace).toEqual(['first', 'cancel', 'second']))
    expect(frames).toEqual([])
  } finally { read.resolve({ id: 'one', events: [] }) }
  await vi.waitFor(() => expect(frames).toEqual([{ type: 'session_get_result', payload: { requestId: 'history', id: 'one', events: [] } }]))
})

it('a history read still starts after the earlier mutation in its connection', async () => {
  const { socket, send } = fixture(), mutation = deferred<void>(), entered = deferred<void>(), read = deferred<Record<string, unknown>>()
  socket.restartProvider = async () => { entered.resolve(); await mutation.promise }
  socket.historyProvider = vi.fn(() => read.promise)
  const message = vi.fn(); socket.messageProvider = message
  send('agent_restart', { agentId: 'one' })
  send('session_get', { requestId: 'history', sessionId: 'one' })
  send('message', { agentId: 'two', content: 'go' })
  await entered.promise
  expect(socket.historyProvider).not.toHaveBeenCalled()
  mutation.resolve()
  try { await vi.waitFor(() => expect(message).toHaveBeenCalledOnce()) }
  finally { read.resolve({ events: [] }) }
  expect(socket.historyProvider).toHaveBeenCalledOnce()
})

it.each([
  { failure: new Error('private-history-fixture'), synchronous: false },
  { failure: new Error('private-history-fixture'), synchronous: true },
  { failure: new ServiceUnavailableError('engine-others'), synchronous: false },
])('answers a rejected history without logging private error content ($synchronous)', async ({ failure, synchronous }) => {
  const { socket, frames, send } = fixture(), log = vi.spyOn(console, 'error').mockImplementation(() => {})
  socket.historyProvider = synchronous ? () => { throw failure } : async () => { throw failure }
  send('session_get', { requestId: 'failed', sessionId: 'one' })
  await vi.waitFor(() => expect(frames).toHaveLength(1))
  expect(frames[0]).toEqual({ type: 'session_get_result', payload: { requestId: 'failed',
    ...(failure instanceof ServiceUnavailableError ? { error: 'SERVICE_UNAVAILABLE', service: 'engine-others', retryable: true } : { error: 'INTERNAL' }),
  } })
  expect(log.mock.calls.flat().map(value => value instanceof Error ? value.message : String(value)).join(' '))
    .not.toContain('private-history-fixture')
  expect(log).toHaveBeenCalledWith('[backend] HISTORY_READ_FAILED')
})

it('reports a failed history reply without an unhandled promise rejection', async () => {
  const { socket, send } = fixture(), log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await socket.unregisterLocalClient('local:history')
  socket.registerLocalClient('local:history', {
    sendFrame: () => { throw new Error('private-reply-fixture') }, sendBinary: () => true,
  })
  socket.historyProvider = async () => ({ events: [] })
  send('session_get', { requestId: 'failed-reply', sessionId: 'one' })
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith('[backend] HISTORY_REPLY_FAILED'))
  expect(log.mock.calls).toEqual([['[backend] HISTORY_REPLY_FAILED']])
})

it('drops a history reply when its original connection has gone', async () => {
  const { socket, frames, send } = fixture(), read = deferred<Record<string, unknown>>()
  socket.historyProvider = vi.fn(() => read.promise)
  send('session_get', { requestId: 'gone', sessionId: 'one' })
  await vi.waitFor(() => expect(socket.historyProvider).toHaveBeenCalledOnce())
  await socket.unregisterLocalClient('local:history')
  socket.registerLocalClient('local:another', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
  read.resolve({ events: [] })
  await read.promise
  await Promise.resolve()
  expect(frames).toEqual([])
})

it('keeps input moving for ten clients with history reads outstanding', async () => {
  const socket = new BackendSocket('fixture'), read = deferred<Record<string, unknown>>()
  sockets.push(socket)
  socket.historyProvider = () => read.promise
  const delivered = new Set<string>()
  socket.messageProvider = payload => { delivered.add(String(payload.agentId)) }
  for (let i = 0; i < 10; i++) {
    const connection = `local:parallel-${i}`
    socket.registerLocalClient(connection, { sendFrame: () => true, sendBinary: () => true })
    socket.handleLocalFrame(connection, { type: 'session_get', payload: { sessionId: `history-${i}` } })
    socket.handleLocalFrame(connection, { type: 'message', payload: { agentId: `agent-${i}`, content: 'go' } })
  }
  try { await vi.waitFor(() => expect(delivered.size).toBe(10)) }
  finally { read.resolve({ events: [] }) }
})

it('bounds preparation and inline reads before entering any provider, while later input proceeds', async () => {
  const { socket, frames, send } = fixture(), read = deferred<Record<string, unknown>>()
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  socket.historyProvider = vi.fn(() => read.promise)
  socket.messageProvider = vi.fn()
  for (let i = 0; i < 17; i++) send('session_get', { requestId: `bounded-${i}`, sessionId: 'one' })
  send('message', { agentId: 'two', content: 'still works' })
  try {
    await vi.waitFor(() => expect(socket.messageProvider).toHaveBeenCalledOnce())
    expect(socket.historyProvider).toHaveBeenCalledTimes(16)
    expect(frames).toEqual([{ type: 'session_get_result', payload: { requestId: 'bounded-16', error: 'ENGINE_BUSY', retryable: true } }])
    expect(log).toHaveBeenCalledWith('[backend] HISTORY_READ_BUSY')
  } finally { read.resolve({ events: [] }) }
  await vi.waitFor(() => expect(frames).toHaveLength(17))
  send('session_get', { requestId: 'admitted-again', sessionId: 'one' })
  await vi.waitFor(() => expect(frames.at(-1)?.payload).toEqual({ requestId: 'admitted-again', events: [] }))
})

it.each(['resolved', 'rejected'])('expires the reply without freeing stuck work or sending a late %s reply', async outcome => {
  vi.useFakeTimers()
  const { socket, frames, send } = fixture(), read = deferred<Record<string, unknown>>()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  socket.historyProvider = vi.fn(() => read.promise)
  for (let i = 0; i < 16; i++) send('session_get', { requestId: `timeout-${i}`, sessionId: 'one' })
  await vi.advanceTimersByTimeAsync(0)
  expect(socket.historyProvider).toHaveBeenCalledTimes(16)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(frames).toHaveLength(16)
  expect(frames.every(frame => frame.payload.error === 'ENGINE_UNAVAILABLE' && frame.payload.retryable === true)).toBe(true)
  expect(log).toHaveBeenCalledWith('[backend] HISTORY_READ_TIMEOUT')
  send('session_get', { requestId: 'still-occupied', sessionId: 'one' })
  await vi.advanceTimersByTimeAsync(0)
  expect(socket.historyProvider).toHaveBeenCalledTimes(16)
  expect(frames.at(-1)?.payload).toEqual({ requestId: 'still-occupied', error: 'ENGINE_BUSY', retryable: true })
  if (outcome === 'resolved') read.resolve({ events: ['late'] })
  else read.reject(new Error('private-late-failure-fixture'))
  await vi.advanceTimersByTimeAsync(0)
  expect(frames).toHaveLength(17)
  socket.historyProvider = async () => ({ events: ['next'] })
  send('session_get', { requestId: 'recovered', sessionId: 'one' })
  await vi.advanceTimersByTimeAsync(0)
  expect(frames.at(-1)?.payload).toEqual({ requestId: 'recovered', events: ['next'] })
  expect(log.mock.calls.flat().map(String).join(' ')).not.toContain('private-late-failure-fixture')
  expect(vi.getTimerCount()).toBe(0)
})

it('retains admission after disconnect and releases it when a failed provider settles', async () => {
  const { socket, send } = fixture(), read = deferred<Record<string, unknown>>()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  socket.historyProvider = vi.fn(() => read.promise)
  for (let i = 0; i < 16; i++) send('session_get', { requestId: `gone-${i}`, sessionId: 'one' })
  await vi.waitFor(() => expect(socket.historyProvider).toHaveBeenCalledTimes(16))
  await socket.unregisterLocalClient('local:history')
  const frames: Record<string, any>[] = []
  socket.registerLocalClient('local:next', { sendFrame: frame => { frames.push(frame); return true }, sendBinary: () => true })
  const next = (requestId: string) => socket.handleLocalFrame('local:next', { type: 'session_get', payload: { requestId, sessionId: 'one' } })
  next('still-busy')
  await vi.waitFor(() => expect(frames.at(-1)?.payload).toEqual({ requestId: 'still-busy', error: 'ENGINE_BUSY', retryable: true }))
  read.reject(new Error('private-failure-fixture'))
  await read.promise.catch(() => {})
  await Promise.resolve()
  socket.historyProvider = async () => ({ events: [] })
  next('recovered')
  await vi.waitFor(() => expect(frames.at(-1)?.payload).toEqual({ requestId: 'recovered', events: [] }))
  expect(frames).toHaveLength(2)
})

it('keeps an overflowing reply-sink failure content-free too', async () => {
  const { socket, send } = fixture(), read = deferred<Record<string, unknown>>()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await socket.unregisterLocalClient('local:history')
  socket.registerLocalClient('local:history', {
    sendFrame: frame => {
      if ((frame.payload as Record<string, unknown>).error === 'ENGINE_BUSY') throw new Error('private-busy-reply-fixture')
      return true
    }, sendBinary: () => true,
  })
  socket.historyProvider = () => read.promise
  for (let i = 0; i < 17; i++) send('session_get', { requestId: `reply-${i}`, sessionId: 'one' })
  try {
    await vi.waitFor(() => expect(log).toHaveBeenCalled())
    expect(log.mock.calls).toEqual([['[backend] HISTORY_REPLY_FAILED']])
  } finally { read.resolve({ events: [] }) }
})
