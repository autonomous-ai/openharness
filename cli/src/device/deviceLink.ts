// The daemon as a DEVICE on the backend's device plane, held on the dial's behalf.
//
// This is the only thing in the CLI that reaches a machine that is not this computer. It exists because
// the dial has no network of its own: everything it can ask for about another machine is asked here and
// answered back over the cable.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────────────────
// It is NOT the daemon's own backend socket. `BackendSocket` (/api/adapter-ws) holds the NODE role for
// this computer's machine and is the sole writer of its down-channel; this holds the COMMANDER role on
// somebody else's. Different endpoint, different role, different lifetime — and no conflict, because the
// backend keys hub clients by (machineId, kind).
//
// Three rules, each paid for:
//
//   1. THE LOCAL MACHINE NEVER COMES THROUGH HERE. Its agents are in this process. Routing them to a dial
//      plugged into this very computer via the cloud would add a round trip, a failure mode and an
//      audience, for nothing. `attach()` refuses it outright rather than trusting callers.
//
//   2. NEVER CLEAR THE AUTH SESSION. `BackendSocket.onRevoked` owns that decision. Two sockets racing to
//      wipe a session on the same 401 is a bug waiting for a bad afternoon; a dead DeviceLink must
//      degrade to "other machines unavailable" and leave the cabled machine working. It holds no session
//      either: its tokens come from the core's (`core.account.accessToken`), and its E2EE sessions are the
//      gateway's, which holds this machine's identity (`core.account.lane`, gateway/lane.ts).
//
//   3. LOG EVERY ERROR AND EVERY DROPPED FRAME. This feature's characteristic bug is SILENT EMPTINESS —
//      an RPC answered with an error nobody printed, a card arriving in a shape nobody recognised. All of
//      them render as "the carousel is empty", and none of them says so anywhere by default.
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'

import WebSocket from 'ws'

import type { LaneSeal } from '../core/api.js'
import type { MachinePeer } from '../lib/e2ee/machinePeers.js'
import { isWrapped } from '../lib/relayFrames.js'
import { VERSION } from '../version.js'

/** One frame on the wire. The backend's own vocabulary, unchanged. */
export interface DeviceFrame {
  type?: string
  machineId?: string
  agentId?: string
  payload?: Record<string, unknown>
  [key: string]: unknown
}

const RPC_TIMEOUT_MS = 15_000
const PING_EVERY_MS = 15_000
const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000

/**
 * A machine's session is thrown away on the far side's word ("session unknown", a new epoch) at most this
 * often, and a session is started for frames nobody asked for at most this often. Both words come through
 * the relay, which end-to-end encryption does not trust: without a limit, repeating them would make every
 * frame cost a handshake. A far daemon restarting twice inside it is still caught by the next one.
 */
const RENEW_EVERY_MS = 30_000
/** After the far end refused this daemon's key, frames from it start no session for this long. */
const DENIED_QUIET_MS = 10 * 60_000
/** Frames held per machine while its session renews, and for how long. The restart replay is a few dozen. */
const HELD_MAX = 64
const HELD_TTL_MS = 30_000
/** What the person sent each machine, kept under its session so a refusal can name what was not delivered. */
const SENT_KEPT = 32
/** A refusal with no counter names what was sealed this recently. */
const SENT_RECENT_MS = 60_000
/** The frames that carry what the person said or chose: a turn, a stop, an answer. */
const DELIVERABLE = new Set(['message', 'cancel', 'question_response'])
/** The error a request gets when its machine's session goes before the answer came: never asked again. */
export const SESSION_GONE = 'E2EE_SESSION_GONE'

/** A turn, stop or answer that did not reach its machine, for the dial to say so (deviceFleet.ts). */
export interface Undelivered { machineId: string; type: string; agentId?: string; requestId?: string }

export type DeviceLinkStatus = 'idle' | 'connecting' | 'ready' | 'error'

export interface DeviceLinkOpts {
  /** The account's tokens, from the core (`core.account.accessToken`): one forced refresh after a 401. */
  auth: { accessToken(options?: { force?: boolean; failedToken?: string }): Promise<string> }
  backendWsBase: string
  computerId: string
  autonomousEnv: string
  /**
   * The E2EE session with each linked machine, held by the gateway under this daemon's own identity — the
   * same one `harness remote-password set`/`link connect` signs with (`core.account.lane`). The lane keeps
   * only whether each session is up.
   */
  seal: LaneSeal
  /** The pinned key for a machine, read FRESH: `harness link connect` runs as a separate process. */
  peer: (machineId: string) => MachinePeer | null
  /**
   * THIS computer's machineId, or '' before the daemon has resolved one.
   *
   * Needed because `multi_machine` attaches a commander to every machine INCLUDING this one, so this
   * socket is subscribed to its own node's cards. They are already delivered in-process; the copy that
   * comes back around through the cloud is dropped by machineId, and this is how it is recognised.
   */
  localMachineId: () => string

