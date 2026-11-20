import { afterEach, expect, it, vi } from 'vitest'
import { otherStorageRequests } from './storageRequests.js'
import { STORAGE_COMPARE, STORAGE_COMPARE_BYTES, STORAGE_BACKGROUND, STORAGE_BACKGROUND_WAIT_MS, STORAGE_CAPABILITIES, STORAGE_LIFETIME, STORAGE_EXPORT, STORAGE_EXPORT_WAIT_MS, storageSession } from '../worker/storageProtocol.js'

const core = { owner: true, local: true }
const payload = { version: 1, engine: 'hermes', session: { sessionId: '20261112_100000_bbbbbb', hermesHome: '/profile' } }
afterEach(() => { vi.useRealTimers() })
it('serves the authenticated core only, with bounded plain input and output', async () => {
  const background = vi.fn(async () => 3), requests = otherStorageRequests({ background })
  expect(await requests[STORAGE_CAPABILITIES]({ version: 1, engine: 'hermes' }, core)).toEqual({ version: 1, engine: 'hermes', storage: 1, storageCompare: 1 })
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

it('shares admission and retains timed-out export slots until their actual work settles', async () => {
  vi.useFakeTimers()
  const release: Array<(result: { bytes: number; sha256: string }) => void> = []
  const requests = otherStorageRequests({ export: () => new Promise(resolve => { release.push(resolve) }), background: async () => 0, recycle: vi.fn() })
  const lifetime = (await requests[STORAGE_LIFETIME]({ version: 1, engine: 'hermes' }, core)).answer
  const ask = { ...payload, lifetime, source: { path: '/private/db', key: '2:3', database: '/private/db' }, stage: { path: '/private/stage', key: '1:2' } }
  const operations = Array.from({ length: 4 }, () => requests[STORAGE_EXPORT](ask, core))
  await vi.advanceTimersByTimeAsync(0)
  expect(release).toHaveLength(4)
  expect(await requests[STORAGE_BACKGROUND](payload, core)).toMatchObject({ error: 'ENGINE_BUSY' })
  await vi.advanceTimersByTimeAsync(STORAGE_EXPORT_WAIT_MS)
  expect(await Promise.all(operations)).toEqual(Array.from({ length: 4 }, () => ({ version: 1, error: 'ENGINE_UNAVAILABLE' })))
  expect(await requests[STORAGE_EXPORT](ask, core)).toMatchObject({ error: 'ENGINE_BUSY' })
  for (const done of release) done({ bytes: 1, sha256: 'a'.repeat(64) })
  await vi.advanceTimersByTimeAsync(0)
  expect(await requests[STORAGE_BACKGROUND](payload, core)).toEqual({ version: 1, answer: 0 })
})

const comparison = { ...payload, source: { path: '/db', key: '2:3', database: '/db' }, checkpoint: { path: '/saved', key: '4:5', bytes: 17 } }
it('compares only bounded core-selected files for the local owner', async () => {
  const compare = vi.fn(async () => true), requests = otherStorageRequests({ compare })
  expect(await requests[STORAGE_COMPARE](comparison, core)).toEqual({ version: 1, answer: true })
  for (const asker of [{ ...core, owner: false }, { ...core, local: false }, { ...core, connection: 'client' }]) {
    expect(await requests[STORAGE_COMPARE](comparison, asker)).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
  }
  for (const extra of [{ sql: 'SELECT *' }, { stage: { path: '/output', key: '1:2' } }, { engine: 'claude' },
    { checkpoint: { ...comparison.checkpoint, bytes: STORAGE_COMPARE_BYTES + 1 } },
    { checkpoint: { ...comparison.checkpoint, extra: true } }, { source: { ...comparison.source, sql: 'x' } }]) {
    expect(await requests[STORAGE_COMPARE]({ ...comparison, ...extra }, core)).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
  }
  expect(compare).toHaveBeenCalledOnce()
})

it('returns a bounded unavailable comparison without recycling a healthy worker', async () => {
  const recycle = vi.fn(), requests = otherStorageRequests({ compare: async () => null, recycle })
  expect(await requests[STORAGE_COMPARE](comparison, core)).toEqual({ version: 1, answer: null })
  expect(recycle).not.toHaveBeenCalled()
  expect(await otherStorageRequests({ compare: async () => ({ rows: 'private' }) as never })[STORAGE_COMPARE](comparison, core))
    .toMatchObject({ error: 'ENGINE_INVALID_REPLY' })
})

it('retains aborted comparisons in shared worker admission until the reads actually settle', async () => {
  vi.useFakeTimers()
  const release: Array<(answer: boolean) => void> = [], recycle = vi.fn()
  const requests = otherStorageRequests({ compare: () => new Promise(resolve => { release.push(resolve) }), background: async () => 0, recycle })
  const closed = new AbortController()
  const work = Array.from({ length: 4 }, () => requests[STORAGE_COMPARE](comparison, core, closed.signal))
  await vi.advanceTimersByTimeAsync(0)
  expect(await requests[STORAGE_BACKGROUND](payload, core)).toMatchObject({ error: 'ENGINE_BUSY' })
  closed.abort()
  expect(await Promise.all(work)).toEqual(Array.from({ length: 4 }, () => ({ version: 1, error: 'ENGINE_UNAVAILABLE' })))
  expect(await requests[STORAGE_BACKGROUND](payload, core)).toMatchObject({ error: 'ENGINE_BUSY' })
  release.forEach(done => done(true)); await vi.advanceTimersByTimeAsync(0)
  expect(await requests[STORAGE_BACKGROUND](payload, core)).toEqual({ version: 1, answer: 0 })
  expect(recycle).not.toHaveBeenCalled()
})
