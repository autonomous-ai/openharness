/**
 * The upstream link: the daemon's dial-out connection to the backend's `/api/adapter-ws`, and nothing
 * else. Moved verbatim out of `BackendSocket` (the core boundary, step 10, R1: the relay leaves the core,
 * docs/design/2026-10-06-core-boundary-next.md): what crosses it and who may read it is the gateway's
 * (gateway/gateway.ts); this file only keeps a socket up and frames moving.
 *
 * The adapter occupies the NODE side of its agentId on the backend hub:
 *   - `up`   { t:'up', frame }            → normalized claude events + `<x>_result` RPC replies
 *   - `down` { t:'down', connId, frame }  → web chat/control + data-plane RPC requests
 *
 * Mirrors the hosted runtime’s managerSocket: idempotent connect, exponential backoff (1s→30s),
 * WS liveness (`lib/wsLiveness.ts`: ping every 20s, 60s deadline on silence) + a 15s app-level
 * `{t:'ping'}` that refreshes the backend presence key, and a bounded FIFO queue for client-facing
 * outbound frames.
 *
 * Auth: the SSO access token rides as the first WS subprotocol.
 */
import { WebSocket } from 'ws'
import { hostname } from 'os'
import { env } from '../config/env.js'
import { AuthSessionError, AuthSessionManager } from '../lib/authSession.js'
import { BACKEND_IDLE_DEADLINE_MS, watchSocketLiveness, type LivenessWatch } from '../lib/wsLiveness.js'
import { decodeTerminalHop, TerminalHopDirection } from '../lib/terminalBinary.js'
import { VERSION } from '../version.js'

const APP_PING_MS = 15_000
// Floor between two `app_presence` up-frames while a window is attached. Rides the 15s app-ping
// tick; the backend only needs to hear about it about once a minute (it floors its own Mongo write
// at five). `open` is never held back — it is the one that counts as a session in
// `user_daily_presence`.
const APP_PRESENCE_UP_MS = 60_000
// How long the opening handshake may take before the attempt is abandoned and retried. `ws` waits
// forever by default, and the heartbeat below only starts on 'open' — so a TCP connection that came
// up while the network was flapping but never got its upgrade answered sat in CONNECTING for hours,
// `this.ws` set, every later connect() returning early, and the daemon reporting "cloud
// reconnecting…" until someone restarted it.
const HANDSHAKE_TIMEOUT_MS = 15_000
const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000
const QUEUE_MAX = 2_000

export type OutboundEnvelope = Record<string, unknown>

interface QueueItem {
  id: number
  data: string
  msg: OutboundEnvelope
  attempts: number
}

/** A down envelope as the backend sends it. */
export interface DownEnvelope {
  t: 'down'
  connId?: string
  frame?: Record<string, unknown>
}

/** What the link tells its owner. Every member is called from the socket's own handlers. */
export interface UpstreamEvents {
  /** A down-frame for this machine: the backend's own (connId '') or a client's, relayed. */
  down(frame: Record<string, unknown>, connId: string): void
  /** A client's sealed terminal bytes, relayed. */
  binary(connId: string, clientFrame: Uint8Array): void
  /** The link came up (each reconnect too), after the queue began to drain. */
  up(): void
  /** The link went down: everything tied to it is gone. Called before the reconnect is scheduled. */
  gone(): void
  /** Whether the link is up, as it changes. */
  status(connected: boolean): void
  /** The account's session is over (a refused or missing refresh, a 401/403 on the upgrade): stop for good. */
  revoked(): void
  /** Another computer already holds this machine (HTTP 409): keep the session, stop for good. */
  busy(): void
  /** How many processes on this computer are attached (windows and tools): the window's presence rides
   *  the app-ping while there are any. */
  localClients(): number
}

export interface UpstreamOptions {
  machineId: string
  /** The daemon's session; without one (isolated unit tests only), `machineId` is the token. */
  auth?: Pick<AuthSessionManager, 'accessToken'>
  computerId?: string
  autonomousEnv?: string
  events: UpstreamEvents
}

