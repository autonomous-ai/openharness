/**
 * A phone, as the relay sees one: a web socket to the (fake) backend's `/api/web-ws`, bound to one
 * machine with `machine_select`, and an end-to-end encrypted session with that machine's daemon opened
 * through the relay (`e2e_hello` / `e2e_welcome`). The crypto is the CLI's own client role
 * (src/lib/e2ee/relayClient.ts, what this daemon runs when it relays the desktop to another machine), and
 * the behaviour around it is that relay client's (src/lib/remoteRelay.ts):
 * - a frame that does not open under the session is dropped, never shown;
 * - `node_status {online: false}` retires the session (the daemon's next process has other keys);
 * - nothing is sent without a ready session: a send then says it did not go (`false`), and a request
 *   fails at once, so a message can be refused visibly but is never queued into nowhere.
 *
 * Everything it opened is kept in `frames`, in arrival order, across sessions.
 */
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { wrapPayload, type Identity } from '../../src/lib/e2ee/core.js'
import { RelaySessionCrypto } from '../../src/lib/e2ee/relayClient.js'
import type { FakeBackend } from './fakeBackend.js'

export type PhoneFrame = { type: string; payload?: Record<string, any>; agentId?: string; replay?: boolean; [key: string]: unknown }

export interface RelayPhoneOptions {
  backend: FakeBackend
  machineId: string
  identity: Identity
  /** The machine's identity key, pinned when the phone was paired: the welcome must be signed by it. */
  machinePub: Uint8Array
  token: string
  /** Keep the socket and the session through `node_status {online:false}`, as the phone app does
   *  (mobile app_state.dart `_applyNodeStatus`), instead of retiring them as the CLI's relay client does. */
  keepSessionWhenOffline?: boolean
}

export class RelayPhone {
  /** Every frame opened, in arrival order, with the session it came on. */
  readonly frames: Array<PhoneFrame & { session: number }> = []
  /** Every sealed frame sent, as it left: what a relay could replay. */
  readonly sealed: PhoneFrame[] = []
  /** Frames the session refused to open: sealed for another session, replayed, or garbage. */
  dropped = 0
  /** How many sessions it has opened. */
  sessions = 0
  connId: string | null = null
  private ws: WebSocket | null = null
  private crypto: RelaySessionCrypto | null = null
  private waiters: Array<{ test: (frame: PhoneFrame) => boolean; done: (frame: PhoneFrame) => void }> = []
  private pending = new Map<string, { resolve: (payload: Record<string, any>) => void; reject: (error: Error) => void }>()
  /** The machine's broadcasts opened so far, by epoch, carried from session to session as the CLI's
   *  relay pool carries them (src/lib/remoteRelay.ts `groupSeen`). */
  private readonly groupSeen = new Map<string, number>()

  constructor(private readonly options: RelayPhoneOptions) {}

  get ready(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.crypto?.ready === true
  }

