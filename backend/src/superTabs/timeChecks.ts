// The Swarm's time checks run in the singleton worker every 30 s. Since Swarm v4 (anh Dee, 2026-11-09) they run only v4's
// jobs (store.ts runTimeChecks): every agent gets its 1:1 chat with its person, and the stops the v3 rules asked for are
// withdrawn once. No v3 rule runs on its own any more: no lost-work sweeps, stuck alerts, proposal cards or PM restarts.
import type { PrismaClient } from '@prisma/client'
import { SWEEP_EVERY_MS } from './liveness.js'
import type { SuperTabStore } from './store.js'
import { logger } from '../utils/logger.js'



/** A Swarm with no conversation active this long has no work for the checks: its stalls were told long ago. */
export const TIME_CHECK_QUIET_MS = 7 * 24 * 3_600_000
/** The most Swarms a pass checks, the most recently active first (AGENTS.md standard 4: no read grows without a bound). */
export const TIME_CHECK_SWARMS = 200
/** A Swarm whose groups show no activity since its last check is checked again only this often (AGENTS.md standard 4: a timer that
 *  wakes while nothing changed is a defect). Its stalls (30 minutes) and idle agents (15) are still told within minutes of
 *  falling due. */
export const QUIET_CHECK_MS = 5 * 60_000

/** The Swarms to check: those with a conversation awake and active in the last [TIME_CHECK_QUIET_MS], newest first. On the
 *  `[dormant, lastActivityAt]` group index; a deleted Swarm is left to `runTimeChecks`, which reads its row anyway. */
export async function timeCheckSwarms(db: PrismaClient, now: number, limit = TIME_CHECK_SWARMS): Promise<string[]> {
  return (await timeCheckCandidates(db, now, limit)).map(row => row.tabId)
}

/** The same Swarms, each with its groups' latest activity, which says whether anything moved there since the last pass. */
async function timeCheckCandidates(db: PrismaClient, now: number, limit: number): Promise<Array<{ tabId: string; at: string }>> {
  const rows = await db.swarmGroup.aggregateRaw({ pipeline: [
    { $match: { dormant: false, lastActivityAt: { $gte: { $date: new Date(now - TIME_CHECK_QUIET_MS).toISOString() } } } },
    { $group: { _id: '$tabId', at: { $max: '$lastActivityAt' } } },
    { $sort: { at: -1 } },
    { $limit: limit },
  ] }) as unknown as Array<{ _id: string; at: { $date: string } | string }>
  return rows.map(row => ({ tabId: row._id, at: typeof row.at === 'string' ? row.at : JSON.stringify(row.at) }))
}

/** Per Swarm, its activity and when the pass last checked it: the worker's memory, gone with it (the next pass checks all). */
export type TimeCheckMemory = Map<string, { at: string; checkedAt: number }>

/** One pass: each Swarm's checks in its own write, for a Swarm whose activity moved since [seen] last checked it, or that it has
 *  not checked for QUIET_CHECK_MS. One Swarm's failure is logged and skips that Swarm alone, and it is checked again next pass. */
export async function runTimeCheckPass(db: PrismaClient, store: Pick<SuperTabStore, 'runTimeChecks'>, now: number, limit = TIME_CHECK_SWARMS,
  seen: TimeCheckMemory = new Map()) {
  const rows = await timeCheckCandidates(db, now, limit)
  const pass = { swarms: rows.length, checked: 0, written: 0, failed: 0 }
  const listed = new Set(rows.map(row => row.tabId))
  for (const tabId of seen.keys()) if (!listed.has(tabId)) seen.delete(tabId)
  for (const { tabId, at } of rows) {
    const last = seen.get(tabId)
    if (last && last.at === at && now - last.checkedAt < QUIET_CHECK_MS) continue
    pass.checked++
    try {
      pass.written += await store.runTimeChecks(tabId)
      seen.set(tabId, { at, checkedAt: now })
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
  const seen: TimeCheckMemory = new Map()
  const run = () => {
    if (running) return
    running = true
    const started = Date.now()
    void runTimeCheckPass(db, store, started, TIME_CHECK_SWARMS, seen)
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
