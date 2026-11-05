/**
 * What a PM spends of its account's week each day (Ken, 11-05, task #3222): the share an account a PM runs on keeps for it is
 * the days left until the account's weekly reset × that daily spend, in place of a fixed 20% (#3134).
 *
 * Sessions report tokens; quotas report a share of the week; nothing turns one into the other. So each machine's readings
 * keep, per engine and UTC day, how many points of its week the account used and what each running session spent at API
 * list prices (costs/prices.ts), both as the sum of each reading's rise over the one before. A day's used points are split
 * among the sessions by their part of that day's spend: price-weighted, so a long session's cheap cache reads do not swamp
 * it (River, 11-05). A fall is a fresh start, not a negative spend: a weekly reset, or a session started again.
 *
 * The ledger lives on the machine's part beside the Lent ledger (leaderboard/lent.ts) and moves with every reading: no write
 * of its own, never told to hosts (parts/commit.ts), and seen by no reader (model.ts visibleState). It keeps SPEND_DAYS days.
 */
import type { ContributedMachine, StoredReading } from './machines.js'
import { priceOf } from './costs/prices.js'
import type { TokensByModel } from './costs/tokens.js'

export const DAY_MS = 86_400_000
/** Days a machine keeps: the 7 a share averages over, and today. */
export const SPEND_DAYS = 8
/** Complete days a share needs before it replaces the fixed 20% (River, 11-05). */
export const MIN_SPEND_DAYS = 3
/** Complete days a share averages over at most: one week. */
export const SPEND_WINDOW_DAYS = 7

/** One engine's account on one UTC day: the week's used points (`seen`, the last reading; `used`, the day's rises) and each
 *  session's spend in US dollars at list prices, the same way. */
export interface SpendDay {
  day: number
  engine: string
  weekly: { seen: number; used: number }
  /** The weekly window's reset, as the day's last reading gave it. */
  resetsAt: number | null
  sessions: Record<string, { seen: number; spent: number }>
}

/** Which engine's subscription a model's tokens are spent from: Claude's or Codex's. Grid models spend none. */
const engineOf = (model: string): string | null => model.startsWith('claude-') ? 'claude' : model.startsWith('gpt-') ? 'codex' : null

/** A session's tokens at list prices, by engine; a model with no price is left out, never guessed (costs/prices.ts). */
function costsOf(tokens: TokensByModel): Map<string, number> {
  const costs = new Map<string, number>()
  for (const [model, t] of Object.entries(tokens)) {
    const engine = engineOf(model), price = priceOf(model)
    if (!engine || !price) continue
    costs.set(engine, (costs.get(engine) ?? 0) + (t.input * price.input + t.output * price.output + t.cacheRead * price.cacheRead
      + t.cacheWrite * price.cacheWrite) / 1e6)
  }
  return costs
}

/** A reset time as a reading gives it: seconds or milliseconds since the epoch, or a date. */
function resetMs(value: string | number | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string') { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null }
  return null
}

/** What rose since the last reading: a fall is a fresh start (a reset, a new session), counted from zero. */
const rise = (now: number, before: number | undefined) => before === undefined ? 0 : now >= before ? now - before : now

/** Adds [reading] to [pool]'s ledger: each engine with a weekly window, and the sessions whose models it pays for. */
export function addSpend(pool: ContributedMachine, reading: Pick<StoredReading, 'quotas'> & { harnessTokens?: Record<string, TokensByModel> },
  now: number): void {
  const today = Math.floor(now / DAY_MS) * DAY_MS
  const days = (pool.spendDays ?? []).filter(d => d.day > today - SPEND_DAYS * DAY_MS)
  const costs = Object.entries(reading.harnessTokens ?? {}).map(([harnessId, tokens]) => [harnessId, costsOf(tokens)] as const)
  for (const quota of reading.quotas ?? []) {
    const week = quota.known ? quota.windows.find(w => w.name === 'weekly') : undefined
    if (!week) continue
    const last = days.filter(d => d.engine === quota.engine).at(-1)
    let day = last?.day === today ? last : undefined
    if (!day) {
      day = { day: today, engine: quota.engine, weekly: { seen: week.usedPercent, used: 0 }, resetsAt: null, sessions: {} }
      days.push(day)
    }
    // The day before's last reading is today's first baseline: what was spent across midnight counts today.
    const before = last ?? day
    day.weekly.used += rise(week.usedPercent, before.weekly.seen)
    day.weekly.seen = week.usedPercent
    day.resetsAt = resetMs(week.resetsAt)
    for (const [harnessId, byEngine] of costs) {
      const cost = byEngine.get(quota.engine)
      if (cost === undefined) continue
      const was = day.sessions[harnessId] ?? (before.sessions[harnessId] ? { seen: before.sessions[harnessId]!.seen, spent: 0 } : undefined)
      day.sessions[harnessId] = { seen: cost, spent: (day.sessions[harnessId]?.spent ?? 0) + rise(cost, was?.seen) }
    }
  }
  days.sort((a, b) => a.day - b.day || (a.engine < b.engine ? -1 : 1))
  pool.spendDays = days
}

/** When [engine]'s weekly window resets on [pool], as its last reading said; null when it did not say. */
export function weeklyResetAt(pool: Pick<ContributedMachine, 'spendDays'>, engine: string): number | null {
  return (pool.spendDays ?? []).filter(d => d.engine === engine).at(-1)?.resetsAt ?? null
}

/**
 * The points of its account's week PM session [harnessId] spends a day, averaged over the last SPEND_WINDOW_DAYS complete
 * days it ran on, from [pools]: the PM's machine and the other pools on its subscription (a Mac and its Harness Team account).
 * A day counts when the account used some of its week and the sessions spent something. Null with fewer than
 * MIN_SPEND_DAYS such days: the caller keeps the fixed 20%.
 */
export function pmDailyShare(pools: Array<Pick<ContributedMachine, 'spendDays'>>, engine: string, harnessId: string, now: number):
  { share: number; days: number } | null {
  const today = Math.floor(now / DAY_MS) * DAY_MS
  const byDay = new Map<number, { used: number; pm: number; all: number }>()
  for (const pool of pools) for (const d of pool.spendDays ?? []) {
    if (d.engine !== engine || d.day >= today || d.day < today - SPEND_WINDOW_DAYS * DAY_MS) continue
    const entry = byDay.get(d.day) ?? { used: 0, pm: 0, all: 0 }
    // One subscription: each pool reads the same week, so the day's used points are its largest, not their sum.
    entry.used = Math.max(entry.used, d.weekly.used)
    for (const [id, s] of Object.entries(d.sessions)) {
      entry.all += s.spent
      if (id === harnessId) entry.pm += s.spent
    }
    byDay.set(d.day, entry)
  }
  const shares = [...byDay.values()].filter(d => d.used > 0 && d.all > 0 && d.pm > 0).map(d => d.used * d.pm / d.all)
  if (shares.length < MIN_SPEND_DAYS) return null
  return { share: shares.reduce((a, b) => a + b, 0) / shares.length, days: shares.length }
}
