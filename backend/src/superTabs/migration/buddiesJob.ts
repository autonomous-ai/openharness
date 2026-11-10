/**
 * Once, after the release that removed Buddies (the lead's decision, 2026-11-10): every Buddy of every Swarm becomes an ordinary
 * agent of its person, its Buddy chat their 1:1 chat (store.ts convertBuddies, buddyConversion.ts). The time checks convert the
 * active Swarms within seconds; this reaches the quiet ones too, so the Buddy read rules can go after it (slice S17b). It runs in
 * the singleton worker; logs only counts; tries again an hour after a pass that failed somewhere and stops once a pass converted
 * nothing and failed nowhere. A worker that starts again walks once more (one read per Swarm, no write when it holds no Buddy).
 * Two runners do no harm: each Swarm is converted in its own transaction, whose save a racing one makes run again, and a
 * converted Swarm holds no Buddy. Goes with the Buddy read rules.
 */
import type { PrismaClient } from '@prisma/client'
import { logger } from '../../utils/logger.js'
import { SuperTabError } from '../model.js'
import type { SuperTabStore } from '../store.js'
import { sleeper, START_DELAY_MS } from './dropLegacyJob.js'
import { PAGE, PAUSE_MS, RETRY_MS } from './teamMachinesJob.js'

export interface BuddiesPass { swarms: number; converted: number; failed: number }

/** One pass over every live Swarm in parts, in id order. */
export async function convertBuddiesOnce(db: PrismaClient, store: Pick<SuperTabStore, 'convertBuddies'>,
  { pause = async () => {}, signal }: { pause?: () => Promise<void>; signal?: AbortSignal } = {}): Promise<BuddiesPass> {
  const pass: BuddiesPass = { swarms: 0, converted: 0, failed: 0 }
  let after: string | undefined
  while (!signal?.aborted) {
    const rows = await db.superTab.aggregateRaw({ pipeline: [{ $match: { format: 2, deletedAt: null, ...after ? { _id: { $gt: after } } : {} } },
      { $sort: { _id: 1 } }, { $limit: PAGE }, { $project: { _id: 1 } }] }) as unknown as Array<{ _id: string }>
    for (const { _id: id } of rows) {
      if (signal?.aborted) break
      try {
        const converted = await store.convertBuddies(id)
        pass.swarms++
        if (converted > 0) {
          pass.converted += converted
          await pause()
        }
      } catch (error) {
        pass.failed++
        logger.warn('[buddies] a Swarm kept its Buddies', { tabId: id, code: error instanceof SuperTabError ? error.code : 'unknown' })
      }
    }
    if (rows.length < PAGE) break
    after = rows.at(-1)!._id
  }
  return pass
}

/** Starts the pass in the background, again each hour until one converted nothing and failed nowhere; the returned function stops it. */
export function startBuddyConversion(db: PrismaClient, store: Pick<SuperTabStore, 'convertBuddies'>, delayMs = START_DELAY_MS): () => void {
  const control = new AbortController()
  const wait = sleeper(control.signal)
  void (async () => {
    await wait(delayMs)
    while (!control.signal.aborted) {
      try {
        const pass = await convertBuddiesOnce(db, store, { pause: () => wait(PAUSE_MS), signal: control.signal })
        if (pass.failed) logger.error('[buddies] pass: some Swarms still hold Buddies, read by the Buddy rules; it tries again in an hour', { ...pass })
        else logger.info('[buddies] pass', { ...pass })
        if (!pass.converted && !pass.failed) return
      } catch (error) {
        logger.error('[buddies] failed: Buddies stay until the next try, in an hour', { error: error instanceof Error ? error.name : 'unknown' })
      }
      await wait(RETRY_MS)
    }
  })()
  return () => control.abort()
}
