import type { PrismaClient } from '@prisma/client'

/** The operations MongoDB served on the collections `collections` matches while `run` ran (its profiler, every operation).
 *  Only each row's collection is read back: a light read's projection holds `$type`, which Prisma would take for one of its
 *  own tagged values. */
export async function profiledReads<T>(db: PrismaClient, collections: RegExp, run: () => Promise<T>):
  Promise<{ value: T; reads: number; byCollection: Record<string, number> }> {
  await db.$runCommandRaw({ profile: 2 })
  const since = new Date()
  try {
    const value = await run()
    const rows = await db.$runCommandRaw({ find: 'system.profile', filter: { ts: { $gte: { $date: since.toISOString() } },
      ns: { $regex: collections.source } }, projection: { _id: 0, ns: 1 }, batchSize: 10_000 }) as
      { cursor: { firstBatch: Array<{ ns: string }> } }
    const byCollection: Record<string, number> = {}
    for (const { ns } of rows.cursor.firstBatch) {
      const collection = ns.slice(ns.lastIndexOf('.') + 1)
      byCollection[collection] = (byCollection[collection] ?? 0) + 1
    }
    return { value, reads: rows.cursor.firstBatch.length, byCollection }
  } finally {
    await db.$runCommandRaw({ profile: 0 })
  }
}
