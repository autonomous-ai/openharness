import { afterEach, expect, it, vi } from 'vitest'
import { BackendSocket } from './backendSocket.js'
import { ServiceUnavailableError } from './core/serviceHost.js'

const sockets: BackendSocket[] = []
afterEach(async () => { await Promise.all(sockets.splice(0).map(socket => socket.stop())); vi.restoreAllMocks() })
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
