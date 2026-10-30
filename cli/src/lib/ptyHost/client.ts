/**
 * The daemon's connection to `harness-pty` (pty/src/server.rs): the hello, control requests as
 * NDJSON lines, the host's unsolicited notices, and stream connections for Task 14's handles.
 *
 * A call's outcome keeps "we could not ask" apart from "we asked and do not know": a request that
 * was never written is `not_started`, one written without a reply is `possibly_executed`
 * (docs/superpowers/specs/2026-10-14-windows-native-pty-host-design.md, error semantics).
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import {
  helloAuth,
  helloProof,
  SUPPORTED_PTY_PROTOCOLS,
  type HelloLine,
  type HelloReply,
  type HelloRole,
  type PtyEvent,
  type PtyOp,
  type PtyOpReplies,
  type PtyResponse,
} from './protocol.js'

/**
 * `<home>/run/pty-host-<instance>.json` (a legacy `p<n>`'s `pty-host-<n>.json`), as the host writes it
 * (pty/src/discovery.rs).
 */
export interface PtyHostDiscovery {
  protocol: number
  instance: string
  endpoint: string
  pid: number
  version: string
  token: string
}

export type PtyHostCallResult<T> =
  | { state: 'ok'; value: T }
  | { state: 'failed'; dispatch: 'not_started' | 'rejected'; code: string; reason: string }
  | { state: 'unknown'; dispatch: 'possibly_executed'; reason: string }

/**
 * A stream-role connection after its hello: every byte read from it is a frame. It comes paused,
 * so nothing is lost before its reader is attached: attach it, then `resume()`.
 */
export type PtyHostStreamConnection = Duplex

const DEFAULT_TIMEOUT_MS = 5_000
/** The host gives a hello 10 s (server.rs HELLO_TIMEOUT); its reply is one short line. */
const MAX_HELLO_REPLY = 64 * 1024

/**
 * Splits a byte stream into lines. Chunks of a line wait in a list and are joined once, when its
 * newline comes: a multi-megabyte `capture` reply arrives in thousands of chunks.
 */
class LineSplitter {
  private parts: Buffer[] = []
  size = 0

  push(chunk: Buffer): string[] {
    const lines: string[] = []
    let start = 0
    let at: number
    while ((at = chunk.indexOf(0x0a, start)) >= 0) {
      const tail = chunk.subarray(start, at)
      const whole = this.parts.length === 0 ? tail : Buffer.concat([...this.parts, tail])
      this.parts = []
      this.size = 0
      lines.push(whole.toString('utf8'))
      start = at + 1
    }
    if (start < chunk.length) {
      this.parts.push(chunk.subarray(start))
      this.size += chunk.length - start
    }
    return lines
  }
}

type HelloOutcome =
  | { state: 'ok'; socket: net.Socket; instance: string; features: string[]; rest: Buffer }
  | { state: 'incompatible'; reason: string }
  | { state: 'unreachable' }

/** Whether [proof] is the hello proof of [token] for [nonce]. */
function provesToken(proof: unknown, token: string, nonce: string): boolean {
  if (typeof proof !== 'string') return false
  const want = Buffer.from(helloProof(token, nonce), 'utf8')
  const got = Buffer.from(proof, 'utf8')
  return got.length === want.length && timingSafeEqual(got, want)
}

/**
 * Connect to `endpoint` and say hello. Unreachable is only "nothing accepted the connection";
 * anything that accepted it and would not finish the hello is incompatible, because starting
 * another host would not help with it.
 */
