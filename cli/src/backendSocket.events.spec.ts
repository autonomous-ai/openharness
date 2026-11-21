import { afterEach, expect, it, vi } from 'vitest'
import { BackendSocket, type Frame, type LocalSendQuota } from './backendSocket.js'
import { dispatchDown } from './testing/relaySocket.js'

afterEach(() => vi.restoreAllMocks())

function client(socket: BackendSocket, id: string, tool: boolean, capable = true) {
  const frames: any[] = [], close = vi.fn(), settlements: Array<(sent: boolean) => void> = []
  socket.registerLocalClient(id, { sendFrame(frame: Frame, _quota?: LocalSendQuota, settled?: (sent: boolean) => void) {
    frames.push(frame); if (settled) settlements.push(settled); return true
  }, sendBinary: () => true, close }, { tool, ...(capable ? { eventsProtocol: 1 } : {}) } as never)
  return { frames, close, settlements }
}
const observe = (socket: BackendSocket, id: string, scope: unknown, requestId = 'observe') => dispatchDown(socket,
  { type: 'events_observe', payload: { requestId, scope } }, id)
const send = (socket: BackendSocket, frame: Frame, batch?: { id: number; index: number; count: number }) =>
  (socket.send as (frame: Frame, batch?: object) => void)(frame, batch)

it('converges negotiated Desktop and explicit tool events without creating foreground or question interest', async () => {
  const socket = new BackendSocket('machine')
  const tool = client(socket, 'local:tool', true)
  await observe(socket, 'local:tool', 'all')
  expect(tool.frames.at(-1)).toMatchObject({ type: 'events_observe_result', payload: { ok: true, generation: expect.any(String) } })
  expect(socket.hasLocalClient()).toBe(false)
  expect(socket.hasCommander()).toBe(false)
  expect(socket.questionsObserved('a')).toBe(false)
  const legacy = client(socket, 'local:legacy', false, false), desktop = client(socket, 'local:desktop', false)
  const frame = { type: 'text_delta', agentId: 'a', payload: { content: 'answer' } }, batch = { id: 1, index: 0, count: 1 }
  send(socket, frame, batch)
  expect(legacy.frames).toEqual([frame])
  for (const target of [tool, desktop]) expect(target.frames.at(-1)).toEqual({ type: 'session_event',
    payload: { generation: expect.any(String), frame, batch } })
  socket.send({ type: 'unrelated', payload: { private: 'not an event subscription' } })
  expect(tool.frames.at(-1).type).toBe('session_event')
  expect(desktop.frames.at(-1).type).toBe('unrelated')
  for (const id of ['tool', 'legacy', 'desktop']) await socket.unregisterLocalClient(`local:${id}`)
})

it('shares question and event admission without one scope releasing the other', async () => {
  const socket = new BackendSocket('machine')
  socket.questionSnapshot = function* () {}
  const clients = Array.from({ length: 65 }, (_, index) => client(socket, `local:${index}`, true))
  for (let index = 0; index < 64; index++) await observe(socket, `local:${index}`, 'all')
  await dispatchDown(socket, { type: 'questions_observe', payload: { requestId: 'q', scope: 'all' } }, 'local:0')
  await dispatchDown(socket, { type: 'questions_observe', payload: { requestId: 'off', scope: 'none' } }, 'local:0')
  expect(socket.questionsObserved('a')).toBe(false)
  await observe(socket, 'local:64', 'all')
  expect(clients[64].frames.at(-1)).toMatchObject({ payload: { error: 'TOO_MANY' } })
  await observe(socket, 'local:0', { agentIds: [] })
  await observe(socket, 'local:64', 'all')
  expect(clients[64].frames.at(-1)).toMatchObject({ payload: { ok: true } })
  for (let index = 0; index < 65; index++) await socket.unregisterLocalClient(`local:${index}`)
})

