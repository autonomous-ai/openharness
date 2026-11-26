export interface Usage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number; cache_creation?: { ephemeral_5m_input_tokens?: number } }

/** What a row, error row or probe row billed: the agent's call and, when it was judged, the judge's. */
export interface Billed { model?: string | null; usage?: Usage; judge_model?: string | null; judge_usage?: Usage }

type Price = { in: number; out: number; cache_read: number }

// $ per million tokens: input and output from the claude-api skill's Current Models table (cached 2026-11-03); cache
// reads at each model's own rate, as Claude Code bills them (the spec checks a billed run's total_cost_usd).
export const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { in: 4, out: 20, cache_read: 0.2 },
}

// The guard must never count an unpriced call as free, so it bills one at the highest known rate of each kind.
const HIGHEST: Price = {
  in: Math.max(...Object.values(PRICES).map(p => p.in)),
  out: Math.max(...Object.values(PRICES).map(p => p.out)),
  cache_read: Math.max(...Object.values(PRICES).map(p => p.cache_read)),
}

/** Archived runs cost $0.32 at most, judge included; the late-need scenarios' longer runs and the crowd's longer
 *  prompt get room up to $1.50. */
export const RUN_RESERVE_USD = 1.5

function priceOf(model: string | null | undefined) {
  if (!model) return undefined
  // Longest matching prefix, as the runner accepts a served model that starts with the requested one.
  const key = Object.keys(PRICES).filter(k => model.startsWith(k)).sort((a, b) => b.length - a.length)[0]
  return key ? PRICES[key] : undefined
}

export function tokensOf(u: Usage | undefined): number {
  return (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0)
    + (u?.cache_creation_input_tokens ?? 0)
}

// A cache write bills by how long the cache keeps it: 1.25× input for 5 minutes, 2× for the hour Claude Code asks
// for. A write not known to be 5-minute, as in rows recorded before the split was kept, is priced as 1-hour.
function priced(p: Price, u: Usage): number {
  const writes = u.cache_creation_input_tokens ?? 0
  const fiveMinute = u.cache_creation?.ephemeral_5m_input_tokens ?? 0
  return (p.in * ((u.input_tokens ?? 0) + 1.25 * fiveMinute + 2 * (writes - fiveMinute))
    + p.cache_read * (u.cache_read_input_tokens ?? 0) + p.out * (u.output_tokens ?? 0)) / 1e6
}

/** Dollars for one call; null when billed tokens have no price. */
export function costOf(model: string | null | undefined, u: Usage | undefined): number | null {
  if (!tokensOf(u)) return 0
  const p = priceOf(model)
  return p ? priced(p, u!) : null
}

/** Dollars for a row's agent and judge calls, an unpriced one at the highest known price. */
export function guardCost(b: Billed): number {
  const one = (model: string | null | undefined, u: Usage | undefined) => costOf(model, u) ?? priced(HIGHEST, u!)
  return one(b.model, b.usage) + one(b.judge_model, b.judge_usage)
}

/** Keeps a pass under its cap: a case or probe starts only while a reserve for it and for each one in flight fits. */
export class SpendGuard {
  readonly #cap: number
  #spent: number
  constructor(capUsd: number, spentUsd: number) { this.#cap = capUsd; this.#spent = spentUsd }
  get spentUsd(): number { return this.#spent }
  mayStart(inFlight: number): boolean { return this.#spent + (inFlight + 1) * RUN_RESERVE_USD <= this.#cap }
  /** Adds what `b` cost less the `counted` dollars of it already added (a case's failed attempts, added as they happen,
   *  so a retry is weighed against them), and returns what it added. */
  add(b: Billed, counted = 0): number {
    const usd = guardCost(b) - counted
    this.#spent += usd
    return usd
  }
}
