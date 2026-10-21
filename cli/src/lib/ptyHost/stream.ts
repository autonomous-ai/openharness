/**
 * A terminal stream on a pane of the Harness PTY host: one stream connection (client.ts `openStream`) subscribed to
 * the pane (pty/src/stream.rs). It behaves as `TmuxControlStream` does (tmuxStream.ts), and its keyframes are built by
 * the same code from the same capture texts: the host answers a snapshot with what `capture-pane` would have printed.
 *
 * Ordering: every output carries the pane's sequence number, and a snapshot reply the number of the last output its
 * capture contains (its cut). An output above the cut always comes after the reply; one at or below it may still come
 * after it, as the host's dispatcher may lag, and is dropped wherever it comes. Input, pastes and resizes are each
 * acknowledged, in the order they were sent.
 */
import type { Duplex } from 'node:stream'
import { REWRAP_MIN_WIDTH, rewrapTmuxHistory } from '../historyRewrap.js'
import {
  TERMINAL_ACTION_SUCCEEDED,
  terminalActionNotStarted,
  terminalActionPossiblyExecuted,
  terminalActionRejected,
  type PtyRuntimeRef,
  type TerminalActionResult,
  type TerminalReadResult,
  type TerminalStreamHandle,
  type TerminalStreamSink,
  type TerminalStreamSize,
  type TerminalStreamSnapshot,
} from '../terminalTypes.js'
import {
  boundedSize,
  CONVERSATION_HISTORY_LINES,
  printInProgress,
  SNAPSHOT_BUFFER_MAX_BYTES,
  SNAPSHOT_HISTORY_LINES,
  tmuxKeyframe,
  TUI_SCROLL_MIN_INTERVAL_MS,
  tuiScrollPageCount,
  waitForRepaint,
  waitForSnapshotQuiet,
  type PaneMeta,
  type SnapshotGate,
  type SnapshotOptions,
} from '../tmuxStream.js'
import {
  encodeFrame,
  FrameKind,
  FrameReader,
  MAX_FRAME,
  type Frame,
  type PtyPaneMeta,
  type StreamAck,
  type StreamClosed,
  type StreamSnapshotReply,
  type StreamSnapshotRequest,
  type StreamSubscribe,
} from './protocol.js'

/** How long an Input, Paste, Resize or Subscribe waits for its ack before it may have happened. */
const ACK_TIMEOUT_MS = 2_000
/** How long a snapshot waits for its reply: the host reads the pane at once, but the reply may be megabytes. */
const SNAPSHOT_TIMEOUT_MS = 5_000
/** How long a snapshot looking for an engine's print waits for outputs its cut contains that the reply overtook. */
const LAGGING_OUTPUT_WAIT_MS = 100
/** How long `close` gives the connection to flush what was written before it is destroyed. */
const CLOSE_FLUSH_MS = 500
/** Keystrokes are sent in frames of at most this many bytes, each acknowledged. */
const INPUT_FRAME_BYTES = 1024 * 1024
/** What tmux writes for its PageUp and PageDown keys (term/src/keys.rs `PPage`, `NPage`). */
const PAGE_UP = Buffer.from('\u001b[5~')
const PAGE_DOWN = Buffer.from('\u001b[6~')

export interface PtyHostStreamOptions {
  ackTimeoutMs?: number
  snapshotTimeoutMs?: number
}

type AckOutcome = StreamAck | 'timeout' | 'closed'

interface PendingAck {
  kind: FrameKind
  /** Settled already (timed out): its ack, when it comes, only keeps the queue in step. */
  done: boolean
  timer: NodeJS.Timeout
  resolve: (outcome: AckOutcome) => void
}

/** The tmux metadata a pane with the host's [m] has: one pane, the window its size. */
function paneMetaOf(m: PtyPaneMeta): PaneMeta | null {
  const numbers = [m?.cols, m?.rows, m?.cursor_x, m?.cursor_y]
  if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) return null
  return {
    sessionId: '$0',
    windowId: '@0',
    windowPanes: 1,
    windowWidth: m.cols,
    windowHeight: m.rows,
    paneWidth: m.cols,
    paneHeight: m.rows,
    alternateOn: m.alternate_on === true,
    cursorX: m.cursor_x,
    cursorY: m.cursor_y,
    cursorVisible: m.cursor_visible === true,
    mouseStandard: m.mouse_standard === true,
    mouseButton: m.mouse_button === true,
    mouseAll: m.mouse_all === true,
    mouseUtf8: m.mouse_utf8 === true,
    mouseSgr: m.mouse_sgr === true,
  }
}

