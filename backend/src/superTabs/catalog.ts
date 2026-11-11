/**
 * The model catalog (design docs/plans/2026-10-30-project-instructions-design.md, Routing): a reviewed, read-only list of
 * each engine's models and the efforts offered, with a strength from 1 to 3 and a relative cost. The tab's routing-policy
 * read serves it beside the benchmark priors and the prices, so one read serves the CLI's route; the built-in routing
 * policy older CLIs read is made from the same rows (routingPolicy.ts). Adding a model is a data change here, with its
 * prior (benchmarkPriors/data.ts) and its price (costs/prices.ts). A project that wants a model treated differently says so
 * in the Routing section of its instructions; nothing an owner saves changes these rows.
 */
import { BENCHMARK_PRIORS } from './benchmarkPriors/data.js'
import type { PriorsTable } from './benchmarkPriors/priors.js'
import { PRICES, type ModelPrice } from './costs/prices.js'

/** One model at one effort. `offered`: the route offers it when nobody names a model; a row not offered is still rated, for
 *  a person who names it. `cost` ranks rows of equal strength (lower first); it is not a price. `engineDefault` marks the row a
 *  start runs when it asks the engine for `default`: the catalog names the model, never the account's own CLI setting (task
 *  #2972: `default default` ran gpt-6-luna on one owner's Mac, which no row rates). */
export interface CatalogModel { engine: 'claude' | 'codex'; model: string; effort: string; strength: 1 | 2 | 3; cost: number; offered: boolean; engineDefault?: true; note?: string }
/** How strong a model served on the Swarm's grid counts: the first named row whose every word is in its id or label, else
 *  `strength` (the CLI's route, superTabs/route.ts gridStrength). */
export interface CatalogGrid { strength: number; models: ReadonlyArray<{ model: string; strength: number }> }

const NOT_OFFERED = 'Not offered by default: no agent runs on Claude Haiku, and none below high effort (Ken, 2026-11-02).'

export const MODEL_CATALOG: { models: readonly CatalogModel[]; grid: CatalogGrid } = {
  models: [
    { engine: 'claude', model: 'opus', effort: 'high', strength: 3, cost: 3, offered: true },
    // Opus 5.5 at xhigh, as the coordinator runs (BUILT_IN_ROLE_DEFAULTS.lead): the same price per token as at high, more
    // thinking per task, so dearer; at equal strength the route keeps choosing high unless the instructions ask for more.
    { engine: 'claude', model: 'opus', effort: 'xhigh', strength: 3, cost: 4, offered: true },
    // Codex's default model, named: GPT-6.1 Sol scores 58.18 on Terminal-Bench 4.0 in Codex (benchmarkPriors/data.ts) and
    // costs Sonnet's API rate (costs/prices.ts). There is no `default default` row: 95% of Codex candidates were that row and
    // 67 of 71 Codex picks (Ken, 2026-11-04), and it ran whatever the account's CLI chose. A start that asks Codex for `default`
    // runs this row (commands.ts agent.start); gpt-6-luna, which an account's CLI chose, has no rating and so no row.
    { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', strength: 3, cost: 2, offered: true, engineDefault: true },
    // Big builds run on Opus high or Astra xhigh (the owners' standing decision). Its API rate is five times Sol's and 2.5
    // times Opus's, so it costs 5, after Opus at xhigh: at equal strength the route keeps choosing Opus high first.
    { engine: 'codex', model: 'gpt-6-astra', effort: 'xhigh', strength: 3, cost: 5, offered: true },
    // Small work (a small feature, a fix, docs, tests) runs on Sonnet or Sol, at high effort, nothing below it (Ken,
    // 2026-11-02; 2026-10-30 had turned Sonnet off). Big or risky work stays on Opus or Astra.
    { engine: 'claude', model: 'sonnet', effort: 'high', strength: 2, cost: 2, offered: true },
    { engine: 'claude', model: 'haiku', effort: 'auto', strength: 1, cost: 1, offered: false, note: NOT_OFFERED },
  ],
  // Grid models are free but weaker. Kimi K3 and DeepSeek v4.1 do Sonnet's work (Ken, 2026-10-29); any other counts 1.
  grid: { strength: 1, models: [{ model: 'kimi k3', strength: 2 }, { model: 'deepseek v4.1', strength: 2 }] },
}

/** What the tab's routing-policy read serves under `catalog`. */
export interface CatalogRead { models: readonly CatalogModel[]; grid: CatalogGrid; priors: PriorsTable; prices: readonly ModelPrice[] }

/** The model and effort a start runs when it asks [engine] for `default`, or null when the catalog names none (Claude). */
export function namedDefault(engine: string): { model: string; effort: string } | null {
  const row = MODEL_CATALOG.models.find(m => m.engine === engine && m.engineDefault)
  return row ? { model: row.model, effort: row.effort } : null
}

export function catalogRead(): CatalogRead {
  return { models: MODEL_CATALOG.models, grid: MODEL_CATALOG.grid, priors: BENCHMARK_PRIORS, prices: PRICES }
}
