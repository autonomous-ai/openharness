import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ runCommandRaw: vi.fn() }))

vi.mock('../../config/env.js', () => ({ env: { DATABASE_URL: 'mongodb://test' } }))
vi.mock('../prisma.js', () => ({ prisma: { $runCommandRaw: db.runCommandRaw } }))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { dropLegacyUniqueIndex, migrateUserPresencePerMachine } from './migrate.js'

function listIndexes(indexes: Array<{ name: string; key: Record<string, number>; unique?: boolean }>): void {
  db.runCommandRaw.mockImplementation(async (cmd: Record<string, unknown>) => {
    if ('listIndexes' in cmd) return { cursor: { firstBatch: indexes } }
    return { ok: 1 }
  })
}

function droppedIndexes(): string[] {
  return db.runCommandRaw.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((cmd) => 'dropIndexes' in cmd)
    .map((cmd) => cmd.index as string)
}

describe('dropLegacyUniqueIndex', () => {
  beforeEach(() => { db.runCommandRaw.mockReset() })

  it('drops exactly the unique index whose key is the given field set', async () => {
    listIndexes([
      { name: '_id_', key: { _id: 1 } },
      { name: 'userId_1_dayUtc_1', key: { userId: 1, dayUtc: 1 }, unique: true },
    ])
    await dropLegacyUniqueIndex('user_daily_presence', ['userId', 'dayUtc'])
    expect(droppedIndexes()).toEqual(['userId_1_dayUtc_1'])
    expect(db.runCommandRaw).toHaveBeenCalledWith({ dropIndexes: 'user_daily_presence', index: 'userId_1_dayUtc_1' })
  })

  it('leaves the compound replacement and the non-unique twin alone', async () => {
    listIndexes([
      { name: 'userId_1_machineId_1_dayUtc_1', key: { userId: 1, machineId: 1, dayUtc: 1 }, unique: true },
      { name: 'userId_1_dayUtc_1', key: { userId: 1, dayUtc: 1 } },
    ])
    await dropLegacyUniqueIndex('user_daily_presence', ['userId', 'dayUtc'])
    expect(droppedIndexes()).toEqual([])
  })

  it('does not match a unique index with only some of the fields', async () => {
    listIndexes([{ name: 'userId_1', key: { userId: 1 }, unique: true }])
    await dropLegacyUniqueIndex('user_daily_presence', ['userId', 'dayUtc'])
    expect(droppedIndexes()).toEqual([])
  })

  it('still finds a single-field legacy index (the pre-existing call sites)', async () => {
    listIndexes([{ name: 'name_1', key: { name: 1 }, unique: true }])
    await dropLegacyUniqueIndex('subscription_plans', ['name'])
    expect(droppedIndexes()).toEqual(['name_1'])
  })

  it('swallows listIndexes failures (cold database) and never throws', async () => {
    db.runCommandRaw.mockRejectedValue(new Error('ns not found'))
    await expect(dropLegacyUniqueIndex('user_daily_presence', ['userId', 'dayUtc'])).resolves.toBeUndefined()
  })
})

describe('migrateUserPresencePerMachine', () => {
  beforeEach(() => { db.runCommandRaw.mockReset() })

  it('drops the old (user, day) unique on user_daily_presence and is a no-op once it is gone', async () => {
    listIndexes([{ name: 'user_daily_presence_userId_dayUtc_key', key: { userId: 1, dayUtc: 1 }, unique: true }])
    await migrateUserPresencePerMachine()
    expect(droppedIndexes()).toEqual(['user_daily_presence_userId_dayUtc_key'])

    db.runCommandRaw.mockClear()
    listIndexes([{ name: 'user_daily_presence_userId_machineId_dayUtc_key', key: { userId: 1, machineId: 1, dayUtc: 1 }, unique: true }])
    await migrateUserPresencePerMachine()
    expect(droppedIndexes()).toEqual([])
  })
})
