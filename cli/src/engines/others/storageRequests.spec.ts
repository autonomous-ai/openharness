import { afterEach, expect, it, vi } from 'vitest'
import { otherStorageRequests } from './storageRequests.js'
import { STORAGE_BACKGROUND, STORAGE_BACKGROUND_WAIT_MS, STORAGE_CAPABILITIES, storageSession } from '../worker/storageProtocol.js'

const core = { owner: true, local: true }
const payload = { version: 1, engine: 'hermes', session: { sessionId: '20261112_100000_bbbbbb', hermesHome: '/profile' } }
afterEach(() => { vi.useRealTimers() })
it('serves the authenticated core only, with bounded plain input and output', async () => {
  const background = vi.fn(async () => 3), requests = otherStorageRequests({ background })
  expect(await requests[STORAGE_CAPABILITIES]({ version: 1, engine: 'hermes' }, core)).toEqual({ version: 1, engine: 'hermes', storage: 1 })
  expect(await requests[STORAGE_BACKGROUND](payload, core)).toEqual({ version: 1, answer: 3 })
  expect(background).toHaveBeenCalledWith(payload.session)
  for (const asker of [{ owner: false, local: true }, { owner: true, local: false }, { ...core, connection: 'client' }]) {
    expect(await requests[STORAGE_BACKGROUND](payload, asker)).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
  }
  for (const bad of [{ ...payload, engine: 'codex' }, { ...payload, sql: 'DELETE' }, { ...payload, session: { sessionId: '' } }]) {
    expect(await requests[STORAGE_BACKGROUND](bad, core)).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
  }
  background.mockResolvedValueOnce(1_025)
  expect(await requests[STORAGE_BACKGROUND](payload, core)).toMatchObject({ error: 'ENGINE_INVALID_REPLY' })
})
it('answers unavailable for a frozen read and recycles only that worker', async () => {
  vi.useFakeTimers()
  const recycle = vi.fn(), requests = otherStorageRequests({ background: () => new Promise(() => {}), recycle })
  const pending = requests[STORAGE_BACKGROUND](payload, core)
  await vi.advanceTimersByTimeAsync(STORAGE_BACKGROUND_WAIT_MS)
  expect(await pending).toMatchObject({ error: 'ENGINE_UNAVAILABLE' })
  expect(recycle).toHaveBeenCalledOnce()
})
it('rejects malformed and overlong identity fields', () => {
  for (const value of [null, [], 3, {}, { sessionId: '\0' }, { sessionId: 'x'.repeat(1_025) },
    { sessionId: 'x', hermesHome: 3 }, { sessionId: 'x', hermesHome: '\0' }, { sessionId: 'x', hermesHome: 'x'.repeat(32_769) },
    { sessionId: 'x', extra: true }]) expect(storageSession(value)).toBe(false)
  for (const hermesHome of [undefined, null, '/profile']) expect(storageSession({ sessionId: 'x', hermesHome })).toBe(true)
})
