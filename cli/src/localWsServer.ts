import { createClientStreamQueue, type ClientStreamQuota } from './lib/clientStreamQueue.js'
import { CLIENT_STREAM_QUEUE_BYTES } from './lib/clientStreamContract.js'
import { randomUUID } from 'node:crypto'
import type { AppSwarms } from './cable/cableSession.js'
import { notificationReadToken, type UnreadNotification } from './lib/notificationRead.js'
import type http from 'node:http'
import type { Socket } from 'node:net'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { watchSocketLiveness } from './lib/wsLiveness.js'
import { isLoopbackRequest, loopbackHosts } from './lib/loopbackRequest.js'
import { isTrustedLocal, pipeProofOf } from './lib/localSocket.js'
import { PIPE_PROOF_HEADER } from './lib/windows/pipeAuth.js'
import { localCredentialMatches } from './lib/localCredential.js'
import { peerIsThisAccount, type PeerAccount } from './lib/peerAccount.js'
import type { Frame, LocalClientSink, LocalSendQuota } from './backendSocket.js'
import { replayLegacyQuestions, questionFrameBytes, QUESTION_OBSERVATION_BYTES, QUESTION_OBSERVATION_CONNECTION_FRAMES, QUESTION_OBSERVATION_FRAMES } from './core/questionObservation.js'
import { boundedJsonBytes } from './lib/boundedJsonBytes.js'
import { SESSION_EVENT_BYTES, SESSION_EVENT_SEND_BYTES, SESSION_EVENT_CONNECTION_FRAMES, SESSION_EVENT_FRAMES, SESSION_EVENT_DRAIN_MS } from './lib/sessionEvents.js'
import {
  clientStreamLocalFrame,
  decodeTerminalLocal,
  TERMINAL_BINARY_VERSION,
  TERMINAL_LOCAL_PASTE_MAX_PAYLOAD_BYTES,
  type TerminalBinaryClear,
} from './lib/terminalBinary.js'
import { RelayConnectError } from './lib/relayFrames.js'
import type { WindowRelay, WindowRelaySession } from './core/api.js'
// Reserved retired feature frames: transport refusals only, no optional implementation.
const DAEMON_IN_TYPES = new Set(['daemon_act', 'daemon_presence', 'daemon_talk', 'daemon_open', 'daemon_shown', 'daemon_confirm'])
const DAEMON_PLATE_GET = 'daemon_plate_get'
const DAEMON_PLATE = 'daemon_plate'

export const LOCAL_WS_PATH = '/api/local-ws'
export const LOCAL_WS_PROTOCOL_VERSION = 1
/** What a tool (`harness new`, `harness hardware watch`) may ask of this daemon that an older one would silently ignore. */
const LOCAL_TOOL_FEATURES = ['openclaw-local', 'dial-watch'] as const

const LOCAL_IDLE_DEADLINE_MS = 40_000
// The `ws` library enforces this on EVERY message on this socket, JSON or binary — so it has to
// cover the largest binary frame this transport carries, not just JSON control frames. That is a
// paste (see TERMINAL_LOCAL_PASTE_MAX_PAYLOAD_BYTES in terminalBinary.ts), plus a little slack for
// the local frame header; ordinary JSON frames stay bounded by LOCAL_JSON_MAX_BYTES regardless.
const MAX_WS_MESSAGE_BYTES = TERMINAL_LOCAL_PASTE_MAX_PAYLOAD_BYTES + 4_096

import { LOCAL_JSON_MAX_BYTES } from './lib/localJsonLimit.js'

export interface LocalWsBackend {
  /** `tool`: `harness pair` or the harnessd MCP server — answered like any local client, never presence.
   *  `watch`: what a tool asked to be sent as it changes; a window is sent it anyway. */
  registerLocalClient: (connId: string, sink: LocalClientSink, opts?: { tool?: boolean; surface?: 'tui'; watch?: readonly 'dial'[]; questionProtocol?: 1; eventsProtocol?: 1 }) => boolean
  unregisterLocalClient: (connId: string) => Promise<void>
  handleLocalFrame: (connId: string, frame: Frame) => void
  handleLocalBinary: (connId: string, frame: TerminalBinaryClear, raw?: Uint8Array) => Promise<void>
  /** The agent this window has focused, or null — which of its terminals gets the short output window. */
  setLocalTerminalFocus?: (connId: string, agentId: string | null, visibleAgents?: readonly string[]) => void
  /** hn's `product_observe`, from a connection on this computer's own socket bound to this machine. */
  observeProduct?: (connId: string, payload: unknown) => void
}

