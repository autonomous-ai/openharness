import { getEventListeners } from 'node:events'
import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollectionDropReport } from './dropCollections.js'
import { dropLegacyUntilDone, RETRY_MS, sleeper } from './dropLegacyJob.js'

const passes = vi.fn<() => Promise<CollectionDropReport>>()
vi.mock('./dropCollections.js', () => ({ dropRemovedCollections: () => passes() }))
const db = {} as PrismaClient
const dropped = (done: boolean): CollectionDropReport => ({ collections: done ? [{ collection: 'SwarmProgress', rows: 2, dropped: true }] : [],
  failed: done ? [] : ['SwarmProgress'], done })

describe('the job that drops the removed collections', () => {
  afterEach(() => passes.mockReset())

  it('tries again an hour after a pass that threw or left one, logs counts and names only, and stops once done', async () => {
    passes.mockRejectedValueOnce(new Error('connection reset')).mockResolvedValueOnce(dropped(false)).mockResolvedValueOnce(dropped(true))
    const waits: number[] = [], lines: Array<Record<string, unknown>> = []
    const report = await dropLegacyUntilDone(db, { wait: async ms => { waits.push(ms) }, log: line => lines.push(line) })
    expect(report?.done).toBe(true)
    expect(waits).toEqual([RETRY_MS, RETRY_MS])
    expect(lines).toEqual([{ failed: 'connection reset' }, { removedCollections: [], collectionsFailed: ['SwarmProgress'] },
      { removedCollections: [{ collection: 'SwarmProgress', rows: 2, dropped: true }], collectionsFailed: [] }])
  })

  it('logs nothing when nothing is left, and stops between tries when asked', async () => {
    passes.mockResolvedValueOnce({ collections: [], failed: [], done: true })
    const lines: unknown[] = []
    expect(await dropLegacyUntilDone(db, { log: line => lines.push(line) })).toEqual({ collections: [], failed: [], done: true })
    expect(lines).toEqual([])
    const control = new AbortController()
    passes.mockResolvedValue(dropped(false))
    await dropLegacyUntilDone(db, { signal: control.signal, wait: async () => control.abort() })
    expect(passes).toHaveBeenCalledTimes(2)
  })
})

describe('the pause between writes', () => {
  afterEach(() => vi.useRealTimers())

  it('leaves no stop listener behind once its time is up, so a long backlog does not pile them up', async () => {
    vi.useFakeTimers()
    const control = new AbortController()
    const wait = sleeper(control.signal)

    for (let i = 0; i < 5; i++) {
      const done = wait(500)
      expect(getEventListeners(control.signal, 'abort')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(500)
      await done
    }

    expect(getEventListeners(control.signal, 'abort')).toHaveLength(0)
  })

  it('ends at once when stopped, and removes its listener', async () => {
    vi.useFakeTimers()
    const control = new AbortController()
    const done = sleeper(control.signal)(3_600_000)

    control.abort()
    await done

    expect(getEventListeners(control.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