/** A refusal the host acknowledged: one that never reached the pane is not started, any other rejected. */
function refusal(reason: string): TerminalActionResult {
  return reason === 'no_pane' || reason === 'not_subscribed' ? terminalActionNotStarted(reason) : terminalActionRejected(reason)
}

export class PtyHostStream implements TerminalStreamHandle<PtyRuntimeRef> {
  /**
   * Subscribe [connection] (paused, as `PtyHostClient.openStream` gives it) to [runtime]'s pane. A stream that may
   * write resizes the pane to [size] as it subscribes.
   */
  static async open(
    connection: Duplex,
    runtime: PtyRuntimeRef,
    size: TerminalStreamSize,
    sink: TerminalStreamSink,
    readOnly = false,
    options: PtyHostStreamOptions = {},
  ): Promise<TerminalReadResult<PtyHostStream>> {
    const stream = new PtyHostStream(connection, runtime, sink, readOnly, options)
    const bounded = boundedSize(size)
    const subscribe: StreamSubscribe = { pane: runtime.paneId, cols: bounded.cols, rows: bounded.rows, readOnly }
    const outcome = await stream.sendForAck(FrameKind.Subscribe, Buffer.from(JSON.stringify(subscribe)))
    if (outcome !== 'timeout' && outcome !== 'closed' && outcome.ok) {
      if (!readOnly) {
        stream.size = bounded
        // An engine prints again after a resize, and `snapshot`'s `repaint` waits for that print: not when the host
        // says the subscription left the pane's size as it was (it skips a size the pane has, as tmux does).
        if (outcome.resized !== false) stream.resizedAt = Date.now()
      }
      return { state: 'succeeded', value: stream }
    }
    await stream.close()
    if (outcome === 'timeout') return { state: 'failed', reason: 'pty host did not answer the subscription' }
    if (outcome === 'closed') return { state: 'failed', reason: 'pty host stream closed' }
    return { state: 'failed', reason: `pty host refused the stream: ${outcome.ok ? 'unknown' : outcome.reason}` }
  }

  readonly runtime: PtyRuntimeRef
  private readonly reader = new FrameReader()
  private readonly ackTimeoutMs: number
  private readonly snapshotTimeoutMs: number
  private readonly acks: PendingAck[] = []
  private readonly snapshots = new Map<number, (reply: StreamSnapshotReply | 'timeout' | 'closed') => void>()
  private nextSnapshotId = 1
  /** No more is sent: `close`, or the connection ended. */
  private closed = false
  private closing: Promise<void> | null = null
  private closeNotified = false
  private operationTail: Promise<void> = Promise.resolve()
  private gated = false
  /** The outputs held behind the gate since it rose or since the last cut, and their sequence numbers. */
  private held: Uint8Array[] = []
  private heldSeqs: number[] = []
  private heldBytes = 0
  private lastOutputAt = 0
  /** The last snapshot's cut: an output at or below it is in a keyframe already. */
  private cut = 0
  /** The highest sequence number read; null before the first output. */
  private lastSeq: number | null = null
  private readonly seqWaiters = new Set<() => void>()
  /** The pane's size as this stream last knew it, from its own resizes and its snapshots. */
  private size: TerminalStreamSize | null = null
  private resizedAt = Number.NEGATIVE_INFINITY
  private lastTuiScrollAt = 0
  private readonly gate: SnapshotGate = {
    closed: () => this.closed,
    gated: () => this.gated,
    held: () => this.held,
    lastOutputAt: () => this.lastOutputAt,
    resizedAt: () => this.resizedAt,
  }

