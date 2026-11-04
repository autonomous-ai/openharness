/**
 * API list prices, in US dollars per million tokens, for the models Swarm attempts run on: what an attempt would have cost
 * on the API (costs/cost.ts). Reviewed by hand; each row names its source and the day it was read. A model not listed has
 * no cost, never a guessed one. To add or update one, read its provider's own price page and change its row here.
 *
 * - Cache writes are the 5-minute rate: transcripts do not say which cache a write went to, so 1-hour writes count low.
 * - Claude Haiku 5.5 is left out on purpose: its rate doubles past 100,000 prompt tokens, which the counts cannot tell.
 * - gpt-6.1-sol and gpt-6-astra are their rates up to 272K input tokens; longer prompts cost more. Their cache writes are the
 *   30-minute rate.
 * - Grid models are priced at OpenRouter's rates, which is how the Swarm reaches them (Lead, 2026-10-29). DeepSeek's
 *   off-peak hours are half this rate, so its cost is an upper bound.
 */
export interface ModelPrice {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  source: string
  /** The day the source was read, YYYY-MM-DD. */
  checked: string
}

const ANTHROPIC = 'https://platform.claude.com/docs/en/about-claude/pricing'
const OPENAI = 'https://developers.openai.com/api/docs/pricing'
const OPENROUTER = 'https://openrouter.ai/api/v1/models'

export const PRICES: readonly ModelPrice[] = [
  { model: 'claude-fable-5-1', input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, source: ANTHROPIC, checked: '2026-10-29' },
  { model: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, source: ANTHROPIC, checked: '2026-10-29' },
  { model: 'claude-sonnet-5-5', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, source: ANTHROPIC, checked: '2026-10-29' },
  { model: 'gpt-6.1-sol', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, source: OPENAI, checked: '2026-10-29' },
  { model: 'gpt-6-astra', input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, source: OPENAI, checked: '2026-10-30' },
  { model: 'moonshotai/kimi-k3', input: 0.192, output: 20, cacheRead: 0.182, cacheWrite: 0, source: OPENROUTER, checked: '2026-10-29' },
  { model: 'deepseek/deepseek-v4.1-flash-1017', input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0, source: OPENROUTER, checked: '2026-10-29' },
]

const byModel = new Map(PRICES.map(p => [p.model, p]))
/** A model's price by its exact id, or by a dated release of it (`claude-opus-5-5-20261001`). */
export const priceOf = (model: string): ModelPrice | undefined => byModel.get(model) ?? byModel.get(model.replace(/-\d{8}$/, ''))
