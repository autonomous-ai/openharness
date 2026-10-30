import type { PrismaClient } from '@prisma/client'

/** The operations MongoDB served on the collections `collections` matches while `run` ran (its profiler, every operation). */
export async function profiledReads<T>(db: PrismaClient, collections: RegExp, run: () => Promise<T>): Promise<{ value: T; reads: number }> {
  await db.$runCommandRaw({ profile: 2 })
  const since = new Date()
  try {
    const value = await run()
    const rows = await db.$runCommandRaw({ find: 'system.profile', filter: { ts: { $gte: { $date: since.toISOString() } },
      ns: { $regex: collections.source } } }) as { cursor: { firstBatch: unknown[] } }
    return { value, reads: rows.cursor.firstBatch.length }
  } finally {
    await db.$runCommandRaw({ profile: 0 })
  }
}