  private constructor(
    private readonly connection: Duplex,
    runtime: PtyRuntimeRef,
    private readonly sink: TerminalStreamSink,
    private readonly readOnly: boolean,
    options: PtyHostStreamOptions,
  ) {
    this.runtime = runtime
    this.ackTimeoutMs = options.ackTimeoutMs ?? ACK_TIMEOUT_MS
    this.snapshotTimeoutMs = options.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS
    // Attached before the connection flows: it comes paused and with no 'error' listener, and an error emitted with
    // none would be thrown in the daemon.
    connection.on('data', (chunk: Buffer) => this.onData(chunk))
    connection.on('error', (error: Error) => {
      this.notifyClose(this.closing ? 'closed' : `pty host stream failed: ${error.message}`)
      this.ended()
    })
    connection.on('end', () => {
      // The host ends the connection after a Closed, and on its own only when it is going away.
      this.notifyClose(this.closing ? 'closed' : 'pty host stream closed')
      this.ended()
      connection.end()
    })
    connection.on('close', () => {
      this.notifyClose(this.closing ? 'closed' : 'pty host stream closed')
      this.ended()
    })
    connection.resume()
  }

  private onData(chunk: Buffer): void {
    // Once the stream is closing or closed nothing more reaches the sink, and nothing waits for a reply.
    if (this.closed) return
    let frames: Frame[]
    try {
      frames = this.reader.push(chunk)
    } catch (error) {
      this.fatal(`pty host stream protocol error: ${(error as Error).message}`)
      return
    }
    for (const frame of frames) {
      if (this.closed) return
      try {
        this.onFrame(frame)
      } catch (error) {
        this.fatal(`pty host stream protocol error: ${(error as Error).message}`)
        return
      }
    }
  }

  private onFrame(frame: Frame): void {
    switch (frame.kind) {
      case FrameKind.Output: {
        if (frame.payload.length < 8) throw new Error('short output frame')
        const seq = Number(frame.payload.readBigUInt64BE(0))
        if (this.lastSeq === null || seq > this.lastSeq) this.lastSeq = seq
        for (const wake of [...this.seqWaiters]) wake()
        if (seq <= this.cut) return
        this.deliver(seq, frame.payload.subarray(8))
        return
      }
      case FrameKind.SnapshotReply: {
        const reply = JSON.parse(frame.payload.toString('utf8')) as StreamSnapshotReply
        const resolve = this.snapshots.get(reply.id)
        if (!resolve) return // one that timed out
        this.snapshots.delete(reply.id)
        resolve(reply)
        return
      }
      case FrameKind.Ack: {
        const ack = JSON.parse(frame.payload.toString('utf8')) as StreamAck
        const pending = this.acks.shift()
        if (!pending || pending.kind !== ack.for) throw new Error(`unexpected ack for frame kind ${ack.for}`)
        clearTimeout(pending.timer)
        if (!pending.done) pending.resolve(ack)
        return
      }
      case FrameKind.Closed: {
        const closed = JSON.parse(frame.payload.toString('utf8')) as StreamClosed
        this.notifyClose(String(closed.reason))
        this.ended()
        this.connection.end()
        return
      }
      default:
        throw new Error(`unexpected frame kind ${frame.kind}`)
    }
  }

  /** To the sink, or, while a snapshot is being taken, behind its gate. */
  private deliver(seq: number, bytes: Uint8Array): void {
    if (!this.gated) {
      this.sink.onData(bytes)
      return
    }
    this.held.push(bytes)
    this.heldSeqs.push(seq)
    this.heldBytes += bytes.length
    this.lastOutputAt = Date.now()
    if (this.heldBytes > SNAPSHOT_BUFFER_MAX_BYTES) this.fatal('pty host snapshot output exceeded safe buffer limit')
  }

  private fatal(reason: string): void {
    this.notifyClose(reason)
    this.ended()
    this.connection.destroy()
  }

  private notifyClose(reason: string): void {
    if (this.closeNotified) return
    this.closeNotified = true
    this.ended()
    this.sink.onClose(reason)
  }

  /** Nothing more is sent, and what waits for the host is told it will not hear. */
  private ended(): void {
    this.closed = true
    for (const pending of this.acks.splice(0)) {
      clearTimeout(pending.timer)
      if (!pending.done) pending.resolve('closed')
    }
    for (const [id, resolve] of [...this.snapshots]) {
      this.snapshots.delete(id)
      resolve('closed')
    }
    for (const wake of [...this.seqWaiters]) wake()
  }

  private get writable(): boolean {
    return !this.closed && this.connection.writable
  }

