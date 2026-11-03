/**
 * Removes the dead old state of every migrated Swarm on its own after a release (`SuperTab.legacyState`; Database
 * optimization roadmap, phase 0). It runs in the singleton worker: a few Swarms per write with a pause between writes, waits
 * while any Swarm is still in one row, tries again after an error, and stops for good once none keeps an old state. A second
 * runner would do no harm: each write matches only rows that still keep one.
 */
import type { PrismaClient } from '@prisma/client'
import { logger } from '../../utils/logger.js'
import { dropLegacyStates, type DropReport } from './dropLegacy.js'

/** A busy Swarm's old state is about 1 MB: this bounds a write to a few megabytes. */
export const JOB_BATCH = 5
export const PAUSE_MS = 500
/** Between two tries while a Swarm waits for its split or the database fails. */
export const RETRY_MS = 3_600_000
/** Lets a starting worker finish its own startup first. */
export const START_DELAY_MS = 60_000

export interface JobOptions {
  batch?: number
  pause?: () => Promise<void>
  wait?: (ms: number) => Promise<void>
  /** Counts and sizes only, or the error text of a failed try. */
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

/** Tries until no Swarm keeps an old state, or `signal` aborts (then it returns the last report, or an empty one). */
export async function dropLegacyUntilDone(db: PrismaClient, { batch = JOB_BATCH, pause, wait = sleeper(), log = () => {}, signal }: JobOptions = {}): Promise<DropReport | null> {
  let report: DropReport | null = null
  while (!signal?.aborted) {
    try {
      report = await dropLegacyStates(db, { apply: true, batch, pause, signal })
      log({ ...report })
      if (report.done) return report
    } catch (error) {
      log({ failed: error instanceof Error ? error.message : String(error) })
    }
    await wait(RETRY_MS)
  }
  return report
}

/** Starts the removal in the background; the returned function stops it. */
export function startLegacyDrop(db: PrismaClient, delayMs = START_DELAY_MS, batch = JOB_BATCH): () => void {
  const control = new AbortController()
  const wait = sleeper(control.signal)
  void wait(delayMs).then(() => dropLegacyUntilDone(db, { batch, signal: control.signal, wait, pause: () => wait(PAUSE_MS),
    log: line => 'failed' in line ? logger.warn('[legacy-drop] failed', line) : logger.info('[legacy-drop] run', line) }))
  return () => control.abort()
}
