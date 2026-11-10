/**
 * A bound OpenClaw session's live stream: the reader's rows (reader.ts) through the one owner of turn state, the
 * normalizer (normalizer.ts). The core holds one of these per session, as it holds an `OpencodeReader`.
 *
 * - At attach the reader hydrates silently; the hydrated rows go through the live normalizer, output discarded, so
 *   its open turn and unanswered calls are the conversation's. A run still going then emits its `turn_started`, as
 *   `OpencodeReader.hydrate` does; a run the store says is over (an abort leaves its call unanswered) is closed
 *   silently.
 * - A run that is aborted, fails or times out writes no closing row: its status leaving `running` closes the turn.
 * - The window's header (seq 0, `{type:'session', cwd}`) is handed on for the workspace label.
 */
import type { LiveEvent } from '../../lib/normalize.js'
import { OpenclawNormalizer } from './normalizer.js'
import { OpenclawReader, type OpenclawEvent } from './reader.js'

/** How the run ended, by the status OpenClaw gives the key (`session_nodes.status`). */
const CLOSED_BY: Record<string, 'aborted' | 'failed' | 'timeout'> = { killed: 'aborted', failed: 'failed', timeout: 'timeout' }

export interface OpenclawLiveDeps {
  db: string
  key: string
  onEvents(events: LiveEvent[]): void
  /** The window's header record, each time a window is read from its start. */
  onHeader?(record: Record<string, unknown>): void
  /** The store cannot be read on this machine or in this version: the stream has stopped. */
  onFatal(reason: 'unsupported' | 'missing'): void
  pollMs?: number
}

export class OpenclawLive {
  private readonly normalizer = new OpenclawNormalizer('live')
  private readonly reader: OpenclawReader
  private midRun = false
  /** The `turn_started` the hydrated rows opened, emitted only if the run is still going. */
  private opening: LiveEvent | null = null

  constructor(private readonly deps: OpenclawLiveDeps) {
    this.reader = new OpenclawReader({
      db: deps.db,
      key: deps.key,
      pollMs: deps.pollMs,
      onHydrated: (events) => {
        this.headers(events)
        this.opening = this.normalizer.push(events).filter((event) => event.type === 'turn_started').at(-1) ?? null
      },
      onTurnStarted: () => { this.midRun = true },
      onEvents: (events) => {
        this.headers(events)
        const out = this.normalizer.push(events)
        if (out.length) deps.onEvents(out)
      },
      onStatus: (status) => {
        const reason = status ? CLOSED_BY[status] : undefined
        const out = reason ? this.normalizer.closeTurn(reason) : []
        if (out.length) deps.onEvents(out)
      },
      onFatal: (reason) => deps.onFatal(reason),
    })
  }

  get turnOpen(): boolean { return this.normalizer.turnOpen }

  async start(): Promise<void> {
    await this.reader.start()
    if (!this.normalizer.turnOpen) return
    if (this.midRun && this.opening) this.deps.onEvents([this.opening])
    else this.normalizer.closeTurn('aborted')
  }

  stop(): void { this.reader.stop() }

  /** A cancel: the turn is over. What closing it returns is not emitted (a cancel sends no turn end). */
  closeTurn(): void { this.normalizer.closeTurn('aborted') }

  private headers(events: OpenclawEvent[]): void {
    for (const event of events) if (event.seq === 0 && event.record.type === 'session') this.deps.onHeader?.(event.record)
  }
}
