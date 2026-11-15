import { afterEach, expect, it, vi } from 'vitest'
import { createEngineStorage } from './storage.js'
import { STORAGE_BACKGROUND, STORAGE_BACKGROUND_WAIT_MS, STORAGE_CAPABILITIES } from '../../engines/worker/storageProtocol.js'

const session = { engine: 'hermes', agentId: 'a', sessionId: '20261112_100000_bbbbbb', hermesHome: '/profile', processIdentity: null } as const
function setup(answer: unknown = 3) {
  const call = vi.fn(async (_service: string, method: string, _payload: Record<string, unknown>) => method === STORAGE_CAPABILITIES
    ? { version: 1, engine: 'hermes', storage: 1 } : { version: 1, answer })
  const inline = vi.fn(async () => 2)
  const storage = createEngineStorage({ call, isolated: true, inline })
  storage.connected('engine-others')
  return { storage, call, inline }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('sends only captured Hermes identity and returns the worker count', async () => {
  const t = setup()
  expect(await t.storage.background(session)).toBe(3)
  expect(t.call).toHaveBeenLastCalledWith('engine-others', STORAGE_BACKGROUND,
    { version: 1, engine: 'hermes', session: { sessionId: session.sessionId, hermesHome: '/profile' } }, expect.any(Number))
  expect(t.inline).not.toHaveBeenCalled()
  expect(await t.storage.background({ ...session, engine: 'codex' })).toBeNull()
  expect(await t.storage.background({ ...session, sessionId: '' })).toBeNull()
})

it('keeps missing, malformed and disconnected answers unknown without falling back', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await setup(null).storage.background(session)).toBeNull()
  for (const answer of [-1, 1.5, 1_025, '3', {}]) expect(await setup(answer).storage.background(session)).toBeNull()
  const t = setup()
  t.storage.disconnected('engine-others')
  t.call.mockResolvedValue({ error: 'SERVICE_UNAVAILABLE' } as never)
  expect(await t.storage.background(session)).toBeNull()
  expect(t.inline).not.toHaveBeenCalled()
  expect(log.mock.calls.every(([line]) => line === '[engine-others] STORAGE_BACKGROUND_UNAVAILABLE')).toBe(true)
})

it('bounds a frozen worker and an explicit inline reader', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const t = setup()
  t.call.mockImplementation(() => new Promise(() => {}))
  const remote = t.storage.background(session)
  await vi.advanceTimersByTimeAsync(STORAGE_BACKGROUND_WAIT_MS)
  expect(await remote).toBeNull()
  const inline = createEngineStorage({ call: t.call, isolated: false, inline: () => new Promise(() => {}) })
  const local = inline.background(session)
  await vi.advanceTimersByTimeAsync(STORAGE_BACKGROUND_WAIT_MS)
  expect(await local).toBeNull()
})

it('uses only explicit compatibility composition, including an absent reader', async () => {
  const call = vi.fn()
  expect(await createEngineStorage({ call, isolated: false, inline: async () => 2 }).background(session)).toBe(2)
  expect(await createEngineStorage({ call, isolated: false }).background(session)).toBeNull()
  expect(call).not.toHaveBeenCalled()
})