export class UpstreamLink {
  private ws: WebSocket | null = null
  private connecting = false
  /** A 401 on the upgrade is being answered with a token refresh; that refresh owns the next connect. */
  private retryingAuth = false
  private readonly auth: Pick<AuthSessionManager, 'accessToken'>
  /** Constructor-without-auth is retained for isolated unit tests only. */
  private readonly testToken?: string
  private readonly url: string
  private attempts = 0
  private closed = false
  private queue: QueueItem[] = []
  private draining = false
  private nextQueueId = 1
  private droppedSinceLog = 0
  private heartbeat: LivenessWatch | null = null
  private appPing: NodeJS.Timeout | null = null
  private lastAppPresenceUpAt = 0
  // A window attached while there was no link to tell (cold start: the app dials this daemon before
  // the daemon has dialed the backend; or a daemon restart under an open window). The session is
  // real and must be counted once, so it is owed to the next link — not turned into a `ping`.
  private appOpenOwed = false
  private thisComputerOnly = false
  private readonly events: UpstreamEvents

  constructor({ machineId, auth, computerId = '', autonomousEnv = 'prod', events }: UpstreamOptions) {
    this.auth = auth ?? new AuthSessionManager(env.BACKEND_WS_URL.replace(/\/$/, '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'))
    this.testToken = auth ? undefined : machineId
    this.events = events
    // `?label=<hostname>` lets the backend record which machine connected (shown on the machine card);
    // `?computer=<stable id>` enforces one-computer-per-computer (a 2nd computer is rejected with HTTP 409);
    // `?v=<VERSION>` is our own version, which the backend stores on the machine at every connect.
    const base = `${env.BACKEND_WS_URL.replace(/\/$/, '')}/api/adapter-ws?label=${encodeURIComponent(hostname())}&v=${encodeURIComponent(VERSION)}&autonomousEnv=${encodeURIComponent(autonomousEnv)}`
    // `?machine=<id>` is the machine this daemon still believes it is. The backend uses it to tell a
    // REVOKED daemon — one whose machine was deleted while it was offline — apart from a first-time
    // pairing, and answers 403 instead of quietly minting a replacement machine. Guarded on shape
    // because in test mode the first constructor argument carries a token, not a machine id.
    const claim = /^[a-f0-9]{32}$/.test(machineId) ? `&machine=${encodeURIComponent(machineId)}` : ''
    this.url = (computerId ? `${base}&computer=${encodeURIComponent(computerId)}` : base) + claim
  }

  /** Live backend link state (`/api/status` + E2EE gating). */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /** Signed out: the cloud link is never dialed in this process's life (a sign-in restarts it), so what
   *  was queued for it is dropped and nothing more is queued: every frame, a text_delta's among them,
   *  was sealed and queued for a link that never opens, two thousand deep. */
  serveThisComputerOnly(): void { this.thisComputerOnly = true; this.queue.length = 0 }
  /** True once the daemon serves this computer only: the gateway then seals nothing for the link. */
  servesThisComputerOnly(): boolean { return this.thisComputerOnly }

  connect(): void {
    if (this.closed || this.ws || this.connecting) return
    this.connecting = true
    void this.connectWithSession()
  }

