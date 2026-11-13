/**
 * An agent browser's screen, piped to a viewer (docs/superpowers/specs/2026-11-10-agent-browser-design.md, "The stream"):
 * one `podman exec … socat` per open panel, its stdout cut into binary `browser` frames and the viewer's bytes written
 * to its stdin through the route's stream profile (rfbShaper.ts). It rides the terminals' transport, so it keeps
 * out of their way:
 *
 * - **Credit.** At most one window of bytes the viewer has not taken is ever ahead of a terminal's echo: the child's
 *   stdout pauses at `pauseBytes` unacknowledged and resumes below `resumeBytes`. A viewer acks the bytes its page has
 *   drawn (`agent_browser_ack {streamId, bytes}`, the count since its last ack), because noVNC queues what it cannot
 *   draw and disconnects at 40 MiB (second spike). An ack that never comes closes the stream with `backlog` after 10 s,
 *   and so does a viewer that never answers the server's banner, which would otherwise hold a viewer slot for good.
 * - **Pacing.** Bytes on the relay and on TURN cost money and share the backend's per-machine budget: their total,
 *   counted sealed as the backend counts them, leaves at `bytesPerSecond`, taken in turn by the streams that have bytes
 *   to send. A direct link is not paced.
 * - **Nothing dropped.** VNC has no keyframe, so a lost chunk corrupts the screen for good. A send that is refused
 *   closes the stream (`backlog`), a route that went away closes it (`route`), and a relay that refused a frame closes
 *   every stream on the relay (`rate`). The panel then shows why, and reconnects.
 */
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { RfbShaper, type StreamProfile } from './rfbShaper.js'
import { sid } from '../../lib/log.js'
import type { AGENT_BROWSER_CLOSE_REASONS, ProductUsageMetric } from '../../lib/productUsageContract.js'
import { TERMINAL_BINARY_HEADER_BYTES, TerminalBinaryKind, type TerminalBinaryClear } from '../../lib/terminalBinary.js'

/** The route a remote viewer's stream took, as the gateway says it (core/api.ts `StreamRoute`). */
export type StreamRoute = 'direct' | 'turn' | 'relay'
/** Who asked to open a stream, as the core established it: whether they may (core/api.ts `mayOpenBrowser`), and
 *  whether they are a window on this computer, whose stream is direct. */
export interface StreamAsker { allowed: boolean; local: boolean }

type BrowserCloseReason = typeof AGENT_BROWSER_CLOSE_REASONS[number]

/** A route's profile (spec § "Stream profiles by route"): the first spike measured 1080p scrolling at about 2 MB/s
 *  direct, 620 KB/s at 5 fps and 270 KB/s at 2 fps, the last the only one inside the relay budget. */
const BROWSER_PROFILES: Readonly<Record<StreamRoute, StreamProfile>> = {
  direct: { quality: 6, compression: 2, fps: 15 },
  turn: { quality: 3, compression: 6, fps: 5 },
  relay: { quality: 3, compression: 6, fps: 2 },
}
/** The backend's browser budget per machine socket, 512 KiB a second of sealed frames counted per fixed minute (backend
 *  lib/terminalRelay.ts): every relayed and TURN stream of this machine shares it. */
const BACKEND_BROWSER_BYTES_PER_SECOND = 512 * 1024
/** What the backend counts of a frame beyond its bytes: the sealed envelope's 20-byte header, the stream id and seq
 *  in its plaintext (24 bytes) and the AEAD tag (16 bytes) (lib/e2ee/terminalSeal.ts). */
const SEALED_FRAME_OVERHEAD_BYTES = TERMINAL_BINARY_HEADER_BYTES + 24 + 16
/** 90% of the backend's budget. The pace holds up to one second of itself, and a fixed minute can start just as that
 *  second is spent, so it sees 61 seconds of the pace: 61 × 0.9 = 55 seconds of budget, under the 60 that would close
 *  every relayed stream with `rate` (two viewers scrolling at the whole budget did, review 2026-11-10). */