function hello(discovery: PtyHostDiscovery, role: HelloRole, timeoutMs: number): Promise<HelloOutcome> {
  return new Promise(resolve => {
    // Node takes `\\.\pipe\…` names here on Windows, so one call serves both transports. It cannot ask for
    // SECURITY_IDENTIFICATION (libuv opens the pipe with no SQOS flags), so a pipe server may impersonate this
    // process. The host's pipe name is random per start (pty/src/transport/windows.rs): nobody can create it before
    // the host does. It is no secret once the host runs (anyone can list `\\.\pipe\`), so a dead host's name could
    // be taken over: launch.ts never dials the endpoint of a host proven dead (`discoveredHostDead`).
    const socket = net.connect(discovery.endpoint)
    const lines = new LineSplitter()
    let connected = false
    let settled = false
    const finish = (outcome: HelloOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onClose)
      socket.off('error', onError)
      socket.off('connect', onConnect)
      if (outcome.state !== 'ok') socket.destroy()
      else socket.pause()
      resolve(outcome)
    }
    const timer = setTimeout(() => finish(connected
      ? { state: 'incompatible', reason: `no hello reply within ${timeoutMs} ms` }
      : { state: 'unreachable' }), timeoutMs)
    // Both sides prove the token over it: this client with `auth`, the host with its reply's proof.
    const nonce = randomBytes(32).toString('hex')
    const onConnect = () => {
      connected = true
      const line: HelloLine = {
        // Never the token itself: what listens here may not be the host.
        hello: {
          // The host's own protocol, which its discovery file names: an older host still draining speaks its own.
          auth: helloAuth(discovery.token, nonce), nonce, protocol: discovery.protocol, role,
          clientId: `harnessd-${process.pid}-${randomUUID()}`,
        },
      }
      socket.write(`${JSON.stringify(line)}\n`)
    }
    const onData = (chunk: Buffer) => {
      const [first] = lines.push(chunk)
      if (first === undefined) {
        if (lines.size > MAX_HELLO_REPLY) finish({ state: 'incompatible', reason: 'the hello reply is too long' })
        return
      }
      let reply: HelloReply['hello'] | undefined
      try {
        reply = (JSON.parse(first) as HelloReply).hello
      } catch {
        // handled below with every other unreadable reply
      }
      if (!reply || typeof reply !== 'object') {
        finish({ state: 'incompatible', reason: 'the host sent an unreadable hello reply' })
      } else if (reply.ok === true && !provesToken(reply.proof, discovery.token, nonce)) {
        finish({ state: 'incompatible', reason: 'the endpoint does not know this host\'s token' })
      } else if (reply.ok === true && reply.pid !== discovery.pid) {
        // The pid is what a drain judges the host's death by, and what a reconnect tells another host by: the one
        // answering must be the one the file names.
        finish({ state: 'incompatible', reason: `the host answering is pid ${String(reply.pid)}, not the ${discovery.pid} its discovery file names` })
      } else if (reply.ok === true) {
        // The lines after the hello's are not split here: they belong to whoever reads next.
        const after = chunk.subarray(chunk.indexOf(0x0a) + 1)
        // A host from before features sends none: it has none. Only names count.
        const features = Array.isArray(reply.features) ? reply.features.filter((name): name is string => typeof name === 'string') : []
        finish({ state: 'ok', socket, instance: String(reply.instance), features, rest: Buffer.from(after) })
      } else {
        finish({ state: 'incompatible', reason: `${reply.code ?? 'incompatible'}: ${reply.reason ?? 'refused'}` })
      }
    }
    const onClose = () => finish(connected
      ? { state: 'incompatible', reason: 'the host closed the connection during the hello' }
      : { state: 'unreachable' })
    const onError = () => { /* 'close' follows and decides */ }
    socket.on('connect', onConnect)
    socket.on('data', onData)
    socket.on('close', onClose)
    socket.on('error', onError)
  })
}

interface Pending {
  resolve: (result: PtyHostCallResult<unknown>) => void
  timer: NodeJS.Timeout
  /** A create or respawn: notices wait for its reply (see `holdNotices`). */
  holds: boolean
}

