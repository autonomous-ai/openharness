/**
 * Shared tabs' relay (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md): the backend's blind
 * relay between the machines of a tab shared across accounts (`/api/agent-messages-ws`, backend/src/lib/agentMessagesWs.ts).
 * It routes by tab and machine, stamps who sent each frame, and reads nothing else: what it carries was sealed by
 * `TabKey` (gateway/tabKey.ts) before it got here.
 *
 * One long-lived socket per shared tab, not one for all of them: the relay admits a socket for one tab at a time
 * (this account owns this machine and is the tab's owner or an accepted member), and checks it again as the tab
 * changes, so a socket per tab keeps that admission per tab. Removed from one tab, this machine loses that tab's
 * socket and keeps the others.
 *
 * A close of 4403 stops for good: the account left the tab or was removed from it, and dialling again would only be
 * refused again. 4409 stops too: another socket of this machine took the tab over, and dialling again would take it
 * back from that one, and so on. Both are told to Agent Messages (`closed`); every other close dials again, backing
 * off as the backend link does (gateway/upstream.ts).
 */
import { WebSocket } from 'ws'
import type { GatewayEvents, TabRelay } from '../core/api.js'
import { SHARED_TAB_FRAME_MAX } from '../lib/e2ee/tabSession.js'
import { BACKEND_IDLE_DEADLINE_MS, watchSocketLiveness, type LivenessWatch } from '../lib/wsLiveness.js'
import { declaredClientQuery } from '../lib/declaredClient.js'

/** The relay closes a socket that sends a frame bigger than this (agentMessagesWs.ts `MAX_FRAME`): refused here first. */
export const TAB_RELAY_MAX_FRAME = SHARED_TAB_FRAME_MAX
/** How long a frame sent before the relay admitted the socket waits for it. */
export const TAB_RELAY_READY_WAIT_MS = 5_000
/** The relay closes a socket that sends more than this many frames in a second (agentMessagesWs.ts `PER_SECOND`). */
export const TAB_RELAY_FRAMES = 20
/** The window those frames are kept to here: a second, and a tenth more for the frames' jitter on the way, so that
 *  twenty sent at the end of one of our windows and twenty at the start of the next never reach the relay in one of its. */
export const TAB_RELAY_WINDOW_MS = 1_100
/**
 * The most a send waits, from the moment it is called, for the relay to admit the socket and then for its turn within
 * the rate; past it the send answers false and the frame is never sent. Below the core's wait on the gateway
 * (core/gatewayLink.ts `TAB_RELAY_WAIT_MS`, 10 s): a frame that outlived that wait would be answered false to Agent
 * Messages by the core and still be sent by the gateway later, so the two would disagree on what was sent.
 */
export const TAB_RELAY_SEND_DEADLINE_MS = 8_000
/** The most frames that may wait per tab, for the relay or their turn: two seconds' worth at the relay's rate. Beyond it
 *  a send is refused at once, rather than hold its frame (up to 128 KiB) in memory for a turn it cannot get in time. */
export const TAB_RELAY_QUEUE = 2 * TAB_RELAY_FRAMES
const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000
const HANDSHAKE_TIMEOUT_MS = 10_000
/** What the relay may send: its frames are below `TAB_RELAY_MAX_FRAME` and the stamp it adds, with room to spare. */
const MAX_PAYLOAD = 2 * SHARED_TAB_FRAME_MAX
/** The relay's ids for a shared tab; it drops an upgrade for anything else before it answers. */
const SHARED_TAB_ID = /^[a-f0-9]{24}$/

export interface TabRelayDeps {
  /** The backend's WebSocket base (`env.BACKEND_WS_URL`). */
  base: string
  /** The account's environment (`prod`, …), which the relay checks the token against. */
  environment: string
  machineId: () => string
  /** The account's token, asked for at each dial; `force` after a 401, once, for the token that was refused. */
  accessToken(options?: { force?: boolean; failedToken?: string }): Promise<string>
  emit: GatewayEvents['tabFrame']
  now?: () => number
}

interface TabSocket {
  ws: WebSocket | null
  ready: boolean
  attempts: number
  timer: NodeJS.Timeout | null
  closed: boolean
  waiters: Array<(ok: boolean) => void>
  heartbeat: LivenessWatch | null
  /** When each of the last frames went, for the relay's rate. */
  sentAt: number[]
  /** The frames waiting for their turn, in the order they were sent. */
  pacing: Promise<unknown>
  /** How many sends wait now, for the relay or their turn (`TAB_RELAY_QUEUE`). */
  waiting: number
  /** Wakes the turn sleeping for its slot, when the tab is closed. */
  sleepers: Set<() => void>
}

