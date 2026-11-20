import { afterEach, expect, it, vi } from 'vitest'
import { otherStorageRequests } from './storageRequests.js'
import { STORAGE_BACKGROUND } from '../worker/storageProtocol.js'

const method = 'engine_storage_user_row_since', core = { owner: true, local: true }
const payload = { version: 1, engine: 'openclaw', session: { sessionId: 'agent:main:plain', pid: 0 }, since: 0, until: 42 }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it.each([true, false, null])('serves a bounded nullable Boolean %s only to core', async answer => {
  const userRowSince = vi.fn(async () => answer), requests = otherStorageRequests({ userRowSince })
  expect(await requests[method](payload, core)).toEqual({ version: 1, answer })
  expect(userRowSince).toHaveBeenCalledExactlyOnceWith(payload.session, 0, 42)
  for (const asker of [{ owner: false, local: true }, { owner: true, local: false }, { ...core, connection: 'client' }]) {
    expect(await requests[method](payload, asker)).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
  }
  expect(userRowSince).toHaveBeenCalledOnce()
})

it('refuses SQL, unknown fields, malformed session or time bounds and non-Boolean replies', async () => {
  const userRowSince = vi.fn(async () => false), requests = otherStorageRequests({ userRowSince })
  for (const patch of [{ sql: 'SELECT 1' }, { engine: 'hermes' }, { version: 2 }, { since: -1 }, { since: 43 },
    { since: 0.5 }, { until: Infinity }, { until: undefined }, { session: { sessionId: '' } }, { requestId: 1 }]) {
    expect(await requests[method]({ ...payload, ...patch }, core)).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
  }
  expect(userRowSince).not.toHaveBeenCalled()
  userRowSince.mockResolvedValueOnce(0 as never)
  expect(await requests[method](payload, core)).toMatchObject({ error: 'ENGINE_INVALID_REPLY' })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  userRowSince.mockRejectedValueOnce(new Error('private path'))
  expect(await requests[method](payload, core)).toMatchObject({ error: 'ENGINE_UNAVAILABLE' })
  expect(console.error).toHaveBeenCalledWith('[engine-others] STORAGE_READ_UNAVAILABLE · Error')
})

it.each(['timeout', 'abort'] as const)('retains aggregate slots after %s until actual work settles', async how => {
  vi.useFakeTimers()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const recycle = vi.fn(), background = vi.fn(async () => 0)
  const requests = otherStorageRequests({ userRowSince: async () => { await held; return true }, background, recycle })
  const controller = new AbortController()
  const pending = Array.from({ length: 4 }, () => requests[method](payload, core, controller.signal))
  await vi.advanceTimersByTimeAsync(0)
  if (how === 'abort') controller.abort()
  else await vi.advanceTimersByTimeAsync(5_000)
  expect((await Promise.all(pending)).every(value => value.error === 'ENGINE_UNAVAILABLE')).toBe(true)
  expect(recycle).toHaveBeenCalledTimes(how === 'timeout' ? 4 : 0)
  expect(await requests[STORAGE_BACKGROUND]({ version: 1, engine: 'hermes', session: { sessionId: 'held' } }, core))
    .toMatchObject({ error: 'ENGINE_BUSY' })
  expect(background).not.toHaveBeenCalled()
  release(); await vi.advanceTimersByTimeAsync(0)
  expect(await requests[method](payload, core)).toEqual({ version: 1, answer: true })
  const before = controller.signal.aborted ? controller : new AbortController()
  before.abort()
  expect(await requests[method](payload, core, before.signal)).toMatchObject({ error: 'ENGINE_UNAVAILABLE' })
})
