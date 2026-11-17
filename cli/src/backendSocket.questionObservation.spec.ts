import { afterEach, expect, it, vi } from 'vitest'
import { BackendSocket } from './backendSocket.js'
import { dispatchDown } from './testing/relaySocket.js'

afterEach(() => vi.restoreAllMocks())

function client(socket: BackendSocket, id: string, tool = false, questionProtocol?: 1) {
  const frames: Record<string, unknown>[] = []
  socket.registerLocalClient(id, { sendFrame: (frame, _quota, settled) => {
    frames.push(frame); settled?.(true); return true
  }, sendBinary: () => true, close: vi.fn() }, { tool, questionProtocol })
  return frames
}

it('uses the actual window and remote app lifetimes for all-agent question interest', async () => {
  const socket = new BackendSocket('machine')
  expect(socket.questionsObserved('unfocused')).toBe(false)
  client(socket, 'local:window')
  expect(socket.questionsObserved('unfocused')).toBe(true)
  await socket.unregisterLocalClient('local:window')
  expect(socket.questionsObserved('unfocused')).toBe(false)
  socket.fromGateway.client('phone', { identity: 'owner', role: 'web', label: 'Phone', direct: false })
  expect(socket.questionsObserved('unfocused')).toBe(true)
  socket.fromGateway.client('phone', null)
  expect(socket.questionsObserved('unfocused')).toBe(false)
  socket.fromGateway.client('device', { identity: 'device', role: 'device', label: 'Device', direct: false })
  expect(socket.questionsObserved('unfocused')).toBe(false)
})

it('lets an actual tool observe all questions without window, dial or commander authority', async () => {
  const socket = new BackendSocket('machine')
  const frames = client(socket, 'local:observer', true)
  socket.questionSnapshot = function* () { yield { type: 'commander_question', agentId: 'unfocused', payload: { requestId: 'q' } } }
  await dispatchDown(socket, { type: 'questions_observe', payload: { requestId: 'observe', scope: 'all' } }, 'local:observer')
  expect(frames).toContainEqual({ type: 'questions_observe_result', payload: { requestId: 'observe', ok: true, generation: expect.any(String) } })
  expect(socket.questionsObserved('unfocused')).toBe(true)
  expect(socket.hasLocalClient()).toBe(false)
  expect(socket.hasCommander()).toBe(false)
  expect(socket.hasRemoteApp()).toBe(false)
  await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ type: 'questions_end' })))
  expect(frames).toContainEqual(expect.objectContaining({ type: 'questions_row', payload: expect.objectContaining({ question: expect.objectContaining({ agentId: 'unfocused' }) }) }))
  await socket.unregisterLocalClient('local:observer')
  expect(socket.questionsObserved('unfocused')).toBe(false)
})

it('shares the existing 64 explicit-tool admission slots and preserves named metadata watches', async () => {
  const socket = new BackendSocket('machine')
  socket.questionSnapshot = function* () {}
  const clients = Array.from({ length: 65 }, (_, i) => client(socket, `local:${i}`, true))
  for (let i = 0; i < 64; i++) await dispatchDown(socket, { type: 'agents_watch', payload: { requestId: `watch${i}`, agentIds: ['named'] } }, `local:${i}`)
  await dispatchDown(socket, { type: 'questions_observe', payload: { requestId: 'full', scope: 'all' } }, 'local:64')
  expect(clients[64].at(-1)).toMatchObject({ payload: { requestId: 'full', error: 'TOO_MANY' } })
  await dispatchDown(socket, { type: 'questions_observe', payload: { requestId: 'same', scope: 'all' } }, 'local:0')
  expect(clients[0]).toContainEqual(expect.objectContaining({ type: 'questions_observe_result', payload: expect.objectContaining({ ok: true }) }))
  await dispatchDown(socket, { type: 'agents_watch', payload: { requestId: 'clear', agentIds: [] } }, 'local:0')
  await dispatchDown(socket, { type: 'agents_watch', payload: { requestId: 'still-full', agentIds: ['named'] } }, 'local:64')
  expect(clients[64].at(-1)).toMatchObject({ payload: { error: 'TOO_MANY' } })
  await dispatchDown(socket, { type: 'questions_observe', payload: { requestId: 'off', scope: 'none' } }, 'local:0')
  await dispatchDown(socket, { type: 'agents_watch', payload: { requestId: 'now', agentIds: ['other'] } }, 'local:64')
  expect(clients[64].at(-1)).toMatchObject({ payload: { ok: true } })
  for (let i = 0; i < 65; i++) await socket.unregisterLocalClient(`local:${i}`)
})

