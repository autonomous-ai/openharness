/** The window pull (Scholes's goals, piece 6: "token maxxing"): a subscription's weekly window that resets soon with quota
 *  left loses that quota at the reset, so the route spends it first. A candidate whose account would otherwise leave part of
 *  its weekly window unused is made cheaper by that part of the task, never stronger: a stronger model still ranks first, and
 *  a candidate the route leaves out stays out (route.ts RoutePlugin). The route's members are idle agents, so an idle agent on
 *  such an account takes the next queued task it can run.
 *
 *  The windows ride on the candidates (routeCommand.ts probeMachine reads them from each machine's last report; one older
 *  than 45 s is unknown quota, which this leaves alone). What it reads besides is the route history every maker shares: the
 *  routes picked and not yet started, which the route's own fit does not count yet. */
import { accountOf, SIZES, type Adjustment, type Commitment, type Fit, type Probe, type RoutePlugin, type Size } from './route.js'
import type { PluginInput, PluginMaker } from './routePlugins.js'

type Json = Record<string, unknown>
export const WINDOW_PULL = 'Window pull'
/** How close a weekly reset must be for the pull to judge it. Earlier in the week, this week's pace says little about what
 *  the rest of it will use: a quiet first day would pull every task onto one account. */
export const RESETS_SOON_MS = 48 * 3_600_000
/** Both engines' weekly windows are seven days long (cli superTabs/capacity.ts names a window of a day or more "weekly"). */
export const WEEK_MS = 7 * 86_400_000
/** Less than this many percent of a week left unused is a rounding error, not quota worth moving work for. */
export const MIN_UNUSED_PERCENT = 1
/** The most the pull takes off a candidate's price: half. An expiring window makes a choice look at most half as costly,
 *  never free, so a choice with a clearly better record (piece 3, measured cost and results) still beats one whose only edge
 *  is quota about to reset (Lead, 10-31). */
export const MAX_DISCOUNT = 0.5
/** How long a pick nobody has started or assigned yet still holds its account's quota. A route is acted on within minutes;
 *  one older than this was dropped, and holding quota for it would keep the window from pulling at all. */
export const PENDING_MS = 15 * 60_000

/** What [p]'s account would leave unused of its weekly window at its reset, in percent of that window, and how soon the reset
 *  is; null when it is not known or nothing would be left. The account is projected to keep this week's pace until the reset
 *  (what it has used, over the part of the week that is over), and the picks on it still at work or not yet started hold what
 *  they have yet to spend, as the route's own fit counts them (route.ts sizeUp), so once enough work is routed there it pulls
 *  no more. */
export function weeklyUnused(p: Probe, now: number, held: readonly Commitment[]): { unused: number; resetsIn: number } | null {
  // A model on the grid and a metered engine spend no subscription; an unknown reading says nothing.
  if (p.gridModel || p.quota.metered || !p.quota.known) return null
  const week = p.quota.windows?.find(w => w.name === 'weekly')
  if (!week || week.resetsAt === null) return null
  const resetsIn = week.resetsAt - now
  // A reset already past is a reading from before it: the window has refilled, and what it says is gone.
  if (resetsIn <= 0 || resetsIn > RESETS_SOON_MS) return null
  const pace = (100 - week.leftPercent) / (WEEK_MS - resetsIn)
  const account = accountOf(p)
  const committed = held.filter(c => c.account === account)
    .reduce((sum, c) => sum + (c.spend.weekly ?? 0) * Math.max(0, 1 - (now - c.createdAt) / (SIZES[c.size].minutes * 60_000)), 0)
  const unused = week.leftPercent - committed - pace * resetsIn
  return unused >= MIN_UNUSED_PERCENT ? { unused, resetsIn } : null
}

const round = (n: number) => Math.round(n * 100) / 100
/** A reset is told as how far away it is, as the route's labels tell it. */
const inTime = (ms: number) => ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : `${Math.round(ms / 3_600_000)}h`

/** The pull's word on one candidate: its price less up to half ([MAX_DISCOUNT]), by the part of the task its account's weekly
 *  window would otherwise leave unused. None on a candidate whose quota would run out partway (a 5-hour window too short):
 *  moving work there trades wasted weekly quota for a stalled task. The reason names the window, never the account or the
 *  machine a reading was relayed from, since every reader of the route log sees it. */
export function windowPullAdjust(p: Readonly<Probe & { fit: Fit }>, now: number, held: readonly Commitment[]): Adjustment | null {
  if (p.fit.status === 'short' || p.fit.spend.weekly <= 0 || p.fit.effectiveCost <= 0) return null
  const left = weeklyUnused(p, now, held)
  if (!left) return null
  const discount = p.fit.effectiveCost * MAX_DISCOUNT * Math.min(1, left.unused / p.fit.spend.weekly)
  const why = `its account's weekly window resets in ${inTime(left.resetsIn)}, and at this week's pace about ${Math.round(left.unused)}% of it would go unused`
  return { cost: -round(discount), reason: p.kind === 'member' ? `${why}; this idle agent takes queued work first` : `${why}; this task spends it first` }
}

/** The plug-in for one route. [pending]: picks of the Swarm's other routes not started or assigned yet, which the route's
 *  picks still at work (its context's `open`) do not hold yet: two routes a minute apart must not both pull onto one window. */
export function windowPull(pending: readonly Commitment[]): RoutePlugin {
  return { name: WINDOW_PULL, adjust: (p, context) => windowPullAdjust(p, context.now, [...context.open, ...pending]) }
}

const SIZE_NAMES = Object.keys(SIZES)
/** How far ahead of this machine's clock the server's may stamp a pick and still have it count. */
const SKEW_MS = 60_000
/** The picks in the route history that hold quota and are not in the route's own `open` yet: no outcome, not started or
 *  assigned (routeCommand.ts takes those that are), recorded in the last [PENDING_MS], and of another group (routing this
 *  group again supersedes its own, backend routeDecisions.ts writeRouteEffects). Null when the history could not be read. */
export function pendingPicks(history: Json | null, conversationId: string, now: number): Commitment[] | null {
  const value = history?.ok === true && history.value && typeof history.value === 'object' ? history.value as Json : null
  if (!value || !Array.isArray(value.decisions)) return null
  return value.decisions.flatMap((d: Json): Commitment[] => {
    const createdAt = Date.parse(String(d?.createdAt))
    if (!d || typeof d !== 'object' || d.final || d.outcome != null || d.conversationId === conversationId || typeof d.account !== 'string'
      || !SIZE_NAMES.includes(String(d.size)) || !d.spend || typeof d.spend !== 'object' || !(now - createdAt < PENDING_MS && createdAt - now < SKEW_MS)) return []
    const weekly = (d.spend as Json).weekly
    // The server's clock may run a little ahead of this machine's: a pick just made still holds all it will spend.
    return [{ account: d.account, size: d.size as Size, createdAt: Math.min(createdAt, now), spend: typeof weekly === 'number' && Number.isFinite(weekly) ? { weekly } : {} }]
  })
}

/** Its maker: the shared route history, for the picks not started yet. Without it the pull could not tell whether another
 *  route just pulled onto the same window, so it is left out, and the route answer says so (routePlugins.ts makePlugins). */
export function windowPullMaker(now: () => number = Date.now): PluginMaker {
  return { name: WINDOW_PULL, make: async (input: PluginInput) => {
    const pending = pendingPicks(await input.history, input.conversationId, now())
    if (!pending) throw new Error('the route history could not be read')
    return windowPull(pending)
  } }
}
