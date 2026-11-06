/**
 * What the Swarm adds to an engine's argv for the agents it starts, beside the instructions it gives them
 * (lib/agentAttribution.ts) and never for a person's own session: declared as `swarmArgs` in the engine's launch
 * (engines/codex/launch.ts), and the shell guard's hook (lib/agentShellGuard.ts, task #3596).
 */
import { launchContract } from '../engines/launches.js'
import { claudeShellGuardArgs, codexShellGuardArgs } from './agentShellGuard.js'

const SHELL_GUARD = new Map<string, () => string[]>([['claude', () => claudeShellGuardArgs()], ['codex', () => codexShellGuardArgs()]])

/** The argv for a session the Swarm started, or none. */
export function swarmEngineArgs(engine: string): string[] {
  return [...launchContract(engine)?.swarmArgs ?? [], ...SHELL_GUARD.get(engine)?.() ?? []]
}