  log: (line: string) => void
  /** The clock, for the renewal limit. Tests only. */
  now?: () => number
}

/** The lane's side of a machine's E2EE session: whether it is up. Its keys are the gateway's. */
interface LaneSession { ready: boolean }

/** What the person sent one session of a machine: each frame with the counter it was sealed under. */
interface SentUnder { session: LaneSession; frames: Array<{ n: number | null; frame: DeviceFrame; at: number }> }

export class DeviceLink {
  private ws: WebSocket | null = null
  private attached = ''
  private wanted = ''
  private attempts = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private state: DeviceLinkStatus = 'idle'
  /** The dial is plugged in, so this socket should exist even with no machine selected. */
  private heldOpen = false
  /** Each request in flight, with the machine it asked: a session that goes fails only that machine's. */
  private readonly pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; machineId: string }>()
  private readonly listeners = new Set<(frame: DeviceFrame) => void>()
  private readonly undeliveredListeners = new Set<(what: Undelivered) => void>()
  /** Resolves when `machine_selected` lands, so callers can await the attach rather than poll for it. */
  private selectWaiter: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null
  /**
   * One session PER MACHINE, keyed by machineId.
   *
   * Only REMOTE machines (another computer running this same daemon) require one: a cloud machine's RPCs
   * are answered by the backend itself and its cards are plaintext, so there is nothing to establish and
   * nobody at the far end to establish it with.
   *
   * A MAP RATHER THAN A FIELD because the dial's carousel is no longer one machine's: it holds every
   * agent on every machine at once, so this daemon is talking to N far ends concurrently and each one
   * has its own key. Every frame in and out therefore has to say WHICH machine it belongs to before it
   * can be encrypted or read — which is exactly what the backend's outer `machineId` tag is for
   * (hub.ts deliverUpLocal tags every commander frame with it).
   */
  private readonly sessions = new Map<string, LaneSession>()
  private readonly cryptoWaiters = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  /** In-flight handshakes, so N concurrent callers for one machine send exactly ONE hello. */
  private readonly handshakes = new Map<string, Promise<void>>()
  /**
   * What goes out and what comes in, each in the order it came. Sealing and opening are a round trip to the
   * gateway, and a frame that needs none must not overtake one that does: a turn's cards, or a reply and
   * the frame after it, would arrive out of order.
   */
  private outbound: Promise<void> = Promise.resolve()
  private inbound: Promise<void> = Promise.resolve()
  /**
   * Sealed frames from a machine that arrived while it had no session up, read once the next one is.
   *
   * THE RESTART REPLAY. A far daemon that comes back replays its agents and open questions at once, under
   * its new process's keys, before anything here knows it restarted. Dropped, those questions vanished
   * from the dial for good: the far side replays only when a commander joins, not when a session renews.
   */
  private readonly held = new Map<string, Array<{ frame: DeviceFrame; at: number }>>()
  /** When each machine's session was last thrown away on the far side's word, and last started for a frame. */
  private readonly renewedAt = new Map<string, number>()
  private readonly startedAt = new Map<string, number>()
  /** What the person sent under each machine's current session, and under the one before it. */
  private readonly sent = new Map<string, SentUnder>()
  private readonly sentBefore = new Map<string, SentUnder>()
  private readonly now: () => number

  constructor(private readonly opts: DeviceLinkOpts) {
    this.now = opts.now ?? Date.now
  }

  status(): DeviceLinkStatus { return this.state }
  get selectedMachine(): string { return this.attached }

  onFrame(cb: (frame: DeviceFrame) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Hear each turn, stop or answer that did not reach its machine. Returns how to stop hearing. */
  onUndelivered(cb: (what: Undelivered) => void): () => void {
    this.undeliveredListeners.add(cb)
    return () => this.undeliveredListeners.delete(cb)
  }

  /**
   * Open the socket WITHOUT attaching to any machine, and start watching the machine list.
   *
   * Connecting and attaching are different things, and the difference is the whole reason this can be
   * held for as long as the dial is plugged in. The backend's relay starts UNATTACHED: a commander client
   * is created by `machine_select`, or by `machines_watch` when a device advertises `multi_machine` —
   * which this one deliberately does not. So the socket costs presence and a live machine list, and
   * nothing else: no machine sees a commander, no daemon starts generating recap cards for a screen
   * nobody is looking at.
   */
  async online(): Promise<void> {
    this.heldOpen = true
    await this.connect()
    this.send({ type: 'machines_watch' })
  }

  /** Dial if needed, then select `machineId`. Rejects with a plain Error the caller maps to a code. */
  async attach(machineId: string): Promise<void> {
    if (!machineId) throw new Error('no machine to attach to')
    this.wanted = machineId
    if (this.attached === machineId && this.ws?.readyState === WebSocket.OPEN) return
    await this.connect()
    await this.select(machineId)
    await this.establish(machineId)
  }

  /**
   * Bring up the E2EE session for a machine that needs one, IF it does not already have a live one.
   *
   * The trust anchor is the PINNED key from `harness link connect`, never anything the backend hands over:
   * a key directory would make the relay the trust anchor, which is the exact property end-to-end
   * encryption exists to deny it.
   *
   * Idempotent and safe to call before every RPC: a machine whose session is already up returns without
   * a frame. That is what lets the caller stop tracking handshake state — the aggregated agent list talks
   * to whichever machines it needs, whenever it needs them, and each one is established on first use.
   */
  async establish(machineId: string): Promise<void> {
    if (!machineId) return
    if (this.sessions.get(machineId)?.ready) return
    // A second caller JOINS the first handshake rather than starting a rival one: two `e2e_hello`s for
    // the same machine race, and the welcome for the loser would resolve against a session that has
    // already been replaced in the map.
    const inflight = this.handshakes.get(machineId)
    if (inflight) return inflight
    const peer = this.opts.peer(machineId)
    if (!peer) return   // a cloud machine, or one whose RPCs the backend answers itself
    const session: LaneSession = { ready: false }
    this.sessions.set(machineId, session)
    const handshake = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cryptoWaiters.delete(machineId)
        reject(new Error('the machine did not answer the E2EE hello'))
      }, RPC_TIMEOUT_MS)
      this.cryptoWaiters.set(machineId, { resolve, reject, timer })
      // The gateway starts the session and words the hello. It goes in clear AND tagged: the backend routes
      // a device frame by its outer machineId, so without the tag the handshake for a background machine
      // would be delivered to the active one. A session given up meanwhile (the socket closed, a reset)
      // sends nothing, and a gateway that cannot start one fails only this one.
      this.opts.seal.hello(machineId, peer.pub).then(
        (hello) => { if (this.sessions.get(machineId) === session) this.send({ ...(hello as DeviceFrame), machineId }) },
        (err: unknown) => {
          if (this.sessions.get(machineId) === session) this.failCrypto(machineId, err instanceof Error ? err : new Error(String(err)))
        },
      )
    }).finally(() => { this.handshakes.delete(machineId) })
    this.handshakes.set(machineId, handshake)
    await handshake
    this.opts.log(`device: e2e session ready ${machineId}`)
  }



  /** Let go of whatever is attached. The socket is closed: nothing else on it is being watched. */
  /** Detach from the machine but KEEP the socket: the dial is still plugged in. */
  detach(): void {
    this.wanted = ''
    this.attached = ''
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'machine_deselect' })
  }

  /**
   * Throw away a machine's E2EE session so the next call handshakes a new one.
   *
   * A SESSION OUTLIVES THE MACHINE THAT AGREED TO IT. `establish()` returns instantly for any session in
   * this map, and nothing in the map notices that the far end stopped answering — so once a machine goes
   * away mid-session, every request to it is encrypted, sent, and waits out its timeout, forever. Measured
   * on the desk: eight minutes of `agents_list timed out` every twenty seconds, with no attempt to rebuild
   * anything, until an unrelated daemon restart cleared the map and the very first call afterwards worked.
   *
   * Deliberately NOT `failCrypto`: that rejects an in-flight handshake, and a handshake in flight is the
   * repair already happening. Returns whether there was anything to drop, so the caller can say so.
   */
  resetSession(machineId: string): boolean {
    if (!machineId || this.handshakes.has(machineId)) return false
    if (!this.sessions.has(machineId)) return false
    this.retire(machineId)
    this.sessions.delete(machineId)
    this.opts.seal.drop(machineId)
    return true
  }

  /**
   * A machine's session is gone, on the far side's word or the backend's: drop it here and at the gateway,
   * and fail at once every request still waiting on that machine (and only that machine). Their answers
   * would come under a session nobody holds any more, so each would otherwise wait out its 15 seconds, and
   * the agents list would read as empty meanwhile. A handshake in flight is the repair already under way
   * and is left alone, unless `andHandshake` (the machine went offline: nobody will answer it).
   */
  private sessionGone(machineId: string, andHandshake = false): void {
    if (this.handshakes.has(machineId)) {
      if (andHandshake) this.failCrypto(machineId, new Error(SESSION_GONE))
    } else if (this.sessions.has(machineId)) {
      this.retire(machineId)
      this.sessions.delete(machineId)
      this.opts.seal.drop(machineId)
    }
    for (const [requestId, waiter] of [...this.pending]) {
      if (waiter.machineId !== machineId) continue
      this.pending.delete(requestId)
      clearTimeout(waiter.timer)
      waiter.reject(new Error(SESSION_GONE))
    }
  }

  /** What was sent under a machine's session, kept as "the one before" once that session goes. */
  private retire(machineId: string): void {
    const current = this.sent.get(machineId)
    if (current) this.sentBefore.set(machineId, current)
    this.sent.delete(machineId)
  }

  /** Whether the far side's word may throw away a machine's session now — see RENEW_EVERY_MS. */
  private mayRenew(machineId: string): boolean {
    return this.allow(this.renewedAt, machineId)
  }

  private allow(at: Map<string, number>, machineId: string): boolean {
    const now = this.now()
    const last = at.get(machineId)
    if (last !== undefined && now - last < RENEW_EVERY_MS) return false
    at.set(machineId, now)
    return true
  }

  private undelivered(machineId: string, frame: DeviceFrame): void {
    const payload = (frame.payload ?? {}) as Record<string, unknown>
    const what: Undelivered = {
      machineId,
      type: String(frame.type ?? ''),
      ...(typeof payload.agentId === 'string' ? { agentId: payload.agentId } : {}),
      ...(typeof payload.requestId === 'string' ? { requestId: payload.requestId } : {}),
    }
    this.opts.log(`device: ${what.type} for ${machineId} was not delivered`)
    for (const cb of this.undeliveredListeners) cb(what)
  }

  release(): void {
    this.wanted = ''
    this.heldOpen = false
    this.attached = ''
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'machine_deselect' })
    }
    this.teardown('released')
  }

  stop(): void {
    this.wanted = ''
    this.heldOpen = false
    this.teardown('daemon stopping')
  }

  /** Fire-and-forget. Dropped with a line rather than thrown: a turn is not worth an unhandled rejection. */
  send(frame: DeviceFrame): void {
    this.enqueue(frame, false)
  }

  /** `deliverable`: the frame carries what the person said or chose, so a loss is reported, never silent. */
  private enqueue(frame: DeviceFrame, deliverable: boolean): void {
    const ws = this.ws
    if (ws?.readyState !== WebSocket.OPEN) {
      this.opts.log(`device: dropped ${frame.type ?? '?'} — no link`)
      if (deliverable) this.undelivered(frame.machineId || this.attached, frame)
      return
    }
    // Wrapped only once THAT MACHINE's session is up. `e2e_*` frames are the handshake itself and must go
    // in clear, or the far end would need the key to learn the key.
    //
    // The key is picked by the frame's own `machineId`, falling back to the attached machine for the
    // frames that predate multi-machine (machine_select, ping). Encrypting with the wrong machine's key
    // is the one failure here that looks like nothing at all: the far end drops it silently.
    //
    // Decided now, as the frame is handed over; sealed by the gateway in turn, and sent in the order handed.
    const machineId = frame.machineId || this.attached
    const session = this.sessions.get(machineId)
    const sealing = !!session?.ready && !String(frame.type ?? '').startsWith('e2e_')
    this.outbound = this.outbound.then(async () => {
      let out = frame
      if (sealing) {
        const sealed = await this.opts.seal.seal(machineId, frame as Record<string, unknown>).catch((): { lost: true } => ({ lost: true }))
        // Never the frame as it came: the gateway restarted under this session (or is not there), so the
        // frame goes nowhere and the next call to that machine starts a session again.
        if ('lost' in sealed) {
          this.forget(machineId, session)
          this.opts.log(`device: dropped ${frame.type ?? '?'} for ${machineId} — its E2EE session is gone`)
          if (deliverable) this.undelivered(machineId, frame)
          return
        }
        out = sealed.frame as DeviceFrame
        if (deliverable && session) this.noteSent(machineId, session, frame, out)
      }
      // The socket it was handed for: one closed meanwhile takes it with it, never the next connection.
      if (ws.readyState !== WebSocket.OPEN) {
        this.opts.log(`device: dropped ${frame.type ?? '?'} — no link`)
        if (deliverable) this.undelivered(machineId, frame)
        return
      }
      try { ws.send(JSON.stringify(out)) } catch (err) {
        this.opts.log(`device: send ${frame.type ?? '?'} failed (${(err as Error).message})`)
      }
    })
  }

  /** A session the gateway no longer holds (it restarted): forgotten here too, so the next call starts one. */
  private forget(machineId: string, session: LaneSession | undefined): void {
    if (session && this.sessions.get(machineId) === session && !this.handshakes.has(machineId)) {
      this.retire(machineId)
      this.sessions.delete(machineId)
    }
  }

  /** Keep a turn, stop or answer with the counter it went under, so a refusal of that counter can name it. */
  private noteSent(machineId: string, session: LaneSession, frame: DeviceFrame, sealed: DeviceFrame): void {
    let under = this.sent.get(machineId)
    if (under?.session !== session) {
      // Sealed under a session already replaced here: what it says belongs to that one, which is gone.
      if (this.sessions.get(machineId) !== session) return
      under = { session, frames: [] }
      this.sent.set(machineId, under)
    }
    const n = (sealed.payload as { __e2e?: { n?: unknown } } | undefined)?.__e2e?.n
    under.frames.push({ n: typeof n === 'number' ? n : null, frame, at: this.now() })
    if (under.frames.length > SENT_KEPT) under.frames.shift()
  }

  /**
   * The far end could not open what was sealed under `under`'s session from counter `n` on: it has no session
   * for this connection, so it opened NONE of them, and each turn, stop or answer among them is reported.
   * Reported, never sent again: the refusal is a clear frame that comes through the relay, and re-sending on
   * its word would let the relay replay a person's turn into a fresh session — a turn run twice.
   */
  private refused(machineId: string, under: SentUnder | undefined, n: number | null): void {
    if (!under) return
    const now = this.now()
    const lost = under.frames.filter((sent) => (n === null ? now - sent.at <= SENT_RECENT_MS : sent.n !== null && sent.n >= n))
    under.frames = under.frames.filter((sent) => !lost.includes(sent))
    for (const sent of lost) this.undelivered(machineId, sent.frame)
  }

  /**
   * Fire-and-forget for a frame carrying what the person said or chose — a turn, an answer, a stop.
   *
   * NEVER IN THE CLEAR TO A LINKED MACHINE. `send()` falls back to plaintext while a session is down, and
   * the far daemon refuses anything from the relay it cannot open. So this handshakes first and drops the
   * frame, with a line, if there is still no session. A machine with no pinned peer is one the backend
   * runs itself, where there is no daemon to seal for and plaintext is the only form it reads.
   */
  async sendSealed(frame: DeviceFrame & { machineId: string }): Promise<void> {
    const deliverable = DELIVERABLE.has(String(frame.type ?? ''))
    try { await this.establish(frame.machineId) } catch (err) {
      this.opts.log(`device: dropped ${frame.type ?? '?'} for ${frame.machineId} — ${(err as Error).message}`)
      if (deliverable) this.undelivered(frame.machineId, frame)
      return
    }
    if (this.opts.peer(frame.machineId) && !this.sessions.get(frame.machineId)?.ready) {
      this.opts.log(`device: dropped ${frame.type ?? '?'} for ${frame.machineId} — no E2EE session`)
      if (deliverable) this.undelivered(frame.machineId, frame)
      return
    }
    this.enqueue(frame, deliverable)
  }

  /**
   * One request/response, correlated by `requestId`. Rejects on timeout or an `error` in the reply.
   *
   * `machineId` names the machine to ask; omitted means the attached one. Passing it is what makes an RPC
   * to a machine the dial is not currently rendering possible at all — the backend routes a device frame
   * by its outer tag and answers from that machine's node.
   */
  async rpc(type: string, payload: Record<string, unknown> = {}, machineId = ''): Promise<Record<string, unknown>> {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('not connected')
    if (machineId) await this.establish(machineId)
    // Never in the clear to a linked machine: `send()` seals only for a session that is up, and one can go
    // between the handshake and here (a refusal, an offline notice, a pin made meanwhile). Decided in the
    // same step as the send below, so nothing can change in between.
    if (machineId && this.opts.peer(machineId) && !this.sessions.get(machineId)?.ready) throw new Error(SESSION_GONE)
    const requestId = randomUUID()

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        this.opts.log(`device: ${type} timed out after ${RPC_TIMEOUT_MS} ms`)
        reject(new Error(`${type} timed out`))
      }, RPC_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, reject, timer, machineId: machineId || this.attached })
      this.send(machineId ? { type, machineId, payload: { ...payload, requestId } } : { type, payload: { ...payload, requestId } })

    })
  }

  // ── connection ──────────────────────────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return
    if (this.ws?.readyState === WebSocket.CONNECTING) return this.waitOpen()
    this.state = 'connecting'
    const base = this.opts.backendWsBase.replace(/\/$/, '')
    const url = `${base}/api/device-ws?computer=${encodeURIComponent(this.opts.computerId)}`
      + `&label=${encodeURIComponent(hostname())}`
      + `&autonomousEnv=${encodeURIComponent(this.opts.autonomousEnv)}`

    let token = await this.opts.auth.accessToken()
    this.opts.log(`device: connecting → ${base}/api/device-ws`)
    try {
      await this.open(url, token)
    } catch (err) {
      // Exactly ONE forced refresh, and only for a 401. Anything else is not a token problem, and a
      // refresh loop against a backend that is simply down burns the refresh token for nothing.
      if (!/401/.test(String((err as Error).message))) throw err
      token = await this.opts.auth.accessToken({ force: true, failedToken: token })
      await this.open(url, token)
    }
  }

  private open(url: string, token: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, [token])
      this.ws = ws
      const onError = (err: Error): void => { cleanup(); reject(err) }
      const onOpen = (): void => {
        cleanup()
        this.attempts = 0
        this.state = 'ready'
        // `e2ee_data` says this side can decrypt an encrypted `*_result` — which it can, through the
        // gateway's session (gateway/lane.ts). Advertising it before that was true would turn a clean
        // E2EE_REQUIRED error into a hang, which is why it went in only once the session did.
        //
        // `multi_machine` is what makes the dial's carousel span machines: the backend then holds a
        // commander client on EVERY machine at once, so each one's node runs its recap and every frame
        // it sends arrives tagged with its machineId. Without it only the selected machine is attached
        // and an RPC aimed at any other is answered by the wrong node.
        //
        // It also attaches a commander to THIS computer's own machine, which is the reason it was held
        // back before. Two guards make that harmless: the local machine's own cards are dropped on
        // arrival (see onMessage), and nothing local is ever ASKED for over this lane — cableHost reads
        // this computer's agents in-process, exactly as it did.
        this.send({
          type: 'device_hello',
          payload: { chip: 'harness-cli', firmwareVersion: VERSION, caps: ['e2ee_data', 'multi_machine'] },
        })

        this.armPing()
        resolve()
      }
      const cleanup = (): void => {
        ws.off('error', onError)
        ws.off('open', onOpen)
      }
      ws.once('error', onError)
      ws.once('open', onOpen)
      ws.on('message', (raw) => {
        this.inbound = this.inbound.then(() => this.onMessage(raw)).catch((err: unknown) => {
          this.opts.log(`device: a frame could not be read (${err instanceof Error ? err.message : String(err)})`)
        })
      })
      ws.on('close', (code) => this.onClose(code))
    })
  }

  private waitOpen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = this.ws
      if (!ws) return reject(new Error('no socket'))
      ws.once('open', () => resolve())
      ws.once('error', (err) => reject(err))
    })
  }

  private select(machineId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.selectWaiter = null
        reject(new Error('the machine did not answer'))
      }, RPC_TIMEOUT_MS)
      this.selectWaiter = { resolve, reject, timer }
      this.send({ type: 'machine_select', payload: { machineId } })
    })
  }

  private async onWelcome(machineId: string, payload: Record<string, unknown>): Promise<void> {
    const session = this.sessions.get(machineId)
    if (!session) return
    const welcomed = await this.opts.seal.welcome(machineId, payload).catch(() => false)
    // Given up while the gateway read it (the socket closed, a reset): a newer session is not this one's.
    if (this.sessions.get(machineId) !== session) return
    if (!welcomed) { this.failCrypto(machineId, new Error('E2EE_HANDSHAKE_FAILED')); return }
    session.ready = true
    const waiter = this.cryptoWaiters.get(machineId)
    if (waiter) { clearTimeout(waiter.timer); this.cryptoWaiters.delete(machineId); waiter.resolve() }
    // Inside the inbound queue, so what was held is read before anything that came after the welcome.
    await this.drain(machineId, session)
  }

  private failCrypto(machineId: string, err: Error): void {
    if (this.sessions.get(machineId)) this.retire(machineId)
    if (this.sessions.delete(machineId)) this.opts.seal.drop(machineId)
    this.drop(machineId, 'its session could not be made')
    const waiter = this.cryptoWaiters.get(machineId)
    if (waiter) { clearTimeout(waiter.timer); this.cryptoWaiters.delete(machineId); waiter.reject(err) }
  }

  /**
   * Keep a sealed frame from a machine with no session up, and start one for it unless one is on its way.
   * `renewing`: the caller just threw the old session away for it, which was already limited.
   */
  private hold(machineId: string, frame: DeviceFrame, renewing: boolean): void {
    const list = this.held.get(machineId) ?? []
    if (list.length >= HELD_MAX) {
      this.opts.log(`device: held too many frames for ${machineId} while its session renews — dropped ${frame.type ?? '?'}`)
    } else {
      list.push({ frame, at: this.now() })
      this.held.set(machineId, list)
    }
    if (this.handshakes.has(machineId)) return
    if (!renewing && !this.allow(this.startedAt, machineId)) return
    // Not awaited: its welcome comes through the very inbound queue this is running in.
    void this.establish(machineId).catch((err: unknown) => {
      this.opts.log(`device: could not renew the E2EE session with ${machineId} (${err instanceof Error ? err.message : String(err)})`)
    })
  }

  /** Read what was held for a machine under the session that just came up, in the order it arrived. */
  private async drain(machineId: string, session: LaneSession): Promise<void> {
    const list = this.held.get(machineId)
    if (!list) return
    this.held.delete(machineId)
    const now = this.now()
    for (const { frame, at } of list) {
      if (now - at > HELD_TTL_MS) { this.opts.log(`device: a held ${frame.type ?? '?'} from ${machineId} waited too long — dropped`); continue }
      // Given up while the gateway read the last one (the socket closed, a reset): a newer session is not this one's.
      if (this.sessions.get(machineId) !== session) return
      const opened = await this.opts.seal.open(machineId, frame as Record<string, unknown>).catch((): { lost: true } => ({ lost: true }))
      if (!('frame' in opened)) {
        // Still not readable under the session it renewed: stale, or forged by the relay. Never held again.
        this.opts.log(`device: a held ${frame.type ?? '?'} from ${machineId} is not from the session it renewed — dropped`)
        continue
      }
      this.route(opened.frame as DeviceFrame)
    }
  }

  /** Let go of what was held for a machine (or for all of them), saying so. */
  private drop(machineId: string | null, why: string): void {
    for (const [id, list] of [...this.held]) {
      if (machineId !== null && id !== machineId) continue
      this.held.delete(id)
      if (list.length) this.opts.log(`device: dropped ${list.length} held frame(s) from ${id} — ${why}`)
    }
  }


  private armPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    // App-level, not a WS ping: the backend refreshes device presence on any inbound frame, and a socket
    // that stops being present is dropped from every machine it is attached to.
    this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_EVERY_MS)
  }

  private teardown(why: string): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(why)) }
    this.pending.clear()
    if (this.selectWaiter) { clearTimeout(this.selectWaiter.timer); this.selectWaiter.reject(new Error(why)); this.selectWaiter = null }
    // EVERY session, not just the attached machine's. The socket is what carried all of them; a session
    // left in the map after it dies would encrypt the first frame of the next connection with a key the
    // far end has already forgotten, and that frame is dropped in silence at the other end.
    for (const machineId of [...this.cryptoWaiters.keys(), ...this.sessions.keys()]) {
      this.failCrypto(machineId, new Error(why))
    }
    this.drop(null, why)
    // What was sent on this socket is unknowable now: none of it is named by a later refusal.
    this.sent.clear()
    this.sentBefore.clear()

    const ws = this.ws
    this.ws = null
    this.attached = ''
    this.state = 'idle'
    try { ws?.close() } catch { /* already gone */ }
  }

  private onClose(code: number): void {
    this.opts.log(`device: closed (${code})`)
    const wanted = this.wanted
    const heldOpen = this.heldOpen
    this.teardown(`socket closed (${code})`)
    if (!wanted && !heldOpen) return
    // 401/403 after the one refresh above is a decision, not a hiccup: stop, and let the cabled machine
    // carry on. Clearing the session here is NOT this class's call — see rule 2 in the header.
    if (code === 4401 || code === 4403) {
      this.state = 'error'
      this.opts.log('device: not authorized — other machines are unavailable until the next sign-in')
      return
    }
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(this.attempts++, 5))
    this.reconnectTimer = setTimeout(() => {
      // Re-select only if a machine was selected. A socket held open purely for presence comes back the
      // same way it went up — connected and attached to nothing.
      const retry = wanted ? this.attach(wanted) : this.online()
      void retry.catch((err) => this.opts.log(`device: reconnect failed (${(err as Error).message})`))
    }, delay)
  }

  private async onMessage(raw: WebSocket.RawData): Promise<void> {
    let frame: DeviceFrame
    try { frame = JSON.parse(raw.toString()) as DeviceFrame } catch { return }

    // WHICH MACHINE THIS CAME FROM. The backend tags every commander frame with it (hub.ts
    // deliverUpLocal), and with N machines attached at once it is the only thing that says which key
    // opens the payload. Empty means a backend-authored frame with no machine behind it.
    const from = typeof frame.machineId === 'string' ? frame.machineId : ''
    // THE ECHO GUARD. `multi_machine` subscribes this socket to this computer's own machine, so every
    // card its node publishes comes back down here. Every one of them was already delivered in-process
    // by the local path, and forwarding the cloud copy too would double every turn card on the dial.
    // RPC replies are exempt: nothing ever ASKS this lane about the local machine, so a `_result` tagged
    // with it can only be a reply this daemon is genuinely waiting for.
    if (from && from === this.opts.localMachineId() && !String(frame.type ?? '').endsWith('_result')) return


    if (frame.type === 'e2e_welcome') { await this.onWelcome(from, (frame.payload ?? {}) as Record<string, unknown>); return }
    if (frame.type === 'e2e_rekey') {
      if (this.sessions.has(from)) await this.opts.seal.rekey(from, (frame.payload ?? {}) as Record<string, unknown>).catch(() => undefined)
      return
    }
    if (frame.type === 'e2e_denied') {
      // The far end knows this daemon's key and rejected it — the pin is stale, not merely missing.
      this.opts.log(`device: e2e denied ${from} — the remote password may have changed or this machine's link was revoked, re-run \`harness link connect ${from}\``)
      this.failCrypto(from, new Error('E2EE_DENIED'))
      // Its frames start no session for a while: each would only be denied again.
      this.startedAt.set(from, this.now() + DENIED_QUIET_MS - RENEW_EVERY_MS)
      return
    }
    if (frame.type === 'e2e_session_unknown') { if (from) this.onSessionUnknown(from, (frame.payload ?? {}) as Record<string, unknown>); return }

    const session = this.sessions.get(from)
    const wrapped = isWrapped(frame.payload)
    // Sealed by a linked machine while no session with it is up — after a drop, or before the first call:
    // held, and read once one is (see `held`).
    if (wrapped && from && !session?.ready && this.opts.peer(from)) { this.hold(from, frame, false); return }
    // A frame that was never sealed (a control frame) is read as it is, as the session itself would read it
    // (lib/e2ee/relayClient.ts `unwrapIncoming`): only a sealed one goes to the gateway to be opened.
    if (session?.ready && wrapped) {
      const opened = await this.opts.seal.open(from, frame as Record<string, unknown>).catch((): { lost: true } => ({ lost: true }))
      if ('lost' in opened) {
        // The gateway restarted under the lane and holds no session: kept, and read under the next one.
        this.forget(from, session)
        this.opts.log(`device: could not decrypt ${frame.type ?? '?'} — the E2EE session with ${from} is gone, holding it for a new one`)
        this.hold(from, frame, false)
        return
      }
      if ('unknownEpoch' in opened) {
        // The far daemon restarted: this is its replay, under keys of a process the session here never met.
        if (!this.mayRenew(from)) {
          this.opts.log(`device: a ${frame.type ?? '?'} from ${from} names a new epoch, but it renewed its session moments ago — dropped`)
          return
        }
        this.opts.log(`device: ${from} restarted (a new epoch) — renewing its E2EE session, holding what it sends until then`)
        this.sessionGone(from)
        this.hold(from, frame, true)
        return
      }
      if ('unreadable' in opened) {
        // The single most misleading failure this lane has: an undecryptable card is indistinguishable
        // from no card at all, and the dial just sits through a whole turn showing nothing.
        this.opts.log(`device: could not decrypt ${frame.type ?? '?'} — dropped`)
        return
      }
      frame = opened.frame as DeviceFrame
    }
    this.route(frame)
  }

  /**
   * The far daemon says it holds no session for what this one sealed: it restarted, and opened none of it.
   *
   * Believed only for a session that is up and was not renewed moments ago. One that lands while a new hello
   * is out refused what the OLD session sealed — the far side answers in order, so its refusals of frames sent
   * before the hello come back before the welcome — and must not throw away the session being made; it still
   * names what the old session sent from the refused counter on.
   */
  private onSessionUnknown(from: string, payload: Record<string, unknown>): void {
    const refused = (payload.refused ?? {}) as { n?: unknown }
    const n = typeof refused.n === 'number' ? refused.n : null
    const session = this.sessions.get(from)
    if (!session?.ready || this.handshakes.has(from)) {
      this.refused(from, this.sentBefore.get(from), n)
      return
    }
    if (!this.mayRenew(from)) {
      this.opts.log(`device: ${from} says it lost the session, but it renewed its session moments ago — ignored`)
      return
    }
    this.refused(from, this.sent.get(from), n)
    this.opts.log(`device: ${from} no longer knows this session (it restarted) — dropped it, the next call says hello again`)
    this.sessionGone(from)
  }

  /** A frame read (opened, or never sealed): to its waiter, or to the listeners. */
  private route(frame: DeviceFrame): void {
    const from = typeof frame.machineId === 'string' ? frame.machineId : ''
    const type = frame.type ?? ''
    const payload = (frame.payload ?? {}) as Record<string, unknown>

    if (type === 'machine_selected') {
      this.attached = typeof payload.machineId === 'string' ? payload.machineId : this.wanted
      this.opts.log(`device: machine_selected ${this.attached}`)
      if (this.selectWaiter) { clearTimeout(this.selectWaiter.timer); this.selectWaiter.resolve(); this.selectWaiter = null }
      return
    }
    if (type === 'machine_select_error') {
      const code = typeof payload.error === 'string' ? payload.error : 'SELECT_FAILED'
      this.opts.log(`device: machine_select_error ${code}`)
      if (this.selectWaiter) { clearTimeout(this.selectWaiter.timer); this.selectWaiter.reject(new Error(code)); this.selectWaiter = null }
      return
    }
    if (type === 'device_revoked') {
      this.opts.log('device: revoked — this dial was removed from the account')
      this.wanted = ''
      this.teardown('revoked')
      return
    }
    // A machine the backend says went offline took its session with it: its daemon is gone or going, and the
    // one that comes back holds none. Dropped now, so the next call says hello instead of sealing for nobody.
    // Still passed on below: these are the wheel's dots.
    if (type === 'node_status' && from && payload.online === false) this.sessionGone(from, true)
    if (type === 'machines_status' && Array.isArray(payload.statuses)) {
      for (const row of payload.statuses as Array<{ machineId?: unknown; online?: unknown }>) {
        if (typeof row?.machineId === 'string' && row.machineId && row.online === false) this.sessionGone(row.machineId, true)
      }
    }

    if (type.endsWith('_result')) {
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
      const waiter = requestId ? this.pending.get(requestId) : undefined
      if (!waiter) {
        // Not noise worth suppressing: a reply nobody is waiting for is either a timeout that already
        // fired or a frame the hub filtered and re-sent, and both are worth seeing while this is young.
        this.opts.log(`device: unmatched ${type}`)
        return
      }
      this.pending.delete(requestId)
      clearTimeout(waiter.timer)
      if (typeof payload.error === 'string') {
        this.opts.log(`device: ${type} error=${payload.error}`)
        waiter.reject(new Error(payload.error))
        return
      }
      waiter.resolve(payload)
      return
    }

    for (const cb of this.listeners) cb(frame)
  }
}
