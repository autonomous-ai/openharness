/**
 * The agent cleanup in its own process, as the core sees it (services/agentCleanupProcess.ts; in the edge host by
 * default).
 *
 * The core tells the process what happens and goes on: a harness stopped (`service_event closed`), and the person
 * typing into a harness another agent started (`typed`), each held until the process hears it, as one it missed while
 * down would leave a harness open, or close one the person joined. `typed` comes with every keystroke a window sends:
 * it is said once a harness, and only for a harness another agent started, so the person's typing costs two map
 * lookups and never a frame to another process.
 *
 * The process asks the core what only the core knows: the live agents (`live`), when one's conversation last moved
 * (`lastActivity`), and to close one (`closeStarted`), which the core does for a harness another agent started and
 * refuses for any other (core/api.ts `closeStarted`). Whatever the process asks, it closes nothing else.
 */
import { answerAgentQuery } from './agentQueries.js'
import type { AgentCleanupPort, CoreApi } from './api.js'
import type { ServiceFrame } from './serviceLinks.js'

type Payload = Record<string, unknown>

export function createAgentCleanupLink(core: Pick<CoreApi, 'agents' | 'usage' | 'count' | 'clients'>, notify: (frame: ServiceFrame, opts?: { untilDelivered?: boolean }) => boolean) {
  /** The harnesses the process was told the person joined: it keeps them itself (services/agentCleanup.ts). */
  const told = new Set<string>()
  const port: AgentCleanupPort = {
    closed: (agentId) => { notify({ type: 'service_event', payload: { kind: 'closed', agentId } }, { untilDelivered: true }) },
    typed: (id) => {
      const session = core.agents.resolve(id)
      if (session?.startedBy !== 'agent' || told.has(session.agentId)) return
      told.add(session.agentId)
      notify({ type: 'service_event', payload: { kind: 'typed', agentId: session.agentId } }, { untilDelivered: true })
    },
    stop: () => {},
  }

  const answer = async (query: string, payload: Payload): Promise<Payload> => {
    if (query !== 'closeStarted' && query !== 'lastActivity') return answerAgentQuery(core, query, payload)
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
    if (!agentId) return { error: 'INVALID_REQUEST' }
    if (query === 'lastActivity') return { at: await (core.agents.lastActivity?.(agentId) ?? null) }
    const mode = payload.mode === 'idle' || payload.mode === 'now' ? payload.mode : null
    if (!mode) return { error: 'INVALID_REQUEST' }
    // Past the ceiling only when the process says so in those words: anything else keeps the refusal.
    const closing = payload.pastCeiling === true ? core.agents.closeStarted?.(agentId, mode, true) : core.agents.closeStarted?.(agentId, mode)
    return { ...await (closing ?? { error: 'UNSUPPORTED' }) }
  }

  return { port, answer }
}