export interface LocalWsServerOptions {
  machineId: string
  backend: LocalWsBackend
  /** The daemon's Unix-socket server (lib/localSocket.ts), served the same endpoint beside TCP. */
  localSocketServer?: http.Server | null
  /** The daemon's local credential (lib/localCredential.ts). Given, a TCP upgrade must carry it: the
   *  loopback port takes any local OS user's process, the Unix socket only this user's. */
  localCredential?: string
  /** Whether a TCP caller runs as this OS account (lib/peerAccount.ts). A test's stand-in for another account. */
  peerAccount?: PeerAccount
  /** Serves a `machine_select` for any OTHER machine this signed-in user owns, by relaying to
   *  backend's `/api/web-ws` — see lib/remoteRelay.ts — and one for a harness shared with this account
   *  (`shareId`, sharing/relay.ts). Both are the gateway's. Omit to keep today's own-machine-only behavior. */
  relayPool?: WindowRelay
  autonomousEnv?: string
  /**
   * Who a window on this computer is, for a `terminal_open` it relays to another machine without
   * introducing itself (a desktop build from before `client`). This daemon knows what the window
   * cannot be made to say: the client is a desktop on THIS machine, by id and name. Filled in only
   * when the frame carries no `client` of its own — a window that does introduce itself is believed.
   */
  localClient?: () => { kind: string; name: string; machineId?: string } | null
  /** The desktop app opened an agent's terminal — which agent, and on which machine. Lets the dial follow
   *  the window, so the two screens stay one desk. */
  /** Explicit focus applies synchronously. A conditional check returns its final guarded apply so
   *  physical-window validation, state mutation and dial forwarding share one synchronous stack. */
  onAppFocusState?: (machineId: string, agentId: string | null, connId: string, expectedRevision?: string) =>
    boolean | void | Promise<false | (() => boolean)>
  /** A registered desktop connection closed. Never interpret this as live empty-workspace focus. */
  onAppDisconnect?: (machineId: string, connId: string) => void
  onDevicePrepareOpened?: (operationId: string, agentId: string) => void
  onAppFocus?: (machineId: string, agentId: string) => void
  /** Every agent the window currently has a tile for, across all its machines. */
  onAppPanes?: (agentIds: string[], foreground: boolean) => void
  /** The window has looked at this harness — see the `agent_seen` case below. */
  onAgentSeen?: (agentId: string, readToken?: string) => void
  /** Everything the window still has unread, newest first — see the `app_unread` case below. */
  onAppUnread?: (items: UnreadNotification[]) => void
  /**
   * The window's swarms — its named groups of agents, one of them on screen. The whole list each time,
   * and `null` when the window goes away, so the daemon never keeps describing tabs nobody can see.
   * Consumed like app_panes: a fact about this desk, never forwarded to the machine.
   */
  onAppSwarms?: (swarms: AppSwarms | null) => void
  /** Tab membership for cleanup, scoped to the reporting window, including local utility tabs. */
  onAppTabAgents?: (connection: string, agentIds: string[] | null) => void
  /** Handlers for declared service frames; unrelated traffic stays on the terminal path. */
  serviceFrames?: ReadonlyMap<string, (connId: string, frame: Frame) => Promise<Frame | null>>
  /** The dial right now, sent to a window, or a tool that asked for the dial, the moment it connects — it may have
   *  missed the announcement. */
  dialStatus?: () => Record<string, unknown>
  /**
   * A window changed a device's settings. `id` names which device on this desk; the rest of the payload
   * is the patch, and an absent field is a setting the window is not changing.
   *
   * There is no reply frame. The device answers its own `settings.set` with what it now holds, and that
   * arrives as an ordinary `dial_status` — which is also what corrects a window whose change was refused.
   */
  onDialSettings?: (id: string, patch: Record<string, unknown>) => void
  /** Questions still waiting on the user, as the `commander_question` frames that announced them. A window
   *  that connects after one was asked is handed them, so a terminal opened late still sees who is blocked. */
  openQuestions?: () => Iterable<Frame>
  /** The core's end of its out-of-process services (core/serviceLinks.ts): a `machine_select` with
   *  `role: "service"` is handed here, and the connection is the service's from then on. */
  services?: {
    accept(service: string, token: string, sink: LocalClientSink & { buffered(): number }, close: (code: number, reason: string) => void, accepted: () => void):
      { receive(frame: Frame): void; receiveBinary(bytes: Uint8Array): void; closed(): void } | null
  }
  onSelectionReply?: (connId: string, machineId: string, payload: Record<string, unknown>) => void
  onVisitReply?: (connId: string, machineId: string, payload: Record<string, unknown>) => void
  onFormReply?: (connId: string, machineId: string, payload: Record<string, unknown>) => void
}

/** The reply each request among them gets. */
const DAEMON_RESULT: Record<string, string> = { daemon_act: 'daemon_act_result', daemon_talk: 'daemon_talk_result', daemon_open: 'daemon_open_result', daemon_confirm: 'daemon_confirm_result' }

export interface LocalWsServer {
  close: () => Promise<void>
  /** Exact local socket, including sockets viewing a remote machine; never relayed. */
  sendToWindow: (connId: string, frame: Frame) => boolean
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function rejectUpgrade(socket: Socket, status: number, reason: string, retryAfter?: number): void {
  if (socket.destroyed) return
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
    (retryAfter === undefined ? '' : `Retry-After: ${retryAfter}\r\n`) +
    'Connection: close\r\n' +
    'Content-Length: 0\r\n' +
    '\r\n',
  )
}

function jsonFrame(raw: RawData, maxBytes = LOCAL_JSON_MAX_BYTES): (Frame & { type: string }) | null {
  const bytes = Buffer.isBuffer(raw)
    ? raw
    : raw instanceof ArrayBuffer
      ? Buffer.from(raw)
      : Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.alloc(0)
  if (!bytes.length || bytes.length > maxBytes) return null
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const frame = value as Frame
    return typeof frame.type === 'string' && frame.type.length <= 100 ? frame as Frame & { type: string } : null
  } catch {
    return null
  }
}

/**
 * The window's swarm list, checked field by field. Anything that is not an id, a name and a list of
 * agent ids is dropped rather than trusted — the same stance app_panes takes with its ids — and a
 * payload with no usable swarm at all is treated as not sent.
 */
function appSwarmsFrom(payload: unknown): AppSwarms | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const rows = Array.isArray(p.swarms) ? p.swarms : []
  const swarms: AppSwarms['swarms'] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r.id !== 'string' || !r.id || typeof r.name !== 'string') continue
    const agentIds = Array.isArray(r.agentIds)
      ? r.agentIds.filter((id): id is string => typeof id === 'string' && id !== '')
      : []
    // A window that predates this field says nothing about its tiles, and the honest reading of that
    // silence is the old one: as many tiles as agents. That keeps an older app behaving exactly as it
    // does today rather than having its tabs vanish from the dial for the opposite reason.
    const panes = typeof r.panes === 'number' && Number.isFinite(r.panes) && r.panes >= 0
      ? Math.min(Math.floor(r.panes), 999)
      : agentIds.length
    swarms.push({ id: r.id, name: r.name.slice(0, 80), agentIds, panes })
    if (swarms.length === 24) break   // the window's own ceiling
  }
  if (swarms.length === 0) return null
  const active = typeof p.active === 'string' && swarms.some((s) => s.id === p.active) ? p.active : swarms[0].id
  // Absent from a window that predates the field, and absent is the honest answer: the far side falls
  // back to deriving a shape from the count, which is what it did before any window sent one.
  const tiles: AppSwarms['tiles'] = []
  for (const row of Array.isArray(p.tiles) ? p.tiles : []) {
    if (!row || typeof row !== 'object') continue
    const t = row as Record<string, unknown>
    const n = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1000, Math.round(v))) : null
    const x1 = n(t.x1), y1 = n(t.y1), x2 = n(t.x2), y2 = n(t.y2)
    // A tile with no area is not a tile. Dropping it here rather than on the device keeps the far
    // side's rule simple: every row it receives is drawable.
    if (x1 === null || y1 === null || x2 === null || y2 === null || x2 <= x1 || y2 <= y1) continue
    tiles.push({ x1, y1, x2, y2, agentId: typeof t.agentId === 'string' ? t.agentId : '' })
    if (tiles.length === 24) break   // the window's own ceiling, same as the rows above
  }
  return { active, swarms, tiles }
}

