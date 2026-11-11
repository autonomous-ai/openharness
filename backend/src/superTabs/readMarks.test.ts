import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureReadMarkExpiry, READ_MARK_EXPIRY_MS, READ_MARK_SWEEP, startReadMarkSweep } from './readMarks.js'
import { logger } from '../utils/logger.js'

const REFUSED = 'Raw query failed. Code: `13`. Message: `not authorized on harness to execute command { collMod: "SuperTabReadMark" }`'

/** A database whose read_mark_expiry index has [expireAfterSeconds] (none: as db push builds it), and whose collMod answers
 *  `collMod`; it records every command. */
function database(options: { expireAfterSeconds?: number; collMod?: () => unknown; found?: string[] } = {}) {
  const commands: Record<string, unknown>[] = []
  const db = { $runCommandRaw: vi.fn(async (command: Record<string, unknown>) => {
    commands.push(command)
    if ('listIndexes' in command) return { cursor: { firstBatch: [{ key: { updatedAt: 1 }, name: 'read_mark_expiry', expireAfterSeconds: options.expireAfterSeconds }] } }
    if ('collMod' in command) return (options.collMod ?? (() => ({ ok: 1 })))()
    if ('find' in command) return { cursor: { firstBatch: (options.found ?? []).map(_id => ({ _id })) } }
    if ('delete' in command) return { n: (options.found ?? []).length }
    return { cursor: { firstBatch: [] } }
  }) }
  return { db: db as never, commands }
}

describe('ensureReadMarkExpiry', () => {
  it('answers that the expiry is set when the index has it already', async () => {
    await expect(ensureReadMarkExpiry(database({ expireAfterSeconds: 15_552_000 }).db)).resolves.toBe(true)
  })

  it('answers that the expiry is set when collMod sets it', async () => {
    await expect(ensureReadMarkExpiry(database().db)).resolves.toBe(true)
  })

  it('answers that it is not when the database user may not run collMod (production, Ken\'s prod scan 11-04)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    try {
      await expect(ensureReadMarkExpiry(database({ collMod: () => { throw new Error(REFUSED) } }).db)).resolves.toBe(false)
    } finally { warn.mockRestore() }
  })
})

describe('startReadMarkSweep', () => {
  afterEach(() => { vi.useRealTimers() })
  const now = new Date('2026-11-04T06:00:00Z')
  const cutoff = { updatedAt: { $lt: { $date: new Date(now.getTime() - READ_MARK_EXPIRY_MS).toISOString() } } }
  const quiet = () => ({ info: vi.fn(), warn: vi.fn() })

  it('runs nothing where the expiry is set: no command, no timer', async () => {
    vi.useFakeTimers()
    const { db, commands } = database({ found: ['old'] })
    const stop = startReadMarkSweep(db, true, { now: () => now, log: quiet() })
    await vi.advanceTimersByTimeAsync(10 * READ_MARK_SWEEP.everyMs)
    expect(commands).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })

  it('where the expiry was refused, removes one chunk of marks past 180 days at once, by the expiry index', async () => {
    vi.useFakeTimers()
    const { db, commands } = database({ found: ['a', 'b'] })
    const log = quiet()
    const stop = startReadMarkSweep(db, false, { now: () => now, log })
    await vi.advanceTimersByTimeAsync(0)
    stop()
    expect(commands).toEqual([
      { find: 'SuperTabReadMark', filter: cutoff, projection: { _id: 1 }, sort: { updatedAt: 1 }, hint: 'read_mark_expiry', limit: 500, batchSize: 500,
        singleBatch: true },
      { delete: 'SuperTabReadMark', deletes: [{ q: { _id: { $in: ['a', 'b'] }, ...cutoff }, limit: 0, hint: { _id: 1 } }] },
    ])
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('[read-marks]'))
    expect(log.info).toHaveBeenCalledWith('[read-marks] pass', { removed: 2, removedSinceStart: 2 })
  })

  it('takes one bounded chunk every 30 s and never stops by itself: marks keep ageing', async () => {
    vi.useFakeTimers()
    const { db, commands } = database()
    const stop = startReadMarkSweep(db, false, { now: () => now, log: quiet(), chunk: 3 })
    await vi.advanceTimersByTimeAsync(3 * 30_000)
    stop()
    const finds = commands.filter(command => 'find' in command)
    // One at start, then one each 30 s; an empty pass is that one find and no delete.
    expect(finds).toHaveLength(4)
    expect(finds.every(command => command.limit === 3)).toBe(true)
    expect(commands.filter(command => 'delete' in command)).toEqual([])
  })
})
