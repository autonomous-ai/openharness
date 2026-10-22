/**
 * How loudly a finished turn tells the devices: rules first, Jev for the grey zone, a fallback when Jev
 * cannot answer in time (docs/superpowers/specs/2026-10-19-device-notify-tiers-design.md).
 */
import type { JevChoice, JevDecide } from './jev/jevClient.js'
import { JevUnavailable } from './jev/jevClient.js'

export type Tier = 'alert' | 'list' | 'silent'
export interface TierInput {
  agent: string; engine: string; recap: string
  durationS: number | null // null: unknown start
  stats: { testsPassed?: number; testsFailed?: number; commits?: number }
  subagent: boolean; onScreen: boolean; failed: boolean
}
export interface TierDecision { tier: Tier; by: string; detail: string; ms: number }

const WINDOW_MS = 30 * 60_000
const RECAP_MAX = 600
const LONG_TURN_S = 120

/** Whether a frame's `tier` is one: anything else is read as no tier at all. */
export const isTier = (value: unknown): value is Tier => value === 'alert' || value === 'list' || value === 'silent'

/** The rule when Jev cannot say: a turn that ran 120 s or more is worth a glance later, a shorter one is not. */
export const fallbackTier = (durationS: number | null): Tier => (durationS !== null && durationS >= LONG_TURN_S ? 'list' : 'silent')

const QUESTIONS: Record<string, JevChoice> = {
  tier: {
    type: 'choice',
    instructions: 'An AI coding agent just finished a turn while its owner was looking at something else. Choose how loudly to tell them.',
    criteria: {
      alert: 'A substantial result the person would want to know about now, such as a long task finished, a build or deploy done, or a requested deliverable ready. Less likely when recent already shows several alerts.',
      list: 'Real progress worth a glance later, such as a small feature or a fix with edits.',
      silent: 'Chatter, such as an acknowledgement, a short answer, a no-op, or a step inside a longer job.',
    },
  },
}

/**
 * What Jev is shown of a turn: four fields of text. Harness's hosted Jev takes nothing else (backend
 * routes/jevRoute.ts: `state` is a record of strings, four keys at most), and on 2026-10-21 every decision
 * there was refused with a 400 — the state carried numbers and nested objects — so every turn fell back
 * to the duration rule and none was ever an alert.
 */
export function tierState(input: TierInput, recent: { alerts: number; lists: number }): Record<string, string> {
  const { testsPassed, testsFailed, commits } = input.stats
  const turn = [
    input.durationS === null ? 'duration unknown' : `ran ${input.durationS} s`,
    ...(testsPassed !== undefined || testsFailed !== undefined ? [`tests ${testsPassed ?? 0} passed, ${testsFailed ?? 0} failed`] : []),
    ...(commits ? [`${commits} ${commits === 1 ? 'commit' : 'commits'}`] : []),
  ]
  return {
    agent: input.engine ? `${input.agent || 'an agent'} (${input.engine})` : input.agent || 'an agent',
    recap: input.recap.slice(0, RECAP_MAX),
    turn: turn.join('; '),
    recent: `${recent.alerts} alerts and ${recent.lists} list entries in the last 30 minutes`,
  }
}

/** Logs one decision line and the day's running count per tier, so the volume can be read from the log (no storage). */
export function createTally(log: (line: string) => void, now: () => number = Date.now): (agent: string, tier: Tier, by: string, detail: string, ms: number) => void {
  let day = ''
  const counts: Record<Tier, number> = { alert: 0, list: 0, silent: 0 }
  return (agent, tier, by, detail, ms) => {
    log(`notify · ${agent} · ${tier} · ${by} · ${detail} · ${ms}ms`)
    const today = new Date(now()).toLocaleDateString('sv')   // local YYYY-MM-DD, so a day matches the person's day
    if (today !== day) { day = today; counts.alert = counts.list = counts.silent = 0 }
    counts[tier]++
    log(`notify · day ${day} · alert ${counts.alert} · list ${counts.list} · silent ${counts.silent}`)
  }
}

export function createTierDecider(opts: {
  jev: JevDecide | null; now?: () => number; log: (line: string) => void; budgetMs?: number
  tally?: ReturnType<typeof createTally>
}): (input: TierInput) => Promise<TierDecision> {
  const tally = opts.tally ?? createTally(opts.log, opts.now)
  const now = opts.now ?? Date.now
  const budgetMs = opts.budgetMs ?? 1000
  const recent: { at: number; tier: Tier }[] = []

  const count = (tier: Tier) => {
    const from = now() - WINDOW_MS
    while (recent.length && recent[0].at <= from) recent.shift()
    return recent.filter((r) => r.tier === tier).length
  }

  return async (input) => {
    const start = now()
    const finish = (tier: Tier, by: string, detail: string): TierDecision => {
      const ms = Math.max(0, now() - start)
      if (tier !== 'silent') recent.push({ at: now(), tier })
      tally(input.agent, tier, by, detail, ms)
      return { tier, by, detail, ms }
    }
    const rule = (tier: Tier, name: string) => finish(tier, `rule:${name}`, name)
    if (input.failed) return rule('alert', 'failed')
    if (input.subagent) return rule('silent', 'subagent')
    if (input.onScreen) return rule('silent', 'onScreen')
    if (!input.recap.trim()) return rule('silent', 'empty')

    const fallback = (reason: string) =>
      finish(fallbackTier(input.durationS), `fallback:${reason}`, input.durationS === null ? 'duration unknown' : `${input.durationS}s`)
    if (!opts.jev) return fallback('off')

    const state = tierState(input, { alerts: count('alert'), lists: count('list') })
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => { abort.abort(); resolve('timeout') }, budgetMs) })
    try {
      const answers = await Promise.race([opts.jev(state, QUESTIONS, abort.signal), late])
      if (answers === 'timeout') return fallback('timeout')
      const answer = answers.tier
      if (!answer || !(answer.choice in QUESTIONS.tier.criteria)) return fallback('no-answer')
      const p = Object.entries(answer.probabilities).map(([k, v]) => `${k}=${Number(v).toFixed(2)}`).join(',')
      return finish(answer.choice as Tier, 'jev', `p=${p}`)
    } catch (error) {
      return fallback(error instanceof JevUnavailable ? error.code : 'error')
    } finally {
      clearTimeout(timer)
    }
  }
}
