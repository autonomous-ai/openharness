/**
 * A bound OpenClaw session's live stream: the reader's rows (reader.ts) through the one owner of turn state, the
 * normalizer (normalizer.ts). The core holds one of these per session, as it holds an `OpencodeReader`.
 *
 * - At attach the reader hydrates silently; the hydrated rows go through the live normalizer, output discarded, so
 *   its open turn and unanswered calls are the conversation's. A run still going then emits its `turn_started`, as
 *   `OpencodeReader.hydrate` does; a run the store says is over (an abort leaves its call unanswered) is closed
 *   silently.
 * - A run that is aborted, fails or times out writes no closing row. A turn left open is closed once the key's status
 *   says no run is going, and once the pane reads idle twice in a row: a Gateway restart can leave `running` behind.
 * - The window's header (seq 0, `{type:'session', cwd}`) is handed on for the workspace label.
 */
import type { LiveEvent } from '../../lib/normalize.js'
import { OpenclawNormalizer } from './normalizer.js'
import { OpenclawReader, type OpenclawEvent } from './reader.js'

type Closed = 'aborted' | 'failed' | 'timeout'

/** How the run ended, by the status OpenClaw gives the key (`session_nodes.status`); any other, as an interrupt. */
const CLOSED_BY: Record<string, Closed> = { killed: 'aborted', failed: 'failed', timeout: 'timeout' }
/** What the person is told when a run ended that way with no row of its own to say so. */
const FAILED: Record<Exclude<Closed, 'aborted'>, string> = {
  failed: 'The OpenClaw run failed.',
  timeout: 'The OpenClaw run timed out.',
}
/** Reads of the key whose status says no run is going, before a turn opened in the first of them is closed. */
const STALE_READS = 2
/** Bind passes (5 s apart, core/agents/bind.ts) that read the pane idle, before a turn still open is closed. */
const READY_PASSES = 2

export interface OpenclawLiveDeps {
  db: string
  key: string
  onEvents(events: LiveEvent[]): void
  /** The window's header record, each time a window is read from its start. */
  onHeader?(record: Record<string, unknown>): void
  /** A run failed or timed out and wrote nothing that says so: what to tell the person. */
  onFailed?(message: string): void
  /** The store cannot be read on this machine or in this version (reader.ts `onFatal`). */
  onFatal(reason: 'unsupported' | 'missing'): void
  /** An unsupported store is read again (OpenClaw was upgraded or downgraded). */
  onRecovered?(): void
  pollMs?: number
}

export class OpenclawLive {
  private readonly normalizer = new OpenclawNormalizer('live')
  private readonly reader: OpenclawReader
  private lastStatus: string | null = null
  private staleReads = 0
  private readyPasses = 0

  constructor(private readonly deps: OpenclawLiveDeps) {
    this.reader = new OpenclawReader({
      db: deps.db,
      key: deps.key,
      pollMs: deps.pollMs,
      onHydrated: (events, status) => {
        this.headers(events)
        const opening = this.normalizer.push(events).filter((event) => event.type === 'turn_started').at(-1)
        if (!this.normalizer.turnOpen) return
        if (opening && (status === 'running' || status === null)) this.emit([opening])
        else this.normalizer.closeTurn('aborted')
      },
      onEvents: (events) => {
        this.headers(events)
        this.emit(this.normalizer.push(events))
      },
      onStatus: (status) => this.status(status),
      onFatal: (reason) => deps.onFatal(reason),
      onRecovered: () => deps.onRecovered?.(),
    })
  }

  get turnOpen(): boolean { return this.normalizer.turnOpen }

  async start(): Promise<void> { await this.reader.start() }

  stop(): void { this.reader.stop() }

  /** A cancel: the turn is over. What closing it returns is not emitted (a cancel sends no turn end). */
  closeTurn(): void {
    this.normalizer.closeTurn('aborted')
    this.staleReads = this.readyPasses = 0
  }

  /** What the bind pass read off the pane: `ready` is a status line that says idle (contract.ts `readOpenclawScreen`). */
  paneReady(ready: boolean): void {
    if (!ready || !this.normalizer.turnOpen) { this.readyPasses = 0; return }
    if (++this.readyPasses >= READY_PASSES) this.close('aborted')
  }

  private status(status: string | null): void {
    const was = this.lastStatus
    this.lastStatus = status
    if (!this.normalizer.turnOpen || status === 'running' || status === null) { this.staleReads = 0; return }
    // The read that opened a turn can come before its run says `running`: a second read is proof, unless the one
    // before saw the run going (Esc within a poll goes from killed to killed, with no `running` seen in between).
    if (was !== 'running' && ++this.staleReads < STALE_READS) return
    this.close(CLOSED_BY[status] ?? 'aborted')
  }

  private close(reason: Closed): void {
    const out = this.normalizer.closeTurn(reason)
    this.emit(out)
    if (out.length && reason !== 'aborted') this.deps.onFailed?.(FAILED[reason])
  }

  private emit(out: LiveEvent[]): void {
    if (!out.length) return
    if (out.some((event) => event.type === 'turn_started' || event.type === 'turn_ended')) this.staleReads = this.readyPasses = 0
    this.deps.onEvents(out)
  }

  private headers(events: OpenclawEvent[]): void {
    for (const event of events) if (event.seq === 0 && event.record.type === 'session') this.deps.onHeader?.(event.record)
  }
}