  /** Send a frame the host acknowledges, and wait for its ack. */
  private sendForAck(kind: FrameKind, payload: Uint8Array): Promise<AckOutcome> {
    if (!this.writable) return Promise.resolve('closed')
    return new Promise((resolve) => {
      const pending: PendingAck = {
        kind,
        done: false,
        timer: setTimeout(() => {
          // It stays queued: its ack may still come, and must not be taken for the next frame's.
          pending.done = true
          resolve('timeout')
        }, this.ackTimeoutMs),
        resolve,
      }
      this.acks.push(pending)
      this.connection.write(encodeFrame(kind, payload))
    })
  }

  private async action(kind: FrameKind, payload: Uint8Array, what: string): Promise<TerminalActionResult> {
    return this.actionResult(await this.sendForAck(kind, payload), what)
  }

  private actionResult(outcome: AckOutcome, what: string): TerminalActionResult {
    if (outcome === 'timeout') return terminalActionPossiblyExecuted(`pty host did not acknowledge the ${what}`)
    if (outcome === 'closed') return terminalActionPossiblyExecuted('pty host stream closed')
    return outcome.ok ? TERMINAL_ACTION_SUCCEEDED : refusal(outcome.reason)
  }

  private serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  beginSnapshot(): void {
    if (this.gated) return
    this.gated = true
    this.held = []
    this.heldSeqs = []
    this.heldBytes = 0
    this.lastOutputAt = Date.now()
  }

  /** As `TmuxControlStream.snapshot`. */
  async snapshot(options?: SnapshotOptions): Promise<TerminalReadResult<TerminalStreamSnapshot>> {
    return this.serializeOperation(async () => {
      if (!this.gated) return { state: 'failed', reason: 'pty host snapshot gate is not active' }
      const repaint = options?.repaint
      if (!repaint) return this.capture(options)
      if (repaint.cleared || Date.now() - this.resizedAt < repaint.withinMs) await waitForRepaint(this.gate, repaint)
      const taken = await this.capture(options, repaint)
      if (taken !== 'printing') return taken
      // The print began before the capture's cut and had not ended at it: it is taken again once the print ends.
      await waitForRepaint(this.gate, { ...repaint, cleared: true })
      return this.capture(options)
    })
  }

  /**
   * The pane, read for a keyframe, as `TmuxControlStream` reads it. The host reads the screen, the cursor and the
   * history under one lock, so there are no separate reads to keep together; the wait for quiet output stays, as a
   * subscription's resize makes a TUI print again.
   */
  private capture(options: SnapshotOptions | undefined): Promise<TerminalReadResult<TerminalStreamSnapshot>>
  private capture(
    options: SnapshotOptions | undefined, print: { clears: string; ends: string },
  ): Promise<TerminalReadResult<TerminalStreamSnapshot> | 'printing'>
  private async capture(
    options: SnapshotOptions | undefined, print?: { clears: string; ends: string },
  ): Promise<TerminalReadResult<TerminalStreamSnapshot> | 'printing'> {
    if (this.closed) return { state: 'failed', reason: 'terminal stream is closed' }
    await waitForSnapshotQuiet(this.gate)
    const tuiOwnsScrollback = options?.tuiOwnsScrollback === true
    const conversationAsked = !tuiOwnsScrollback && options?.conversationHistory === true
    const request: StreamSnapshotRequest = tuiOwnsScrollback
      ? { id: this.nextSnapshotId++, history: 'none' }
      : conversationAsked
        ? { id: this.nextSnapshotId++, history: 'conversation', historyLines: CONVERSATION_HISTORY_LINES }
        : { id: this.nextSnapshotId++, history: 'plain', historyLines: SNAPSHOT_HISTORY_LINES }
    const reply = await this.requestSnapshot(request)
    if (reply === 'timeout') return { state: 'failed', reason: 'pty host snapshot timed out' }
    if (reply === 'closed') return { state: 'failed', reason: 'terminal stream is closed' }
    if (!reply.ok) return { state: 'failed', reason: `pty host snapshot failed: ${reply.reason}` }
    const meta = paneMetaOf(reply.meta)
    if (!meta || typeof reply.seq !== 'number' || typeof reply.capture !== 'string' || typeof reply.history !== 'string') {
      return { state: 'failed', reason: 'pty host snapshot metadata is invalid' }
    }
    // Outputs the capture contains can come after its reply. They are dropped anyway; a print is looked for in them.
    if (print && this.lastSeq !== null && this.lastSeq < reply.seq) await this.outputThrough(reply.seq)
    const contained = this.takeThrough(reply.seq)
    const printing = print ? printInProgress(contained, print) : false
    this.cut = Math.max(this.cut, reply.seq)
    this.size = { cols: meta.paneWidth, rows: meta.paneHeight }
    if (printing) return 'printing'
    // As `TmuxControlStream.capturePane`: the alternate screen and a TUI that owns its scrollback seed no history, and
    // a conversation's is re-wrapped by word where the joined history came and the pane is wide enough for it.
    const seedsHistory = !meta.alternateOn && !tuiOwnsScrollback
    const conversation = seedsHistory && conversationAsked
    const history = seedsHistory ? Buffer.from(reply.history, 'utf8') : Buffer.alloc(0)
    let rows: Uint8Array | null = null
    if (conversation && meta.paneWidth >= REWRAP_MIN_WIDTH && typeof reply.historyJoined === 'string') {
      try {
        rows = rewrapTmuxHistory(Buffer.from(reply.historyJoined, 'utf8'), meta.paneWidth, { lastContinues: reply.lastContinues === true })
      } catch {
        // A history the re-wrap cannot read is sent as it is, as tmuxStream.ts sends it.
        rows = null
      }
    }
    const bytes = tmuxKeyframe(Buffer.from(reply.capture, 'utf8'), meta, history, rows, { conversation, tuiOwnsScrollback })
    return { state: 'succeeded', value: { bytes, cols: meta.paneWidth, rows: meta.paneHeight } }
  }

