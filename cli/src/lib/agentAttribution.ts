/** Legacy agent-spawn instructions remain readable for existing harnesses.
 * Super Tab supplies its own scoped coordination instructions. New launches
 * no longer add Harness branding to pull requests, including old accounts
 * whose saved pullRequestLine compatibility field is still true. */
import { env } from '../config/env.js'
import { agentInstructionArgs, launchContract, type AttributionPlace } from '../engines/launches.js'
import { readAgentSettings } from './agentSettings.js'

/** The line: short and plain, as the engines' own are, and linked to Harness's site. */
export const AGENT_ATTRIBUTION_LINE = '🤝 Started by another agent in [Harness](https://harness.autonomous.ai) — agents that run agents.'

/** Who started a harness, as `agent_create` takes it and its row keeps it: another agent; absent, the person. */
export type StartedBy = 'agent'

/**
 * What every harness is told as it starts, while the person lets agents start agents (Settings ▸ Experimental): that it runs in
 * Harness, the verbs that hand work to another agent, and when to: every harness started spends the person's tokens, so
 * only for work that gains from it, and closed once answered (owner, October 12). An agent that does not know Harness is
 * there never uses it, and every harness Harness starts is an agent that could (docs/design/2026-10-11-agent-client.md).
 * It is in every system prompt: keep it short.
 */
export const HARNESS_INSTRUCTIONS = 'You are running in Harness, and the person can watch you. You can hand work to other agents '
  + '(Claude Code, Codex) that run in their own harnesses: `harness new`, `harness wait`, `harness show`, `harness close` '
  + '(see `harness --help`). Start one only for work that can run in parallel, needs another model, or takes long; '
  + 'do quick work yourself, and close each one once you have its answer. Only use or close harnesses you started.'

/**
 * A launch’s argv for legacy agent-spawn instructions, read at each launch.
 * The retired PR branding preference never changes a new launch.
 */
export function agentLaunchArgs(engine: string, _startedBy: StartedBy | null | undefined, place: AttributionPlace & { swarmInstructions?: string },
  dataDir: string = env.ADAPTER_DATA_DIR): string[] {
  // Swarm roles route through their Lead; generic spawning advice would invite private worker teams.
  const instructions = place.swarmInstructions ?? (readAgentSettings(dataDir).agentsStartAgents ? HARNESS_INSTRUCTIONS : null)
  return agentInstructionArgs(engine, {
    instructions,
    prLine: null,
  }, place)
}

/**
 * [args] with every appended system prompt joined into one, for an engine that takes Harness's instructions that way:
 * a grid launch and a store harness append their own (lib/gridWebMcp.ts, the DSH's `contextArgs`), and an engine that
 * keeps only the last of a repeated flag would drop the others.
 */
export function joinedInstructions(engine: string, args: readonly string[]): string[] {
  const told = launchContract(engine)?.harnessInstructions
  if (told?.kind !== 'append') return [...args]
  const flag = told.args[0]
  const texts: string[] = []
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) { texts.push(args[++i]); continue }
    rest.push(args[i])
  }
  return texts.length ? [...rest, flag, texts.join('\n\n')] : rest
}