  private async connectWithSession(): Promise<void> {
    let token: string
    try {
      token = this.testToken ?? await this.auth.accessToken()
    } catch (err) {
      this.connecting = false
      this.events.status(false)
      const delay = err instanceof AuthSessionError && err.code === 'INVALID_REFRESH' ? MAX_DELAY_MS : BASE_DELAY_MS
      if (!this.closed) setTimeout(() => this.connect(), delay)
      return
    }
    if (this.closed) { this.connecting = false; return }
    // On timeout `ws` emits 'error' ("Opening handshake has timed out") then 'close', which lands in
    // onGone below and re-enters the ordinary backoff — the same path a refused connection takes.
    const ws = new WebSocket(this.url, [token], { handshakeTimeout: HANDSHAKE_TIMEOUT_MS })
    this.ws = ws
    this.connecting = false

    ws.on('open', () => {
      this.attempts = 0
      console.log(`[backend] connected → ${this.url}`)
      this.events.status(true)
      this.drainQueue()
      this.events.up()

      this.heartbeat = watchSocketLiveness(ws, {
        onIdle: (idleMs) => console.log(`[backend] no traffic for ${Math.round(idleMs / 1000)}s — terminating the link`),
        onWake: (sleptMs, hungUp) => console.log(`[backend] woke after ${Math.round(sleptMs / 1000)}s asleep — ${hungUp ? 'the backend has hung up, redialing' : 're-probing the link'}`),
        peerGivesUpAfterMs: BACKEND_IDLE_DEADLINE_MS,
      })

      // App-level ping refreshes the backend's presence key (TTL 30s). The window's presence rides
      // the same tick — a fresh socket knows nothing about the window, so its first tick goes through.
      this.lastAppPresenceUpAt = 0
      if (this.appOpenOwed && this.events.localClients() > 0) this.sendAppPresence('open')
      this.appPing = setInterval(() => {
        this.sendBestEffort({ t: 'ping' })
        if (this.events.localClients() > 0) this.sendAppPresence('ping')
      }, APP_PING_MS)
    })

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        const hop = decodeTerminalHop(new Uint8Array(raw as Buffer))
        if (hop?.direction === TerminalHopDirection.down) this.events.binary(hop.connId, hop.clientFrame)
        return
      }
      let env_: DownEnvelope
      try { env_ = JSON.parse(raw.toString()) as DownEnvelope } catch { return }
      if (env_.t === 'down' && env_.frame) {
        // A malformed/hostile down-frame (bad __e2e envelope, bad ephemeral key) can throw in the
        // pre-`try` part of the dispatch; the gateway contains it per connection. Hand it on.
        this.events.down(env_.frame, env_.connId ?? '')
      }
    })

    const onGone = (why: string): void => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.heartbeat) { this.heartbeat.stop(); this.heartbeat = null }
      if (this.appPing) { clearInterval(this.appPing); this.appPing = null }
      this.draining = false
      this.events.gone()
      this.events.status(false)
      if (this.closed) return
      // A 401 refresh owns the next connect (see the error handler below): no competing backoff timer,
      // or two sockets would race for the one machine claim.
      if (this.retryingAuth) { console.log(`[backend] disconnected (${why}) — refreshing the token before reconnecting`); return }
      const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(this.attempts++, 5))
      console.log(`[backend] disconnected (${why}) — retrying in ${Math.round(delay / 1000)}s (attempt ${this.attempts})`)
      setTimeout(() => this.connect(), delay)
    }
    ws.on('close', (code) => onGone(`close ${code}`))
    ws.on('error', (err) => {
      const e = err as Error & { code?: string }
      const msg = e.message || e.code || String(err)
      console.error('[backend] socket error:', msg)
      // 401 on the upgrade = the access token was refused. Refresh it and come back; the socket is
      // torn down the ordinary way below (`ws.close()` → onGone: timers, status, streams), which is
      // what the previous shape skipped — it nulled `this.ws` first, so onGone returned at its first
      // line, status kept saying connected, and a refresh that failed for ANY reason (a network blip
      // included) wiped the SSO session. Only a refresh token the backend itself rejects means the
      // session is over; everything else is a transient and re-enters the backoff.
      if (/Unexpected server response: 401\b/.test(msg) && !this.retryingAuth) {
        this.retryingAuth = true
        void this.auth.accessToken({ force: true, failedToken: token })
          .then(() => {
            this.retryingAuth = false
            // onGone has normally run by now (the close lands long before a network round trip
            // returns); if this socket is somehow still ours, let go of it before dialing again.
            if (this.ws === ws) { this.ws = null; try { ws.terminate() } catch { /* ignore */ } }
            this.connect()
          })
          .catch((error: unknown) => {
            this.retryingAuth = false
            // No session to refresh, or a refresh token the backend rejects: the session is over.
            if (error instanceof AuthSessionError && (error.code === 'INVALID_REFRESH' || error.code === 'MISSING')) {
              this.closed = true
              this.events.revoked()
              return
            }
            if (this.closed) return
            if (this.ws === ws) { this.ws = null; try { ws.terminate() } catch { /* ignore */ } }
            const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(this.attempts++, 5))
            console.log(`[backend] token refresh failed (${error instanceof Error ? error.message : String(error)}) — retrying in ${Math.round(delay / 1000)}s (attempt ${this.attempts})`)
            setTimeout(() => this.connect(), delay)
          })
      } else if (/Unexpected server response: 40[13]\b/.test(msg)) {
        this.closed = true
        this.events.revoked()
      }
      // 409 = another computer already holds this machine. Keep the SSO session; stop
      // retrying (the 40[13] regex above deliberately excludes 409, so without this it would loop).
      else if (/Unexpected server response: 409\b/.test(msg)) {
        this.closed = true
        this.events.busy()
      }
      try { ws.close() } catch { /* ignore */ }
    })
  }

  /** Stop for good: no reconnect, whatever the socket does next (a `machine_revoked`). */
  close(): void { this.closed = true }

  stop(): void {
    this.closed = true
    if (this.heartbeat) this.heartbeat.stop()
    if (this.appPing) clearInterval(this.appPing)
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
  }

  /**
   * The desktop window is open on this computer: tell the backend, which turns it into the person's
   * `user_daily_presence` row. The window itself says nothing — its loopback socket IS the fact, so
   * this daemon reports it: `open` the moment a window registers, `ping` on the app-ping tick while any
   * window is attached, at most once per APP_PRESENCE_UP_MS. Best-effort and plaintext on purpose: it
   * is bookkeeping about the person, not data, and a daemon that is signed out (no backend dial) or
   * between reconnects simply drops it rather than queueing a stale "was open" behind real frames.
   * Returns whether a frame went up.
   */
  sendAppPresence(kind: 'open' | 'ping'): boolean {
    const now = Date.now()
    if (kind === 'ping' && now - this.lastAppPresenceUpAt < APP_PRESENCE_UP_MS) return false
    const sent = this.sendBestEffort({
      t: 'up',
      webEligible: false,
      commanderEligible: false,
      frame: { type: 'app_presence', payload: { kind } },
    })
    if (sent) this.lastAppPresenceUpAt = now
    if (kind === 'open') this.appOpenOwed = !sent
    return sent
  }

  /** The last window left before any link could hear it attach: nothing happened, as far as the backend
   *  is concerned, and a later link must not be told otherwise. */
  noLocalClients(): void { this.appOpenOwed = false }

  enqueue(msg: OutboundEnvelope): void {
    if (this.thisComputerOnly) return
    const item: QueueItem = { id: this.nextQueueId++, data: JSON.stringify(msg), msg, attempts: 0 }
    if (this.queue.length >= QUEUE_MAX) this.dropOneQueued()
    if (this.queue.length >= QUEUE_MAX) {
      this.droppedSinceLog++
      this.logQueueDrops()
      return
    }
    this.queue.push(item)
    this.drainQueue()
  }

  sendBestEffort(msg: OutboundEnvelope): boolean {
    const data = JSON.stringify(msg)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(data); return true } catch { /* ignore */ }
    }
    return false
  }

  /** A binary packet (a sealed terminal hop) on the open link; false when there is none. */
  sendBinary(packet: Uint8Array): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    try { this.ws.send(packet); return true } catch { return false }
  }

  private drainQueue(): void {
    if (this.draining || !this.queue.length) return
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const item = this.queue[0]
    this.draining = true
    try {
      ws.send(item.data, (err?: Error) => {
        if (this.ws !== ws) return
        if (err) {
          item.attempts++
          this.draining = false
          console.error(`[backend] queued send failed (id=${item.id}, attempts=${item.attempts}):`, err.message)
          try { ws.close() } catch { /* ignore */ }
          return
        }
        if (this.queue[0] === item) this.queue.shift()
        this.draining = false
        this.drainQueue()
      })
    } catch (err) {
      item.attempts++
      this.draining = false
      console.error(`[backend] queued send threw (id=${item.id}, attempts=${item.attempts}):`, err instanceof Error ? err.message : err)
      try { ws.close() } catch { /* ignore */ }
    }
  }

  private dropOneQueued(): void {
    const idx = this.queue.findIndex((item) => !('targetConnId' in item.msg))
    const dropAt = idx >= 0 ? idx : 0
    if (this.queue.splice(dropAt, 1).length) {
      this.droppedSinceLog++
      this.logQueueDrops()
    }
  }

  private logQueueDrops(): void {
    if (this.droppedSinceLog === 1 || this.droppedSinceLog % 100 === 0) {
      console.warn(`[backend] outbound queue full; dropped ${this.droppedSinceLog} frame(s) so far`)
    }
  }
}
