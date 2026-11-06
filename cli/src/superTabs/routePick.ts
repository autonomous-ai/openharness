/**
 * The route's pick (task #3576, anh Dee 11-06: a rule that can be checked runs as code, not as a prompt the PM follows by
 * hand). The project's Routing order, "Order and quota", applied to the candidates the route shows:
 *   1. what the work needs: a model strong enough (Sonnet or Sol at high effort for small work, a grid model first when one is
 *      offered; Opus high or Astra xhigh for big, hard or risky work and for reviews, never a grid model for a review);
 *   2. every account with weekly quota left: the one resetting soonest, then the one with the most left; a big task needs 5%
 *      left, small work, a review or a test 2%, and an account that runs a PM takes no new work under 20%;
 *   3. an idle agent is reused only between candidates equal so far, except the same reviewer for its next round and work that
 *      follows straight on from what the agent just did (its earlier work on this task);
 *   4. between equals, the machine with fewer agents working, then price.
 * Pure: the route's own facts in, a pick and one reason per step out. The machine rules (hours off, phone work, an engine
 * forbidden on a Mac) are refusals the route makes before this runs; they are not ranked here.
 */
import { runsPm } from './pmAccounts.js'
import { fitRank, tierOf, weekly, type Assessment, type Catalog, type Shown, type Tier } from './route.js'

const D = 86_400_000, H = 3_600_000
/** Weekly quota an account needs left to take a big task, and small work, a review or a test (the Routing order). */
export const BIG_NEEDS = 5, SMALL_NEEDS = 2
/** Below this much weekly quota left, an account that runs a PM takes no new work. */
export const PM_RESERVE = 20

/** Efforts below high, which no agent runs at. */
const BELOW_HIGH = new Set(['minimal', 'low', 'medium'])

/** `first`: the machines the task's lane goes to first by the project's machine rules (machineRules.ts), and why. */
export interface PickInput { shown: readonly Shown[]; catalog: Catalog; assessment: Assessment; now: number; conversationId: string
  first?: { machines: ReadonlySet<string>; why: string } }
export interface Picked { id: string; reasons: string[] }

const kindIs = (a: Assessment, word: string) => new RegExp(`(^|-)${word}(-|$)`).test(a.kind ?? '')
const pct = (n: number) => `${Math.round(n)}%`
const span = (ms: number) => ms >= D ? `${Math.round(ms / D)}d` : `${Math.max(1, Math.round(ms / H))}h`

interface Ranked { p: Shown; need: number; left: number | null; resetsAt: number | null; follows: boolean }

export function pickByOrder({ shown, catalog, assessment: a, now, conversationId, first }: PickInput): Picked | null {
  const tier: Tier | null = tierOf(a)
  const review = kindIs(a, 'review'), test = kindIs(a, 'test')
  const named = !!a.model || !!a.local
  const big = !review && !test && tier === 'strong'
  const needs = big ? BIG_NEEDS : SMALL_NEEDS

  // 1. What the work needs. A person naming a model, or asking for a local one, has already narrowed the candidates.
  const fits = shown.flatMap((p): Ranked[] => {
    const { left, resetsAt } = weekly(p.quota)
    const follows = p.kind === 'member' && !!p.earlier?.some(e => e.groupId === conversationId)
    // No agent runs below high effort, and none on Haiku (the Routing order, Models), unless a person named the model.
    if (!named && !p.gridModel && (BELOW_HIGH.has(p.effort.toLowerCase()) || /haiku/i.test(p.model))) return []
    let need: number
    if (named) need = 0
    else if (p.gridModel) {
      if (review || tier === 'strong') return []
      // Small work goes first to a grid model when one is offered (free, Sonnet-level).
      need = tier === 'standard' ? -1 : 0
    } else if (tier === null) need = 0
    else {
      need = fitRank(p, catalog, tier)
      if (tier === 'strong' && need === 2) return []
    }
    return [{ p, need, left, resetsAt, follows }]
  })

  // 2. Quota: an account is used while it has the weekly quota the work needs; grid and metered models use no subscription,
  // and a reading that is missing does not rule an account out.
  const usable = fits.filter(r => {
    if (r.p.gridModel || r.p.quota.metered || r.left === null) return true
    return r.left >= needs && !(runsPm(r.p) && r.left < PM_RESERVE)
  })
  if (!usable.length) return null
  // The machine the work needs: a lane's first machine, while one there can take it (project's machine rules, task #3964).
  const there = first ? usable.filter(r => first.machines.has(r.p.machineId)) : []
  const placed = there.length ? there : usable
  const best = Math.min(...placed.map(r => r.need))
  const pool = placed.filter(r => r.need === best)

  const unread = (r: Ranked) => r.left === null ? 1 : 0
  const byAccount = (x: Ranked, y: Ranked) => unread(x) - unread(y) || (x.resetsAt ?? Infinity) - (y.resetsAt ?? Infinity) || (y.left ?? 0) - (x.left ?? 0)
  const agents = (r: Ranked) => r.p.load?.agents ?? 0
  const order = [...pool].sort((x, y) => Number(y.follows) - Number(x.follows) || byAccount(x, y)
    || Number(y.p.kind === 'member') - Number(x.p.kind === 'member') || agents(x) - agents(y) || x.p.cost - y.p.cost || x.p.id.localeCompare(y.p.id))
  const win = order[0]!

  const accounts = new Set(pool.map(r => r.p.fit.account)).size
  const sameAccountPosition = (r: Ranked) => byAccount(win, r) === 0
  const reasons = [
    `1. Need: ${win.p.title} ${win.p.gridModel ? 'is a grid model, free, for small work' : tier === null ? 'runs the work (no size given)'
      : win.need === 0 ? `is the ${tier === 'strong' ? (review ? 'strong model a review needs' : 'strong model for big, hard or risky work') : 'model for small work'}`
        : 'is the closest fit to the model the work needs'}.${there.length ? ` On ${win.p.machineName}, where this lane's work goes first: ${first!.why}.` : ''}`,
    win.p.gridModel || win.p.quota.metered ? '2. Quota: it uses no subscription.'
      : win.left === null ? `2. Quota: weekly unknown; no account with a reading has the ${pct(needs)} the work needs.`
        : `2. Quota: weekly ${pct(win.left)} left${win.resetsAt === null ? '' : `, resets in ${span(Math.max(0, win.resetsAt - now))}`}`
          + (accounts === 1 ? ': the only account with quota left.'
            : pool.some(r => r !== win && (r.resetsAt ?? Infinity) > (win.resetsAt ?? Infinity)) ? `: resets soonest of ${accounts} accounts.`
              : `: the most left of ${accounts} accounts resetting together.`),
    win.p.kind === 'member'
      ? `3. Idle: reuses ${win.p.name ?? 'the idle agent'}${win.follows ? ', which worked on this task before' : ', equal so far to a new agent'}.`
      : `3. Idle: a new agent; ${pool.some(r => r.p.kind === 'member' && !sameAccountPosition(r)) ? 'an idle agent is on a worse account' : 'no idle agent is equal so far'}.`,
    `4. Load and price: ${agents(win)} ${agents(win) === 1 ? 'agent' : 'agents'} working on ${win.p.machineName}, price ${win.p.cost}.`,
  ]
  return { id: win.p.id, reasons }
}