it('keeps the current named scope on malformed replacement and includes binding/deletion announcements', async () => {
  const socket = new BackendSocket('machine'), observed = client(socket, 'local:tool', true)
  await observe(socket, 'local:tool', { agentIds: ['a'] })
  const generation = observed.frames.at(-1).payload.generation
  await observe(socket, 'local:tool', { agentIds: Array(9).fill('a') })
  expect(observed.frames.at(-1)).toMatchObject({ payload: { error: 'TOO_MANY' } })
  const a = { type: 'agent_synced', payload: { agent: { id: 'a', sessionId: 's' } } }
  socket.send(a); socket.send({ type: 'agent_deleted', agentId: 'b', payload: { agentId: 'b' } })
  const end = { type: 'agent_deleted', agentId: 'a', payload: { agentId: 'a' } }
  socket.send(end)
  expect(observed.frames.filter(frame => frame.type === 'session_event')).toEqual([
    { type: 'session_event', payload: { generation, frame: a } },
    { type: 'session_event', payload: { generation, frame: end } },
  ])
  await socket.unregisterLocalClient('local:tool')
})

it('does not let old send settlement revoke a replacement scope or replacement connection', async () => {
  const socket = new BackendSocket('machine'), old = client(socket, 'local:tool', true)
  await observe(socket, 'local:tool', 'all')
  send(socket, { type: 'text_delta', agentId: 'a', payload: { content: 'old' } }, { id: 1, index: 0, count: 1 })
  expect(old.settlements).toHaveLength(1)
  await observe(socket, 'local:tool', { agentIds: ['b'] })
  old.settlements[0](false)
  expect(old.close).not.toHaveBeenCalled()
  await socket.unregisterLocalClient('local:tool')
  const fresh = client(socket, 'local:tool', true)
  await observe(socket, 'local:tool', 'all')
  old.settlements[0](false)
  expect(fresh.close).not.toHaveBeenCalled()
  send(socket, { type: 'turn_ended', agentId: 'a', payload: {} }, { id: 2, index: 0, count: 1 })
  expect(fresh.frames.at(-1).type).toBe('session_event')
  await socket.unregisterLocalClient('local:tool')
})

it('publishes the existing cancel activity to the same negotiated Desktop and tool event scope', async () => {
  const socket = new BackendSocket('machine'), tool = client(socket, 'local:tool', true), desktop = client(socket, 'local:desktop', false)
  await observe(socket, 'local:tool', 'all')
  const frame = { type: 'agent_activity', agentId: 'a', dbSessionId: 's', payload: {
    cause: 'cancel', activity: { epoch: 'boot', revision: 7, state: 'idle', validForMs: 0 },
  } }
  socket.send(frame)
  for (const target of [tool, desktop]) expect(target.frames.at(-1)).toMatchObject({ type: 'session_event', payload: { frame } })
  await socket.unregisterLocalClient('local:tool'); await socket.unregisterLocalClient('local:desktop')
})

it('keeps trusted card provenance outside the unchanged frame and ignores spoofed public provenance', async () => {
  const socket = new BackendSocket('machine'), tool = client(socket, 'local:tool', true)
  await observe(socket, 'local:tool', 'all')
  const frame = { type: 'commander_event', agentId: 'a', source: 'recaps', payload: { kind: 'error', text: 'core error', source: 'recaps' } }
  await dispatchDown(socket, frame, 'local:tool')
  expect(tool.frames.some(frame => frame.type === 'session_event')).toBe(false)
  socket.sendCommander(frame)
  expect(tool.frames.at(-1)).toMatchObject({ type: 'session_event', payload: { source: 'core', frame } })
  ;(socket.sendCommander as (frame: Frame, source?: string) => void)(frame, 'recaps')
  expect(tool.frames.at(-1)).toMatchObject({ type: 'session_event', payload: { source: 'recaps', frame } })
  expect(tool.frames.filter(frame => frame.type === 'session_event')).toHaveLength(2)
  await socket.unregisterLocalClient('local:tool')
})
