/**
 * The DSH viewers in their own process, as the core sees them (`HARNESSD_SERVICES=viewers`; the
 * process's side is services/viewersProcess.ts).
 *
 * The core asks the viewers two things while it builds an agent's frame: what its DSH context is (its
 * harness's name, its viewer URL, its verdict) and where the windows' viewer pane forwards to. A frame
 * cannot wait on another process, so the viewers tell the core each agent's answers whenever they change
 * (a `service_query` of kind `context`), the core keeps the last of them here, and the port answers from
 * that: while the process is down, with what it last knew, or the fallbacks for an agent it never heard
 * of. Each change then does in the core what the viewers did in their process: the frame of an agent
 * whose terminal is attached goes out again. (A viewer that moved used to move the core's streams to it
 * too; they are the viewers' own now, and follow it in their process.)
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
 *
 * A client served a viewer over its connection (core/viewerStreams.ts): each frame of its stream is told
 * to the process as it comes, never held (a stream dies with the process that held it), and refused
 * instead while the process is not reading, so a hung one cannot pile a client's uploads up in the core.
 * What the stream answers comes back as a notice for that connection; one the core cannot deliver ends
 * that stream in the process, as a frame the forwarder could not send ended it in the core's. A rendered
 * frame (`viewer_surface`) is asked of the process (`surface`), and answered unavailable, as a routed
 * request is, if it is down or slower than a client waits.
 */
import type { AgentDshContext } from '../lib/agentFrame.js'
import { viewerStreamId } from '../lib/viewerFrames.js'
import { VIEWERS_UNAVAILABLE, type CoreApi, type ViewersPort } from './api.js'
import type { ServiceFrame } from './serviceLinks.js'

/** Tell the viewers' process something (core/serviceLinks.ts `notify`, for `viewers`). */
export type NotifyViewers = (frame: ServiceFrame, opts?: { untilDelivered?: boolean }) => boolean

/** The rest of the link to the viewers' process (core/serviceLinks.ts `call` and `buffered`, for `viewers`). */
export interface ViewersChannel {
  call(type: string, payload: Record<string, unknown>, waitMs?: number): Promise<Record<string, unknown>>
  buffered(): number
}

/** Past this many bytes waiting on the socket to the viewers' process, it is not reading: a stream's frame
 *  is refused rather than kept. A client sends at most a viewer window (128 KiB) per stream unacknowledged
 *  (lib/viewerWire.ts), so a process that reads keeps far less than this waiting. */
export const VIEWERS_BUFFER_LIMIT = 4 * 1024 * 1024

/** How long a client's rendered frame may wait on the viewers: under the 25 s the desktop gives the
 *  request, so it hears why rather than timing out. Starting a headless browser takes a few seconds. */
export const SURFACE_WAIT_MS = 20_000

const CLOSED: ViewersChannel = { call: async () => VIEWERS_UNAVAILABLE, buffered: () => 0 }

/** What the viewers last said of one agent. */
interface Known {
  context: AgentDshContext | null
  forwardingUrl: string | null
}

export function createViewersLink(core: Pick<CoreApi, 'agents' | 'clients'>, notify: NotifyViewers, channel: ViewersChannel = CLOSED) {
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
      known.delete(agentId)
      notify({ type: 'service_event', payload: { kind: 'detach', agentId } }, { untilDelivered: true })
    },
    frameContext: (session) => (session.dsh ? known.get(session.agentId)?.context ?? null : null),
    forwardingUrl: (agentId) => known.get(agentId)?.forwardingUrl ?? null,
    // The viewers are the process's: a core restarting or stopping leaves them running for the next core,
    // and the master stops the process itself when the daemon stops.
    stop: async () => {},
    stream: (connId, type, frame) =>
      channel.buffered() <= VIEWERS_BUFFER_LIMIT && notify({ type: 'service_event', payload: { kind: 'stream', connId, type, frame } }),
    surface: (connId, payload) => channel.call('surface', { ...payload, connId }, SURFACE_WAIT_MS),
    closed: (connId) => { notify({ type: 'service_event', payload: { kind: 'closed', ...(connId === undefined ? {} : { connId }) } }) },
  }

  /** What the process tells the core without asking: a stream's frame for one client's connection. */
  const notice = (payload: Record<string, unknown>): void => {
    if (payload.kind !== 'viewer' || typeof payload.connId !== 'string' || typeof payload.type !== 'string') return
    const frame = payload.payload && typeof payload.payload === 'object' ? payload.payload as Record<string, unknown> : {}
    if (core.clients.viewerFrame(payload.connId, payload.type, frame)) return
    // Not delivered: the stream ends in the process too, without another word to a client it cannot reach.
    if (payload.type !== 'viewer_close' && viewerStreamId(frame.streamId)) {
      port.stream(payload.connId, 'viewer_close', { streamId: frame.streamId, error: 'Viewer connection closed' })
    }
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
    // Only once the agent's terminal is attached: a frame with none reads to the desktop as "agent gone"
    // (services/viewers.ts, `syncCompanion`). The attach's own sync carries what arrived first.
    const session = core.agents.byAgent(agentId)
    if (session && core.agents.terminalAvailable(agentId)) core.agents.sync(session)
    return { kept: true }
  }

  return {
    port,
    notice,
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
