/**
 * The Wi-Fi device, as the core keeps it. The device's service runs with the dials, in the devices'
 * process (services/wifi.ts, step 9, D3); what stays here is what the core reads in line, kept from what
 * the service tells it, and the checks on what the service sends a device:
 *
 * - **Presence.** Which device sessions said their app's hello, by connection: a device watching means the
 *   core makes the turn cards and recaps for it, as it reads in line on every card. The core keeps them, so
 *   a service that starts again is handed the devices it was serving and serves them on (`WifiResume`).
 * - **The transcripts it proves its turns by.** Every transcript line of every agent is too much to send
 *   to another process; the service reads only those of an agent it sent a prompt to, until that prompt's
 *   turn is proven. The core starts sending an agent's lines as it dispatches the prompt, before the service
 *   could ask, and stops when the service says it is done with the agent as of the last prompt it was told
 *   of: never in the gap between a prompt and the service hearing of it.
 * - **The live text it streams.** The answer's text goes always (a device subscribing mid-turn is sent the
 *   whole final, as before), a tool's events only for an agent a device subscribed to; the service says
 *   which before the subscription's answer leaves it, so no event in between is lost.
 * - **The focus revision** a window's delayed selection is checked against, as the service last said it;
 *   none while it is off, so a selection is refused then, as it was with no service.
 * - **Each answer goes to the session it came from:** the core seals it to a session only while that
 *   session is still the same identity's device.
 * - **What a device sends while its service is not there** (its process starting at the first device, or
 *   starting again) is held, in order, and handed on once the service has been resumed; a session, a
 *   request or a pairing asks for the process (core/devicesWake.ts).
 */
import type { LiveEvent } from '../engines/kit/events.js'
import type { DeviceInputStatus } from './deviceInput.js'
import type { CoreApi, RemoteClient, WifiPort, WifiResume } from './api.js'
import type { AutonomousDeviceDelivery } from '../lib/autonomous-device/service.js'

/** What the core's own modules tell the Wi-Fi device: its deliveries into the panes (core/input.ts), the
 *  transcript lines (core/transcripts/), the turns and their live events (core/turns/). */
export interface WifiFeed {
  needsTranscript(agentId: string, sessionId: string, engine: string): boolean
  observeTranscript(agentId: string, sessionId: string, engine: string, line: string): void
  delivery(event: AutonomousDeviceDelivery): void
  inputDispatched(agentId: string, deliveryId: string, text: string, sessionId?: string): void
  inputStatus(event: DeviceInputStatus): void
  agentGone(agentId: string): void
  turnStarted(agentId: string): void
  turnEnded(agentId: string, aborted?: boolean): void
  stream(agentId: string, events: readonly LiveEvent[]): void
}

/** The gateway's calls a device's relay makes. */
export interface WifiGateway {
  /** An answer or event, sealed to one session. */
  device(connId: string, type: string, payload: Record<string, unknown>): void
  /** Which identity's app said hello on a session, so the gateway can tell it it was unpaired. */
  deviceClient(connId: string, identity: string | null): void
  /** A pairing the device gave up over its own session. */
  revokeIdentity(identity: string): void
}

export interface WifiCoreDeps {
  /** The service's port; null while it is off. */
  port(): WifiPort | null
  gateway: WifiGateway
  /** A remote client the gateway holds a session with, as the socket last heard. */
  remoteClient(connId: string): RemoteClient | null
  /** A turn's whole answer, for its summary card: the device shows more than the card carries. */
  fullText(agentId: string): string | undefined
  /** A device said hello: the live cards and the open questions again (BackendSocket.onCommanderJoin). */
  joined(): void
  /** The service is built and serving: the gateway's direct links may connect devices to it. */
  ready(): void
  /** Ask for the service's process: a device needs it (core/devicesWake.ts). False when there is none to ask
   *  for: the service runs in the core's process, and is there or failed as the core started. */
  want(): boolean
  /** The doors that are one call each into the core's own modules. */
  doors: Pick<CoreApi['wifi'], 'view' | 'submit' | 'cancel' | 'started' | 'stop' | 'answer' | 'create' | 'stepFocus' | 'scroll' | 'focusApp' | 'reveal'>
}

