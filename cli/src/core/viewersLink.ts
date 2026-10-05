/**
 * The DSH viewers in their own process, as the core sees them (`HARNESSD_SERVICES=viewers`; the
 * process's side is services/viewersProcess.ts).
 *
 * The core asks the viewers two things while it builds an agent's frame: what its DSH context is (its
 * harness's name, its viewer URL, its verdict) and where the windows' viewer pane forwards to. A frame
 * cannot wait on another process, so the viewers tell the core each agent's answers whenever they change
 * (a `service_query` of kind `context`), the core keeps the last of them here, and the port answers from
 * that: while the process is down, with what it last knew, or the fallbacks for an agent it never heard
 * of. Each change then does in the core what the viewers did in their process: the windows' viewer panes
 * follow a viewer that moved (`clients.viewerChanged`), and the frame of an agent whose terminal is
 * attached goes out again.
 *
 * Attach and detach go to the process as notifications (`service_event`). A detach it missed would leave
 * a viewer running, so it is held until the process hears it. An attach it missed is caught up instead:
 * the process asks for every agent with a harness (`agents`) each time it connects, which a restarted
 * process needs anyway, since it starts holding nothing. Holding attaches as well would only pile up the
 * core's repeats (one per agent on every discovery pass) while the process is down.
 *
 * The core keeps what it hears only for the agents it has attached and not since detached: what the
 * process says of an agent before it hears the agent's detach must not bring the forgotten agent's
 * viewer back. The process says everything again on each attach, which is how the core's first word on
 * an agent arrives after a core restart, when the process connects before the core has attached anyone.
 */
import type { AgentDshContext } from '../lib/agentFrame.js'
import type { CoreApi, ViewersPort } from './api.js'
import type { ServiceFrame } from './serviceLinks.js'

/** Tell the viewers' process something (core/serviceLinks.ts `notify`, for `viewers`). */
export type NotifyViewers = (frame: ServiceFrame, opts?: { untilDelivered?: boolean }) => boolean

/** What the viewers last said of one agent. */
interface Known {
  context: AgentDshContext | null
  forwardingUrl: string | null
}

/** The two URLs a change in which the windows' viewer panes must follow. */
const urls = (known: Known | undefined): string => JSON.stringify([known?.context?.viewerUrl ?? null, known?.forwardingUrl ?? null])

export function createViewersLink(core: Pick<CoreApi, 'agents' | 'clients'>, notify: NotifyViewers) {
  const attached = new Set<string>()
  const known = new Map<string, Known>()

  const port: ViewersPort = {
    attach: (session) => {
      if (!session.dsh) return
      attached.add(session.agentId)
      notify({ type: 'service_event', payload: { kind: 'attach', session } })
    },
    detach: (agentId) => {
      attached.delete(agentId)
      const had = known.get(agentId)
      known.delete(agentId)
      // The windows' viewer panes let go of its viewer at once, as when it stopped in this process.
      if (urls(had) !== urls(undefined)) core.clients.viewerChanged(agentId)
      notify({ type: 'service_event', payload: { kind: 'detach', agentId } }, { untilDelivered: true })
    },
    frameContext: (session) => (session.dsh ? known.get(session.agentId)?.context ?? null : null),
    forwardingUrl: (agentId) => known.get(agentId)?.forwardingUrl ?? null,
    // The viewers are the process's: a core restarting or stopping leaves them running for the next core,
    // and the master stops the process itself when the daemon stops.
    stop: async () => {},
  }

  /** The process says what one agent's frame says of its harness now. */
  const heard = (payload: Record<string, unknown>): Record<string, unknown> => {
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
    if (!attached.has(agentId)) return { kept: false }
    const next: Known = {
      context: payload.context && typeof payload.context === 'object' ? payload.context as AgentDshContext : null,
      forwardingUrl: typeof payload.forwardingUrl === 'string' ? payload.forwardingUrl : null,
    }
    const before = known.get(agentId)
    if (JSON.stringify(before) === JSON.stringify(next)) return { kept: true }
    known.set(agentId, next)
    if (urls(before) !== urls(next)) core.clients.viewerChanged(agentId)
    // Only once the agent's terminal is attached: a frame with none reads to the desktop as "agent gone"
    // (services/viewers.ts, `syncCompanion`). The attach's own sync carries what arrived first.
    const session = core.agents.byAgent(agentId)
    if (session && core.agents.terminalAvailable(agentId)) core.agents.sync(session)
    return { kept: true }
  }

  return {
    port,
    /** The core's answers to the viewers' questions (core/serviceLinks.ts `answer`, for `viewers`). */
    answer(query: string, payload: Record<string, unknown>): Record<string, unknown> {
      // Every agent the core has with a harness, dormant ones too: the ones it attaches at start.
      if (query === 'agents') return { agents: core.agents.live().filter((session) => session.dsh) }
      if (query === 'context') return heard(payload)
      return { error: 'UNKNOWN_QUERY' }
    },
  }
}

export type ViewersLink = ReturnType<typeof createViewersLink>
