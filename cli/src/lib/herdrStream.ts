/**
 * Herdr has no private PTY that leaves other clients attached. The stream is
 * the visible pane screen (ANSI), polled, and input goes through send-text. It never
 * attaches, focuses, or resizes the pane.
 *
 * Every keyframe and every change is a whole-screen repaint: home, clear screen and
 * scrollback, then herdr's `--format ansi` rows (CRLF-separated). Diffing plain text
 * by suffix sent bare LFs and partial rows that a terminal cannot place.
 */
import type {
  TerminalActionResult,
  TerminalReadResult,
  TerminalStreamHandle,
  TerminalStreamSink,
  TerminalStreamSize,
  TerminalStreamSnapshot,
} from './terminalTypes.js'
import type { HerdrRuntimeRef } from './terminalTypes.js'
import type { HerdrRun } from './herdrBackend.js'

const failed = (reason: string): TerminalActionResult => ({ state: 'failed', dispatch: 'not_started', reason })
const ok = (): TerminalActionResult => ({ state: 'succeeded', dispatch: 'executed' })

export class HerdrPaneStream implements TerminalStreamHandle<HerdrRuntimeRef> {
  private closed = false
  private held = false
  private last = ''
  private polling = false
  private timer: ReturnType<typeof setInterval> | undefined
  private size: TerminalStreamSize

  constructor(
    readonly runtime: HerdrRuntimeRef,
    private readonly run: HerdrRun,
    private readonly sink: TerminalStreamSink,
    private readonly readOnly: boolean,
    size?: TerminalStreamSize,
  ) {
    this.size = size ?? { cols: 80, rows: 24 }
  }

  start(): void {
    this.timer = setInterval(() => { void this.poll() }, 200)
    void this.poll()
  }

  private async readVisible(): Promise<string | null> {
    const read = await this.run(['pane', 'read', this.runtime.paneId, '--source', 'visible', '--format', 'ansi'])
    return read.code === 0 ? read.stdout : null
  }

  /** A full repaint of [text]: reset attributes, home, clear screen + scrollback, the rows. */
  private static repaint(text: string): Uint8Array {
    const rows = text.replace(/\r?\n$/, '').replace(/\r?\n/g, '\r\n')
    return new TextEncoder().encode(`\x1b[0m\x1b[H\x1b[2J\x1b[3J${rows}\x1b[0m`)
  }

  private async poll(): Promise<void> {
    if (this.closed || this.held || this.polling) return
    this.polling = true
    try {
      const text = await this.readVisible()
      if (this.closed || this.held || text === null || text === this.last) return
      this.last = text
      this.sink.onData(HerdrPaneStream.repaint(text))
    } finally {
      this.polling = false
    }
  }

  beginSnapshot(): void { this.held = true }

  async snapshot(): Promise<TerminalReadResult<TerminalStreamSnapshot>> {
    const text = await this.readVisible()
    if (text === null) return { state: 'failed', reason: 'herdr pane read failed' }
    this.last = text
    return { state: 'succeeded', value: { bytes: HerdrPaneStream.repaint(text), cols: this.size.cols, rows: this.size.rows } }
  }

  endSnapshot(): void { this.held = false }

  async writeRaw(bytes: Uint8Array): Promise<TerminalActionResult> {
    if (this.readOnly) return failed('herdr stream is read-only')
    const sent = await this.run(['pane', 'send-text', this.runtime.paneId, new TextDecoder().decode(bytes)])
    return sent.code === 0 ? ok() : failed(sent.stderr.trim() || 'herdr send-text failed')
  }

  async pasteRaw(text: string): Promise<TerminalActionResult> {
    return this.writeRaw(new TextEncoder().encode(text))
  }

  async resize(size: TerminalStreamSize): Promise<TerminalActionResult> {
    // The viewer's size, not the pane's: herdr panes are never resized from here.
    this.size = size
    return ok()
  }

  async scroll(direction: 'up' | 'down', lines: number): Promise<TerminalActionResult> {
    if (this.readOnly) return ok()
    const key = direction === 'up' ? 'pageup' : 'pagedown'
    const count = Math.max(1, Math.min(lines, 20))
    for (let i = 0; i < count; i++) {
      const sent = await this.run(['pane', 'send-keys', this.runtime.paneId, key])
      if (sent.code !== 0) return failed(sent.stderr.trim() || 'herdr send-keys failed')
    }
    return ok()
  }

  async pauseOutput(): Promise<TerminalActionResult> {
    this.held = true
    return ok()
  }

  async resumeOutput(): Promise<TerminalActionResult> {
    this.held = false
    return ok()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    this.sink.onClose('closed')
  }
}
