/**
 * Once, after the release that made a person's name in a Swarm follow their account's (personNames.ts nameFromAccount; anh Dee,
 * 2026-11-10): every Swarm's people take their accounts' names, so names chosen in a Swarm before show no longer. It runs in the
 * singleton worker a Swarm at a time, pausing after each write, logs only counts and the Swarms that failed, tries again after a
 * failure and stops once a pass changed nothing and failed nowhere. A worker that starts again walks the Swarms once more (one read
 * each, no write when nothing changed) until this goes, with `chosenName`, from 2026-12-10. Two runners do no harm: each Swarm is
 * read again in its own transaction, and a name that already follows is not written.
 */
import type { PrismaClient } from '@prisma/client'
import { logger } from '../../utils/logger.js'
import { SuperTabError } from '../model.js'
import type { SuperTabStore } from '../store.js'
import { sleeper, START_DELAY_MS } from './dropLegacyJob.js'

export const PAGE = 100
export const PAUSE_MS = 200
export const RETRY_MS = 3_600_000

export interface AccountNamesPass { swarms: number; changed: number; failed: number }

/** One pass over every live Swarm in parts, in id order. A raw match: Prisma's `deletedAt: null` misses a row that never had the
 *  field, and a Swarm still in one row is split first (its split reads names as they are then). */
export async function followAccountNamesOnce(db: PrismaClient, store: Pick<SuperTabStore, 'followAccountNames'>,
  { pause = async () => {}, signal }: { pause?: () => Promise<void>; signal?: AbortSignal } = {}): Promise<AccountNamesPass> {
  const pass: AccountNamesPass = { swarms: 0, changed: 0, failed: 0 }
  let after: string | undefined
  while (!signal?.aborted) {
    const rows = await db.superTab.aggregateRaw({ pipeline: [{ $match: { format: 2, deletedAt: null, ...after ? { _id: { $gt: after } } : {} } },
      { $sort: { _id: 1 } }, { $limit: PAGE }, { $project: { _id: 1 } }] }) as unknown as Array<{ _id: string }>
    for (const { _id: id } of rows) {
      if (signal?.aborted) break
      try {
        const changed = await store.followAccountNames(id)
        pass.swarms++
        if (typeof changed === 'number' && changed > 0) {
          pass.changed += changed
          await pause()
        }
      } catch (error) {
        pass.failed++
        logger.warn('[account-names] a Swarm did not follow', { tabId: id, code: error instanceof SuperTabError ? error.code : 'unknown' })
      }
    }
    if (rows.length < PAGE) break
    after = rows.at(-1)!._id
  }
  return pass
}

/** Starts the pass in the background, again each hour until one changed nothing and failed nowhere; the returned function stops it. */
export function startAccountNames(db: PrismaClient, store: Pick<SuperTabStore, 'followAccountNames'>, delayMs = START_DELAY_MS): () => void {
  const control = new AbortController()
  const wait = sleeper(control.signal)
  void (async () => {
    await wait(delayMs)
    while (!control.signal.aborted) {
      try {
        const pass = await followAccountNamesOnce(db, store, { pause: () => wait(PAUSE_MS), signal: control.signal })
        if (pass.failed) logger.warn('[account-names] pass', { ...pass })
        else logger.info('[account-names] pass', { ...pass })
        if (!pass.changed && !pass.failed) return
      } catch (error) {
        logger.warn('[account-names] failed', { error: error instanceof Error ? error.name : 'unknown' })
      }
      await wait(RETRY_MS)
    }
  })()
  return () => control.abort()
}