  private requestSnapshot(request: StreamSnapshotRequest): Promise<StreamSnapshotReply | 'timeout' | 'closed'> {
    if (!this.writable) return Promise.resolve('closed')
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.snapshots.delete(request.id)
        resolve('timeout')
      }, this.snapshotTimeoutMs)
      this.snapshots.set(request.id, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      this.connection.write(encodeFrame(FrameKind.Snapshot, Buffer.from(JSON.stringify(request))))
    })
  }

  /** Until the output numbered [seq] has been read, the stream has ended, or LAGGING_OUTPUT_WAIT_MS has passed. */
  private outputThrough(seq: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        if (!this.closed && (this.lastSeq ?? 0) < seq) return
        clearTimeout(timer)
        this.seqWaiters.delete(done)
        resolve()
      }
      const timer = setTimeout(() => {
        this.seqWaiters.delete(done)
        resolve()
      }, LAGGING_OUTPUT_WAIT_MS)
      this.seqWaiters.add(done)
    })
  }

  /** Remove the held outputs at or below [seq], the cut, and give them back. */
  private takeThrough(seq: number): Uint8Array[] {
    const taken: Uint8Array[] = []
    const held: Uint8Array[] = []
    const heldSeqs: number[] = []
    let heldBytes = 0
    this.heldSeqs.forEach((at, index) => {
      if (at <= seq) {
        taken.push(this.held[index])
      } else {
        held.push(this.held[index])
        heldSeqs.push(at)
        heldBytes += this.held[index].length
      }
    })
    this.held = held
    this.heldSeqs = heldSeqs
    this.heldBytes = heldBytes
    return taken
  }

  endSnapshot(): void {
    if (!this.gated) return
    this.gated = false
    const held = this.held
    const seqs = this.heldSeqs
    this.held = []
    this.heldSeqs = []
    this.heldBytes = 0
    // The sink can begin the next snapshot from what is released here (as tmuxStream.ts `endSnapshot`): what is left
    // is then held behind that one.
    held.forEach((bytes, index) => {
      if (seqs[index] > this.cut && !this.closed) this.deliver(seqs[index], bytes)
    })
  }

  /**
   * Every frame is written before the first `await`, as `TmuxControlStream.writeRaw` requires: the stream manager
   * hands over the next keystroke without waiting for this one.
   */
  async writeRaw(bytes: Uint8Array): Promise<TerminalActionResult> {
    if (this.readOnly) return terminalActionNotStarted('VIEW_ONLY')
    if (!this.writable) return terminalActionNotStarted('terminal stream is closed')
    if (bytes.length === 0) return TERMINAL_ACTION_SUCCEEDED
    const sends: Array<Promise<TerminalActionResult>> = []
    for (let offset = 0; offset < bytes.length; offset += INPUT_FRAME_BYTES) {
      sends.push(this.action(FrameKind.Input, bytes.subarray(offset, offset + INPUT_FRAME_BYTES), 'input'))
    }
    const results = await Promise.all(sends)
    const failedAt = results.findIndex((result) => result.state !== 'succeeded')
    if (failedAt < 0) return TERMINAL_ACTION_SUCCEEDED
    return failedAt === 0 ? results[0] : terminalActionPossiblyExecuted('pty host raw input stopped after a partial write')
  }

  /** One Paste frame: the host writes it bracketed when the program asked for that, as tmux's `paste-buffer -p`. */
  async pasteRaw(text: string): Promise<TerminalActionResult> {
    if (this.readOnly) return terminalActionNotStarted('VIEW_ONLY')
    if (!this.writable) return terminalActionNotStarted('terminal stream is closed')
    if (text.length === 0) return TERMINAL_ACTION_SUCCEEDED
    const payload = Buffer.from(text, 'utf8')
    if (payload.length > MAX_FRAME) return terminalActionNotStarted('the paste is too large')
    return this.action(FrameKind.Paste, payload, 'paste')
  }

  /** PageUp/PageDown into the pane, a page a wheel burst, as `TmuxControlStream.scroll`. */
  async scroll(direction: 'up' | 'down', lines: number): Promise<TerminalActionResult> {
    if (this.readOnly) return terminalActionNotStarted('VIEW_ONLY')
    if (!this.writable) return terminalActionNotStarted('terminal stream is closed')
    const pages = tuiScrollPageCount(lines)
    if (pages <= 0) return TERMINAL_ACTION_SUCCEEDED
    const now = Date.now()
    if (now - this.lastTuiScrollAt < TUI_SCROLL_MIN_INTERVAL_MS) return TERMINAL_ACTION_SUCCEEDED
    this.lastTuiScrollAt = now
    const key = direction === 'up' ? PAGE_UP : PAGE_DOWN
    return this.action(FrameKind.Input, Buffer.concat(Array.from({ length: pages }, () => key)), 'scroll')
  }

  async resize(requested: TerminalStreamSize): Promise<TerminalActionResult> {
    if (this.readOnly) return terminalActionNotStarted('VIEW_ONLY')
    return this.serializeOperation(async () => {
      if (!this.writable) return terminalActionNotStarted('terminal stream is closed')
      const size = boundedSize(requested)
      // As tmux: a repeated open or focus asks for the size in use, and a TUI may print again on any resize.
      if (this.size && this.size.cols === size.cols && this.size.rows === size.rows) return TERMINAL_ACTION_SUCCEEDED
      const outcome = await this.sendForAck(FrameKind.Resize, Buffer.from(JSON.stringify(size)))
      // A resize the host says changed nothing (the pane had this size) makes no print to wait for; one that may
      // have happened is taken to have.
      if (outcome === 'timeout' || outcome === 'closed' || !outcome.ok || outcome.resized !== false) this.resizedAt = Date.now()
      const result = this.actionResult(outcome, 'resize')
      this.size = result.state === 'succeeded' ? size : null
      return result
    })
  }

  /** The host holds this stream's output while paused, up to its limit (Closed `overflow` past it). */
  async pauseOutput(): Promise<TerminalActionResult> {
    if (!this.writable) return terminalActionNotStarted('terminal stream is closed')
    this.connection.write(encodeFrame(FrameKind.Pause, new Uint8Array()))
    return TERMINAL_ACTION_SUCCEEDED
  }

  async resumeOutput(): Promise<TerminalActionResult> {
    if (!this.writable) return terminalActionNotStarted('terminal stream is closed')
    this.connection.write(encodeFrame(FrameKind.Resume, new Uint8Array()))
    return TERMINAL_ACTION_SUCCEEDED
  }

  /** End the connection; the host then drops the subscription. The pane is not touched. */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = (async () => {
      this.ended()
      const connection = this.connection
      if (!connection.destroyed) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, CLOSE_FLUSH_MS)
          connection.end(() => {
            clearTimeout(timer)
            resolve()
          })
        })
        connection.destroy()
      }
      this.notifyClose('closed')
    })()
    return this.closing
  }
}