/** [raw]'s length in bytes, with nothing copied or made: it is read for every message. */
function rawBytes(raw: RawData): number {
  if (Array.isArray(raw)) { let total = 0; for (const part of raw) total += part.byteLength; return total }
  return raw.byteLength
}

function binaryBytes(raw: RawData): Uint8Array {
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw))
  return new Uint8Array()
}

/** `terminal_open` with this computer's own introduction, when the window gave none — see `localClient`. */
function withLocalClient(frame: Frame, localClient: LocalWsServerOptions['localClient']): Frame {
  if (frame.type !== 'terminal_open' || !localClient) return frame
  const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload as Record<string, unknown> : {}
  if (payload.client !== undefined) return frame
  const client = localClient()
  return client ? { ...frame, payload: { ...payload, client } } : frame
}

/**
 * Add an internal loopback WebSocket endpoint to the CLI's existing HTTP server. Over the daemon's Unix
 * socket it takes no credential: the filesystem says who the peer is. Over TCP it takes the daemon's
 * local credential (lib/localCredential.ts) — never an SSO credential — besides being loopback-only with
 * no Origin header: any OS user's process can reach the loopback port.
 */
/** How long a closing server waits for its clients to answer the close before it drops them. */
export const LOCAL_WS_CLOSE_GRACE_MS = 1_000

