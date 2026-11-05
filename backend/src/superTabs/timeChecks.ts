// The Swarm's time checks run in the singleton worker (task #3385, anh Dee's Swarm redesign, 11-05): lost and stalled work,
// failed starts and idle agents are found and told to each project's PM whether or not the PM is up. They ran only on the
// PM's own poll before: on 11-05 a hung PM left five people's asks unanswered for 3 to 10 hours and the board showed nothing
// working. A machine's report still runs the loss checks too (liveness.ts sweepLiveness); what both find is recorded in the
// Swarm's own write, so each notice is written once whichever runs first.
import type { PrismaClient } from '@prisma/client'
import { SWEEP_EVERY_MS } from './liveness.js'
import type { SuperTabStore } from './store.js'
import { logger } from '../utils/logger.js'

/** A Swarm with no conversation active this long has no work for the checks: its stalls were told long ago. */
export const TIME_CHECK_QUIET_MS = 7 * 24 * 3_600_000
/** The most Swarms a pass checks, the most recently active first (ENGINEERING.md 4: no read grows without a bound). */
export const TIME_CHECK_SWARMS = 200

/** The Swarms to check: those with a conversation awake and active in the last [TIME_CHECK_QUIET_MS], newest first. On the
 *  `[dormant, lastActivityAt]` group index; a deleted Swarm is left to `runTimeChecks`, which reads its row anyway. */
export async function timeCheckSwarms(db: PrismaClient, now: number, limit = TIME_CHECK_SWARMS): Promise<string[]> {
  const rows = await db.swarmGroup.aggregateRaw({ pipeline: [
    { $match: { dormant: false, lastActivityAt: { $gte: { $date: new Date(now - TIME_CHECK_QUIET_MS).toISOString() } } } },
    { $group: { _id: '$tabId', at: { $max: '$lastActivityAt' } } },
    { $sort: { at: -1 } },
    { $limit: limit },
  ] }) as unknown as Array<{ _id: string }>
  return rows.map(row => row._id)
}

/** One pass: each Swarm's checks in its own write. One Swarm's failure is logged and skips that Swarm alone. */
export async function runTimeCheckPass(db: PrismaClient, store: Pick<SuperTabStore, 'runTimeChecks'>, now: number, limit = TIME_CHECK_SWARMS) {
  const tabIds = await timeCheckSwarms(db, now, limit)
  const pass = { swarms: tabIds.length, written: 0, failed: 0 }
  for (const tabId of tabIds) {
    try {
      pass.written += await store.runTimeChecks(tabId)
    } catch (error) {
      pass.failed++
      logger.warn('[swarm-time-checks] Swarm skipped', { tabId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return pass
}

/** Runs the pass every [everyMs] in the singleton worker, one at a time. A pass longer than its interval says so: the first
 *  sign the checks no longer keep up. */
export function startTimeChecks(db: PrismaClient, store: Pick<SuperTabStore, 'runTimeChecks'>, everyMs = SWEEP_EVERY_MS): () => void {
  let running = false
  const run = () => {
    if (running) return
    running = true
    const started = Date.now()
    void runTimeCheckPass(db, store, started)
      .then(pass => {
        const ms = Date.now() - started
        if (pass.failed || ms > everyMs) logger.warn('[swarm-time-checks] pass', { ...pass, ms })
        else if (pass.written) logger.info('[swarm-time-checks] pass', { ...pass, ms })
      })
      .catch(error => logger.error('[swarm-time-checks] pass failed: stalls, losses and idle agents go untold until one runs', { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { running = false })
  }
  run()
  const timer = setInterval(run, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
