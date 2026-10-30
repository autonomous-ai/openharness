import type { PrismaClient } from '@prisma/client'
import type { SuperTabState } from '../superTabs/model.js'
import { projectsOf, type SwarmProject } from '../superTabs/projects.js'
import type { SuperTabStore } from '../superTabs/store.js'
import { weekStart } from '../superTabs/leaderboard/week.js'
import { logger } from '../utils/logger.js'

/**
 * The nightly routing reflection (Scholes's roadmap, piece 2, 2026-10-30): at 23:00 in each project's time zone, the singleton
 * worker posts in the project chat what its routed work cost and how it went, with at most three routing changes asked of
 * its owner (superTabs/costs/reflection.ts, store.ts postReflection). Nothing changes routing without the owner's answer.
 *
 * - Which projects: those with evidence rows (superTabs/evidence/store.ts) from the last two weeks, grouped in Mongo by the
 *   evidence collection's week index; a project with no routed work has none and is never read. Then one head per Swarm,
 *   for each project's time zone. That plan is read again every PLAN_EVERY_MS, not on each of the 96 passes a day (review
 *   of #2276): a project whose first routed work or new time zone is newer than the plan gets its first report a night later.
 * - When: a pass every 15 minutes; a project is due during its local 23:00 hour, once a local date (the report's id). A
 *   project whose report this process already settled for a date is not asked again for it.
 * - Failure: a pass that fails for a project writes nothing and is tried again on the next pass, at most four times a night;
 *   a Swarm whose head read fails makes the next pass read the plan again.
 */
export const REFLECTION_EVERY_MS = 15 * 60_000
/** The zone of a project that set no digest: the owner's time zone is stored nowhere; the digest's is the one a project sets. */
export const DEFAULT_TIME_ZONE = 'Asia/Ho_Chi_Minh'
const HOUR = '23'
/** (Swarm, project) pairs one pass reads at most: far more than projects route in two weeks. */
export const MAX_CANDIDATES = 5000
const WEEK_MS = 7 * 24 * 60 * 60_000
/** How long a pass reuses the projects and time zones it read. */
export const PLAN_EVERY_MS = 3 * 60 * 60_000

function localNow(timeZone: string, now: number): { date: string; hour: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: parts.hour! }
}

/** The local date whose report is due at `now`, or null outside the project's 23:00 hour. A zone the runtime does not know
 *  counts as the default one. */
export function reflectionDue(project: Pick<SwarmProject, 'digest'>, now: number): string | null {
  let local: ReturnType<typeof localNow>
  try { local = localNow(project.digest?.timeZone ?? DEFAULT_TIME_ZONE, now) } catch { local = localNow(DEFAULT_TIME_ZONE, now) }
  return local.hour === HOUR ? local.date : null
}

/** The Swarms and projects with evidence from the week holding 7 days ago on: one $group in Mongo over the week index, never
 *  Prisma's groupBy (it crashed the engine on Mongo here). Says so when it reads MAX_CANDIDATES: some projects may be left out. */
export async function reflectionCandidates(db: PrismaClient, now: number, log: Pick<typeof logger, 'warn'> = logger): Promise<Map<string, string[]>> {
  const rows = await db.superTabModelEvidence.aggregateRaw({ pipeline: [
    { $match: { week: { $gte: { $date: new Date(weekStart(now - WEEK_MS)).toISOString() } } } },
    { $group: { _id: { tabId: '$tabId', projectId: '$projectId' } } },
    { $limit: MAX_CANDIDATES },
  ] }) as unknown as Array<{ _id: { tabId: string; projectId: string } }>
  if (rows.length >= MAX_CANDIDATES) log.warn('[routing-reflection] read the most projects a pass reads; some may get no report', { limit: MAX_CANDIDATES })
  const byTab = new Map<string, string[]>()
  for (const { _id: { tabId, projectId } } of rows) byTab.set(tabId, [...byTab.get(tabId) ?? [], projectId])
  return byTab
}

/** A project that may get a report, with what tells when: its digest's time zone. */
export interface ReflectionTarget { tabId: string; projectId: string; digest?: SwarmProject['digest'] }

/** The candidates, each with its project's time zone from its Swarm's head. A Swarm with no projects list has its one project
 *  (projects.ts projectsOf). A Swarm whose head read fails is logged and counted in `failed`. */
export async function reflectionPlan(db: PrismaClient, now: number, log: Pick<typeof logger, 'warn'> = logger): Promise<{ targets: ReflectionTarget[]; failed: number }> {
  const targets: ReflectionTarget[] = []
  let failed = 0
  for (const [tabId, projectIds] of await reflectionCandidates(db, now, log)) {
    try {
      const head = await db.swarmHead.findUnique({ where: { id: `${tabId}:head` }, select: { deleted: true, data: true } })
      if (!head || head.deleted) continue
      for (const project of projectsOf(head.data as unknown as SuperTabState).filter(p => projectIds.includes(p.id))) {
        targets.push({ tabId, projectId: project.id, ...project.digest ? { digest: project.digest } : {} })
      }
    } catch (error) {
      failed++
      log.warn('[routing-reflection] reading a Swarm failed; trying again on the next pass', { tabId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { targets, failed }
}

export interface ReflectionPass { posted: number; already: number; empty: number; skipped: number; failed: number }
/** What passes in one process share: the plan and when it was read, and the reports settled since. */
export interface ReflectionCache { plan: ReflectionTarget[] | null; readAt: number; settled: Set<string> }
export const reflectionCache = (): ReflectionCache => ({ plan: null, readAt: 0, settled: new Set() })

/** One pass: each planned project whose report is due gets it. A failure is one project's: logged, the others go on. */
export async function reflectNightly(db: PrismaClient, store: Pick<SuperTabStore, 'postReflection'>, now: number,
  log: Pick<typeof logger, 'warn'> = logger, cache: ReflectionCache = reflectionCache()): Promise<ReflectionPass> {
  const pass: ReflectionPass = { posted: 0, already: 0, empty: 0, skipped: 0, failed: 0 }
  if (!cache.plan || now - cache.readAt >= PLAN_EVERY_MS) {
    const { targets, failed } = await reflectionPlan(db, now, log)
    pass.failed += failed
    Object.assign(cache, { plan: failed ? null : targets, readAt: now, settled: new Set() })
    return run(targets)
  }
  return run(cache.plan)

  async function run(targets: ReflectionTarget[]): Promise<ReflectionPass> {
    for (const target of targets) {
      const on = reflectionDue(target, now)
      const key = JSON.stringify([target.tabId, target.projectId, on])
      if (!on || cache.settled.has(key)) continue
      try {
        pass[await store.postReflection(target.tabId, target.projectId, on)]++
        cache.settled.add(key)
      } catch (error) {
        pass.failed++
        log.warn('[routing-reflection] a report failed; trying again on the next pass', { tabId: target.tabId, projectId: target.projectId,
          error: error instanceof Error ? error.message : String(error) })
      }
    }
    return pass
  }
}

/** Runs a pass every [everyMs] in the singleton worker, never two at once. */
export function startRoutingReflection(db: PrismaClient, store: Pick<SuperTabStore, 'postReflection'>, everyMs = REFLECTION_EVERY_MS,
  now: () => number = Date.now): () => void {
  let running = false
  const cache = reflectionCache()
  const run = () => {
    if (running) return
    running = true
    void reflectNightly(db, store, now(), logger, cache).then(pass => { if (pass.posted || pass.failed) logger.info('[routing-reflection] pass', { ...pass }) })
      .catch(error => logger.warn('[routing-reflection] pass failed', { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { running = false })
  }
  run()
  const timer = setInterval(run, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
