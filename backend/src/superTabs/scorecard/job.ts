/**
 * The nightly scorecard (task #3386): once a project's local day has ended, the singleton worker computes its figures from
 * the Swarm's records and stores them, for every project of every Swarm, so the numbers never wait on a PM's poll.
 *
 * - Which projects: those with a group active in the last week, from one $group over the activity index, read again every
 *   PLAN_EVERY_MS, not on each pass. Then each Swarm's head, for its projects' chats and time zones.
 * - When: a pass every 15 minutes. A project's day is due from 30 minutes after its local midnight, for the two days before
 *   today that have no row yet: the first pass after a release fills yesterday and the day before by itself.
 * - Failure: a day that fails is logged with its Swarm and project and tried again on the next pass, at most
 *   MAX_TRIES times; then it is logged as an error and left missing, never stored as zeros.
 */
import type { PrismaClient } from '@prisma/client'
import type { SuperTabState } from '../model.js'
import { projectsOf } from '../projects.js'
import { groupsBy } from '../parts/indexed.js'
import { knownTimeZone, localNow } from '../digest.js'
import { DEFAULT_TIME_ZONE } from '../costs/reflection.js'
import { logger } from '../../utils/logger.js'
import { dayBounds, scorecardDay } from './figures.js'
import { scorecardRecords } from './records.js'
import { daysBefore, hasScorecard, writeScorecard } from './rows.js'

export const SCORECARD_EVERY_MS = 15 * 60_000
export const PLAN_EVERY_MS = 3 * 60 * 60_000
/** How long after its local midnight a day is computed: late rows of the day have landed. */
export const SETTLE_MS = 30 * 60_000
const ACTIVE_MS = 7 * 24 * 60 * 60_000
/** Days before today a pass fills when they have no row. */
const DAYS_BACK = 2
export const MAX_TRIES = 4
/** (Swarm, project) pairs one plan reads at most. */
export const MAX_CANDIDATES = 5000

export interface ScorecardTarget { tabId: string; projectId: string; chatId: string; timeZone: string }
export interface ScorecardPass { stored: number; already: number; failed: number; capped: number }
export interface ScorecardCache { plan: ScorecardTarget[] | null; readAt: number; settled: Set<string>; tries: Map<string, number> }
export const scorecardCache = (): ScorecardCache => ({ plan: null, readAt: 0, settled: new Set(), tries: new Map() })

type Log = Pick<typeof logger, 'warn' | 'error' | 'info'>

/** Every project with a group active in the last week, with its chat and time zone. A Swarm whose head fails to read is
 *  logged and counted; the next pass reads the plan again. */
