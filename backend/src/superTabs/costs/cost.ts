/** What an attempt cost: its tokens (costs/attempts.ts) at the list prices (costs/prices.ts). */
import { attemptTokens, type RouteRun } from './attempts.js'
import { priceOf } from './prices.js'

export interface AttemptCost {
  /** What its tokens would have cost on the API, in US dollars; 0 on the Swarm's own GPUs; null when not known. */
  apiCost: number | null
  /** Money actually spent per token: its API cost when it paid per token, 0 on a plan or own GPUs, null when not known. */
  spend: number | null
  /** How the cost was found: list prices, own hardware, or why there is none (a model without a price, no token reading). */
  priced: 'list' | 'own-hardware' | 'unpriced-model' | 'no-tokens'
}

/** `fresh`: the agent was started for this attempt, so with no start reading its tokens count from zero (attemptTokens). */
export function attemptCost(run: RouteRun, fresh: boolean): AttemptCost {
  if (run.billing === 'own-hardware') return { apiCost: 0, spend: 0, priced: 'own-hardware' }
  const used = attemptTokens(run, fresh)
  if (!used) return { apiCost: null, spend: null, priced: 'no-tokens' }
  let apiCost = 0
  for (const [model, t] of Object.entries(used)) {
    // A grid model's transcript names whatever its API answered as; the Swarm knows which model it started.
    const price = priceOf(run.grid ?? model)
    if (!price) return { apiCost: null, spend: null, priced: 'unpriced-model' }
    apiCost += (t.input * price.input + t.output * price.output + t.cacheRead * price.cacheRead + t.cacheWrite * price.cacheWrite) / 1e6
  }
  const spend = run.billing === 'api' ? apiCost : run.billing === 'subscription' ? 0 : null
  return { apiCost, spend, priced: 'list' }
}
