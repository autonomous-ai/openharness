/**
 * The leaderboard's three routes (backend routes/superTabs.ts), the `data` of the usual envelope. Desktop (`desktop/lib/super_tabs/
 * leaderboard`) and the daemon (`cli/src/superTabs/shipping.ts`) mirror them by hand. Times are epoch milliseconds; a week is its
 * Monday 00:00 UTC. Nothing here names a title, branch, path or the repository of what shipped: counts only.
 */
import { z } from 'zod'
import { PRIORITIES } from './score.js'
import { weekStart } from './week.js'

/** Why a daemon could not read GitHub: the codes of the CLI's `gh` errors (lib/github.ts ghError), and its own bound on a week. */
export const READ_FAILURES = ['GH_MISSING', 'GH_SIGNED_OUT', 'RATE_LIMITED', 'TIMEOUT', 'GH_FAILED', 'TOO_MANY'] as const
export type ReadFailure = typeof READ_FAILURES[number]

/** What a report may claim, per priority and agent and week: no agent comes near it, and the server cannot check GitHub. */
export const MAX_SHIPPED = 1_000
export const MAX_AGENTS_REPORTED = 100
/** Weeks of rows kept: this one and the four before it. The board reads this one and the three before it. */
export const WEEKS_KEPT = 5
export const WEEKS_READABLE = 4
/** How far back a reading may start: a new agent starts BACKFILL_WEEKS back, a daemon away longer loses the rest. */
export const BACKFILL_WEEKS = 4
export const MAX_RANGE_WEEKS = 8
/** The most Swarms and repositories one daemon is told of. */
export const MAX_SWARMS = 100
export const MAX_REPOSITORIES = 20
/** What one agent's week may weigh (score.ts WEIGHT): 100 is fifty P2 issues. A report claiming more is cut to it, highest
 *  priorities first: nothing is refused, so a busy agent still reads true, and noise cannot buy more than ten points a week. */
export const WEEK_CAP = 100
/** How long after the seventh day a week stays open to a revert, for a report that was read before the week ended. */
export const SETTLE_SLACK_MS = 60 * 60_000
/** The board lists this many people, best first, and always the reader. */
export const MAX_LISTED = 200

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/)
const monday = z.number().int().nonnegative().safe().refine(week => weekStart(week) === week, 'Name a week by its Monday 00:00 UTC.')
const count = z.number().int().min(0).max(MAX_SHIPPED).optional()
const weekCounts = z.object({ week: monday, ...Object.fromEntries(PRIORITIES.map(priority => [priority, count])) as Record<typeof PRIORITIES[number], typeof count> }).strict()
const reading = z.object({ agentId: id, name: z.string().trim().min(1).max(160), from: monday, weeks: z.array(weekCounts).max(MAX_RANGE_WEEKS + 1)
  .refine(weeks => new Set(weeks.map(w => w.week)).size === weeks.length, 'Name each week once.') }).strict()
const failure = z.object({ agentId: id, failed: z.enum(READ_FAILURES) }).strict()
/** A daemon's report for one Swarm: for each agent, either everything it shipped from `from` to now, or why it could not read. */
export const reportBody = z.object({ tabId: id, agents: z.array(z.union([reading, failure])).min(1).max(MAX_AGENTS_REPORTED)
  .refine(agents => new Set(agents.map(a => a.agentId)).size === agents.length, 'Name each agent once.') }).strict()
export type ReportBody = z.infer<typeof reportBody>

/** `?week=` a Monday, this one or one of the three before it, or `?all=1` for all time; neither is this week. */
export const boardQuery = z.object({ week: z.coerce.number().int().nonnegative().safe().optional(), all: z.literal('1').optional() }).strict()
  .refine(query => query.week === undefined || query.all === undefined, 'Ask for a week or all time, not both.')
export type BoardQuery = z.infer<typeof boardQuery>

/** `GET /hosts/:machineId/shipping`: for each Swarm of this machine where the signed-in person has agents, what to read. `from`
 *  is the first week still open to a revert (a new agent's is BACKFILL_WEEKS back); read every issue closed since then. */
export interface ShippingTargets {
  swarms: Array<{ tabId: string; repositories: string[]; agents: Array<{ id: string; name: string; from: number }> }>
}
/** `POST /hosts/:machineId/shipping`: how many agents' reports were stored, how many were not the sender's to report, and how many
 *  weeks were cut to WEEK_CAP. */
export interface ShippingReported { applied: number; skipped: number; capped: number }

/** `GET /:tabId/shipping`: everyone with an agent shipping in the week (or ever), best first. Nobody else is listed. `failures`
 *  are the reader's own computers whose reading failed, which nobody else is told. */
export interface ShippingBoard {
  week: number | null
  people: Array<{ personId: string; displayName: string; agentsShipping: number; level: number; points: number; rank: number }>
  failures: Array<{ machineId: string; code: ReadFailure }>
}
