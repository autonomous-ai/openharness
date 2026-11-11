/**
 * Removes what Swarm v4 left in the database on its own after a release: the collections of what it removed
 * (dropCollections.ts). It runs in the singleton worker: a chunk of rows per write with a pause between writes, tries again after
 * an error, and stops for good once nothing is left. A second runner would do no harm: each write matches only rows that are
 * still there.
 */
import type { PrismaClient } from '@prisma/client'
import { logger } from '../../utils/logger.js'
import { dropRemovedCollections, type CollectionDropReport } from './dropCollections.js'

export const PAUSE_MS = 500
/** Between two tries while the database fails. */
export const RETRY_MS = 3_600_000
/** Lets a starting worker finish its own startup first. */
export const START_DELAY_MS = 60_000

export interface JobOptions {
  pause?: () => Promise<void>
  wait?: (ms: number) => Promise<void>
  /** Counts and collection names only, or the error text of a failed try. */
  log?: (line: Record<string, unknown>) => void
  signal?: AbortSignal
}

/** Waits `ms`, or until `signal` aborts; either way its timer and its stop listener are gone. */
export const sleeper = (signal?: AbortSignal) => (ms: number) => new Promise<void>(resolve => {
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve() }
  const timer = setTimeout(finish, ms)
  timer.unref()
  signal?.addEventListener('abort', finish, { once: true })
})

/** Tries until no removed collection is left, or `signal` aborts (then it returns the last report, or null). A try that finds nothing
 *  to remove logs nothing. */
export async function dropLegacyUntilDone(db: PrismaClient, { pause, wait = sleeper(), log = () => {}, signal }: JobOptions = {}): Promise<CollectionDropReport | null> {
  let report: CollectionDropReport | null = null
  while (!signal?.aborted) {
    try {
      report = await dropRemovedCollections(db, { pause, signal })
      if (report.collections.length || report.failed.length) log({ removedCollections: report.collections, collectionsFailed: report.failed })
      if (report.done) return report
    } catch (error) {
      log({ failed: error instanceof Error ? error.message : String(error) })
    }
    await wait(RETRY_MS)
  }
  return report
}

/** Starts the removal in the background; the returned function stops it. */
export function startLegacyDrop(db: PrismaClient, delayMs = START_DELAY_MS): () => void {
  const control = new AbortController()
  const wait = sleeper(control.signal)
  void wait(delayMs).then(() => dropLegacyUntilDone(db, { signal: control.signal, wait, pause: () => wait(PAUSE_MS),
    log: line => 'failed' in line || (line.collectionsFailed as unknown[] | undefined)?.length
      ? logger.warn('[legacy-drop] failed', line) : logger.info('[legacy-drop] run', line) }))
  return () => control.abort()
}
