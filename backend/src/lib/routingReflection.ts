import type { PrismaClient } from '@prisma/client'
import type { HeadData } from '../superTabs/parts/index.js'
import type { SwarmProject } from '../superTabs/projects.js'
import type { SuperTabStore } from '../superTabs/store.js'
import { weekStart } from '../superTabs/leaderboard/week.js'
import { logger } from '../utils/logger.js'

/**
 * The nightly routing reflection (Scholes's roadmap, piece 2, 2026-10-30): at 23:00 in each project's time zone, the singleton
 * worker posts in the project chat what its routed work cost and how it went, with at most three routing changes asked of
 * its owner (superTabs/costs/reflection.ts, store.ts postReflection). Nothing changes routing without the owner's answer.
 *
 * - Which projects: those with evidence rows (superTabs/evidence/store.ts) from the last two weeks, grouped in Mongo by the
 *   evidence collection's week index; a project with no routed work has none and is never read. Then one head per Swarm.
 * - When: a pass every 15 minutes; a project is due during its local 23:00 hour, once a local date (the report's id).
 * - Failure: a pass that fails for a project writes nothing and is tried again on the next pass, at most four times a night.
 */
export const REFLECTION_EVERY_MS = 15 * 60_000
/** The zone of a project that set no digest: the owner's time zone is stored nowhere; the digest's is the one a project sets. */
export const DEFAULT_TIME_ZONE = 'Asia/Ho_Chi_Minh'
const HOUR = '23'
/** (Swarm, project) pairs one pass reads at most: far more than projects route in two weeks. */
export const MAX_CANDIDATES = 5000
const WEEK_MS = 7 * 24 * 60 * 60_000

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
 *  Prisma's groupBy (it crashed the engine on Mongo here). */
export async function reflectionCandidates(db: PrismaClient, now: number): Promise<Map<string, string[]>> {
  const rows = await db.superTabModelEvidence.aggregateRaw({ pipeline: [
    { $match: { week: { $gte: { $date: new Date(weekStart(now - WEEK_MS)).toISOString() } } } },
    { $group: { _id: { tabId: '$tabId', projectId: '$projectId' } } },
    { $limit: MAX_CANDIDATES },
  ] }) as unknown as Array<{ _id: { tabId: string; projectId: string } }>
  const byTab = new Map<string, string[]>()
  for (const { _id: { tabId, projectId } } of rows) byTab.set(tabId, [...byTab.get(tabId) ?? [], projectId])
  return byTab
}

export interface ReflectionPass { posted: number; already: number; empty: number; skipped: number; failed: number }

/** One pass: each candidate project whose report is due gets it. A failure is one project's: logged, the others go on. */
export async function reflectNightly(db: PrismaClient, store: Pick<SuperTabStore, 'postReflection'>, now: number,
  log: Pick<typeof logger, 'warn'> = logger): Promise<ReflectionPass> {
  const pass: ReflectionPass = { posted: 0, already: 0, empty: 0, skipped: 0, failed: 0 }
  for (const [tabId, projectIds] of await reflectionCandidates(db, now)) {
    try {
      const head = await db.swarmHead.findUnique({ where: { id: `${tabId}:head` }, select: { deleted: true, data: true } })
      const projects = head && !head.deleted ? (head.data as unknown as HeadData).projects ?? [] : []
      for (const project of projects.filter(p => projectIds.includes(p.id))) {
        const on = reflectionDue(project, now)
        if (!on) continue
        try {
          pass[await store.postReflection(tabId, project.id, on)]++
        } catch (error) {
          pass.failed++
          log.warn('[routing-reflection] a report failed; trying again on the next pass', { tabId, projectId: project.id,
            error: error instanceof Error ? error.message : String(error) })
        }
      }
    } catch (error) {
      pass.failed++
      log.warn('[routing-reflection] reading a Swarm failed; trying again on the next pass', { tabId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return pass
}

/** Runs a pass every [everyMs] in the singleton worker, never two at once. */
export function startRoutingReflection(db: PrismaClient, store: Pick<SuperTabStore, 'postReflection'>, everyMs = REFLECTION_EVERY_MS,
  now: () => number = Date.now): () => void {
  let running = false
  const run = () => {
    if (running) return
    running = true
    void reflectNightly(db, store, now()).then(pass => { if (pass.posted || pass.failed) logger.info('[routing-reflection] pass', { ...pass }) })
      .catch(error => logger.warn('[routing-reflection] pass failed', { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { running = false })
  }
  run()
  const timer = setInterval(run, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
