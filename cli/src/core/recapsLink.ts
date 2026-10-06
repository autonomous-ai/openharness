/**
 * The recaps in their own process, as the core sees them (services/recapsProcess.ts; in the edge host by
 * default).
 *
 * The core tells the process each turn's lifecycle as a notification (`service_event lifecycle`) and goes
 * on: it never waits for an answer, and one the process misses — down, hung, restarting — costs that turn
 * its recap and its card, nothing else. A hung process reads nothing, so what would pile up on the socket
 * to it is dropped past RECAPS_BUFFER_LIMIT and said once a minute, rather than kept in the core's memory.
 * Two notifications are held until the process hears them, as a purge's is for search: a purge's
 * forgetting, and a conversation's recaps moving to its new session.
 *
 * What the core reads back in line (an agent's last turns and asks, whether its card is busy) it answers
 * from what the process last said of each session (`service_notice recaps`), which the process says again
 * whole each time it connects. A purge forgets here at once, before the process hears it: a purged
 * conversation's recaps are never served again. The process gone, no card of it is busy.
 *
 * What the process would put in front of a person (a device's card, the apps' recap) it sends as a notice,
 * which goes through the core API's check of its type. A turn's final answer it asks of the core
 * (`service_query lastTurn`): the transcript is the core's to read.
 */
import type { CoreApi, RecapsPort, TurnCardFrame } from './api.js'
import type { SessionRecaps } from '../lib/recapReads.js'
import type { ServiceFrame } from './serviceLinks.js'

/** The most the core lets wait on the socket to a recaps process that reads nothing. */
export const RECAPS_BUFFER_LIMIT = 4 * 1024 * 1024

export interface RecapsLinkDeps {
  /** Tell the recaps' process something (core/serviceLinks.ts `notify`, for `recaps`). */
  notify(frame: ServiceFrame, opts?: { untilDelivered?: boolean }): boolean
  /** How many bytes wait on the socket to it. */
  buffered(): number
  /** Ask it something (core/serviceLinks.ts `call`, for `recaps`): its answer, or SERVICE_UNAVAILABLE. */
  call(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Where its cards and recaps go: the core API checks each frame's type. */
  clients: Pick<CoreApi['clients'], 'turnCard' | 'turnSummary'>
  lastTurn: CoreApi['transcripts']['lastTurn']
  log?: (line: string) => void
  now?: () => number
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

/** What the process said of a session, as the core keeps it; null when it said nothing is held. */
function recapsOf(value: unknown): SessionRecaps | null {
  if (!value || typeof value !== 'object') return null
  const said = value as Record<string, unknown>
  return {
    latest: typeof said.latest === 'string' ? said.latest : null,
    history: strings(said.history),
    fullTexts: strings(said.fullTexts),
    asks: strings(said.asks),
    busy: said.busy === true,
  }
}

export function createRecapsLink(deps: RecapsLinkDeps) {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const now = deps.now ?? Date.now
  const known = new Map<string, SessionRecaps>()
  let dropped = 0
  let saidAt = -Infinity

  const port: RecapsPort = {
    lifecycle: (event, watchers) => {
      if (event.kind === 'purged') known.delete(event.sessionId)
      const held = event.kind === 'purged' || event.kind === 'rebound'
      if (!held && deps.buffered() > RECAPS_BUFFER_LIMIT) {
        dropped++
        if (now() - saidAt >= 60_000) {
          log(`[recaps] the recaps' process is not reading: ${dropped} turn event(s) dropped; those turns have no recap`)
          saidAt = now()
          dropped = 0
        }
        return
      }
      deps.notify({ type: 'service_event', payload: { kind: 'lifecycle', event, watchers } }, held ? { untilDelivered: true } : {})
    },
    recaps: (sessionId) => known.get(sessionId) ?? null,
    liveCards: async () => {
      const answer = await deps.call('liveCards', {})
      return Array.isArray(answer.cards) ? answer.cards.filter((card): card is TurnCardFrame => !!card && typeof card === 'object') : []
    },
  }

  return {
    port,
    /** What the process says without asking: a session's recaps, a card, a recap for the apps. */
    notice(payload: Record<string, unknown>): void {
      if (payload.kind === 'recaps' && typeof payload.sessionId === 'string') {
        const recaps = recapsOf(payload.recaps)
        if (recaps) known.set(payload.sessionId, recaps)
        else known.delete(payload.sessionId)
      } else if (payload.kind === 'card' && payload.frame && typeof payload.frame === 'object') {
        deps.clients.turnCard(payload.frame as Parameters<RecapsLinkDeps['clients']['turnCard']>[0])
      } else if (payload.kind === 'summary' && payload.frame && typeof payload.frame === 'object') {
        deps.clients.turnSummary(payload.frame as Parameters<RecapsLinkDeps['clients']['turnSummary']>[0])
      }
    },
    /** The core's answers to the process's questions (core/serviceLinks.ts `answer`, for `recaps`). */
    async answer(query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (query === 'lastTurn' && typeof payload.sessionId === 'string') return { turn: await deps.lastTurn(payload.sessionId) }
      return { error: 'UNKNOWN_QUERY' }
    },
    /** The process went: no card of it is busy any more, and the core's heartbeats stop with their turns. */
    disconnected(): void {
      for (const [sessionId, recaps] of known) if (recaps.busy) known.set(sessionId, { ...recaps, busy: false })
    },
  }
}

export type RecapsLink = ReturnType<typeof createRecapsLink>