export const BROWSER_PACING_BYTES_PER_SECOND = Math.floor(BACKEND_BROWSER_BYTES_PER_SECOND * 0.9)
/** The credit window: one 1080p update at q6 is 105-173 KB (second spike), so a window holds one with room to spare. */
export const BROWSER_WINDOW = { pauseBytes: 256 * 1024, resumeBytes: 128 * 1024 }
const BROWSER_VIEWERS_MAX = 4
const STALL_MS = 10_000
/**
 * How long a viewer has to say anything once its stream sent it the server's banner. Its first ack cannot be the
 * test: a viewer acks every 64 KiB drawn (Desktop `browserAckStepBytes`), and a still page's whole first screen can be
 * smaller than that. Its answer to the banner can: the Desktop loads noVNC before it opens, and noVNC sends its version
 * the moment the banner arrives. The clock starts when the banner leaves, after its pace on the slowest route (the
 * relay), so what is left is one round trip; the 10 s an owed ack gets is far more than that. A Desktop that gave up on
 * its open never answers (review 2026-11-10).
 */
const ANSWER_MS = STALL_MS
const KILL_GRACE_MS = 1_000
const STDERR_KEPT = 2_000

interface Stream {
  id: string
  connId: string
  agentId: string
  local: boolean
  route: StreamRoute | null
  child: ChildProcess
  shaper: RfbShaper
  seq: number
  /** Read from the child and not yet acknowledged by the viewer, sent or still waiting for its pace. */
  unacked: number
  waiting: Uint8Array[]
  paused: boolean
  stallTimer: NodeJS.Timeout | null
  /** The viewer has sent something: an ack or its own bytes. */
  answered: boolean
  answerTimer: NodeJS.Timeout | null
  stderr: string
}

export interface BrowserStreamDeps {
  /** The exec into a ready browser's container that pipes its screen, for this to start as the service starts every
   *  Podman child (services/agentBrowser.ts), or why there is none. */
  exec: (agentId: string) => { spawn: () => ChildProcess } | { error: 'NO_BROWSER' | 'NOT_READY' }
  sendTarget: (connId: string, type: string, payload: Record<string, unknown>) => boolean
  /** False when the bytes were not taken. In the agent browser's own process that is the link to the core; what the
   *  viewer's transport refuses after it is told later (`refused`). */
  sendBinaryTarget: (connId: string, frame: TerminalBinaryClear) => boolean
  measure: (metric: ProductUsageMetric) => void
  pacing: { bytesPerSecond: number }
  window: { pauseBytes: number; resumeBytes: number }
  chunkBytes: number
}

