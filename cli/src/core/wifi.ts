/** Remaining Wi-Fi transcript/stream feeds; relay, presence and focus revision live in components. */
import type { LiveEvent } from '../engines/kit/events.js'
import type { CoreApi, WifiPort, WifiResume } from './api.js'

/** What the core's own modules tell the Wi-Fi device: its deliveries into the panes (core/input.ts), the
 *  transcript lines (core/transcripts/), the turns and their live events (core/turns/). */
export interface WifiFeed {
  needsTranscript(agentId: string, sessionId: string, engine: string): boolean
  observeTranscript(agentId: string, sessionId: string, engine: string, line: string): void
  inputDispatched(agentId: string): void
  agentGone(agentId: string): void
  turnEnded(agentId: string, aborted?: boolean): void
  events(agentId: string, events: readonly LiveEvent[]): void
  stream(agentId: string, events: readonly LiveEvent[]): void
}

export interface WifiCoreDeps {
  /** The service's port; null while it is off. */
  port(): WifiPort | null
  /** A turn's whole answer for its existing summary card feed. */
  fullText(agentId: string): string | undefined
  /** The doors that are one call each into the core's own modules. */
  doors: Pick<CoreApi['wifi'], 'view' | 'stop' | 'answer' | 'create' | 'stepFocus' | 'scroll' | 'focusApp' | 'reveal'>
}

/** The engines whose transcripts prove a device's turn (lib/autonomous-device/resultEvidence.ts). */
const PROVEN_BY_TRANSCRIPT = new Set(['claude', 'codex'])
/** The live events a device's stream is made of (lib/autonomous-device/stream.ts): the answer's text,
 *  always, and a tool's start and end, for an agent a device subscribed to. */
const ALWAYS_STREAMED = new Set(['turn_started', 'text_delta', 'turn_ended'])
const TOOL_EVENTS = new Set(['tool_start', 'tool_end'])
export function createWifiCore(deps: WifiCoreDeps) {
  const { port } = deps
  /** The agents whose transcript lines the service reads, and how many prompts the core told it of. */
  const watched = new Set<string>()
  const dispatched = new Map<string, number>()
  /** The agents a device subscribed to. */
  let streamed = new Set<string>()
  let up = false
  const api: CoreApi['wifi'] = {
    ...deps.doors,
    transcripts: (agentId, seen) => { if ((dispatched.get(agentId) ?? 0) <= seen) watched.delete(agentId) },
    watching: (agentIds) => {
      watched.clear()
      dispatched.clear()
      for (const agentId of agentIds) watched.add(agentId)
    },
    streams: (agentIds) => { streamed = new Set(agentIds) },
  }

  const feed: WifiFeed = {
    needsTranscript: (agentId, _sessionId, engine) => up && watched.has(agentId) && PROVEN_BY_TRANSCRIPT.has(engine),
    observeTranscript: (agentId, sessionId, engine, line) => port()?.transcript(agentId, sessionId, engine, line),
    inputDispatched: (agentId) => {
      // Before the service hears of it: the prompt's first lines may be written before it could ask.
      watched.add(agentId)
      dispatched.set(agentId, (dispatched.get(agentId) ?? 0) + 1)
    },
    agentGone: (agentId) => port()?.agentGone(agentId),
    turnEnded: (agentId, aborted = false) => port()?.turnEnded(agentId, aborted),
    // Keep batch adjacency intact for the component; send no extra batch for ordinary output.
    events: (agentId, events) => {
      if (events.some(event => event.type === 'turn_started' || event.type === 'turn_ended')) port()?.events(agentId, events)
    },
    stream: (agentId, events) => {
      if (!up) return
      const tools = streamed.has(agentId)
      const sent = events.filter((event) => ALWAYS_STREAMED.has(event.type) || (tools && TOOL_EVENTS.has(event.type)))
      if (sent.length) port()?.stream(agentId, sent)
    },
  }

  return {
    api,
    feed,
    /** A frame bound for the devices, as it is sent; a summary with the turn's whole answer. */
    card: (frame: Record<string, unknown>): void => {
      const service = port()
      if (!service) return
      const payload = frame.payload as Record<string, unknown> | undefined
      const summary = frame.type === 'commander_event' && payload?.kind === 'summary' && typeof frame.agentId === 'string'
      service.card(frame, summary ? deps.fullText(frame.agentId as string) : undefined)
    },
    /** Re-establish the remaining feed/focus state on this service connection. */
    started: (focus: WifiResume['focus']): void => {
      up = true
      watched.clear()
      dispatched.clear()
      streamed = new Set()
      void port()?.resume({ focus }).catch(() => {})
    },
    /** Service loss disables its feed. */
    stopped: (): void => {
      up = false
    },

  }
}

export type WifiCore = ReturnType<typeof createWifiCore>