export async function scorecardPlan(db: PrismaClient, now: number, log: Log = logger): Promise<{ targets: ScorecardTarget[]; failed: number }> {
  const rows = await groupsBy(db, 'activity', [
    { $match: { dormant: { $in: [false, true] }, lastActivityAt: { $gte: { $date: new Date(now - ACTIVE_MS).toISOString() } } } },
    { $group: { _id: '$tabId' } }, { $limit: MAX_CANDIDATES },
  ]) as unknown as Array<{ _id: string }>
  if (rows.length >= MAX_CANDIDATES) log.warn('[scorecard] read the most Swarms a plan reads; some get no scorecard', { limit: MAX_CANDIDATES })
  const targets: ScorecardTarget[] = []
  let failed = 0
  for (const { _id: tabId } of rows) {
    try {
      const head = await db.swarmHead.findUnique({ where: { id: `${tabId}:head` }, select: { deleted: true, data: true } })
      if (!head || head.deleted) continue
      for (const project of projectsOf(head.data as unknown as SuperTabState)) {
        const zone = project.digest?.timeZone
        targets.push({ tabId, projectId: project.id, chatId: project.leadConversationId, timeZone: zone && knownTimeZone(zone) ? zone : DEFAULT_TIME_ZONE })
      }
    } catch (error) {
      failed++
      log.warn('[scorecard] reading a Swarm failed; trying again on the next pass', { tabId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { targets, failed }
}

/** Forgets the days no pass at `now` can be due for, in any zone (UTC±14 h): a long-lived worker keeps a few keys a project. */
export function pruneCache(cache: ScorecardCache, now: number): void {
  const oldest = daysBefore(new Date(now).toISOString().slice(0, 10), DAYS_BACK + 1)
  const stale = (key: string) => (JSON.parse(key) as [string, string, string])[2] < oldest
  for (const key of cache.settled) if (stale(key)) cache.settled.delete(key)
  for (const key of cache.tries.keys()) if (stale(key)) cache.tries.delete(key)
}

/** The days of `target` a pass at `now` computes when they have no row: the ended ones of the last DAYS_BACK. */
export function dueDays(target: Pick<ScorecardTarget, 'timeZone'>, now: number): string[] {
  const today = localNow(target.timeZone, now).date
  return Array.from({ length: DAYS_BACK }, (_, i) => daysBefore(today, i + 1)).filter(on => dayBounds(on, target.timeZone).end + SETTLE_MS <= now)
}

/** Computes and stores one project's day. `read`: the client the records come from (the secondaries in production). */
export async function computeScorecard(read: PrismaClient, write: PrismaClient, target: ScorecardTarget, on: string, now: number):
  Promise<{ capped: number }> {
  const { start, end } = dayBounds(on, target.timeZone)
  const { input, capped } = await scorecardRecords(read, { tabId: target.tabId, projectId: target.projectId, chatId: target.chatId, start, end })
  await writeScorecard(write, target.tabId, { projectId: target.projectId, on, timeZone: target.timeZone, figures: scorecardDay(input), computedAt: now })
  return { capped }
}

/** One pass: each planned project's due days without a row are computed. A failure is one day's: logged, the others go on. */
export async function scorecardPass(db: PrismaClient, read: PrismaClient, now: number, log: Log = logger,
  cache: ScorecardCache = scorecardCache()): Promise<ScorecardPass> {
  const pass: ScorecardPass = { stored: 0, already: 0, failed: 0, capped: 0 }
  if (!cache.plan || now - cache.readAt >= PLAN_EVERY_MS) {
    const { targets, failed } = await scorecardPlan(db, now, log)
    pruneCache(cache, now)
    pass.failed += failed
    Object.assign(cache, { plan: failed ? null : targets, readAt: now })
    return run(targets)
  }
  return run(cache.plan)

  async function run(targets: ScorecardTarget[]): Promise<ScorecardPass> {
    for (const target of targets) {
      for (const on of dueDays(target, now)) {
        const key = JSON.stringify([target.tabId, target.projectId, on])
        if (cache.settled.has(key)) continue
        try {
          if (await hasScorecard(db, target.tabId, target.projectId, on)) { pass.already++; cache.settled.add(key); continue }
          const { capped } = await computeScorecard(read, db, target, on, now)
          pass.stored++
          pass.capped += capped
          if (capped) log.warn('[scorecard] some groups had more rows than a day reads; their figures may be low', { tabId: target.tabId, projectId: target.projectId, on, capped })
          cache.settled.add(key)
        } catch (error) {
          pass.failed++
          const tries = (cache.tries.get(key) ?? 0) + 1
          cache.tries.set(key, tries)
          const facts = { tabId: target.tabId, projectId: target.projectId, on, tries, error: error instanceof Error ? error.message : String(error) }
          if (tries >= MAX_TRIES) {
            cache.settled.add(key)
            log.error('[scorecard] a day failed every try; it stays missing from the project\'s scorecard', facts)
          } else log.warn('[scorecard] a day failed; trying again on the next pass', facts)
        }
      }
    }
    return pass
  }
}

/** Runs a pass every [everyMs] in the singleton worker, never two at once. */
export function startScorecards(db: PrismaClient, read: PrismaClient = db, everyMs = SCORECARD_EVERY_MS, now: () => number = Date.now): () => void {
  let running = false
  const cache = scorecardCache()
  const run = () => {
    if (running) return
    running = true
    const began = Date.now()
    void scorecardPass(db, read, now(), logger, cache)
      .then(pass => { if (pass.stored || pass.failed) logger.info('[scorecard] pass', { ...pass, durationMs: Date.now() - began }) })
      .catch(error => logger.warn('[scorecard] pass failed', { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { running = false })
  }
  run()
  const timer = setInterval(run, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
