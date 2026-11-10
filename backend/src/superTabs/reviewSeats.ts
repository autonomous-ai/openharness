/** Whether a new agent of an engine could start on a contributed machine soon: what the project chat's notice
 *  (reviewCapacity.ts) reads. On 2026-10-30 every Codex Reviewer was out of weekly quota for days and reviews waited all
 *  morning (Tony). */
import { suspendedEngines } from './engineHealth.js'
import { MACHINE_FRESH_MS, type ContributedMachine } from './machines.js'

/** How soon a Reviewer has to be able to start to count: a start still not running after this long is abandoned
 *  (store.ts ABANDONED_START_MS), so a review waiting longer than that is stuck. A window that resets inside it counts as
 *  quota; one out for longer does not. */
export const REVIEW_START_MS = 15 * 60_000
/** Weekly allowance left, in percent, at or below which an engine is close to running out: the route keeps the policy's
 *  reserve (10) back, so about one more day of reviews is left. */
const LOW_LEFT = 20

/** How a machine stands for a new Reviewer on an engine, best first. Words only: a person's own numbers stay theirs. */
export const STANDING = ['usable', 'close to running out', 'out of quota', 'signed out', 'suspended', 'paused', 'offline'] as const
export type Standing = typeof STANDING[number]
/** A Reviewer could start there within REVIEW_START_MS. */
export const canStart = (s: Standing) => s === 'usable' || s === 'close to running out'

/** The engine's quota reading for [pool]. */
export function quotaOf(pool: ContributedMachine, engine: string) {
  return pool.observation?.quotas.find(q => q.engine === engine)
}

export function resetMs(value: string | number | null): number | null {
  if (typeof value === 'number') return value > 1e10 ? value : value * 1000
  if (typeof value === 'string') { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null }
  return null
}

/** How [pool] stands for a new Reviewer of [engine] at [now]. A usage window that is used up but resets within
 *  REVIEW_START_MS is not out: the Reviewer starts once it does. */
export function standing(pool: ContributedMachine, engine: string, now: number): Standing {
  const reading = pool.observation
  if (!reading || now - reading.receivedAt > MACHINE_FRESH_MS) return 'offline'
  // Its owner paused new work there, as the CLI's route reads it (routeCommand.ts probeMachine) and starts refuse it.
  if (pool.paused) return 'paused'
  if (reading.readiness?.engines?.find(e => e.engine === engine)?.signedIn === false) return 'signed out'
  if (suspendedEngines(pool, now)[engine]) return 'suspended'
  const quota = quotaOf(pool, engine)
  // A quota it cannot read stays usable, as a start there is (engineHealth.ts engineUnusable).
  if (!quota?.known) return 'usable'
  const soon = (w: { resetsAt: string | number | null }) => { const at = resetMs(w.resetsAt); return at !== null && at - now <= REVIEW_START_MS }
  if (quota.windows.some(w => w.usedPercent >= 100 && !soon(w))) return 'out of quota'
  const weekly = quota.windows.find(w => w.name === 'weekly')
  return weekly && !(weekly.usedPercent >= 100) && 100 - weekly.usedPercent <= LOW_LEFT ? 'close to running out' : 'usable'
}
