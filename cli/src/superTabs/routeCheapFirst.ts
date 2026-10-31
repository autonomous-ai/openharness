/** Cheap first (Scholes's goals, piece 4; Ken, 2026-10-29): a small, low-risk build goes to a cheap model on the Swarm's grid
 *  (Kimi K3, DeepSeek v4.1) before Opus or Astra, and steps up to them once that attempt fails. Reviews and security work never
 *  run on the grid. A route plug-in (route.ts RoutePlugin): it ranks and leaves out grid candidates only, each with a reason
 *  people read, and leaves every subscription candidate and member as it was.
 *
 *  Since project instructions (#2414) the server no longer steps a task up, and only the server knew a grid attempt's first
 *  review failed. So the step-up is read from what the route already sees: a grid model takes only a task's first attempt
 *  (Lead, 2026-10-31), and any earlier assignment, start or routed pick for the task means the next route leaves the grid out.
 *  That works with today's backend; a step-up the backend records on the task (`stepUp`) is read too, for its reason. */
import type { Assessment, RoutePlugin } from './route.js'
import type { PluginMaker } from './routePlugins.js'

type Json = Record<string, unknown>
const object = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}
const list = (v: unknown) => Array.isArray(v) ? v.map(object) : []
const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null
/** A review task: one linked to the work it reviews. */
const isReview = (group: Json) => typeof group.reviewOf === 'string' && !!group.reviewOf

/** The plug-in's name, which starts each of its reasons on a candidate ("Cheap first: …"). */
export const CHEAP_FIRST = 'Cheap first'
/** How many owned paths a task may name and still be small enough for a grid model to try first (Lead, 2026-10-31: "a few
 *  owned files"). Every routed task names owned code and checks, so their presence says nothing on its own. */
export const MAX_OWNED = 3
/** The least strength a grid model needs to be tried first: the catalog's named grid rows (Kimi K3, DeepSeek v4.1) are 2; an
 *  unnamed grid model (a small local one) is 1 and is never moved up. */
const CHEAP_STRENGTH = 2
/** Kinds of work a grid model never takes, as the routing agent names them (route.ts Assessment.kind). */
const SECURITY_KINDS = new Set(['security', 'auth', 'privacy', 'secrets', 'crypto', 'permissions'])

export const GRID_FIRST = 'A small, low-risk build: a cheap model on the Swarm\'s grid tries it first. If its review fails or the attempt is lost, the next route steps up to a strong model.'
export const NEVER_REVIEWS = 'A review never runs on a model on the Swarm\'s grid: reviews need a strong model.'
export const NEVER_SECURITY = 'Security-sensitive work (a security kind or high risk) never runs on a model on the Swarm\'s grid.'
export const FIRST_ATTEMPT_ONLY = 'A model on the Swarm\'s grid takes only a task\'s first attempt, so this one steps up.'
export const EARLIER_UNREADABLE = 'Its earlier attempts could not be read, so it is not taken for a first attempt.'
const NAMED = 'A person named this model, so it is offered.'

/** What the plug-in needs of the task, read before the route (RoutePlugin: pure and synchronous). `earlier`: why this is not
 *  the task's first attempt, or null when it is. */
export interface CheapTask { review: boolean; owned: number; earlier: string | null }

/** What the route reads of [group]: whether it is a review (a task linked to the work it reviews), how many owned paths it
 *  names, and any earlier attempt at it. [history] is the route's read of the log and the group's attempts (service.ts
 *  routeHistory), null when it failed: an attempt it cannot rule out counts as one, so a grid model is never sent back to a
 *  task that already failed on it because a read timed out. */
export function cheapTaskOf(group: Json, state: Json, history: { decisions: unknown[] | null; attempts: unknown[] | null } | null): CheapTask {
  const id = group.id, owns = object(group.task).owns
  const starts = list(state.starts)
  const harnessOf = new Map(list(state.agents).map(agent => [agent.id, agent.harnessId]))
  /** The grid model an agent was started on, if it was. */
  const gridOf = (agentId: unknown) => {
    const harness = harnessOf.get(agentId)
    return harness ? text(object(starts.find(s => s.harnessId === harness)?.request).gridModel) : null
  }
  const assignment = object(group.assignment), lost = object(group.lostAttempt)
  const mine = starts.filter(s => object(s.request).conversationId === id)
  const decisions = list(history?.decisions).filter(d => d.conversationId === id && d.final && typeof d.final === 'object')
  const attempts = list(history?.attempts).filter(a => typeof a.id === 'string')
  const agentIds = [assignment.agentId, lost.agentId, ...attempts.map(a => a.agentId)]
  const any = !!text(assignment.id) || !!text(lost.id) || mine.length > 0 || decisions.length > 0 || attempts.length > 0
  const onGrid = mine.map(s => text(object(s.request).gridModel)).find(Boolean) ?? agentIds.map(gridOf).find(Boolean)
  const stepped = text(object(group.stepUp).reason)
  const earlier = stepped ?? (onGrid ? `Its earlier attempt ran on ${onGrid} on the Swarm's grid.` : any ? 'It had an earlier attempt.'
    : !history || !history.decisions || !history.attempts ? EARLIER_UNREADABLE : null)
  return { review: isReview(group), owned: Array.isArray(owns) ? owns.filter(o => typeof o === 'string').length : 0, earlier }
}