export function attachLocalWsServer(server: http.Server, options: LocalWsServerOptions): LocalWsServer {
  const streamQueue = createClientStreamQueue()
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_MESSAGE_BYTES,
    // The local credential travels in a header, never a subprotocol. Echo a protocol only for generic
    // WS clients that insist on proposing one; it carries no authority and is never inspected.
    handleProtocols: (protocols) => [...protocols][0] ?? false,
  })
  // Over the Windows pipe every answer proves the daemon's token (lib/windows/pipeAuth.ts), and so does the 101: a
  // client drops a connection whose upgrade carries no proof. Nothing is added on TCP or the Unix socket.
  wss.on('headers', (headers, req) => {
    const proof = pipeProofOf(req)
    if (proof) headers.push(`${PIPE_PROOF_HEADER}: ${proof}`)
  })
  // One desktop can have a connection per machine. Once a live window reports its selected pane,
  // background terminal attachments on ANY of those connections must not overwrite that selection.
  const explicitFocusClients = new Set<string>()
  const windowSinks = new Map<string, LocalClientSink>()
  // A separate declared class on this physical send owner, shared by all observation connections.
  const questionBudget = { bytes: 0, frames: 0, peakBytes: 0, peakFrames: 0 }
  const eventBudget = { bytes: 0, frames: 0, peakBytes: 0, peakFrames: 0 }
  // The desktop reports the same desk on one connection per machine. Losing a
  // remote relay must not erase the desk while another connection still holds it.
  // Map order records the latest announcement, including a replacement socket.
  const paneRosters = new Map<string, { ids: string[]; foreground: boolean }>()
  const swarmRosters = new Map<string, AppSwarms>()

  const onUpgrade = (req: http.IncomingMessage, socket: Socket, head: Buffer): void => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== LOCAL_WS_PATH) return
    // Over the daemon's own socket (lib/localSocket.ts) the filesystem already vouched for the peer, or, on Windows,
    // the request proved the daemon's token over its pipe; it has no address or port to check. It still must not be a browser.
    if (isTrustedLocal(req)) {
      if (req.headers.origin) { rejectUpgrade(socket, 403, 'Forbidden'); return }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
      return
    }
    if (!isLoopback(req.socket.remoteAddress)) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    // Also refuses any Origin: a browser always sends one on a WebSocket, and no browser is a client.
    const bound = server.address()
    if (req.headers.origin || !bound || typeof bound === 'string' || !isLoopbackRequest(req, loopbackHosts(bound.port))) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    // Another OS user's process reaches this port too (a guest's harness, say): only this user's carries
    // the credential.
    if (options.localCredential !== undefined && !localCredentialMatches(options.localCredential, req)) {
      rejectUpgrade(socket, 401, 'Unauthorized')
      return
    }
    if (options.localCredential === undefined) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
      return
    }
    // A credential another account heard while it held this port during a restart (audit H1) must open nothing.
    // Nothing else listens on this socket until the upgrade: a client's reset while the lookup runs would be uncaught.
    const ignoreReset = (): void => {}
    socket.on('error', ignoreReset)
    void (options.peerAccount ?? peerIsThisAccount)(req.socket).then((mine) => {
      socket.off('error', ignoreReset)
      if (socket.destroyed) return
      // Who is calling could not be looked up in time: not a refusal, and the client reconnects.
      if (mine === 'unanswered') { rejectUpgrade(socket, 503, 'Service Unavailable', 1); return }
      if (!mine) { rejectUpgrade(socket, 401, 'Unauthorized'); return }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    }, () => { socket.off('error', ignoreReset); rejectUpgrade(socket, 401, 'Unauthorized') })
  }
  const servers = [server, ...(options.localSocketServer ? [options.localSocketServer] : [])]
  for (const each of servers) each.on('upgrade', onUpgrade)

  wss.on('connection', (ws, req: http.IncomingMessage) => {
    const connId = `local:${randomUUID()}`
    // Over the daemon's own Unix socket (0600, in a 0700 folder): this user's process, not any user's.
    const trusted = isTrustedLocal(req)
    /** Introduced itself as a tool (`machine_select { tool: true }`), rather than a window. */
    let tool = false
    let selected = false
    // Which machine THIS connection is bound to. The app opens one local socket per machine, so it is
    // fixed for the life of the connection — set once, beside `selected`.
    let boundMachineId: string | null = null
    let relay: WindowRelaySession | null = null
    /** Whether this connection ever reported a tile roster — only then is clearing it ours to do. */
    let sentPanes = false
    let sentSwarms = false
    let chain = Promise.resolve()
    /** Set when this connection is one of the core's services, not a window. */
    let serviceLink: { receive(frame: Frame): void; receiveBinary(bytes: Uint8Array): void; closed(): void } | null = null
    // Ownership records only: ws owns each actual write. Logical unregister never clears these callbacks.
    const observationSends = new Set<(sent: boolean) => void>()
    const observations = {
      questions: { pending: 0, frames: 0, bytes: 0, refused: 0 },
      events: { pending: 0, frames: 0, bytes: 0, refused: 0 },
    }
    let eventDeadline: ReturnType<typeof setTimeout> | undefined
    ws.once('close', () => {
      clearTimeout(eventDeadline)
      for (const settled of observationSends) settled(false)
      for (const kind of ['questions', 'events'] as const) {
        const stats = observations[kind], budget = kind === 'questions' ? questionBudget : eventBudget
        if (stats.frames || stats.refused) console.log(`[${kind === 'questions' ? 'question-observation' : 'session-events'}] closed · frames=${stats.frames} bytes=${stats.bytes} peakBytes=${budget.peakBytes} peakFrames=${budget.peakFrames} refused=${stats.refused}`)
      }
    })

    const refusedStream = (quota: ClientStreamQuota): false => {
      if (quota.direction === 'service' || quota.final) {
        // Revoke authority now. Actual queued bytes stay charged until the physical socket releases them.
        serviceLink?.closed()
        serviceLink = null
        close(1013, 'Stream queue full')
      }
      return false
    }
    const queued = streamQueue.connection()
    ws.once('close', () => queued.close())
    const sink: LocalClientSink = {
      sendFrame: (frame: Frame, quota?: LocalSendQuota, settled?: (sent: boolean) => void) => {
        if (ws.readyState !== WebSocket.OPEN) { settled?.(false); return false }
        if (quota && 'kind' in quota) {
          const questions = quota.kind === 'questions', budget = questions ? questionBudget : eventBudget
          const stats = observations[quota.kind]
          const limit = questions ? QUESTION_OBSERVATION_BYTES : SESSION_EVENT_BYTES
          const total = questions ? QUESTION_OBSERVATION_BYTES : SESSION_EVENT_SEND_BYTES
          const connectionFrames = questions ? QUESTION_OBSERVATION_CONNECTION_FRAMES : SESSION_EVENT_CONNECTION_FRAMES
          const totalFrames = questions ? QUESTION_OBSERVATION_FRAMES : SESSION_EVENT_FRAMES
          const prefix = questions ? 'QUESTION_OBSERVATION' : 'SESSION_EVENTS'
          let bytes: number | null
          try { bytes = questions ? questionFrameBytes(frame, limit) : boundedJsonBytes(frame, limit) } catch { bytes = null }
          if (bytes === null || budget.bytes + bytes > total || stats.pending >= connectionFrames || budget.frames >= totalFrames) {
            stats.refused++
            const reason = `${prefix}_${bytes === null ? 'TOO_LARGE' : 'BACKPRESSURE'}`
            console.warn(`[${questions ? 'question-observation' : 'session-events'}] ${reason}`)
            close(1013, reason)
            settled?.(false)
            return false
          }
          budget.bytes += bytes
          budget.frames++
          budget.peakBytes = Math.max(budget.peakBytes, budget.bytes)
          budget.peakFrames = Math.max(budget.peakFrames, budget.frames)
          stats.pending++; stats.frames++; stats.bytes += bytes
          if (!questions && !eventDeadline) {
            eventDeadline = setTimeout(() => {
              console.warn('[session-events] SESSION_EVENTS_DRAIN_TIMEOUT')
              close(1013, 'SESSION_EVENTS_DRAIN_TIMEOUT')
            }, SESSION_EVENT_DRAIN_MS)
            eventDeadline.unref?.()
          }
          let done = false
          const finish = (sent: boolean): void => {
            if (done) return
            done = true
            observationSends.delete(finish)
            budget.bytes -= bytes
            budget.frames--; stats.pending--
            if (!questions && !stats.pending) { clearTimeout(eventDeadline); eventDeadline = undefined }
            settled?.(sent)
          }
          observationSends.add(finish)
          try {
            ws.send(JSON.stringify(frame), error => { finish(!error); if (error) close(1013, `${prefix}_UNAVAILABLE`) })
            return true
          } catch { finish(false); close(1013, `${prefix}_UNAVAILABLE`); return false }
        }
        let release: (() => void) | null | undefined
        try {
          const serialized = JSON.stringify(frame)
          if (!quota) { ws.send(serialized); return true }
          if (ws.bufferedAmount > CLIENT_STREAM_QUEUE_BYTES) return refusedStream(quota)
          release = queued.reserve(quota, Buffer.byteLength(serialized))
          if (release === null) return refusedStream(quota)
          ws.send(serialized, (error) => { release!(); if (error) ws.terminate() })
          return true
        } catch { release?.(); return false }
      },
      sendBinary: (frame, quota) => {
        if (ws.readyState !== WebSocket.OPEN) return false
        let release: (() => void) | null | undefined
        try {
          if (!quota) { ws.send(frame, { binary: true }); return true }
          if (ws.bufferedAmount > CLIENT_STREAM_QUEUE_BYTES) return refusedStream(quota)
          release = queued.reserve(quota, frame.length)
          if (release === null) return refusedStream(quota)
          ws.send(frame, { binary: true }, (error) => { release!(); if (error) ws.terminate() })
          return true
        } catch { release?.(); return false }
      },
      close: (code, reason) => close(code, reason),
    }
    // A reading cursor belongs to this physical desk. A terminal's upstream
    // event feed cannot manufacture device gestures; only sendToWindow can.
    const terminalSink: LocalClientSink = {
      ...sink,
      sendFrame: (frame: Frame, quota?: LocalSendQuota, settled?: (sent: boolean) => void) => {
        if (frame.type === 'dial_selection' || frame.type === 'dial_visit' || frame.type === 'dial_form') { settled?.(false); return true }
        return quota && 'kind' in quota ? sink.sendFrame(frame, quota, settled) : sink.sendFrame(frame, quota)
      },
    }

    const close = (code: number, reason: string): void => {
      try { ws.close(code, reason) } catch { ws.terminate() }
    }

    // The handshake is asynchronous; established local control frames are not.
    // Keep its suspension state out of the per-message hot path.
    const selectMachine = async (raw: RawData, isBinary: boolean): Promise<void> => {
      if (isBinary) { close(4400, 'machine_select required'); return }
      const frame = jsonFrame(raw)
      const payload = frame?.payload as Record<string, unknown> | undefined
      const requestedMachineId = payload?.machineId
      if (typeof requestedMachineId === 'string') boundMachineId = requestedMachineId
      if (frame?.type !== 'machine_select'
        || typeof requestedMachineId !== 'string'
        || payload?.localProtocolVersion !== LOCAL_WS_PROTOCOL_VERSION) {
        close(4403, 'machine mismatch')
        return
      }
      // A harness someone shared with this account, watched read-only through the gateway, which holds the
      // Share relay's socket (sharing/relay.ts): 4403 when the share ended, 1013 when it is out of reach.
      if (typeof payload.shareId === 'string') {
        if (!options.relayPool?.acquireShare) { close(4403, 'Sharing is unavailable'); return }
        try {
          relay = await options.relayPool.acquireShare(requestedMachineId, payload.shareId, terminalSink, close)
          if (ws.readyState !== WebSocket.OPEN) { relay.detach(); return }
          selected = true
        } catch (error) {
          close(error instanceof RelayConnectError && error.closeCode ? error.closeCode : 1013,
            error instanceof Error ? error.message.slice(0, 120) : 'Sharing unavailable')
        }
        return
      }
      // One of the core's own services, started by harnessd's master: its frames go to its link, and it
      // never joins the windows' event stream. Known by its token, the secret the master gave only it and
      // the core for this boot, never by the machine id it names: a signed-in core serves under its
      // account's machine id while a service names this computer's, and matching them refused every
      // service of every signed-in daemon (found by the release rehearsal, signed in).
      if (payload.role === 'service') {
        const link = options.services?.accept(String(payload.service ?? ''), String(payload.token ?? ''), { ...sink, buffered: () => ws.bufferedAmount }, close, () => {
          sink.sendFrame({ type: 'connected', payload: { machineId: options.machineId, transport: 'local', localProtocolVersion: LOCAL_WS_PROTOCOL_VERSION, service: payload.service } })
        }) ?? null
        if (!link) { close(4401, 'service refused'); return }
        serviceLink = link
        selected = true
        return
      }
      if (requestedMachineId === options.machineId) {
        tool = payload.tool === true
        // Outside text: only names this daemon knows are kept. A window's is never read: it is sent the dial anyway.
        const watch: readonly 'dial'[] = tool && Array.isArray(payload.watch) && payload.watch.includes('dial') ? ['dial'] : []
        // `harness tui` says so; every other window is the desktop app. Each is its own presence.
        const registration = { ...(tool ? { tool: true, watch } : payload.client === 'tui' ? { surface: 'tui' as const } : {}),
          ...(payload.questionProtocol === 1 ? { questionProtocol: 1 as const } : {}),
          ...(payload.eventsProtocol === 1 ? { eventsProtocol: 1 as const } : {}),
        }
        if (!options.backend.registerLocalClient(connId, terminalSink, registration)) {
          close(1011, 'local registration failed')
          return
        }
        selected = true
        windowSinks.set(connId, sink)
        sink.sendFrame({
          type: 'connected',
          payload: {
            machineId: options.machineId,
            transport: 'local',
            localProtocolVersion: LOCAL_WS_PROTOCOL_VERSION,
            terminalProtocolVersion: TERMINAL_BINARY_VERSION,
            e2ee: false,
            // A tool's frame only: the window's handshake parser is shared with the relay path (below).
            ...(tool ? { features: [...LOCAL_TOOL_FEATURES] } : {}),
            ...(payload.questionProtocol === 1 ? { questionProtocol: 1 } : {}),
            ...(payload.eventsProtocol === 1 ? { eventsProtocol: 1 } : {}),
          },
        })
        // Right after, not inside `connected`: the window's handshake parser is shared with the
        // relay path, and a field it does not expect is a field it has to learn to ignore. A tool that did not
        // ask for the dial is not told it.
        if (options.dialStatus && (!tool || watch.includes('dial'))) sink.sendFrame({ type: 'dial_status', payload: options.dialStatus() })
        if (options.openQuestions && payload.questionProtocol !== 1) replayLegacyQuestions(options.openQuestions(), frame => { sink.sendFrame(frame) })
        return
      }
      // Not this daemon's own machine — relay to backend for the other machines this same
      // signed-in user owns, if the daemon was wired up to do that (see lib/remoteRelay.ts).
      if (!options.relayPool || !options.autonomousEnv) {
        close(4403, 'machine mismatch')
        return
      }
      // A tool reads only its own replies, so it gets a background pool like any other, never the window's shared one:
      // that upstream would carry the tool's select when the tool dialled first. `relayIsolation` upstream tells the
      // backend it hears only frames addressed to it and is no app on that machine (OPENHARNES-13).
      const isolated = payload?.relayIsolation === true || payload?.tool === true
      // The local client observed a live RPC time out against an otherwise-"connected" machine —
      // its pooled entry is suspect (most commonly the relayed machine's own Harness process
      // restarted, dropping its E2EE session without the transport itself ever closing). Drop it
      // so this select dials fresh instead of handing back the same dead session again.
      if (payload?.forceReconnect === true) {
        if (isolated) options.relayPool.invalidateIsolated(requestedMachineId)
        else options.relayPool.invalidate(requestedMachineId)
      }
      try {
        relay = isolated
          ? await options.relayPool.acquireIsolated(requestedMachineId, options.autonomousEnv,
            { ...frame, payload: { ...payload, relayIsolation: true } }, terminalSink, close)
          : await options.relayPool.acquire(requestedMachineId, options.autonomousEnv, frame, terminalSink, close)
        if (ws.readyState !== WebSocket.OPEN) { relay.detach(); return }
        selected = true
        windowSinks.set(connId, sink)
      } catch (err) {
        const noPeerLink = err instanceof RelayConnectError && err.message === 'NO_PEER_LINK'
        const code = noPeerLink ? 4404 : err instanceof RelayConnectError && err.closeCode ? err.closeCode : 1011
        close(code, err instanceof Error ? err.message.slice(0, 120) : 'relay failed')
      }
      return
    }

    // A JSON frame past LOCAL_JSON_MAX_BYTES is refused by name, with its size and the limit, before the close (1009, too big): closed
    // with no word, an agent that posted a long log heard only "The connection to Harness closed." (Q3, 2026-11-10).
    const tooLarge = (raw: RawData, isBinary: boolean): boolean => {
      if (isBinary || serviceLink || ws.readyState !== WebSocket.OPEN) return false
      const bytes = rawBytes(raw)
      if (bytes <= LOCAL_JSON_MAX_BYTES) return false
      console.warn(`[local-ws] ${connId} FRAME_TOO_LARGE ${bytes} bytes, past ${LOCAL_JSON_MAX_BYTES}: refused, closing`)
      ws.send(JSON.stringify({ type: 'frame_too_large', payload: { error: 'FRAME_TOO_LARGE', bytes, limit: LOCAL_JSON_MAX_BYTES } }))
      close(1009, 'frame too large')
      return true
    }

    ws.on('message', (raw, isBinary) => {
      chain = chain.then(() => {
        if (tooLarge(raw, isBinary)) return
        if (!selected) return selectMachine(raw, isBinary)
        if (serviceLink) {
          if (isBinary) { serviceLink.receiveBinary(binaryBytes(raw)); return }
          // Tropic's agent list exceeded the window's 512 KiB limit and kept
          // dropping the gateway, taking every remote pane with it. Only a
          // token-authenticated service may use the existing transport ceiling.
          const frame = jsonFrame(raw, MAX_WS_MESSAGE_BYTES)
          if (!frame) { close(4400, 'invalid json frame'); return }
          serviceLink.receive(frame)
          return
        }

        // Parsed ONCE. Every sniff below used to re-run JSON.parse on the same bytes — up to seven
        // times for a frame that matched none of them, which is what a terminal_ack (every 16ms of
        // output) and a resize are. A frame that does not parse falls through all of them, as before,
        // to the close at the bottom.
        const parsed = isBinary ? null : jsonFrame(raw)

        // Local reading context must never reach a remote daemon/cloud relay.
        if (parsed?.type === 'app_selection_result' || parsed?.type === 'app_visit_result' || parsed?.type === 'app_form_result') {
          const p = parsed.payload
          if (windowSinks.has(connId) && boundMachineId && p && typeof p === 'object' && !Array.isArray(p)) {
            const reply = parsed.type === 'app_form_result' ? options.onFormReply :
              parsed.type === 'app_visit_result' ? options.onVisitReply : options.onSelectionReply
            reply?.(connId, boundMachineId, p as Record<string, unknown>)
          }
          return
        }

        // Local desktop acknowledgement only; never forward this through a remote relay.
        if (parsed?.type === 'device_prepare_opened') {
          const p = parsed.payload as Record<string, unknown> | undefined
          if (!relay && boundMachineId === options.machineId && typeof p?.operationId === 'string'
            && /^[a-f0-9]{64}$/.test(p.operationId) && typeof p.agentId === 'string' && p.agentId.length > 0 && p.agentId.length <= 200) {
            options.onDevicePrepareOpened?.(p.operationId, p.agentId)
          }
          return
        }
        // hn's own measurement, for this computer's product-usage queue alone: one-way, never answered,
        // never relayed to another machine or handed to the backend socket's dispatch. Over the owner's
        // socket only, from a window (not a tool) bound to this machine; the backend checks it is hn's.
        if (parsed?.type === 'product_observe') {
          if (trusted && !tool && !relay && boundMachineId === options.machineId && windowSinks.has(connId)) {
            options.backend.observeProduct?.(connId, parsed.payload)
          }
          return
        }
        // THE APP MOVED — tell whoever wants to follow it, before the frame is dispatched either way.
        // Sniffed here rather than in the backend socket because that path never sees a RELAYED machine's
        // frames: those are forwarded upstream a few lines below and would be invisible, which is exactly
        // the case that matters — the dial has to follow the window onto ANOTHER machine too.
        // The window's tile ROSTER. Consumed here like `app_focus` — it describes
        // a screen at this desk, not anything the machine could act on.
        //
        // It carries every agent the window has open, INCLUDING ones belonging
        // to other machines, and the app sends the same list to every daemon it
        // is connected to. That is deliberate: the dial is served by whichever
        // daemon owns the cable, and only a full picture lets that one decide
        // whether a finished turn is already in front of the person.
        if (!isBinary && options.onAppPanes) {
          if (parsed?.type === 'app_panes') {
            const payload = parsed.payload as Record<string, unknown> | undefined
            const raw = payload?.agentIds
            const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && id !== '') : []
            // Absent from a window that predates the field. TRUE then, which is
            // what every such window meant: it only ever sent this list while it
            // was up, and reading absence as "behind something" would start
            // announcing work that is in plain sight.
            const foreground = payload?.foreground !== false
            sentPanes = true
            paneRosters.delete(connId)
            paneRosters.set(connId, { ids, foreground })
            options.onAppPanes(ids, foreground)
            return
          }
        }
        // THE WINDOW LOOKED AT A HARNESS. Consumed here like `app_focus` and the
        // roster above — it describes a pair of eyes at this desk, not anything
        // the machine could act on, so it never goes on the wire.
        //
        // The dial takes a notification away when a row is TAPPED; the window
        // takes it away when the tab holding that harness comes to the front.
        // Two gestures, and each has to reach the other screen or the badge and
        // the pill part company the first time either is used. This is the half
        // the window owns; the dial's half already travels as `agent.open`.
        if (!isBinary && options.onAgentSeen) {
          if (parsed?.type === 'agent_seen') {
            const agentId = (parsed.payload as Record<string, unknown> | undefined)?.agentId
            const rawToken = (parsed.payload as Record<string, unknown> | undefined)?.readToken
            const readToken = notificationReadToken(rawToken)
            // Invalid versioned receipts must not become unversioned clears.
            if (rawToken !== undefined && !readToken) return
            if (typeof agentId === 'string' && agentId) options.onAgentSeen(agentId, readToken)
            return
          }
        }
        // EVERYTHING THE WINDOW STILL HAS UNREAD. Consumed here like the roster and the focus — it
        // describes a screen at this desk, never anything a machine could act on.
        //
        // The dial keeps its drawer in RAM and loses it to any reboot, while this window does not.
        // Held here so a cable attaching later can be handed the list without a round trip to a window
        // that may be busy.
        if (!isBinary && options.onAppUnread) {
          if (parsed?.type === 'app_unread') {
            const raw = (parsed.payload as Record<string, unknown> | undefined)?.items
            const items = Array.isArray(raw)
              ? raw.flatMap((row) => {
                  const item = row as Record<string, unknown> | null
                  const agentId = item?.agentId
                  const machineId = item?.machineId
                  const text = typeof item?.text === 'string' ? item.text : ''
                  return typeof agentId === 'string' && agentId && typeof machineId === 'string'
                    ? [{ agentId, machineId, question: item?.question === true, text,
                        ...(notificationReadToken(item?.readToken) ? { readToken: notificationReadToken(item?.readToken) } : {}) }]
                    : []
                })
              : []
            options.onAppUnread(items)
            return
          }
        }
        if (!isBinary && options.onAppSwarms) {
          if (parsed?.type === 'app_swarms') {
            const swarms = appSwarmsFrom(parsed.payload)
            if (swarms) {
              sentSwarms = true
              swarmRosters.delete(connId)
              swarmRosters.set(connId, swarms)
              options.onAppSwarms(swarms)
              options.onAppTabAgents?.(connId, swarms.swarms.flatMap(s => s.agentIds))
            }
            return
          }
        }
        // A frame a service answers (core/api.ts `SERVICE_WS_FRAMES`): ⌘K's pick and its send, and the window's answer to a
        // spoken task. Consumed here like app_focus, on a connection relayed to another machine too: each describes a hand
        // at this desk, not anything a machine could act on. ⌘K rides the app's own rpc convention, `payload.requestId`
        // out and the same id back (ws_conn.dart `request()`), and an answer ALWAYS goes back: the window holds a spinner
        // open on that id, and silence is the one reply it cannot recover from.
        //
        // Answered OFF this connection's ordered chain, which carries the terminal's keystrokes: the answer is the
        // devices' (the fleet's router), in a process of their own, and one that hangs must not hold a window's typing until
        // the request times out. Nothing orders on the answer but its request id.
        const serve = parsed && options.serviceFrames?.get(parsed.type)
        if (serve) {
          void serve(connId, parsed!).then((reply) => { if (reply) sink.sendFrame(reply) })
          return
        }
        // THE PAIR BRAIN'S FRAMES. Local only, in both directions: never forwarded to a relayed machine,
        // never dispatched into the backend socket (whose `send()` uploads). Not awaited on this chain — an
        // answer relayed to another machine takes seconds, and this chain carries the terminal's keystrokes.
        //
        // A key here can answer a harness, so the transport is part of the check (daemons/BRAIN.md,
        // "Security"): only the Unix socket, whose file mode keeps other users out — never the TCP port any
        // user's process can reach — and, for everything but presence, only a window bound to this machine.
        // An individual's art: the same socket rule as the keys below, but no window rule — a plate moves
        // nothing. Not awaited either: a plate not drawn yet takes seconds.
        if (!isBinary && parsed?.type === DAEMON_PLATE_GET) {
          const payload = (parsed.payload && typeof parsed.payload === 'object' && !Array.isArray(parsed.payload)
            ? parsed.payload : {}) as Record<string, unknown>
          const refuse = (error: string, detail?: string): void => {
            sink.sendFrame({ type: DAEMON_PLATE, payload: { requestId: payload.requestId, error, ...(detail ? { detail } : {}) } })
          }
          if (!trusted) { refuse('LOCAL_SOCKET_REQUIRED', 'The daemon takes these only over its own socket, never TCP.'); return }
          refuse('UNSUPPORTED')
          return
        }
        if (!isBinary && parsed && typeof parsed.type === 'string' && DAEMON_IN_TYPES.has(parsed.type)) {
          const type: string = parsed.type
          const payload = (parsed.payload && typeof parsed.payload === 'object' && !Array.isArray(parsed.payload)
            ? parsed.payload : {}) as Record<string, unknown>
          const answer = (fields: Record<string, unknown>): void => {
            const resultType = DAEMON_RESULT[type]
            if (!resultType) return   // presence and shown are one-way: dropped, never answered
            sink.sendFrame({ type: resultType, payload: {
              requestId: payload.requestId,
              ...(type === 'daemon_act' ? { id: payload.id } : {}),
              ...(type === 'daemon_confirm' ? { kind: payload.kind, nonce: payload.nonce } : {}),
              ...fields,
            } })
          }
          if (!trusted) { answer({ ok: false, error: 'LOCAL_SOCKET_REQUIRED', detail: 'The daemon takes these only over its own socket, never TCP.' }); return }
          if (tool) { answer({ ok: false, error: 'UI_ONLY', detail: 'A tool is not a window: keys, talk and confirmations come from a window.' }); return }
          const ui = !relay && boundMachineId === options.machineId
          if (type === 'daemon_presence' || type === 'daemon_shown') return
          if (!ui) { answer({ ok: false, error: 'UI_ONLY' }); return }
          answer({ ok: false, error: 'UNSUPPORTED' })
          return
        }
        if (!isBinary && boundMachineId && ws.readyState === WebSocket.OPEN) {
          const agentId = (parsed?.payload as Record<string, unknown> | undefined)?.agentId
          if (parsed?.type === 'app_focus') {
            if (agentId === null || (typeof agentId === 'string' && agentId)) {
              explicitFocusClients.add(connId)
              // Ahead of the dial's revision check below: that gate is about which agent the voice
              // follows, and a stale one says nothing about which terminal is in front of the person.
              // Only this daemon's own streams — a relayed machine's live on that machine's daemon.
              if (!relay && boundMachineId === options.machineId) {
                const listed = (parsed.payload as Record<string, unknown>)?.visibleAgents
                const visible = Array.isArray(listed) ? listed.filter((id): id is string => typeof id === 'string' && !!id) : undefined
                options.backend.setLocalTerminalFocus?.(connId, agentId, visible)
              }
              const revision = (parsed.payload as Record<string, unknown>)?.focusRevision
              const machine = boundMachineId
              const failed = (): void => { console.warn('[local-ws] FOCUS_VALIDATION_UNAVAILABLE') }
              try {
                const validation = options.onAppFocusState?.(machine, agentId, connId,
                  typeof revision === 'string' ? revision : undefined)
                if (validation instanceof Promise) {
                  // Never put this wait on the dispatch chain: a later explicit choice must win now.
                  void validation.then(apply => {
                    if (ws.readyState !== WebSocket.OPEN || windowSinks.get(connId) !== sink || boundMachineId !== machine) return
                    if (apply && apply() && agentId) options.onAppFocus?.(machine, agentId)
                  }).catch(failed)
                } else if (validation !== false && agentId) options.onAppFocus?.(machine, agentId)
              } catch { failed() }
            }
            // Focus is local desk state and must never be forwarded to a remote machine.
            return
          }
          // Compatibility for windows that never report selection. A modern window restores every
          // terminal on reconnect; their attachment order is not the pane the person selected.
          // (A watch-only open is hn with no terminal reading a pane: nobody is in front of it.)
          if (parsed?.type === 'terminal_open' && !explicitFocusClients.size && typeof agentId === 'string' && agentId
            && (parsed.payload as Record<string, unknown>).watch !== true) {
            options.onAppFocus?.(boundMachineId, agentId)
          }
        }

        // A device on THIS desk, named by the fleet's id. Like app_focus it is answered here and never
        // forwarded: a robot plugged into this computer is nothing a remote machine can act on, and the
        // reply is the ordinary `dial_status` the device's own answer produces.
        if (parsed?.type === 'dial_settings') {
          // Legacy settings are only for this desk. Remote management uses the
          // encrypted harness_device_settings RPC, dispatched by the host.
          if (relay || boundMachineId !== options.machineId) return
          const payload = (parsed.payload ?? {}) as Record<string, unknown>
          const id = typeof payload.id === 'string' ? payload.id : ''
          options.onDialSettings?.(id, payload)
          return
        }

        if (relay) {
          // The relay now terminates E2EE itself (lib/remoteRelay.ts) — every frame past this point is
          // already plaintext going in and out, so binary frames use the SAME local wire format as this
          // daemon's own machine.
          if (isBinary) {
            const clear = decodeTerminalLocal(binaryBytes(raw))
            if (!clear) { close(4400, 'invalid terminal frame'); return }
            return relay.sendBinary(clear)
          }
          if (!parsed) { close(4400, 'invalid json frame'); return }
          return relay.send(withLocalClient(parsed, options.localClient))
        }

        if (isBinary) {
          const bytes = binaryBytes(raw)
          const frame = clientStreamLocalFrame(bytes) ?? decodeTerminalLocal(bytes)
          if (!frame) { close(4400, 'invalid terminal frame'); return }
          return options.backend.handleLocalBinary(connId, frame, bytes)
        }
        if (!parsed) { close(4400, 'invalid json frame'); return }
        options.backend.handleLocalFrame(connId, parsed)
      }).catch(() => close(1011, 'local dispatch failed'))
    })

    // Loopback: a late pong here means the app is hung or gone, not a slow network, so the deadline is
    // tighter than the cloud link's — two pings, not three. Noticing a crashed window sooner is what
    // clears its tile roster (see cleanup) sooner.
    const heartbeat = watchSocketLiveness(ws, {
      deadlineMs: LOCAL_IDLE_DEADLINE_MS,
      onIdle: (idleMs) => console.log(`[local-ws] ${connId} no traffic for ${Math.round(idleMs / 1000)}s — terminating`),
      // The app is on this computer and slept with us, so a wake re-probes it rather than ending the
      // socket — but only once per answer. Unbounded forgiveness is what let a window that was already
      // gone keep its tile roster for 912-995s against this 40s deadline (wsLiveness.ts GENUINE_SLEEP_MS).
      onWake: (sleptMs, givingUp) => console.log(`[local-ws] ${connId} woke after ${Math.round(sleptMs / 1000)}s asleep — ${givingUp ? 'the app has not answered since the last wake, terminating' : 're-probing'}`),
    })

    const cleanup = (): void => {
      heartbeat.stop()
      const wasWindow = windowSinks.delete(connId)
      explicitFocusClients.delete(connId)
      if (wasWindow && boundMachineId) options.onAppDisconnect?.(boundMachineId, connId)
      // Only the latest reporter can change the desk on close. If another
      // socket still reports a window, restore its latest state; the last
      // window going away is what empties the device's panes and tabs.
      if (sentPanes) {
        const latest = [...paneRosters.keys()].at(-1) === connId
        paneRosters.delete(connId)
        if (latest) {
          const remaining = [...paneRosters.values()].at(-1)
          options.onAppPanes?.(remaining?.ids ?? [], remaining?.foreground ?? false)
        }
      }
      if (sentSwarms) {
        const latest = [...swarmRosters.keys()].at(-1) === connId
        swarmRosters.delete(connId)
        if (latest) options.onAppSwarms?.([...swarmRosters.values()].at(-1) ?? null)
      }
      if (sentSwarms) options.onAppTabAgents?.(connId, null)
      if (serviceLink) { serviceLink.closed(); serviceLink = null }
      else if (relay) { relay.detach(); relay = null }
      else if (selected) void options.backend.unregisterLocalClient(connId)
      selected = false
    }
    ws.once('close', cleanup)
    ws.once('error', () => { /* close performs cleanup */ })
  })

  return {
    sendToWindow: (connId, frame) => windowSinks.get(connId)?.sendFrame(frame) ?? false,
    close: async () => {
      for (const each of servers) each.off('upgrade', onUpgrade)
      for (const client of wss.clients) client.close(1001, 'server shutting down')
      // A client that does not answer the close (a suspended `hn`, a window whose process is hung) held
      // this for ws's own close timeout, 30 s, and with it every shutdown: an update's teardown, and the
      // core of a master that is gone, whose successor waits for its socket only 20 s.
      const grace = setTimeout(() => { for (const client of wss.clients) client.terminate() }, LOCAL_WS_CLOSE_GRACE_MS)
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      clearTimeout(grace)
    },
  }
}
