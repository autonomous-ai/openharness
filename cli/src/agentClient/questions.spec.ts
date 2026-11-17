import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { observeQuestions } from './questions.js'
import type { ClientSocket } from './daemon.js'

afterEach(() => vi.useRealTimers())

function fixture() {
  const socket = new EventEmitter() as EventEmitter & ClientSocket
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  socket.send = text => { sent.push(JSON.parse(text)) }
  socket.close = vi.fn(() => socket.emit('close', 1000))
  const listener = { begin: vi.fn(), question: vi.fn(), end: vi.fn(), unavailable: vi.fn() }
  const client = observeQuestions({ port: 1, dataDir: '/fixture', machineId: 'machine' }, listener, () => socket)
  const frame = (type: string, payload: Record<string, unknown>) => socket.emit('message', { toString: () => JSON.stringify({ type, payload }) }, false)
  return { socket, sent, listener, client, frame }
}

it('selects a real tool, ignores legacy unsolicited replay and is ready only after its complete generation', async () => {
  const f = fixture()
  await Promise.resolve()
  f.socket.emit('open')
  expect(f.sent[0]).toMatchObject({ type: 'machine_select', payload: { tool: true, machineId: 'machine' } })
  f.frame('connected', { questionProtocol: 1 })
  f.frame('commander_question', { requestId: 'old' })
  const requestId = f.sent[1].payload.requestId
  expect(f.sent[1]).toMatchObject({ type: 'questions_observe', payload: { scope: 'all' } })
  f.frame('questions_observe_result', { requestId, ok: true, generation: 'g' })
  f.frame('questions_begin', { generation: 'g' })
  const question = { type: 'commander_question', agentId: 'a', payload: { requestId: 'q' } }
  f.frame('questions_row', { generation: 'other', question })
  f.frame('questions_row', { generation: 'g', question })
  expect(f.listener.begin).toHaveBeenCalledExactlyOnceWith('g')
  expect(f.listener.question).toHaveBeenCalledExactlyOnceWith('g', question)
  const ready = vi.fn(); void f.client.ready.then(ready)
  await Promise.resolve(); expect(ready).not.toHaveBeenCalled()
  f.frame('questions_end', { generation: 'g' })
  await f.client.ready
  expect(f.listener.end).toHaveBeenCalledExactlyOnceWith('g')
  f.client.close()
})

it('fails an incomplete snapshot visibly and does not let late frames reconcile it', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const failure = expect(f.client.ready).rejects.toMatchObject({ code: 'QUESTION_OBSERVATION_TIMEOUT' })
  await Promise.resolve(); f.socket.emit('open'); f.frame('connected', { questionProtocol: 1 })
  f.frame('questions_observe_result', { requestId: f.sent[1].payload.requestId, ok: true, generation: 'g' })
  f.frame('questions_begin', { generation: 'g' })
  await vi.advanceTimersByTimeAsync(20_000)
  await failure
  f.frame('questions_end', { generation: 'g' })
  expect(f.listener.end).not.toHaveBeenCalled()
  expect(f.listener.unavailable).toHaveBeenCalledExactlyOnceWith('QUESTION_OBSERVATION_TIMEOUT')
  expect(f.socket.close).toHaveBeenCalledOnce()
})

it('closes a connection that completes dialing after cancellation', async () => {
  let connected!: (socket: ClientSocket) => void
  const pending = new Promise<ClientSocket>(resolve => { connected = resolve })
  const client = observeQuestions({ port: 1, dataDir: '/fixture', machineId: 'machine' },
    { begin: vi.fn(), question: vi.fn(), end: vi.fn(), unavailable: vi.fn() }, () => pending)
  const failure = expect(client.ready).rejects.toMatchObject({ code: 'QUESTION_OBSERVATION_CLOSED' })
  client.close()
  const close = vi.fn()
  connected({ close } as unknown as ClientSocket)
  await failure; await Promise.resolve()
  expect(close).toHaveBeenCalledOnce()
})

it('refuses an old daemon before pretending it negotiated bounded question replay', async () => {
  const f = fixture()
  const failed = expect(f.client.ready).rejects.toMatchObject({ code: 'QUESTION_OBSERVATION_UNSUPPORTED' })
  await Promise.resolve(); f.socket.emit('open'); f.frame('connected', {})
  await failed
  expect(f.sent).toHaveLength(1)
  expect(f.listener.begin).not.toHaveBeenCalled()
})

it.each([null, [], 1, { type: 'connected', payload: null }, { type: 'connected', payload: [] },
  { type: 'connected', payload: 1 }, { type: 'connected', payload: 'text' }, { payload: {} }].map(frame => [frame]))('fails malformed JSON shape once without throwing (%j)', async frame => {
  const f = fixture()
  const failed = f.client.ready.catch(error => error)
  await Promise.resolve()
  let thrown: unknown
  try { f.socket.emit('message', { toString: () => JSON.stringify(frame) }, false) } catch (error) { thrown = error }
  if (!f.listener.unavailable.mock.calls.length) f.client.close()
  const error = await failed
  expect(thrown).toBeUndefined()
  expect(error).toMatchObject({ code: 'QUESTION_OBSERVATION_PROTOCOL' })
  expect(f.listener.unavailable).toHaveBeenCalledExactlyOnceWith('QUESTION_OBSERVATION_PROTOCOL')
  f.socket.emit('message', { toString: () => 'null' }, false)
  expect(f.listener.unavailable).toHaveBeenCalledOnce()
})