it('keeps an existing scope on malformed replacement and sends live content only to explicit content observers', async () => {
  const socket = new BackendSocket('machine')
  socket.questionSnapshot = function* () {}
  const observed = client(socket, 'local:observed', true), metadata = client(socket, 'local:metadata', true)
  await dispatchDown(socket, { type: 'agents_watch', payload: { requestId: 'watch', agentIds: ['a'] } }, 'local:metadata')
  await dispatchDown(socket, { type: 'questions_observe', payload: { requestId: 'on', scope: ['a'] } }, 'local:observed')
  await dispatchDown(socket, { type: 'questions_observe', payload: { requestId: 'bad', scope: Array(9).fill(0).map((_, i) => `a${i}`) } }, 'local:observed')
  expect(observed.at(-1)).toMatchObject({ payload: { error: 'TOO_MANY' } })
  expect(socket.questionsObserved('a')).toBe(true)
  expect(socket.questionsObserved('b')).toBe(false)
  const question = { type: 'commander_question', agentId: 'a', payload: { requestId: 'q', questions: [{ q: 'Private words' }] } }
  socket.sendLocal(question)
  expect(observed).toContainEqual(expect.objectContaining({ type: 'questions_row', payload: expect.objectContaining({ question }) }))
  expect(metadata.at(-1)).toEqual({ type: 'commander_question', agentId: 'a', payload: { agentId: 'a', requestId: 'q' } })
  await socket.unregisterLocalClient('local:observed'); await socket.unregisterLocalClient('local:metadata')
})

it('gives an opted-in window one bounded path and real named/none scope while legacy windows keep all questions', async () => {
  const socket = new BackendSocket('machine')
  socket.questionSnapshot = function* () {}
  const frames = client(socket, 'local:window', false, 1)
  expect(socket.hasLocalClient()).toBe(true)
  expect(socket.questionsObserved('b')).toBe(false)
  await dispatchDown(socket, { type: 'questions_observe', payload: { requestId: 'named', scope: ['a'] } }, 'local:window')
  expect(socket.questionsObserved('a')).toBe(true)
  expect(socket.questionsObserved('b')).toBe(false)
  const a = { type: 'commander_question', agentId: 'a', payload: { requestId: 'qa' } }
  const b = { type: 'commander_question', agentId: 'b', payload: { requestId: 'qb' } }
  socket.sendLocal(a); socket.sendLocal(b)
  expect(frames.filter(frame => frame.type === 'questions_row')).toEqual([
    { type: 'questions_row', payload: { generation: expect.any(String), question: a } },
  ])
  expect(frames.some(frame => frame.type === 'commander_question')).toBe(false)
  await dispatchDown(socket, { type: 'questions_observe', payload: { requestId: 'none', scope: 'none' } }, 'local:window')
  await dispatchDown(socket, { type: 'questions_observe', payload: { requestId: 'none-again', scope: 'none' } }, 'local:window')
  socket.sendLocal(a)
  expect(frames.filter(frame => frame.type === 'questions_row')).toHaveLength(1)
  expect(socket.questionsObserved('a')).toBe(false)
  const legacy = client(socket, 'local:legacy')
  expect(socket.questionsObserved('b')).toBe(true)
  socket.sendLocal(b)
  expect(legacy).toEqual([b])
  await socket.unregisterLocalClient('local:legacy')
  expect(socket.questionsObserved('b')).toBe(false)
  await socket.unregisterLocalClient('local:window')
})

it('keeps a metadata watch and its admission when the same tool stops content observation', async () => {
  const socket = new BackendSocket('machine')
  socket.questionSnapshot = function* () {}
  client(socket, 'local:tool', true)
  await dispatchDown(socket, { type: 'agents_watch', payload: { requestId: 'metadata', agentIds: ['a'] } }, 'local:tool')
  await dispatchDown(socket, { type: 'questions_observe', payload: { requestId: 'content', scope: 'all' } }, 'local:tool')
  await dispatchDown(socket, { type: 'questions_observe', payload: { requestId: 'off', scope: 'none' } }, 'local:tool')
  expect(socket.questionsObserved('a')).toBe(true)
  expect(socket.questionsObserved('b')).toBe(false)
  await socket.unregisterLocalClient('local:tool')
})

it('does not let an old snapshot callback remove a same-ID successor or leak a legacy count', async () => {
  const socket = new BackendSocket('machine'), callbacks: Array<(sent: boolean) => void> = [], close = vi.fn()
  socket.questionSnapshot = function* () {}
  const sink = { sendFrame: (_frame: Record<string, unknown>, _quota: unknown, settled?: (sent: boolean) => void) => {
    if (settled) callbacks.push(settled); return true
  }, sendBinary: () => true, close }
  expect(socket.registerLocalClient('local:window', sink)).toBe(true)
  expect(socket.registerLocalClient('local:window', sink)).toBe(false)
  await dispatchDown(socket, { type: 'questions_observe', payload: { requestId: 'old', scope: ['a'] } }, 'local:window')
  await socket.unregisterLocalClient('local:window')
  client(socket, 'local:window')
  callbacks[0](false)
  expect(close).not.toHaveBeenCalled()
  expect(socket.questionsObserved('anything')).toBe(true)
  await socket.unregisterLocalClient('local:window')
  expect(socket.questionsObserved('anything')).toBe(false)
})
