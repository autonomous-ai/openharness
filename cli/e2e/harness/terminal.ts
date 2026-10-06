import { TerminalBinaryKind, type TerminalBinaryClear } from '../../src/lib/terminalBinary.js'
import type { LocalClient, Frame } from './client.js'
import { until } from './daemon.js'

const PROTOCOL = 3
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8')

/** One terminal as a window holds it: its stream, what it has drawn, and the keystrokes it sent. */
export class Terminal {
  private inputSeq = 0
  private constructor(readonly client: LocalClient, readonly agentId: string, readonly ready: Record<string, any>, private readonly since: number) {}

  get streamId(): string { return this.ready.streamId as string }
  get readOnly(): boolean { return this.ready.readOnly === true }

  /** Opens it, or rejects with the `terminal_error` code the daemon answered. */
  static async open(client: LocalClient, agentId: string, options: Record<string, unknown> = {}): Promise<Terminal> {
    const answer = await Terminal.answer(client, { agentId, cols: 100, rows: 30, ...options })
    if (answer.type !== 'terminal_ready') throw new Error(String(answer.payload?.code))
    return new Terminal(client, agentId, answer.payload!, client.binaries.length)
  }

  /** The frame `terminal_open` is answered with: `terminal_ready`, or `terminal_error` naming why. */
  static async answer(client: LocalClient, payload: Record<string, unknown>): Promise<Frame> {
    const requestId = `open-${Math.random().toString(36).slice(2)}`
    const answered = client.next((frame) => (frame.type === 'terminal_ready' || frame.type === 'terminal_error')
      && frame.payload?.requestId === requestId, 30_000, 'terminal_ready')
    client.send('terminal_open', { requestId, protocolVersion: PROTOCOL, ...payload })
    return answered
  }

  frames(): TerminalBinaryClear[] {
    return this.client.binaries.slice(this.since).filter((frame) => frame.streamId === this.streamId)
  }

  /** What the window would draw: the latest keyframe and the output after it. */
  screen(): string {
    const frames = this.frames()
    let start = -1
    for (let i = frames.length - 1; i >= 0; i--) if (frames[i].kind === TerminalBinaryKind.keyframe) { start = i; break }
    return frames.slice(Math.max(start, 0)).filter((frame) => frame.kind !== TerminalBinaryKind.sync).map((frame) => text(frame.bytes)).join('')
  }

  /** Every output byte since the stream opened, keyframes left out: the engine's writes, in order. */
  output(): string {
    return this.frames().filter((frame) => frame.kind === TerminalBinaryKind.output).map((frame) => text(frame.bytes)).join('')
  }

  keyframe(index = 0): Promise<TerminalBinaryClear> {
    return until(`keyframe ${index}`, () => this.frames().filter((frame) => frame.kind === TerminalBinaryKind.keyframe)[index] ?? null, 20_000, 50)
  }

  shows(what: string, ms = 20_000): Promise<string> {
    return until(`the terminal to show ${JSON.stringify(what)}`, () => { const now = this.screen(); return now.includes(what) ? now : null }, ms, 50)
  }

  /** Keystrokes, in frames of at most `chunk` bytes, numbered as the desktop numbers them. */
  type(keys: string, chunk = 8): void {
    const bytes = Buffer.from(keys, 'utf8')
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      this.client.sendBinary({ kind: TerminalBinaryKind.input, streamId: this.streamId, seq: this.inputSeq++, compressed: false, bytes: bytes.subarray(offset, offset + chunk) })
    }
  }

  /** A keystroke frame with any seq at all: what a client whose counter drifted sends. */
  typeAt(seq: number, keys: string): void {
    this.client.sendBinary({ kind: TerminalBinaryKind.input, streamId: this.streamId, seq, compressed: false, bytes: Buffer.from(keys, 'utf8') })
  }

  paste(words: string): void {
    this.client.sendBinary({ kind: TerminalBinaryKind.paste, streamId: this.streamId, seq: 0, compressed: false, bytes: Buffer.from(words, 'utf8') })
  }

  /** Acknowledges everything drawn so far, as the renderer does once it has painted it. */
  ack(): void {
    const frames = this.frames()
    if (frames.length) this.client.send('terminal_ack', { streamId: this.streamId, lastSeq: frames[frames.length - 1].seq })
  }

  closed(ms = 20_000): Promise<Frame> {
    return this.client.waitFor((frame) => frame.type === 'terminal_closed' && frame.payload?.streamId === this.streamId, ms, 'terminal_closed')
  }

  error(code: string, ms = 20_000): Promise<Frame> {
    return this.client.waitFor((frame) => frame.type === 'terminal_error' && frame.payload?.code === code
      && (frame.payload?.streamId === undefined || frame.payload.streamId === this.streamId), ms, `terminal_error ${code}`)
  }
}

