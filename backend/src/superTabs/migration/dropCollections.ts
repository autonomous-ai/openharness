/**
 * Removes the collections of what Swarm v4 removed, once nothing in the code reads or writes them (anh Dee, 2026-11-09: "drop
 * them all"; the readers went in the release before the one that carries this). A collection is listed here in the pull request
 * that takes its model, its expiry index and its purge entry out of the code, so a release's schema push never makes it again.
 *
 * Each is emptied in chunks of [CHUNK] (a pause between them) and then dropped. A database user that may not drop leaves it
 * empty: the data is gone either way. Safe to repeat, and from two pods at once: a removal of a row already removed removes
 * nothing, and a collection another pod dropped first counts as dropped.
 *
 * Only whole collections that nothing reads or writes are listed. A row of a collection that v4 still uses (Swarms, chats,
 * agents, machines, the leaderboard's records) is never removed here: those go by a strict row filter in their own jobs.
 * Delete this list, its job and its test 30 days after the release that carries it, and not before 2026-12-09.
 */
import type { PrismaClient } from '@prisma/client'
import { removeChunk } from '../../lib/chunkSweep.js'
import { notAuthorized } from '../../lib/db/indexes.js'
import { logger } from '../../utils/logger.js'

export const REMOVED_COLLECTIONS = [
  // Workspaces, the level above Swarms (removed in #3637), their invitations and the removals still in flight.
  'SwarmWorkspace', 'SwarmWorkspaceMember', 'SwarmWorkspaceInvitation', 'SwarmWorkspaceRemoval',
  // The nightly scorecard's rows (removed in #3629) and the terminal recording's receipts (removed in #3631).
  'SuperTabScorecard', 'SuperTabNativeContext',
] as const

/** Rows removed by one write: a few megabytes at most. */
export const CHUNK = 500

export interface CollectionDrop {
  collection: string
  /** Rows it held when this pass found it. */
  rows: number
  /** False when the database user may not drop: the collection is left empty. */
  dropped: boolean
}
/** Counts and collection names only: no row's content or id. */
export interface CollectionDropReport {
  /** What this pass emptied and dropped; a collection already gone is not here. */
  collections: CollectionDrop[]
  /** Collections it could not empty, by name: the job says which, and tries them again. */
  failed: string[]
  /** Nothing is left to remove: every collection is gone or empty. False when stopped or when one failed. */
  done: boolean
}
export interface DropCollectionsOptions {
  chunk?: number
  /** Awaited between two chunks, so a large collection never holds the database for long. */
  pause?: () => Promise<void>
  /** Checked before each chunk: an aborted pass returns what it has done, not done. */
  signal?: AbortSignal
  collections?: readonly string[]
}

type Commands = Pick<PrismaClient, '$runCommandRaw'>
const missing = (error: unknown): boolean => /NamespaceNotFound|ns not found|Code: `26`/.test(String((error as Error)?.message ?? error))

async function existing(db: Commands, names: readonly string[]): Promise<Set<string>> {
  const answer = await db.$runCommandRaw({ listCollections: 1, nameOnly: true, filter: { name: { $in: [...names] } } } as never) as
    { cursor: { firstBatch: Array<{ name: string }> } }
  return new Set(answer.cursor.firstBatch.map(entry => entry.name))
}

/** Empties [collection] in chunks, then drops it; false when the database user may not drop. Aborted: null, left as it is. */
async function remove(db: Commands, collection: string, { chunk = CHUNK, pause, signal }: DropCollectionsOptions): Promise<CollectionDrop | null> {
  const rows = Number((await db.$runCommandRaw({ count: collection }) as { n?: unknown }).n ?? 0)
  for (;;) {
    if (signal?.aborted) return null
    const removed = await removeChunk(db, { collection, filter: {}, sort: { _id: 1 }, hint: '_id_', chunk })
    if (removed < chunk) break
    await pause?.()
  }
  try {
    await db.$runCommandRaw({ drop: collection } as never)
  } catch (error) {
    if (missing(error)) return { collection, rows, dropped: true }
    if (!notAuthorized(error)) throw error
    logger.warn('[legacy-drop] a removed collection is empty but not dropped: the database user may not drop it', { collection })
    return { collection, rows, dropped: false }
  }
  return { collection, rows, dropped: true }
}

/** One pass over [DropCollectionsOptions.collections]: each that exists is emptied and dropped. */
export async function dropRemovedCollections(db: Commands, options: DropCollectionsOptions = {}): Promise<CollectionDropReport> {
  const names = options.collections ?? REMOVED_COLLECTIONS
  const report: CollectionDropReport = { collections: [], failed: [], done: true }
  for (const collection of await existing(db, names)) {
    try {
      const removed = await remove(db, collection, options)
      if (removed) report.collections.push(removed)
      else report.done = false
    } catch (error) {
      // Another pod may have dropped it under this one: a collection gone now is done, not failed.
      if ((await existing(db, [collection])).has(collection)) {
        report.failed.push(collection)
        report.done = false
        logger.warn('[legacy-drop] a removed collection could not be emptied', { collection, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return report
}
