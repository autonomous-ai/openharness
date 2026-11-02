/**
 * How loudly a finished turn tells the devices, by fixed rules and no model: a harness agent's turn alerts, a Swarm
 * agent's is silent because the Swarm tells its news through chat cards
 * (docs/superpowers/specs/2026-11-02-device-notify-no-jev-design.md).
 */

export type Tier = 'alert' | 'list' | 'silent'
export interface TierInput {
  agent: string; engine: string; recap: string
  durationS: number | null // null: unknown start
  stats: { testsPassed?: number; testsFailed?: number; commits?: number }
  subagent: boolean; onScreen: boolean; failed: boolean
  swarm: boolean // a Swarm agent (registry row with swarmSkill, or a Team machine)
}
export interface TierDecision { tier: Tier; by: string; detail: string; ms: number }

const LONG_TURN_S = 120

/** Whether a frame's `tier` is one: anything else is read as no tier at all. */
export const isTier = (value: unknown): value is Tier => value === 'alert' || value === 'list' || value === 'silent'

/** The rule for a decision superseded before it lands (lib/commander.ts): a turn that ran 120 s or more is worth a glance later, a shorter one is not. */
export const fallbackTier = (durationS: number | null): Tier => (durationS !== null && durationS >= LONG_TURN_S ? 'list' : 'silent')

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
  now?: () => number; log: (line: string) => void; tally?: ReturnType<typeof createTally>
}): (input: TierInput) => Promise<TierDecision> {
  const tally = opts.tally ?? createTally(opts.log, opts.now)
  const now = opts.now ?? Date.now

  return async (input) => {
    const start = now()
    const rule = (tier: Tier, name: string): TierDecision => {
      const ms = Math.max(0, now() - start)
      tally(input.agent, tier, `rule:${name}`, name, ms)
      return { tier, by: `rule:${name}`, detail: name, ms }
    }
    if (input.failed) return rule('alert', 'failed')
    if (input.subagent) return rule('silent', 'subagent')
    if (input.onScreen) return rule('silent', 'onScreen')
    if (!input.recap.trim()) return rule('silent', 'empty')
    return input.swarm ? rule('silent', 'swarm') : rule('alert', 'turn')
  }
}
