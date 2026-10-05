import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { patientExec } from './patientExec.js'

type CaptureOptions = { visible?: boolean; ansi?: boolean }
type CaptureExecutor = (args: string[], options: { timeout: number; maxBuffer: number },
  done: (error: Error | null, stdout: string) => void) => void
type PendingCapture = { args: string[]; resolve: (value: string | null) => void }

const MAX_BATCH = 32
const SINGLE_BYTES = 1024 * 1024
const BATCH_BYTES = 4 * SINGLE_BYTES

export function tmuxCaptureArgs(pane: string, historyLines = 100, options: CaptureOptions = {}): string[] {
  const bounded = Math.max(20, Math.min(300, Math.floor(historyLines)))
  const args = ['capture-pane', '-p']
  if (options.ansi !== false) args.push('-e')
  args.push('-J', '-t', pane)
  if (!options.visible) args.push('-S', `-${bounded}`)
  return args
}

/** Concurrent reads share a tmux client, never a cached screen. A microtask
 * collects only this event-loop turn; a solitary read keeps the direct path. */
export class TmuxCaptureBatcher {
  private pending: PendingCapture[] = []

  // A held event loop must not turn a timeout into an empty screen (patientExec.ts).
  constructor(private readonly execute: CaptureExecutor = (args, options, done) => {
    patientExec(execFile)('tmux', args, options, done)
  }) {}

  capture(pane: string, historyLines = 100, options: CaptureOptions = {}): Promise<string | null> {
    // Captures address exact pane IDs. In particular, an argv command separator
    // must never be accepted as a target in a compound tmux command.
    if (!/^%\d+$/.test(pane)) return Promise.resolve(null)
    return new Promise(resolve => {
      this.pending.push({ args: tmuxCaptureArgs(pane, historyLines, options), resolve })
      if (this.pending.length === 1) queueMicrotask(() => this.flush())
    })
  }

  private flush(): void {
    const pending = this.pending
    this.pending = []
    for (let i = 0; i < pending.length; i += MAX_BATCH) this.batch(pending.slice(i, i + MAX_BATCH))
  }

  private single(read: PendingCapture): void {
    try {
      this.execute(read.args, { timeout: 2_000, maxBuffer: SINGLE_BYTES }, (error, stdout) => {
        read.resolve(error ? null : stdout)
      })
    } catch {
      read.resolve(null)
    }
  }

  private batch(reads: PendingCapture[]): void {
    if (reads.length === 1) { this.single(reads[0]); return }
    const nonce = `harness-capture-${randomUUID()}`
    const frames = reads.map((_, i) => ({ start: `${nonce}-${i}-start\n`, end: `${nonce}-${i}-end\n` }))
    const args: string[] = []
    for (const [i, read] of reads.entries()) {
      if (i) args.push(';')
      args.push('display-message', '-p', frames[i].start.trimEnd(), ';', ...read.args,
        ';', 'display-message', '-p', frames[i].end.trimEnd())
    }
    const finish = (_error: Error | null, stdout: string): void => {
      let cursor = 0
      for (const [i, read] of reads.entries()) {
        const { start, end } = frames[i]
        const begin = stdout.startsWith(start, cursor) ? cursor + start.length : -1
        const finish = begin < 0 ? -1 : stdout.indexOf(end, begin)
        if (finish >= begin && begin >= 0 && (finish === begin || stdout[finish - 1] === '\n')) {
          const text = stdout.slice(begin, finish)
          // A retained question must not retain the backing string for every
          // other pane in this batch. Return independent UTF-8 string storage.
          read.resolve(Buffer.byteLength(text) <= SINGLE_BYTES ? Buffer.from(text).toString('utf8') : null)
          cursor = finish + end.length
        } else {
          // tmux stops a command list at the first missing pane. Retain only
          // complete frames; retry every unfinished read on its own so one dead
          // pane or an output-size limit cannot hide neighboring questions.
          this.single(read)
        }
      }
    }
    try {
      this.execute(args, { timeout: 2_000, maxBuffer: BATCH_BYTES }, finish)
    } catch {
      for (const read of reads) this.single(read)
    }
  }
}

const captures = new TmuxCaptureBatcher()

/** Capture fresh terminal text with independently selectable ANSI and history. */
export function captureTmuxPane(pane: string, historyLines = 100, options: CaptureOptions = {}): Promise<string | null> {
  return captures.capture(pane, historyLines, options)
}