  /** Dial, bind to the machine and open a session. Rejects when any step fails or takes too long. */
  async open(ms = 20_000): Promise<void> {
    this.retire()
    const { backend, machineId, identity, machinePub, token } = this.options
    const ws = new WebSocket(`${backend.wsUrl}/api/web-ws?autonomousEnv=prod`, [token])
    ws.on('error', () => { /* 'close' follows */ })
    const crypto = new RelaySessionCrypto({ machineId, selfIdentity: identity, peerPub: machinePub, groupSeen: this.groupSeen })
    this.ws = ws
    this.crypto = crypto
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { fail(new Error('the phone could not open a session in time')) }, ms)
      const fail = (error: Error): void => { clearTimeout(timer); ws.terminate(); reject(error) }
      ws.on('message', (raw, binary) => {
        if (binary) return
        let frame: PhoneFrame
        try { frame = JSON.parse(raw.toString()) as PhoneFrame } catch { this.dropped++; return }
        if (!crypto.ready) {
          if (frame.type === 'connected' && frame.payload?.machineId === machineId) {
            ws.send(JSON.stringify(crypto.helloFrame()))
          } else if (frame.type === 'machine_select_error') {
            fail(new Error(`machine_select refused: ${frame.payload?.error}`))
          } else if (frame.type === 'e2e_denied') {
            fail(new Error(`the daemon denied the phone: ${frame.payload?.reason}`))
          } else if (frame.type === 'e2e_welcome') {
            if (!crypto.handleWelcome(frame.payload ?? {})) { fail(new Error('the welcome did not open')); return }
            clearTimeout(timer)
            this.sessions++
            resolve()
          }
          return
        }
        this.receive(ws, crypto, frame)
      })
      ws.on('open', () => ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId } })))
      ws.on('close', () => {
        fail(new Error('the relay closed the phone\'s socket'))
        if (this.ws === ws) this.retire()
      })
    })
    this.connId = backend.webConnections(machineId).at(-1) ?? null
  }

  private receive(ws: WebSocket, crypto: RelaySessionCrypto, frame: PhoneFrame): void {
    if (frame.type === 'node_status') {
      this.record({ ...frame }, this.sessions)
      // As the CLI's relay client does: the daemon's next process knows nothing of these keys.
      if (frame.payload?.online === false && !this.options.keepSessionWhenOffline) ws.close(1012, 'remote machine disconnected')
      return
    }
    if (frame.type === 'e2e_session_unknown') {
      // The daemon has no session for this connection any more: what was sent on it was not taken.
      this.record({ ...frame }, this.sessions)
      ws.close(1012, 'remote session gone')
      return
    }
    if (frame.type === 'e2e_rekey') { crypto.handleRekey(frame.payload ?? {}); return }
    if (frame.type === 'e2e_welcome' || frame.type === 'connected') return
    const opened = crypto.unwrapIncoming(frame) as PhoneFrame | null
    // A payload sealed for another session, replayed, or not sealed at all where it must be: dropped.
    if (!opened || opened.payload?.__e2e) { this.dropped++; return }
    const requestId = opened.payload?.requestId
    if (typeof requestId === 'string' && opened.type.endsWith('_result') && this.pending.has(requestId)) {
      const waiting = this.pending.get(requestId)!
      this.pending.delete(requestId)
      waiting.resolve(opened.payload ?? {})
    }
    this.record(opened, this.sessions)
  }

  private record(frame: PhoneFrame, session: number): void {
    this.frames.push({ ...frame, session })
    for (const waiter of [...this.waiters]) {
      if (waiter.test(frame)) { this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.done(frame) }
    }
  }

  /** Let go of the socket and the session; anything waiting on them fails now, visibly. */
  private retire(): void {
    const ws = this.ws
    this.ws = null
    this.crypto = null
    this.connId = null
    for (const [id, waiting] of this.pending) { this.pending.delete(id); waiting.reject(new Error('the phone\'s session ended')) }
    if (ws && ws.readyState === WebSocket.OPEN) ws.close()
  }

  /** A sealed frame with no answer expected (a message). False when there is no session to send it on.
   *  `always`: sealed whatever its type, as a client with a protocol of its own seals every request (the
   *  Wi-Fi device's firmware; the CLI's client crypto seals only the types its apps send). */
  send(type: string, payload: Record<string, unknown>, always = false): boolean {
    if (!this.ready) return false
    const sealed = (always ? this.sealAlways({ type, payload }) : this.crypto!.wrapOutgoing({ type, payload })) as PhoneFrame
    this.sealed.push(sealed)
    this.ws!.send(JSON.stringify(sealed))
    return true
  }

  /** The client crypto's own sealing, for any type: its session key and counter (test code reaches them). */
  private sealAlways(frame: { type: string; payload: Record<string, unknown> }): PhoneFrame {
    const crypto = this.crypto as unknown as { c2s: Uint8Array; c2sCounter: number }
    return { type: frame.type, payload: wrapPayload(crypto.c2s, 'p', crypto.c2sCounter++, frame.type, undefined, frame.payload) as unknown as Record<string, any> }
  }

  /** A sealed request and its sealed answer. Fails at once with no session, or when the session ends. */
  request(type: string, payload: Record<string, unknown> = {}, ms = 30_000, always = false): Promise<Record<string, any>> {
    if (!this.ready) return Promise.reject(new Error(`no session to ask ${type} on`))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`${type} was not answered within ${ms}ms`))
      }, ms)
      this.pending.set(requestId, {
        resolve: (answer) => { clearTimeout(timer); resolve(answer) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.send(type, { ...payload, requestId }, always)
    })
  }

  /** The first frame, past or future, that passes `test`. */
  waitFor(test: (frame: PhoneFrame) => boolean, ms = 30_000, what = 'a frame', since = 0): Promise<PhoneFrame> {
    const seen = this.frames.slice(since).find(test)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.done !== done)
        reject(new Error(`the phone waited ${ms}ms for ${what}; last frames: ${JSON.stringify(this.frames.slice(-8).map((f) => f.type))}`))
      }, ms)
      const done = (frame: PhoneFrame) => { clearTimeout(timer); resolve(frame) }
      this.waiters.push({ test, done })
    })
  }

  /** Only frames that arrive after this call. */
  next(test: (frame: PhoneFrame) => boolean, ms = 30_000, what = 'a frame'): Promise<PhoneFrame> {
    return this.waitFor(test, ms, what, this.frames.length)
  }

  /** The socket gone with no close frame, as a phone losing its network. */
  drop(): void {
    this.ws?.terminate()
  }

  close(): void {
    this.retire()
  }
}