/** The engines whose transcripts prove a device's turn (lib/autonomous-device/resultEvidence.ts). */
const PROVEN_BY_TRANSCRIPT = new Set(['claude', 'codex'])
/** The live events a device's stream is made of (lib/autonomous-device/stream.ts): the answer's text,
 *  always, and a tool's start and end, for an agent a device subscribed to. */
const ALWAYS_STREAMED = new Set(['turn_started', 'text_delta', 'turn_ended'])
const TOOL_EVENTS = new Set(['tool_start', 'tool_end'])
/** A device's requests held while its service is not there: the most, and how old one may be when handed on.
 *  The device retries a request it had no answer to by the same key, so one older than this has been sent
 *  again, or given up on; the process starts in about a second. */
export const WIFI_HELD_MAX = 256
export const WIFI_HELD_MS = 30_000
/** How long a pairing waits for the service to serve: its process starts in about a second, more under load. */
export const WIFI_START_MS = 15_000

export function createWifiCore(deps: WifiCoreDeps) {
  const { port, gateway, remoteClient } = deps
  /** The device sessions the gateway holds, as the socket heard them. */
  const sessions = new Map<string, RemoteClient>()
  /** Which identity's app said hello on each session. */
  const helloed = new Map<string, string>()
  /** The agents whose transcript lines the service reads, and how many prompts the core told it of. */
  const watched = new Set<string>()
  const dispatched = new Map<string, number>()
  /** The agents a device subscribed to. */
  let streamed = new Set<string>()
  let revision: string | undefined
  let up = false
  /** Whether the service said it serves, since it was last there; and who waits for that (a pairing). */
  let serves = false
  const servingWaiters = new Set<() => void>()
  /** A device's requests while the service is not there, or before what it was handed has gone first. */
  const held: Array<{ connId: string; frame: Record<string, unknown>; opened: Record<string, unknown> | null; at: number }> = []
  let holding = true
  const release = (): void => {
    const service = port()
    if (!up || !service) return
    const now = Date.now()
    for (const each of held.splice(0)) if (now - each.at <= WIFI_HELD_MS) void service.request(each.connId, each.frame, each.opened)
    holding = false
  }

  /** A session that is still the identity's device it said hello as. */
  const serving = (connId: string, identity: string): boolean => {
    const client = remoteClient(connId)
    return client?.role === 'device' && client.identity === identity
  }
  const servingCount = (only: (client: RemoteClient) => boolean = () => true): number => {
    if (!up) return 0
    let count = 0
    for (const [connId, identity] of helloed) {
      const client = remoteClient(connId)
      if (client && serving(connId, identity) && only(client)) count++
    }
    return count
  }
  const forget = (connId: string): void => {
    if (!helloed.delete(connId)) return
    gateway.deviceClient(connId, null)
  }

  const api: CoreApi['wifi'] = {
    ...deps.doors,
    send: (connId, identity, type, payload) => { if (serving(connId, identity)) gateway.device(connId, type, payload) },
    hello: (connId, identity) => {
      if (identity) helloed.set(connId, identity)
      else helloed.delete(connId)
      gateway.deviceClient(connId, identity)
    },
    joined: () => deps.joined(),
    // The gateway told first, so a pairing waiting on this finds the direct links started.
    ready: () => {
      serves = true
      deps.ready()
      for (const served of [...servingWaiters]) served()
    },
    unpaired: (identity) => gateway.revokeIdentity(identity),
    focus: (next) => { revision = next },
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
    delivery: (event) => port()?.delivery(event),
    inputDispatched: (agentId, deliveryId, text, sessionId) => {
      // Before the service hears of it: the prompt's first lines may be written before it could ask.
      watched.add(agentId)
      dispatched.set(agentId, (dispatched.get(agentId) ?? 0) + 1)
      port()?.dispatched(agentId, deliveryId, text, sessionId)
    },
    inputStatus: (event) => port()?.inputStatus(event),
    agentGone: (agentId) => port()?.agentGone(agentId),
    turnStarted: (agentId) => port()?.turnStarted(agentId),
    turnEnded: (agentId, aborted = false) => port()?.turnEnded(agentId, aborted),
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
    /** What the gateway says of the device sessions (GatewayEvents), on to the service. */
    fromGateway: {
      session: (connId: string, client: RemoteClient | null): void => {
        if (client?.role === 'device') sessions.set(connId, client)
        else if (!sessions.delete(connId)) return
        if (!up && client?.role === 'device') deps.want()
        port()?.session(connId, client?.role === 'device' ? client : null)
      },
      request: (connId: string, frame: Record<string, unknown>, opened: Record<string, unknown> | null): void => {
        if (holding) {
          held.push({ connId, frame, opened, at: Date.now() })
          if (held.length > WIFI_HELD_MAX) held.shift()
          if (!up) deps.want()
          return
        }
        port()?.request(connId, frame, opened)
      },
      dropped: (connId: string): void => {
        sessions.delete(connId)
        // The service forgets it too, and says so; said here as well, for a service that is not there.
        forget(connId)
        port()?.dropped(connId)
      },
      revoked: (identity: string): void => {
        for (const [connId, said] of [...helloed]) if (said === identity) helloed.delete(connId)
        port()?.revoked(identity)
      },
    },
    /** A frame bound for the devices, as it is sent; a summary with the turn's whole answer. */
    card: (frame: Record<string, unknown>): void => {
      const service = port()
      if (!service) return
      const payload = frame.payload as Record<string, unknown> | undefined
      const summary = frame.type === 'commander_event' && payload?.kind === 'summary' && typeof frame.agentId === 'string'
      service.card(frame, summary ? deps.fullText(frame.agentId as string) : undefined)
    },
    /** Whether a device's app said hello on a session that is still its own: the core then makes the
     *  cards and recaps it shows. */
    connected: (): boolean => servingCount() > 0,
    /** How many of those are on a direct link, for `harness device status`. */
    directSessions: (): number => servingCount((client) => client.direct),
    /** The focus revision, as the service last said; none while it is off. */
    focusRevision: (): string | undefined => (up ? revision : undefined),
    /** The service is there (it started here, or its process connected): it is handed what the core holds,
     *  and then what its devices sent meanwhile, in order, before anything they send from now on. */
    started: (focus: WifiResume['focus']): void => {
      up = true
      watched.clear()
      dispatched.clear()
      streamed = new Set()
      revision = undefined
      for (const [connId, identity] of [...helloed]) if (!serving(connId, identity)) forget(connId)
      const resumed = port()?.resume({
        sessions: [...sessions].map(([connId, client]) => ({ connId, client })),
        helloed: [...helloed].map(([connId, identity]) => ({ connId, identity })),
        focus,
      })
      void Promise.resolve(resumed).catch(() => {}).then(release)
    },
    /** The service went away: nothing it watched is sent, and no device is served until it is back; what its
     *  devices send meanwhile is held for it. */
    stopped: (): void => {
      up = false
      serves = false
      holding = true
      revision = undefined
    },
    /** Ask for the service and wait, at most `waitMs`, until it serves: a device's discovery and pairing go through
     *  the gateway's direct links, which start only then. False when it did not in time. */
    serving: (waitMs: number): Promise<boolean> => {
      if (up && serves) return Promise.resolve(true)
      if (!deps.want()) return Promise.resolve(false)
      return new Promise((resolve) => {
        const served = (): void => { servingWaiters.delete(served); clearTimeout(timer); resolve(true) }
        const timer = setTimeout(() => { servingWaiters.delete(served); resolve(false) }, waitMs)
        servingWaiters.add(served)
      })
    },
  }
}

export type WifiCore = ReturnType<typeof createWifiCore>
