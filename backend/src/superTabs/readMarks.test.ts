import { describe, expect, it, vi } from 'vitest'
import { ensureReadMarkExpiry } from './readMarks.js'
import { logger } from '../utils/logger.js'

const REFUSED = 'Raw query failed. Code: `13`. Message: `not authorized on harness to execute command { collMod: "SuperTabReadMark" }`'

/** A database whose read_mark_expiry index has [expireAfterSeconds] (none: as db push builds it), and whose collMod answers
 *  `collMod`; it records every command. */
function database(options: { expireAfterSeconds?: number; collMod?: () => unknown } = {}) {
  const commands: Record<string, unknown>[] = []
  const db = { $runCommandRaw: vi.fn(async (command: Record<string, unknown>) => {
    commands.push(command)
    if ('listIndexes' in command) return { cursor: { firstBatch: [{ key: { updatedAt: 1 }, name: 'read_mark_expiry', expireAfterSeconds: options.expireAfterSeconds }] } }
    if ('collMod' in command) return (options.collMod ?? (() => ({ ok: 1 })))()
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
