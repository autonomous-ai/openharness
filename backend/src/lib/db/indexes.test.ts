import { describe, expect, it, vi } from 'vitest'
import { ensureIndex } from './indexes.js'
import { logger } from '../../utils/logger.js'

const SPEC = { key: { updatedAt: 1 }, name: 'read_mark_expiry', expireAfterSeconds: 15_552_000 }

/** A database whose index exists without expiry (as db push builds it), and whose collMod answers `collMod`. */
function db(collMod: () => unknown) {
  const calls: Record<string, unknown>[] = []
  const run = vi.fn(async (command: Record<string, unknown>) => {
    calls.push(command)
    if ('listIndexes' in command) return { cursor: { firstBatch: [{ key: { updatedAt: 1 }, name: 'read_mark_expiry' }] } }
    if ('collMod' in command) return collMod()
    return {}
  })
  return { db: { $runCommandRaw: run } as never, calls }
}

describe('ensureIndex', () => {
  it('sets a missing expiry with collMod and builds nothing', async () => {
    const { db: fake, calls } = db(() => ({ ok: 1 }))
    await ensureIndex(fake, 'SuperTabReadMark', SPEC)
    expect(calls.map(call => Object.keys(call)[0])).toEqual(['listIndexes', 'collMod'])
  })

  it('warns and carries on when the database user may not run collMod (10-29: the worker crash-looped)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const { db: fake, calls } = db(() => {
      throw new Error('Raw query failed. Code: `13`. Message: `not authorized on harness to execute command { collMod: "SuperTabReadMark" }`')
    })
    await expect(ensureIndex(fake, 'SuperTabReadMark', SPEC)).resolves.toBeUndefined()
    expect(calls.map(call => Object.keys(call)[0])).toEqual(['listIndexes', 'collMod'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('collMod'), expect.objectContaining({ collection: 'SuperTabReadMark', index: 'read_mark_expiry' }))
    warn.mockRestore()
  })

  it('still fails on any other collMod error', async () => {
    const { db: fake } = db(() => { throw new Error('Raw query failed. Code: `27`. Message: `index not found`') })
    await expect(ensureIndex(fake, 'SuperTabReadMark', SPEC)).rejects.toThrow('index not found')
  })
})