export class PtyHostClient {
  /**
   * Connect and say hello. `null` when nothing accepts a connection at the endpoint (start a
   * host); `{ incompatible }` when something does but refuses or cannot finish the hello.
   */
  static async connect(
    discovery: PtyHostDiscovery,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<PtyHostClient | { incompatible: string } | null> {
    if (!SUPPORTED_PTY_PROTOCOLS.includes(discovery.protocol)) {
      return { incompatible: `protocol ${discovery.protocol} is not supported; this daemon speaks ${SUPPORTED_PTY_PROTOCOLS.join(' and ')}` }
    }
    const outcome = await hello(discovery, 'control', timeoutMs)
    if (outcome.state === 'unreachable') return null
    if (outcome.state === 'incompatible') return { incompatible: outcome.reason }
    return new PtyHostClient(discovery, outcome.socket, outcome.instance, outcome.features, outcome.rest)
  }

  readonly instance: string
  /** What the host says it can do beyond its protocol (protocol.ts `SEED_FEATURE`), from its hello; `[]` when none. */
  readonly features: readonly string[]
  /** The protocol this connection speaks: the host's own, which gates the ops added since (protocol.ts). */
  get protocol(): number {
    return this.discovery.protocol
  }
  /** The host's process, as its discovery file names it: another pid after a reconnect is another host. */
  get pid(): number {
    return this.discovery.pid
  }

  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly eventListeners = new Set<(event: PtyEvent) => void>()
  private readonly closeListeners = new Set<() => void>()
  private readonly lines = new LineSplitter()
  /** Set once the connection has ended, by either side. */
  private ended = false
  /** Set when `close()` ended it: the owner already knows, so `onClose` stays quiet. */
  private closedByUs = false
  /**
   * Notices that arrived while a create or respawn was in flight. The host queues a pane's exit
   * notice the moment its process exits, which for a command that fails at once is before the
   * reply naming the pane (found in Task 10's review): delivered then, the exit names a pane the
   * caller does not know yet and is lost, and the pane looks alive until the next inventory.
   */
  private held: PtyEvent[] = []
  private holding = 0

  private constructor(
    private readonly discovery: PtyHostDiscovery,
    private readonly socket: net.Socket,
    instance: string,
    features: readonly string[],
    rest: Buffer,
  ) {
    this.instance = instance
    this.features = Object.freeze([...features])
    socket.on('data', chunk => this.onData(chunk))
    socket.on('error', () => { /* 'close' follows */ })
    socket.on('close', () => this.onEnded())
    socket.resume()
    if (rest.length > 0) this.onData(rest)
  }

  /**
   * Send one request and wait for its reply, at most `timeoutMs`. The reply type follows the op:
   * `call({ op: 'inventory' })` gives `{ panes }`.
   */
  call<O extends PtyOp>(op: O, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<PtyHostCallResult<PtyOpReplies[O['op']]>> {
    if (this.ended || !this.socket.writable) {
      return Promise.resolve({ state: 'failed', dispatch: 'not_started', code: 'not_connected', reason: 'the pty host connection is closed' })
    }
    const id = this.nextId++
    const holds = op.op === 'create' || op.op === 'respawn'
    if (holds) this.holding++
    return new Promise(resolve => {
      const timer = setTimeout(() => this.settle(id, {
        state: 'unknown', dispatch: 'possibly_executed', reason: `no reply within ${timeoutMs} ms`,
      }), timeoutMs)
      this.pending.set(id, { resolve: resolve as Pending['resolve'], timer, holds })
      this.socket.write(`${JSON.stringify({ id, ...op })}\n`)
    })
  }

  /** A new stream-role connection to the same host, or null when it cannot be had. */
  async openStream(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<PtyHostStreamConnection | null> {
    const outcome = await hello(this.discovery, 'stream', timeoutMs)
    if (outcome.state !== 'ok') return null
    // A frame may have come in the hello reply's chunk; put it back for the stream's reader.
    if (outcome.rest.length > 0) outcome.socket.unshift(outcome.rest)
    return outcome.socket
  }

  /** The host's exit and title notices. Returns the unsubscribe. */
  onEvent(listener: (event: PtyEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }

  /**
   * Called once when the host ends the connection (it exited, or dropped this client); not for
   * `close()`. A listener added after that is called at once.
   */
  onClose(listener: () => void): () => void {
    if (this.ended && !this.closedByUs) {
      listener()
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  /** End the connection. The host and its panes are not touched. */
  close(): void {
    if (this.ended) return
    this.closedByUs = true
    this.socket.destroy()
    this.onEnded()
  }

  private onData(chunk: Buffer): void {
    for (const line of this.lines.push(chunk)) {
      if (!line.trim()) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        // Nothing to match it to; the call it answered, if any, times out as possibly_executed.
        continue
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue
      if ('event' in message) this.notice(message as PtyEvent)
      else if ('id' in message) this.reply(message as PtyResponse)
    }
  }

  private reply(response: PtyResponse): void {
    if (response.ok === true) {
      const { id: _id, ok: _ok, ...value } = response
      this.settle(response.id, { state: 'ok', value })
    } else {
      // A pane the host does not have is one this request never reached.
      const dispatch = response.code === 'no_pane' ? 'not_started' : 'rejected'
      this.settle(response.id, { state: 'failed', dispatch, code: String(response.code), reason: String(response.reason) })
    }
  }

  private settle(id: number, result: PtyHostCallResult<unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(result)
    if (pending.holds && --this.holding === 0) {
      // After the caller's continuation, which runs in the microtasks `resolve` queued.
      setImmediate(() => this.releaseHeld())
    }
  }

  private notice(event: PtyEvent): void {
    if (this.holding > 0 || this.held.length > 0) this.held.push(event)
    else this.emit(event)
  }

  private releaseHeld(): void {
    // Another create may have started meanwhile; its reply releases them.
    if (this.holding > 0) return
    // Closed by its owner, who is no longer listening: its notices go with it.
    if (this.closedByUs) {
      this.held = []
      return
    }
    const held = this.held
    this.held = []
    for (const event of held) this.emit(event)
  }

  private emit(event: PtyEvent): void {
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event)
      } catch {
        // One listener's failure must not cost the others the notice.
      }
    }
  }

  private onEnded(): void {
    if (this.ended) return
    this.ended = true
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { state: 'unknown', dispatch: 'possibly_executed', reason: 'the pty host connection closed' })
    }
    if (this.closedByUs) return
    for (const listener of [...this.closeListeners]) {
      try {
        listener()
      } catch {
        // as for notices
      }
    }
    this.closeListeners.clear()
  }
}
