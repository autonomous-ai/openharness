/**
 * What the Swarm adds to an engine's argv for the agents it starts, beside the instructions it gives them
 * (lib/agentAttribution.ts) and never for a person's own session: declared as `swarmArgs` in the engine's launch
 * (engines/codex/launch.ts).
 */
import { launchContract } from '../engines/launches.js'

/** The argv for a session the Swarm started, or none. */
export function swarmEngineArgs(engine: string): string[] {
  return [...launchContract(engine)?.swarmArgs ?? []]
}