export class BrowserStreamManager {
  private readonly streams = new Map<string, Stream>()
  /** Paced streams with bytes waiting, in the order they take turns. */
  private readonly turns = new Set<Stream>()
  private tokens = 0
  private refilledAt = Date.now()
  private paceTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: BrowserStreamDeps) {}

  open(connId: string, payload: Record<string, unknown>, asker: StreamAsker): void {
    const requestId = payload.requestId
    if (typeof requestId !== 'string') return
    const refuse = (error: string) => { this.deps.sendTarget(connId, 'agent_browser_open_result', { requestId, error }) }
    if (!asker.allowed) return refuse('NOT_OWNER')
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
    const exec = agentId ? this.deps.exec(agentId) : { error: 'NO_BROWSER' as const }
    if ('error' in exec) return refuse(exec.error)
    if ([...this.streams.values()].filter(stream => stream.agentId === agentId).length >= BROWSER_VIEWERS_MAX) return refuse('VIEWER_LIMIT')
    let child: ChildProcess
    try {
      child = exec.spawn()
    } catch (error) {
      // Podman not found after all, or the exec refused at once: the panel is told, and asks again.
      console.warn(`[agent-browser] stream exec for ${sid(agentId)} did not start: ${(error as Error).message}`)
      return refuse('NOT_READY')
    }
    const local = asker.local
    const stream: Stream = {
      id: randomUUID(), connId, agentId, local, route: local ? 'direct' : null, child,
      // Until the gateway says which route it took, a remote stream gets the relay's profile, the cheapest.
      shaper: new RfbShaper(BROWSER_PROFILES[local ? 'direct' : 'relay']),
      seq: 0, unacked: 0, waiting: [], paused: false, stallTimer: null, answered: false, answerTimer: null, stderr: '',
    }
    this.streams.set(stream.id, stream)
    stream.shaper.onOutput(bytes => { if (this.streams.get(stream.id) === stream) child.stdin?.write(bytes) })
    stream.shaper.onClose((reason, detail) => {
      console.warn(`[agent-browser] stream ${sid(stream.id)} closed: ${detail}`)
      this.end(stream, reason)
    })
    child.stdout?.on('data', (data: Buffer) => this.output(stream, data))
    child.stderr?.on('data', (data: Buffer) => { stream.stderr = (stream.stderr + data.toString()).slice(-STDERR_KEPT) })
    // A child that died closes its stdin under a write: the exit below is what ends the stream.
    child.stdin?.on('error', () => {})
    child.on('error', (error) => {
      console.warn(`[agent-browser] stream ${sid(stream.id)} exec failed: ${error.message}`)
      this.end(stream, 'agent')
    })
    child.on('exit', (code, signal) => {
      if (this.streams.get(stream.id) !== stream) return
      console.warn(`[agent-browser] stream ${sid(stream.id)} exec exited (${code ?? signal}): ${stream.stderr.trim()}`)
      this.end(stream, 'agent')
    })
    this.deps.sendTarget(connId, 'agent_browser_open_result', { requestId, streamId: stream.id })
    this.deps.measure('agent_browser_stream_opened')
  }

  ack(connId: string, payload: Record<string, unknown>): void {
    const stream = this.of(connId, payload.streamId)
    if (!stream) return
    this.heard(stream)
    const bytes = payload.bytes
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return
    stream.unacked = Math.max(0, stream.unacked - bytes)
    if (stream.paused && stream.unacked < this.deps.window.resumeBytes) {
      stream.paused = false
      stream.child.stdout?.resume()
    }
    this.watchStall(stream)
  }

  /** A viewer's bytes, which the core passes on only from the connection it holds the stream for
   *  (core/browserStreams.ts). */
  input(streamId: string, bytes: Uint8Array): void {
    const stream = this.streams.get(streamId)
    if (!stream) return
    this.heard(stream)
    stream.shaper.push(bytes)
  }

  close(connId: string, payload: Record<string, unknown>): void {
    const stream = this.of(connId, payload.streamId)
    if (stream) this.end(stream, 'closed')
  }

  closeConnection(connId: string): void {
    for (const stream of [...this.streams.values()]) if (stream.connId === connId) this.end(stream, 'closed')
  }

  closeAgent(agentId: string): void {
    for (const stream of [...this.streams.values()]) if (stream.agentId === agentId) this.end(stream, 'agent')
  }

  /** The service stops: every stream ends, and its exec with it. */
  closeAll(): void {
    for (const stream of [...this.streams.values()]) this.end(stream, 'agent')
  }

  /** The viewer's transport refused one of this stream's frames, which the core tells after the fact where this runs in
   *  a process of its own: a hole in the screen, so the stream ends, as a send refused in line ends it. */
  refused(streamId: string): void {
    const stream = this.streams.get(streamId)
    if (stream) this.end(stream, 'backlog')
  }

  /** The gateway's word on the route a remote stream opened on (`GatewayEvents.browserRoute`): it keeps it. */
  route(streamId: string, route: StreamRoute): void {
    const stream = this.streams.get(streamId)
    if (!stream || stream.local) return
    stream.route = route
    stream.shaper.setProfile(BROWSER_PROFILES[route])
    if (route !== 'direct') return
    this.turns.delete(stream)
    for (const chunk of stream.waiting.splice(0)) if (!this.send(stream, chunk)) return
    this.watchStall(stream)
  }

  /** The stream's route went away (`GatewayEvents.browserRouteLost`): VNC cannot survive a move, so it ends. */
  routeLost(streamId: string): void {
    const stream = this.streams.get(streamId)
    if (stream) this.end(stream, 'route')
  }

  /**
   * The backend refused one of this machine's relayed browser frames (`GatewayEvents.browserTransportError`). The
   * frame's stream is inside its ciphertext, so every stream that may be on the relay ends: one whose route the gateway
   * has not said yet included, since a dropped chunk would corrupt it.
   */
  transportError(): void {
    for (const stream of [...this.streams.values()]) {
      if (stream.route === 'relay' || stream.route === null) this.end(stream, 'rate')
    }
  }

  private of(connId: string, streamId: unknown): Stream | undefined {
    const stream = typeof streamId === 'string' ? this.streams.get(streamId) : undefined
    return stream?.connId === connId ? stream : undefined
  }

  private paced(stream: Stream): boolean {
    return stream.route !== 'direct'
  }

  private output(stream: Stream, data: Buffer): void {
    if (this.streams.get(stream.id) !== stream) return
    stream.unacked += data.length
    if (stream.unacked >= this.deps.window.pauseBytes) {
      stream.paused = true
      stream.child.stdout?.pause()
    }
    for (let at = 0; at < data.length; at += this.deps.chunkBytes) {
      // A view: each read is a buffer of its own, and the chunk is copied once, into its frame.
      const chunk = data.subarray(at, at + this.deps.chunkBytes)
      if (this.paced(stream)) stream.waiting.push(chunk)
      else if (!this.send(stream, chunk)) return
    }
    if (stream.waiting.length) {
      this.turns.add(stream)
      this.pace()
    }
    this.watchStall(stream)
  }

  /** False when the stream had to end: a send the transport refused would be a hole in the screen. */
  private send(stream: Stream, bytes: Uint8Array): boolean {
    const sent = this.deps.sendBinaryTarget(stream.connId, { kind: TerminalBinaryKind.browser, streamId: stream.id, seq: stream.seq++, bytes, compressed: false })
    if (!sent) this.end(stream, 'backlog')
    else if (!stream.answered && !stream.answerTimer) {
      stream.answerTimer = setTimeout(() => {
        console.warn(`[agent-browser] stream ${sid(stream.id)} closed: its viewer never answered in ${ANSWER_MS / 1000} s`)
        this.end(stream, 'backlog')
      }, ANSWER_MS)
      stream.answerTimer.unref?.()
    }
    return sent
  }

  private heard(stream: Stream): void {
    stream.answered = true
    if (stream.answerTimer) clearTimeout(stream.answerTimer)
    stream.answerTimer = null
  }

  /** One token bucket for every paced stream, filled at `bytesPerSecond` of sealed bytes and holding at most one second
   *  of it. */
  private pace(): void {
    if (this.paceTimer) return
    const rate = this.deps.pacing.bytesPerSecond
    const now = Date.now()
    this.tokens = Math.min(rate, this.tokens + ((now - this.refilledAt) * rate) / 1000)
    this.refilledAt = now
    for (const stream of this.turns) {
      const chunk = stream.waiting[0]
      const cost = chunk.length + SEALED_FRAME_OVERHEAD_BYTES
      if (cost > this.tokens) {
        this.paceTimer = setTimeout(() => { this.paceTimer = null; this.pace() }, Math.ceil(((cost - this.tokens) * 1000) / rate))
        this.paceTimer.unref?.()
        return
      }
      this.tokens -= cost
      stream.waiting.shift()
      // Its next chunk waits behind every other stream's.
      this.turns.delete(stream)
      if (!this.send(stream, chunk)) continue
      if (stream.waiting.length) this.turns.add(stream)
      this.watchStall(stream)
    }
  }

  /** The credit is used up and every byte has gone: only the viewer's ack can move the stream now, and 10 s without
   *  one means it was lost. Bytes still waiting for their pace are ours, not the viewer's. */
  private watchStall(stream: Stream): void {
    if (this.streams.get(stream.id) !== stream) return
    const stalled = stream.paused && stream.waiting.length === 0
    if (stalled && !stream.stallTimer) {
      stream.stallTimer = setTimeout(() => this.end(stream, 'backlog'), STALL_MS)
      stream.stallTimer.unref?.()
    } else if (!stalled && stream.stallTimer) {
      clearTimeout(stream.stallTimer)
      stream.stallTimer = null
    }
  }

  private end(stream: Stream, reason: BrowserCloseReason): void {
    if (this.streams.get(stream.id) !== stream) return
    this.streams.delete(stream.id)
    this.turns.delete(stream)
    stream.waiting = []
    if (stream.stallTimer) clearTimeout(stream.stallTimer)
    if (stream.answerTimer) clearTimeout(stream.answerTimer)
    this.deps.sendTarget(stream.connId, 'agent_browser_close', { streamId: stream.id, reason })
    this.deps.measure(`agent_browser_stream_closed_${reason}`)
    const { child } = stream
    child.stdin?.end()
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    // `podman exec` hands SIGTERM on to socat; one that does not end in a second is killed outright.
    const force = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    force.unref?.()
    child.once('exit', () => clearTimeout(force))
  }
}
