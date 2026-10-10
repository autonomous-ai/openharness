/**
 * The router: where a task a person typed or said should go — an existing session, or a new harness and
 * how to set it up (docs/design/2026-10-09-auto-router.md). An experiment in a process of its own, started
 * at its first request.
 *
 * It DECIDES and does nothing else. Every client that offers "say what you want" — the desktop's ⌘B box
 * today; the phone, the web, the TUI and the dial next — sends the task with the sessions, projects and
 * agents it can see, and acts on the answer through its own doors: it sends into the session the way it
 * sends anything, or makes the harness the way it makes one. So the router needs nothing from the core,
 * holds no session list of its own, and reaches no other machine: a client that can see a session on
 * another computer can route to it.
 *
 * It asks Jev through the person's OpenRouter key (lib/jev/); the decision is lib/routeDecide.ts.
 */
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { createJevDecide } from '../lib/jev/jevClient.js'
import { decideRoute, type RouteDeps, type RouteInput, type RouteOption, type RouteSession } from '../lib/routeDecide.js'

/** The requests the router answers, declared in core/api.ts for the core to route. */
export { ROUTER_REQUESTS } from '../core/api.js'

/** Bounds on what a client may send: a desk is tens of sessions, not thousands. */
const MAX_SESSIONS = 200
const MAX_OPTIONS = 200
const MAX_TEXT = 16_000

function options(raw: unknown): RouteOption[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, MAX_OPTIONS).flatMap((row) => {
    const { id, name } = (row ?? {}) as { id?: unknown; name?: unknown }
    return typeof id === 'string' && typeof name === 'string' && id.length <= 4200 && name.length <= 300 ? [{ id, name }] : []
  })
}

function sessions(raw: unknown): RouteSession[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, MAX_SESSIONS).flatMap((row) => {
    const { id, name, asks, about, stoppedAgoMs } = (row ?? {}) as { id?: unknown; name?: unknown; asks?: unknown; about?: unknown; stoppedAgoMs?: unknown }
    if (typeof id !== 'string' || typeof name !== 'string' || id.length > 4200 || name.length > 300) return []
    const said = Array.isArray(asks) ? asks.filter((ask): ask is string => typeof ask === 'string').slice(0, 3).map((ask) => ask.slice(0, 500)) : []
    const stopped = typeof stoppedAgoMs === 'number' && Number.isFinite(stoppedAgoMs) && stoppedAgoMs >= 0 ? { stoppedAgoMs } : {}
    return [{ id, name, asks: said, ...(typeof about === 'string' && about.trim() ? { about: about.slice(0, 500) } : {}), ...stopped }]
  })
}

/** A client's request, checked and bounded; null when it has no task. */
export function routeInput(payload: Record<string, unknown>): RouteInput | null {
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  if (!text || text.length > MAX_TEXT) return null
  const last = payload.last as { id?: unknown; agoMs?: unknown } | undefined
  return {
    text,
    sessions: sessions(payload.sessions),
    projects: options(payload.projects),
    agents: options(payload.agents),
    ...(typeof last?.id === 'string' && typeof last.agoMs === 'number' && Number.isFinite(last.agoMs) ? { last: { id: last.id, agoMs: last.agoMs } } : {}),
  }
}

export type Router = RouteDeps

/** Jev through the person's key, and the router's log. */
export function defaultRouter(): Router {
  const log = (line: string): void => console.log(`[route] ${line}`)
  // Every answer's price, as OpenRouter charged it: the person pays for these with their own key.
  return { jev: createJevDecide({ onCost: (usd, tokens) => log(`jev cost $${usd.toFixed(6)} for ${tokens} tokens`) }), log }
}

export function startRouter(_core: CoreApi, router: Router = defaultRouter()): ServiceRequests {
  /** Decisions in flight, each with the connection that asked: what the limits count. */
  const pending = new Map<object, unknown>()
  return {
    route_decide: async (payload, asker, closed) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      const input = routeInput(payload)
      if (!input) return { error: 'INVALID_REQUEST' }
      const connection = asker.connection ?? {}
      if (pending.size >= 8 || [...pending.values()].filter((id) => id === connection).length >= 2) return { error: 'BUSY' }
      const request = {}
      pending.set(request, connection)
      try {
        // The asker gone frees its slot at once rather than when Jev answers (up to eight seconds later).
        const verdict = await decideRoute(input, router, closed)
        router.log?.(`${verdict.kind === 'session' ? 'session' : verdict.kind === 'new' ? `new (${verdict.why})` : `nothing decided (${verdict.why})`} — ${verdict.trace}`)
        if (verdict.kind === 'unavailable') return { error: 'JEV_UNAVAILABLE', detail: verdict.why }
        return verdict.kind === 'session'
          ? { decided: 'session', id: verdict.id, via: 'jev' }
          : { decided: 'new', via: verdict.via, reason: verdict.why, ...(verdict.project ? { project: verdict.project } : {}), ...(verdict.agent ? { agent: verdict.agent } : {}) }
      } finally { pending.delete(request) }
    },
  }
}