/** Whether the task is one a grid model never takes: a review (a task linked to the work it reviews, or kind `review`), or
 *  security work (a security kind, or high risk). */
function forbidden(review: boolean, a: Pick<Assessment, 'kind' | 'risk'>): string | null {
  if (review || a.kind === 'review') return NEVER_REVIEWS
  if (a.risk === 'high' || (a.kind && SECURITY_KINDS.has(a.kind))) return NEVER_SECURITY
  return null
}

/** The guard's name, which starts its reasons ("Grid limits: …"). */
export const GRID_LIMITS = 'Grid limits'
/** Ken's rule, "never route reviews to cheap or local models", and the same for security work: a grid candidate is left out of
 *  either, even one a person names. The route itself has no such filter (project instructions, #2414), so this plug-in is the
 *  only place it lives. It is made from nothing but the task's own row, so it is ready at once and never depends on a read
 *  that could be late (Lead, 10-31). */
export function gridLimits(review: boolean): RoutePlugin {
  return {
    name: GRID_LIMITS,
    adjust(candidate, { assessment }) {
      const why = candidate.gridModel ? forbidden(review, assessment) : null
      return why ? { refuse: true, reason: why } : null
    },
  }
}

/** The ranking for one task, beside [gridLimits]: a grid candidate is left out of any attempt after the first unless a person
 *  named it, and ranked first for a small, low-risk build it is strong enough for: above the catalog's strongest, so it is
 *  tried before Opus and Astra while keeping the order among grid models. A review or security task is the guard's, so this
 *  says nothing of it. */
export function cheapFirst(task: CheapTask): RoutePlugin {
  return {
    name: CHEAP_FIRST,
    adjust(candidate, { assessment: a, catalog }) {
      if (!candidate.gridModel || forbidden(task.review, a)) return null
      if (task.earlier) {
        const why = `${FIRST_ATTEMPT_ONLY} ${task.earlier}`
        return a.model || a.local ? { reason: `${why} ${NAMED}` } : { refuse: true, reason: why }
      }
      const small = a.risk === 'low' && a.difficulty === 'low' && task.owned > 0 && task.owned <= MAX_OWNED
      if (!small || candidate.quality < CHEAP_STRENGTH) return null
      const top = Math.max(CHEAP_STRENGTH, ...catalog.models.map(m => m.strength))
      return { strength: top + 1 - CHEAP_STRENGTH, reason: GRID_FIRST }
    },
  }
}

/** The task's row in the tab the route read, or only its id when the tab does not list it. */
const groupIn = (read: Record<string, unknown>, conversationId: string) => {
  const state = object(object(read.tab).state)
  return { state, group: list(state.conversations).find(c => c.id === conversationId) ?? { id: conversationId } }
}

/** Makes [gridLimits] from the tab the route already read: no read of its own and nothing to wait for. */
export const GRID_LIMITS_MAKER: PluginMaker = {
  name: GRID_LIMITS,
  make: async ({ conversationId, read }) => gridLimits(isReview(groupIn(read, conversationId).group)),
}

/** How long the cheap-first maker waits for the route's history read: under the makers' limit (routePlugins.ts
 *  MAKER_TIMEOUT_MS), so the first-attempt check is made rather than dropped. A history later than this counts as
 *  unreadable, so the grid is left out of the attempt. */
export const HISTORY_WAIT_MS = 2000

/** Makes [cheapFirst] from the route's own reads: the task from the tab it read, and the shared history read. It reads
 *  nothing of its own and never fails: what it cannot read makes it leave the grid out of the attempt. */
export const CHEAP_FIRST_MAKER: PluginMaker = {
  name: CHEAP_FIRST,
  async make({ conversationId, read, history }) {
    const { state, group } = groupIn(read, conversationId)
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<null>(resolve => { timer = setTimeout(resolve, HISTORY_WAIT_MS, null) })
    const past = object(await Promise.race([history.catch(() => null), late]).finally(() => clearTimeout(timer)))
    const value = object(past.value)
    return cheapFirst(cheapTaskOf(group, state, past.ok !== true ? null
      : { decisions: Array.isArray(value.decisions) ? value.decisions : null, attempts: Array.isArray(value.attempts) ? value.attempts : null }))
  },
}

/** Piece 4's makers, in order: the guard first, ready at once, then the ranking. */
export const CHEAP_FIRST_MAKERS: readonly PluginMaker[] = [GRID_LIMITS_MAKER, CHEAP_FIRST_MAKER]
