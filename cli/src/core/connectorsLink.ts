/**
 * Connected services in their own process, as the core reaches them (in the edge host; the process's side is
 * services/connectorsProcess.ts).
 *
 * The core asks one thing of them: as an agent launches on a profile home, that home's MCP config written with the
 * connections' entries (`syncProfileHome`). It is a request to the edge host (core/serviceLinks.ts `call`), waited on
 * for `SYNC_WAIT_MS` at most, and an answer that does not come (the process is down, failed, or slower than that) is
 * what the in-process fallback gives (core/api.ts `CONNECTORS_FALLBACKS`): nothing written, and the agent launches with
 * the entries its profile's config already holds.
 */
import type { ConnectorsPort } from './api.js'

/** Ask the connectors' process (core/serviceLinks.ts `call`, for `connectors`): never rejects. */
export type CallConnectors = (type: string, payload: Record<string, unknown>, waitMs: number) => Promise<Record<string, unknown>>

/** The longest a launch waits for its profile home's entries. The sync waits up to 3 s for the vault's lock
 *  (lib/connectors/agents.ts `syncProfileHome`) and then writes a config or two: a process silent past this is hung,
 *  and the launch goes on without it. */
export const SYNC_WAIT_MS = 5_000

export function createConnectorsLink(call: CallConnectors, log: (line: string) => void = (line) => console.warn(line)): ConnectorsPort {
  return {
    syncProfileHome: async (engine, folder) => {
      const answer = await call('syncProfileHome', { engine, folder }, SYNC_WAIT_MS)
      // SERVICE_UNAVAILABLE or SERVICE_FAILED (down, failed or past the wait): nothing was written, and the agent starts
      // without the connections it would have had. Said by the engine and the code alone: the folder names the profile.
      if (typeof answer.error === 'string') log(`[connections] profile home not updated (${engine}): ${answer.error}; launching with its current config`)
      return Array.isArray(answer.names) ? answer.names.filter((name): name is string => typeof name === 'string') : []
    },
  }
}
