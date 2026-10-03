// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

/**
 * Spend brake: token and dollar caps per agent, per machine and per day that pause a pane instead of
 * letting an overnight Loop run up a bill. The daemon already counts tokens per agent
 * (lib/agentTokenUsage.ts) but has no price table and nothing that stops; this is both, pure.
 */
export interface PriceUsdPerMillion { input: number; output: number }

/** Rough list prices, USD per million tokens, by model family substring. First match wins. */
export const DEFAULT_PRICES: Array<{ match: string; price: PriceUsdPerMillion }> = [
  { match: 'opus', price: { input: 15, output: 75 } },
  { match: 'sonnet', price: { input: 3, output: 15 } },
  { match: 'haiku', price: { input: 0.8, output: 4 } },
  { match: 'gpt-5', price: { input: 1.25, output: 10 } },
  { match: 'o3', price: { input: 2, output: 8 } },
  { match: 'codex', price: { input: 1.5, output: 6 } },
  { match: 'grok', price: { input: 3, output: 15 } },
  { match: 'gemini', price: { input: 1.25, output: 10 } },
  { match: 'kimi', price: { input: 0.6, output: 2.5 } },
  { match: 'local', price: { input: 0, output: 0 } },
  { match: 'ollama', price: { input: 0, output: 0 } },
]
export const FALLBACK_PRICE: PriceUsdPerMillion = { input: 3, output: 15 }

export function priceFor(model: string | null | undefined, table = DEFAULT_PRICES): PriceUsdPerMillion {
  const m = (model ?? '').toLowerCase()
  for (const row of table) if (m.includes(row.match)) return row.price
  return FALLBACK_PRICE
}

export function estimateUsd(tokens: { input: number; output: number }, price: PriceUsdPerMillion): number {
  return (tokens.input * price.input + tokens.output * price.output) / 1_000_000
}

export interface SpendCaps {
  version: 1
  enabled: boolean
  /** Per agent for its lifetime. */
  perAgentUsd: number | null
  perAgentTokens: number | null
  /** Per machine per local calendar day. */
  perDayUsd: number | null
  perDayTokens: number | null
  /** Warn at this fraction of any cap (0.8 = 80 percent). */
  warnAt: number
}

export const DEFAULT_CAPS: SpendCaps = { version: 1, enabled: false, perAgentUsd: null, perAgentTokens: null, perDayUsd: null, perDayTokens: null, warnAt: 0.8 }

export interface AgentSpend { agentId: string; model: string | null; input: number; output: number; usd: number; updatedAt: number }

export interface BrakeVerdict {
  action: 'run' | 'warn' | 'pause'
  reason: string
  agentUsd: number
  dayUsd: number
  /** 0..1 of the tightest cap consumed; > 1 when over. */
  fraction: number
}

export interface SpendLedger {
  day: string
  agents: Record<string, AgentSpend>
}

/** The calendar day a reading belongs to, in this machine's own time zone unless one is named. */
export function dayKey(now: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', { ...(timeZone ? { timeZone } : {}), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
}

export function emptyLedger(now: number, timeZone?: string): SpendLedger { return { day: dayKey(now, timeZone), agents: {} } }

/** Fold a usage reading into the ledger, starting a new day when the calendar turns. */
export function recordUsage(ledger: SpendLedger, reading: { agentId: string; model: string | null; input: number; output: number; now: number }, prices = DEFAULT_PRICES, timeZone?: string): SpendLedger {
  const day = dayKey(reading.now, timeZone)
  const base = ledger.day === day ? ledger : emptyLedger(reading.now, timeZone)
  const usd = estimateUsd({ input: reading.input, output: reading.output }, priceFor(reading.model, prices))
  return { ...base, agents: { ...base.agents, [reading.agentId]: { agentId: reading.agentId, model: reading.model, input: reading.input, output: reading.output, usd, updatedAt: reading.now } } }
}

export function dayTotals(ledger: SpendLedger): { usd: number; tokens: number } {
  let usd = 0, tokens = 0
  for (const a of Object.values(ledger.agents)) { usd += a.usd; tokens += a.input + a.output }
  return { usd, tokens }
}

/** Should this agent's next turn run, run with a warning, or be paused? */
export function decideSpend(caps: SpendCaps, ledger: SpendLedger, agentId: string): BrakeVerdict {
  const agent = ledger.agents[agentId]
  const agentUsd = agent?.usd ?? 0
  const agentTokens = agent ? agent.input + agent.output : 0
  const day = dayTotals(ledger)
  if (!caps.enabled) return { action: 'run', reason: 'brake disabled', agentUsd, dayUsd: day.usd, fraction: 0 }
  const fractions: Array<[number, string]> = []
  if (caps.perAgentUsd) fractions.push([agentUsd / caps.perAgentUsd, `agent at $${agentUsd.toFixed(2)} of $${caps.perAgentUsd}`])
  if (caps.perAgentTokens) fractions.push([agentTokens / caps.perAgentTokens, `agent at ${agentTokens} of ${caps.perAgentTokens} tokens`])
  if (caps.perDayUsd) fractions.push([day.usd / caps.perDayUsd, `machine at $${day.usd.toFixed(2)} of $${caps.perDayUsd} today`])
  if (caps.perDayTokens) fractions.push([day.tokens / caps.perDayTokens, `machine at ${day.tokens} of ${caps.perDayTokens} tokens today`])
  if (!fractions.length) return { action: 'run', reason: 'no caps set', agentUsd, dayUsd: day.usd, fraction: 0 }
  const [fraction, reason] = fractions.reduce((a, b) => (b[0] > a[0] ? b : a))
  if (fraction >= 1) return { action: 'pause', reason: `paused: ${reason}`, agentUsd, dayUsd: day.usd, fraction }
  if (fraction >= caps.warnAt) return { action: 'warn', reason: `warning: ${reason}`, agentUsd, dayUsd: day.usd, fraction }
  return { action: 'run', reason, agentUsd, dayUsd: day.usd, fraction }
}

export function parseCaps(raw: unknown): { ok: true; caps: SpendCaps } | { ok: false; problems: string[] } {
  const problems: string[] = []
  if (!raw || typeof raw !== 'object') return { ok: false, problems: ['caps must be an object'] }
  const c = raw as Record<string, unknown>
  if (c.version !== 1) problems.push('version must be 1')
  if (typeof c.enabled !== 'boolean') problems.push('enabled must be a boolean')
  for (const k of ['perAgentUsd', 'perAgentTokens', 'perDayUsd', 'perDayTokens'] as const) {
    if (c[k] !== null && !(typeof c[k] === 'number' && c[k] >= 0)) problems.push(`${k} must be null or a non-negative number`)
  }
  if (!(typeof c.warnAt === 'number' && c.warnAt > 0 && c.warnAt <= 1)) problems.push('warnAt must be in (0, 1]')
  return problems.length ? { ok: false, problems } : { ok: true, caps: raw as SpendCaps }
}
