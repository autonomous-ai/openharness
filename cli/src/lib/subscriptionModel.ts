/**
 * Putting an agent back on its own login, ON THE MODEL IT WAS USING BEFORE.
 *
 * Moving an agent to a grid and back is not symmetric, and the asymmetry is invisible until you do
 * it. Going TO a grid sets the endpoint AND the model. Coming back clears both — and the engine then
 * restores whatever its OWN session file remembers, which is the grid's model. Measured on Claude
 * Code: after a switch back it said
 *
 *   Session model Qwen3.6-35B-A3B-UD-Q5_K_XL could not be restored (not a model this version of
 *   Claude Code recognizes) — using opus instead.
 *
 * The engine picked a house default, which is the one thing the harness must not let it do on the
 * user's behalf: the person had a model before, and coming back should return them to it rather
 * than to whatever the vendor considers reasonable. So the model in use is remembered when an agent
 * leaves for a grid, and re-selected when it comes back.
 *
 * ## Why this is its own table rather than a flag on the grid contract
 *
 * A grid launch answers "where do requests go, with which credential, for which model". This answers
 * only the last third, against the vendor's own endpoint. They share no fields, and the mechanisms
 * genuinely differ per engine — Claude Code reads an environment variable while Codex and Hermes
 * resolve the interactive CLI's model from argv.
 *
 * ## An engine with no entry gets nothing, deliberately
 *
 * The alternative to a cited mechanism is a guessed one, and a guessed model flag does not fail
 * loudly: the engine starts, ignores what it did not understand, and runs on a model the person did
 * not choose — which is the exact failure this module exists to remove. So an engine absent from
 * this table relaunches the way it always did, and the engine picks. That is today's behaviour, not
 * a regression, and it is recoverable by hand in the pane.
 */
import type { AgentEngine } from '../engines/types.js'

export interface SubscriptionModelLaunch {
  env: Record<string, string>
  args: string[]
}

/**
 * How each engine is told which of its OWN models to use, on its own login.
 *
 * Every entry is the same mechanism the grid contract uses for that engine's model — the part of it
 * that is about the model and not about the endpoint — so the two cannot drift into disagreeing
 * about how a model is named to an engine. See `GRID_ENGINE_CONTRACTS` in `gridLaunch.ts`.
 */
const CONTRACTS: Partial<Record<AgentEngine, (model: string) => SubscriptionModelLaunch>> = {
  // Claude Code reads `ANTHROPIC_MODEL` and prefers it over the model stored on a resumed session,
  // which is precisely the stale value being displaced here. Same variable the grid contract sets.
  claude: (model) => ({ env: { ANTHROPIC_MODEL: model }, args: [] }),

  // Codex resolves its model from argv; `-m` is what the grid contract passes, and it means the same
  // thing without a provider block beside it.
  codex: (model) => ({ env: {}, args: ['-m', model] }),

  // Hermes' INTERACTIVE cli resolves `-m` then config.yaml, with no environment tier at all
  // (`cli.py:_init_model_and_provider`, "Priority: CLI args > config"), and `--resume` otherwise
  // restores the model stored on the session row unless argv carried one. So argv — NOT
  // `HERMES_INFERENCE_MODEL`, which the grid contract sets for a different surface and which this
  // pane would ignore. The distinction is documented at length in `gridLaunch.ts`'s hermes entry.
  hermes: (model) => ({ env: {}, args: ['-m', model] }),

  // OpenCode's `-m` wants a `provider/model` pair. A remembered value that already carries a slash
  // is one the engine itself reported, so it round-trips; a bare model name has no provider this
  // module could supply without inventing one, and OpenCode would look for a model that does not
  // exist. Absent provider ⇒ no argument, per the rule at the top of this file.
  opencode: (model) => (model.includes('/') ? { env: {}, args: ['-m', model] } : { env: {}, args: [] }),
}

/** Engines that can be returned to a specific model. Everything else relaunches as it always did. */
export function subscriptionModelEngines(): AgentEngine[] {
  return Object.keys(CONTRACTS) as AgentEngine[]
}

/**
 * How to relaunch `engine` on its own login with `model` selected, or null when there is nothing
 * this module can say — an engine with no cited mechanism, or a model string it cannot use.
 *
 * Null is a normal answer and never an error: the relaunch proceeds without it.
 */
export function subscriptionModelLaunch(
  engine: AgentEngine,
  model: string | null | undefined,
): SubscriptionModelLaunch | null {
  const chosen = model?.trim()
  if (!chosen) return null
  const build = CONTRACTS[engine]
  if (!build) return null
  const launch = build(chosen)
  return launch.args.length || Object.keys(launch.env).length ? launch : null
}
