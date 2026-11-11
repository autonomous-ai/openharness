/**
 * What the Swarm adds to an engine's argv for the agents it starts, beside the instructions it gives them
 * (lib/agentAttribution.ts) and never for a person's own session: declared as `swarmArgs` in the engine's launch
 * (engines/codex/launch.ts), and Claude Code's hooks kept on.
 */
import { launchContract } from '../engines/launches.js'

/** A Swarm Claude Code session runs Harness's own hooks even where the person's settings turn every hook off, as it has since
 *  the shell guard's settings carried this (task #3596): the guard is gone, the hooks it kept on are not. */
const CLAUDE_HOOKS_ON = ['--settings', JSON.stringify({ disableAllHooks: false })]

/** The argv for a session the Swarm started, or none. */
export function swarmEngineArgs(engine: string): string[] {
  return [...launchContract(engine)?.swarmArgs ?? [], ...engine === 'claude' ? CLAUDE_HOOKS_ON : []]
}
