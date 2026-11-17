/** Forwarding targets and rendered surfaces from the viewers process. Streams use clientStreams.ts. */
import { VIEWERS_FOLLOW, VIEWERS_UNAVAILABLE, type CoreApi, type ViewersPort } from './api.js'

export const SURFACE_WAIT_MS = 20_000
export interface ViewersChannel {
  call(type: string, payload: Record<string, unknown>, waitMs?: number): Promise<Record<string, unknown>>
}
const CLOSED: ViewersChannel = { call: async () => VIEWERS_UNAVAILABLE }
interface Known { forwardingUrl: string | null }

export function createViewersLink(core: Pick<CoreApi, 'agents'>, channel: ViewersChannel = CLOSED) {
  const attached = new Set<string>()
  const known = new Map<string, Known>()
  const port: ViewersPort = {
    forwardingUrl: agentId => known.get(agentId)?.forwardingUrl ?? null,
    stop: async () => {},
    surface: (connection, payload) => channel.call('surface', { ...payload, connId: connection }, SURFACE_WAIT_MS),
  }

  /** The process reports only the current forwarding target for a live harness. */
  const heard = (payload: Record<string, unknown>): Record<string, unknown> => {
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
    if (!attached.has(agentId)) return { kept: false }
    const next: Known = {
      forwardingUrl: typeof payload.forwardingUrl === 'string' ? payload.forwardingUrl : null,
    }
    const before = known.get(agentId)
    if (JSON.stringify(before) === JSON.stringify(next)) return { kept: true }
    known.set(agentId, next)
    return { kept: true }
  }

  return {
    port,
    /** Follow the agents with a harness (core/agentLife.ts): the ones the core keeps the process's word on, and a look
     *  at one asks for the process, which runs only once there is one. Only while the viewers run in their own
     *  process: in the core's, the service follows them itself. */
    follow(): () => void {
      return core.agents.follow?.((event) => {
        if (event.kind === 'running') {
          attached.add(event.session.agentId)
        } else if (event.kind === 'ended') {
          attached.delete(event.agentId)
          known.delete(event.agentId)
        }
      }, VIEWERS_FOLLOW) ?? (() => {})
    },
    /** The core's answers to the viewers' questions (core/serviceLinks.ts `answer`, for `viewers`). */
    answer(query: string, payload: Record<string, unknown>): Record<string, unknown> {
      if (query === 'viewer_target') return heard(payload)
      return { error: 'UNKNOWN_QUERY' }
    },
  }
}

export type ViewersLink = ReturnType<typeof createViewersLink>
