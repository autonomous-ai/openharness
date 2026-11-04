/**
 * Prisma runs an upsert on Mongo as a read, then an insert: an identical request between the two inserts first, and
 * this one fails on the unique key (P2002). Run once more, the read finds that row and the upsert updates it, so both
 * requests get the same answer instead of a conflict.
 */
export async function upsertRacing<T>(write: () => Promise<T>): Promise<T> {
  try { return await write() } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 'P2002') throw error
    return write()
  }
}
