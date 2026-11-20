import { afterEach, expect, it, vi } from 'vitest'
import { createEngineStorage } from './storage.js'
import { STORAGE_CAPABILITIES } from '../../engines/worker/storageProtocol.js'

const method = 'engine_storage_user_row_since'
const session = { sessionId: 'agent:main:plain', openclawStateDir: '/profile', pid: 42 }
const reply = (answer: unknown) => ({ version: 1, answer })
function setup(answer?: unknown) {
  if (arguments.length === 0) answer = true
  const call = vi.fn(async (_service: string, name: string, _body: Record<string, unknown>) => name === STORAGE_CAPABILITIES
    ? { version: 1, engine: 'openclaw', storage: 1 } : reply(answer))
  const inlineUserRowSince = vi.fn(async () => false)
  const storage = createEngineStorage({ call, isolated: true, inlineUserRowSince })
  storage.connected('engine-others')
  return { storage, call, inlineUserRowSince }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it.each([true, false, null])('returns only the captured user-row observation %s', async value => {
  const t = setup(value)
  expect(await t.storage.userRowSince(session, 12, 34)).toBe(value)
  expect(t.call).toHaveBeenLastCalledWith('engine-others', method,
    { version: 1, engine: 'openclaw', session, since: 12, until: 34 }, expect.any(Number))
  expect(t.inlineUserRowSince).not.toHaveBeenCalled()
})

it('keeps malformed, disconnected and replaced replies unknown without inline fallback', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const answer of [0, 1, 'true', {}, undefined]) expect(await setup(answer).storage.userRowSince(session, 0)).toBeNull()
  const t = setup()
  t.call.mockResolvedValue({ error: 'SERVICE_UNAVAILABLE' } as never)
  t.storage.disconnected('engine-others')
  expect(await t.storage.userRowSince(session, 0)).toBeNull()
  expect(t.inlineUserRowSince).not.toHaveBeenCalled()
  const replaced = setup()
  let finish!: (value: ReturnType<typeof reply>) => void
  const started = new Promise<void>(resolve => replaced.call.mockImplementation(async (_service, name) => {
    if (name === STORAGE_CAPABILITIES) return { version: 1, engine: 'openclaw', storage: 1 }
    resolve(); return new Promise(done => { finish = done })
  }))
  const pending = replaced.storage.userRowSince(session, 0)
  await started
  replaced.storage.disconnected('engine-others'); replaced.storage.connected('engine-others')
  finish(reply(false))
  expect(await pending).toBeNull()
})

it('bounds remote waits and refuses invalid snapshots before dispatch', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {})
  const t = setup()
  for (const [since, until] of [[-1, 2], [2, 1], [NaN, 3], [0, Infinity], [0.5, 2]]) {
    expect(await t.storage.userRowSince(session, since, until)).toBeNull()
  }
  expect(await t.storage.userRowSince({ ...session, sessionId: '' }, 0)).toBeNull()
  expect(t.call).not.toHaveBeenCalled()
  t.call.mockImplementation(() => new Promise(() => {}))
  const pending = t.storage.userRowSince(session, 0)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await pending).toBeNull()
})

it('shares inline admission with background reads until actual timed-out work settles', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {})
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const inline = vi.fn(async () => 0), call = vi.fn()
  const storage = createEngineStorage({ call, isolated: false, inline,
    inlineUserRowSince: async () => { await held; return false } })
  const pending = Array.from({ length: 4 }, () => storage.userRowSince(session, 0))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await Promise.all(pending)).toEqual([null, null, null, null])
  expect(await storage.background({ engine: 'hermes', sessionId: 'held', agentId: 'a', processIdentity: null })).toBeNull()
  expect(inline).not.toHaveBeenCalled()
  release(); await vi.advanceTimersByTimeAsync(0)
  expect(await storage.background({ engine: 'hermes', sessionId: 'held', agentId: 'a', processIdentity: null })).toBe(0)
  expect(await storage.userRowSince(session, 0)).toBe(false)
  expect(await createEngineStorage({ call, isolated: false }).userRowSince(session, 0)).toBeNull()
  expect(call).not.toHaveBeenCalled()
})

it('refuses a malformed explicit inline answer', async () => {
  const storage = createEngineStorage({ call: vi.fn(), isolated: false, inlineUserRowSince: async () => 0 as never })
  expect(await storage.userRowSince(session, 0)).toBeNull()
})
