/**
 * A bound OpenClaw session's live stream: the reader's rows (reader.ts) through the one owner of turn state, the
 * normalizer (normalizer.ts). The core holds one of these per session, as it holds an `OpencodeReader`.
 *
 * - At attach the reader hydrates silently; the hydrated rows go through the live normalizer, output discarded, so
 *   its open turn and unanswered calls are the conversation's. A run still going then emits its `turn_started`, as
 *   `OpencodeReader.hydrate` does; a run the store says is over (an abort leaves its call unanswered) is closed
 *   silently.
 * - A run that is aborted, fails or times out writes no closing row. A turn left open is closed once the key's status
 *   says no run is going. A Gateway restart can leave `running` behind, so a turn is also closed once the pane, after
 *   showing the connection drop, reads idle on two passes with no row between them. Idle alone is no proof: the TUI
 *   reads `connected | idle` through a run it did not start until that run's first delta (another TUI, the Control UI,
 *   a channel message, cron), and its watchdog sets idle 30 s after a reconnect.
 * - The window's header (seq 0, `{type:'session', cwd}`) is handed on for the workspace label. A key with no rows yet
 *   (`main`, bound before its first message) hands on the agent's newest header instead: the workspace is the agent's.
 * - A pane that read idle, with no turn open and its store unchanged since, has nothing new to show but a Gateway that
 *   dropped: the bind pass reads it every QUIET_PANE_MS instead of every pass (`paneDue`). The pane's captures were
 *   most of what one bound idle pane cost the daemon.
 * - A pane that reads a run in progress (`running`, `streaming`; not `connecting`) while the store holds no node for
 *   the key, on every pass for NO_SESSION_MS, is on a store the Gateway does not write: the TUI's state folder is not
 *   the Gateway's, and the store will never get the session (`onSessionMissing`). A fresh key reads idle before its
 *   first message, and a Gateway that is only slow writes the node well within that time. Said once, and cleared once
 *   the key is found (`onSessionFound`). Not counted while the store cannot be read (`onFatal`), which says so itself.
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
/** Bind passes (5 s apart, core/agents/bind.ts) that read the pane idle with no row between, before a turn left open
 * after a Gateway drop is closed. */
const READY_PASSES = 2
/** How often a quiet pane is read all the same: a Gateway that stops while nothing runs changes the screen alone. */
const QUIET_PANE_MS = 30_000
/** How long the pane reads a run with no node for the key before the store is said to be the wrong one. */
const NO_SESSION_MS = 30_000
/**
 * How far short of NO_SESSION_MS a pass may read and still count as reaching it: the passes are timed on the event
 * loop's clock and each reads after a capture of its own, so by `Date.now()` the pass 30 s on lands a few ms either side
 * of it (end to end, 2026-11-11: short each time, and the hold came a pass later). A tenth of the shortest pass interval.
 */
const PASS_JITTER_MS = 500

/** What a bind pass read off the pane (contract.ts `readOpenclawScreen`). */
interface OpenclawPaneReading {
  /** The status line says idle. */
  ready: boolean
  /** The status line says the Gateway connection dropped or just came back. */
  gatewayLost: boolean
  /** The status line says a run is in progress. */
  running: boolean
}

export interface OpenclawLiveDeps {
  db: string
  key: string
  onEvents(events: LiveEvent[]): void
  /** The window's header record, each time a window is read from its start; for a key with no rows yet, the agent's
   *  newest window's. */
  onHeader?(record: Record<string, unknown>): void
  /** A run failed or timed out and wrote nothing that says so: what to tell the person. */
  onFailed?(message: string): void
  /** The store cannot be read on this machine or in this version (reader.ts `onFatal`). */
  onFatal(reason: 'unsupported' | 'missing'): void
  /** An unsupported store is read again (OpenClaw was upgraded or downgraded). */
  onRecovered?(): void
  /** The pane read a run for NO_SESSION_MS while the store held no node for the key: it is not the Gateway's store. */
  onSessionMissing?(): void
  /** The key was found after `onSessionMissing`. */
  onSessionFound?(): void
  pollMs?: number
}

