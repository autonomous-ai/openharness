import type { PrismaClient } from '@prisma/client'

/** One index as `createIndexes` takes it. */
export type IndexSpec = { name: string; key: Record<string, number>; unique?: boolean; expireAfterSeconds?: number }

async function listIndexes(db: Pick<PrismaClient, '$runCommandRaw'>, collection: string): Promise<IndexSpec[]> {
  try {
    const answer = await db.$runCommandRaw({ listIndexes: collection, cursor: {} }) as { cursor?: { firstBatch?: IndexSpec[] } }
    return answer.cursor?.firstBatch ?? []
  } catch {
    // A collection that does not exist yet has no indexes; createIndexes creates it, and reports any real failure.
    return []
  }
}

const sameKey = (a: Record<string, number>, b: Record<string, number>) => JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b))

/**
 * Makes sure `collection` has `index`, and changes nothing when it already does. A build, a drop or an option change locks
 * the collection exclusively for a moment, and a Swarm read's transaction waits at most 5 ms for its lock (the 10-28 release);
 * listing the indexes takes no lock that reads or writes wait for. An index Prisma declares without expiry (db push builds it
 * so on a new database) gets its expiry with collMod, without a rebuild. Any other difference fails in createIndexes, as before.
 */
export async function ensureIndex(db: Pick<PrismaClient, '$runCommandRaw'>, collection: string, index: IndexSpec): Promise<void> {
  const found = (await listIndexes(db, collection)).find(existing => existing.name === index.name)
  if (found && sameKey(found.key, index.key) && !!found.unique === !!index.unique) {
    if (found.expireAfterSeconds === index.expireAfterSeconds) return
    if (index.expireAfterSeconds !== undefined) {
      await db.$runCommandRaw({ collMod: collection, index: { name: index.name, expireAfterSeconds: index.expireAfterSeconds } })
      return
    }
  }
  await db.$runCommandRaw({ createIndexes: collection, indexes: [index] })
}