type Payload = Record<string, unknown>
const isRecord = (value: unknown): value is Payload => !!value && typeof value === 'object' && !Array.isArray(value)
const why = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class TabRelaySockets implements TabRelay {
  private readonly sockets = new Map<string, TabSocket>()
  private readonly now: () => number

  constructor(private readonly deps: TabRelayDeps) {
    this.now = deps.now ?? Date.now
  }

  async open(sharedTabId: string): Promise<void> {
    if (!SHARED_TAB_ID.test(sharedTabId) || this.sockets.has(sharedTabId)) return
    const entry: TabSocket = { ws: null, ready: false, attempts: 0, timer: null, closed: false, waiters: [], heartbeat: null, sentAt: [], pacing: Promise.resolve(), waiting: 0, sleepers: new Set() }
    this.sockets.set(sharedTabId, entry)
    void this.dial(sharedTabId, entry)
  }

  async send(sharedTabId: string, to: string, payload: Record<string, unknown>): Promise<boolean> {
    const entry = this.sockets.get(sharedTabId)
    if (!entry || typeof to !== 'string' || !to || to.length > 128 || !isRecord(payload)) return false
    let data: string
    try { data = JSON.stringify({ type: 'amsg_frame', to, payload }) } catch { return false }
    if (Buffer.byteLength(data) > TAB_RELAY_MAX_FRAME || entry.waiting >= TAB_RELAY_QUEUE) return false
    const deadline = this.now() + TAB_RELAY_SEND_DEADLINE_MS
    entry.waiting++
    try {
      if (!entry.ready && !await this.whenReady(entry)) return false
      return await this.pace(entry, deadline, data)
    } finally {
      entry.waiting--
    }
  }

  close(sharedTabId: string): void {
    const entry = this.sockets.get(sharedTabId)
    if (!entry) return
    this.sockets.delete(sharedTabId)
    entry.closed = true
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    entry.heartbeat?.stop()
    entry.ws?.close(1000, 'Closed')
    this.settle(entry, false)
    for (const wake of [...entry.sleepers]) wake()
  }

  /** The gateway stops: every tab's socket goes with it. */
  closeAll(): void {
    for (const sharedTabId of [...this.sockets.keys()]) this.close(sharedTabId)
  }

  private async dial(sharedTabId: string, entry: TabSocket): Promise<void> {
    const short = sharedTabId.slice(0, 8)
    let token: string
    try {
      token = await this.deps.accessToken()
    } catch (error) {
      this.retry(sharedTabId, entry, `no token (${why(error)})`)
      return
    }
    if (entry.closed) return
    const { base, environment } = this.deps
    const url = `${base.replace(/\/$/, '')}/api/agent-messages-ws?share=${encodeURIComponent(sharedTabId)}`
      + `&machine=${encodeURIComponent(this.deps.machineId())}&autonomousEnv=${encodeURIComponent(environment)}&${declaredClientQuery('relay')}`
    let ws: WebSocket
    try {
      ws = new WebSocket(url, [token], { handshakeTimeout: HANDSHAKE_TIMEOUT_MS, maxPayload: MAX_PAYLOAD })
    } catch (error) {
      this.retry(sharedTabId, entry, `could not dial (${why(error)})`)
      return
    }
    entry.ws = ws
    let refused: number | null = null
    // The relay answering the upgrade with a status rather than a socket: a 401 is the token, refreshed below.
    ws.on('unexpected-response', (_request, response) => { refused = Number(response.statusCode); ws.terminate() })
    ws.on('open', () => {
      entry.heartbeat = watchSocketLiveness(ws, {
        onIdle: (idleMs) => console.log(`[shared-tabs] ${short} no traffic for ${Math.round(idleMs / 1000)}s — terminating`),
        onWake: (sleptMs, givingUp) => console.log(`[shared-tabs] ${short} woke after ${Math.round(sleptMs / 1000)}s asleep — ${givingUp ? 'giving up on the link' : 're-probing'}`),
        peerGivesUpAfterMs: BACKEND_IDLE_DEADLINE_MS,
      })
    })
    ws.on('message', (raw) => this.heard(sharedTabId, entry, String(raw)))
    // Every error ends in a close, which is where it is handled.
    ws.on('error', () => {})
    // One socket a tab at a time: the next is dialled only after this one's close.
    ws.on('close', (code, reason) => {
      entry.ws = null
      entry.ready = false
      entry.heartbeat?.stop()
      entry.heartbeat = null
      if (entry.closed) return
      if (code === 4403 || code === 4409) {
        this.sockets.delete(sharedTabId)
        entry.closed = true
        this.settle(entry, false)
        console.log(`[shared-tabs] ${short} closed ${code} — not dialling again`)
        this.deps.emit({ sharedTabId, closed: { code, reason: reason.toString() } })
        return
      }
      if (refused === 401) {
        void this.deps.accessToken({ force: true, failedToken: token }).then(
          () => this.retry(sharedTabId, entry, 'token refused, refreshed'),
          () => this.retry(sharedTabId, entry, 'token refused, refresh failed'))
        return
      }
      this.retry(sharedTabId, entry, refused === null ? `closed ${code}` : `refused ${refused}`)
    })
  }

  private heard(sharedTabId: string, entry: TabSocket, raw: string): void {
    // Closed here, what was still on its way is nobody's: the tab's frames are not told after its close.
    if (entry.closed) return
    let frame: unknown
    try { frame = JSON.parse(raw) } catch { return }
    if (!isRecord(frame)) return
    if (frame.type === 'amsg_ready') {
      entry.ready = true
      entry.attempts = 0
      this.settle(entry, true)
      this.deps.emit({ sharedTabId, ready: true })
    } else if (frame.type === 'amsg_frame') {
      const from = frame.from
      if (!isRecord(from) || typeof from.machineId !== 'string' || typeof from.userId !== 'string' || !isRecord(frame.payload)) return
      this.deps.emit({ sharedTabId, from: { machineId: from.machineId, userId: from.userId }, payload: frame.payload })
    } else if (frame.type === 'amsg_undeliverable' && typeof frame.to === 'string') {
      this.deps.emit({ sharedTabId, undeliverable: frame.to })
    }
  }

  private retry(sharedTabId: string, entry: TabSocket, why: string): void {
    if (entry.closed) return
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(entry.attempts++, 5))
    console.log(`[shared-tabs] ${sharedTabId.slice(0, 8)} ${why} — retrying in ${Math.round(delay / 1000)}s (attempt ${entry.attempts})`)
    entry.timer = setTimeout(() => { entry.timer = null; void this.dial(sharedTabId, entry) }, delay)
    entry.timer.unref?.()
  }

  /** True once the relay admits the socket, false after `TAB_RELAY_READY_WAIT_MS` or once the tab is closed. */
  private whenReady(entry: TabSocket): Promise<boolean> {
    return new Promise((resolve) => {
      const waiter = (ok: boolean) => { clearTimeout(timer); resolve(ok) }
      const timer = setTimeout(() => {
        entry.waiters.splice(entry.waiters.indexOf(waiter), 1)
        resolve(false)
      }, TAB_RELAY_READY_WAIT_MS)
      timer.unref()
      entry.waiters.push(waiter)
    })
  }

  private settle(entry: TabSocket, ok: boolean): void {
    for (const waiter of entry.waiters.splice(0)) waiter(ok)
  }

  /**
   * Send the frame in its turn within the relay's rate, after every frame sent before it: true once written. False,
   * and never written, when the tab is closed, its socket is not admitted when the turn comes, or the deadline passed.
   * Only a frame written takes a slot of the rate.
   */
  private pace(entry: TabSocket, deadline: number, data: string): Promise<boolean> {
    const turn = entry.pacing.then(async (): Promise<boolean> => {
      for (;;) {
        const at = this.now()
        if (entry.closed || at >= deadline) return false
        while (entry.sentAt.length && at - entry.sentAt[0] >= TAB_RELAY_WINDOW_MS) entry.sentAt.shift()
        if (entry.sentAt.length < TAB_RELAY_FRAMES) {
          const ws = entry.ws
          if (!entry.ready || !ws || ws.readyState !== WebSocket.OPEN) return false
          entry.sentAt.push(at)
          ws.send(data)
          return true
        }
        await this.sleep(entry, Math.min(entry.sentAt[0] + TAB_RELAY_WINDOW_MS, deadline) - at)
      }
    })
    entry.pacing = turn
    return turn
  }

  /** Sleep for a turn's slot; woken early when the tab is closed. Never keeps the process alive. */
  private sleep(entry: TabSocket, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); entry.sleepers.delete(wake); resolve() }
      const timer = setTimeout(wake, ms)
      timer.unref()
      entry.sleepers.add(wake)
    })
  }
}