export class OpenclawLive {
  private readonly normalizer = new OpenclawNormalizer('live')
  private readonly reader: OpenclawReader
  private lastStatus: string | null = null
  private staleReads = 0
  private readyPasses = 0
  /** The pane showed the Gateway connection drop since the open turn started. */
  private gatewayLost = false
  /** The last bind pass that read the pane: when, how many store changes the reader had seen, and whether it was quiet. */
  private paneSeen: { at: number; changes: number; quiet: boolean } | null = null
  /** When the passes that read a run with no node for the key began, and whether `onSessionMissing` was said. */
  private runWithoutKey: number | null = null
  private sessionMissing = false
  /** The store cannot be read here or in this version (`onFatal`) and is not read again yet: no word on the key. */
  private unreadable = false

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
        // A row is the run going: the pane's idle passes count again from the next one.
        if (events.length) this.readyPasses = 0
        this.headers(events)
        this.emit(this.normalizer.push(events))
      },
      onStatus: (status) => this.status(status),
      onFatal: (reason) => { this.unreadable = true; deps.onFatal(reason) },
      onRecovered: () => { this.unreadable = false; deps.onRecovered?.() },
      onAgentHeader: (record) => deps.onHeader?.(record),
      busy: () => this.normalizer.turnOpen,
    })
  }

  get turnOpen(): boolean { return this.normalizer.turnOpen }

  async start(): Promise<void> { await this.reader.start() }

  stop(): void { this.reader.stop() }

  /** A cancel: the turn is over. What closing it returns is not emitted (a cancel sends no turn end). */
  closeTurn(): void {
    this.normalizer.closeTurn('aborted')
    this.reset()
  }

  /** A bind pass's reading of the pane: how long a run has gone with no node for the key, and the backstop for a run
   *  the status still calls `running` after a Gateway drop. */
  paneRead(reading: OpenclawPaneReading): void {
    this.paneSeen = { at: Date.now(), changes: this.reader.changes, quiet: reading.ready && !reading.gatewayLost }
    this.keySought(reading.running)
    if (!this.normalizer.turnOpen) { this.readyPasses = 0; return }
    if (reading.gatewayLost) this.gatewayLost = true
    if (!reading.ready) { this.readyPasses = 0; return }
    if (++this.readyPasses >= READY_PASSES && this.gatewayLost) this.close('aborted')
  }

  /** Whether the next bind pass reads the pane (core/agents/bind.ts): it may show something the last one did not. */
  paneDue(): boolean {
    const seen = this.paneSeen
    return !seen || !seen.quiet || this.normalizer.turnOpen || seen.changes !== this.reader.changes
      || Date.now() - seen.at >= QUIET_PANE_MS
  }

  /** Times the passes that read a run while the store has no node for the key; a pass with no run, or a found key,
   *  starts the count again. */
  private keySought(running: boolean): void {
    if (this.reader.keyFound) {
      this.runWithoutKey = null
      if (this.sessionMissing) { this.sessionMissing = false; this.deps.onSessionFound?.() }
      return
    }
    // A store that cannot be read says nothing of the key: what it says instead is its own state (`onFatal`).
    if (!running || this.unreadable) { this.runWithoutKey = null; return }
    this.runWithoutKey ??= Date.now()
    if (this.sessionMissing || Date.now() - this.runWithoutKey < NO_SESSION_MS - PASS_JITTER_MS) return
    this.sessionMissing = true
    this.deps.onSessionMissing?.()
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
    if (out.some((event) => event.type === 'turn_started' || event.type === 'turn_ended')) this.reset()
    this.deps.onEvents(out)
  }

  /** What counts toward closing a turn is counted again for each turn. */
  private reset(): void {
    this.staleReads = this.readyPasses = 0
    this.gatewayLost = false
  }

  private headers(events: OpenclawEvent[]): void {
    for (const event of events) if (event.seq === 0 && event.record.type === 'session') this.deps.onHeader?.(event.record)
  }
}
