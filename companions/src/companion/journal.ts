/**
 * The pair journal: what happened to this machine's harnesses, so a brain that was not watching — the
 * laptop that slept, the computer you just sat down at — can be told afterwards (daemons/BRAIN.md).
 *
 * `ADAPTER_DATA_DIR/pair/journal.jsonl`, one entry per line, mode 0600 (it holds question text and
 * recaps). A RING: past `max` entries the oldest are dropped by rewriting the file. Every entry carries
 * the journal's `epoch` and a `seq` monotonic within it; a reader's cursor is that pair. A missing or
 * unreadable file starts a new epoch, and a cursor from another epoch is told `reset`.
 *
 * Nothing touches the disk until the journal is first used — pairing on — so a daemon with daemons off
 * (lib/daemonsSwitch.ts) never makes the folder or reads the file.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { PairJournalEntry, PairJournalPage } from './protocol.js'

export const JOURNAL_MAX = 2_000
/** A page is bounded: a brain catching up reads in pages, and one frame stays well under the relay's cap. */
export const JOURNAL_PAGE_MAX = 200

export interface PairJournalOptions {
  dir: string
  max?: number
  newEpoch?: () => string
}

export type JournalInput = Omit<PairJournalEntry, 'epoch' | 'seq'>

export class PairJournal {
  readonly path: string
  private readonly max: number
  private entries: PairJournalEntry[] = []
  private _epoch = ''
  private _seq = 0
  private opened = false

  constructor(private readonly opts: PairJournalOptions) {
    this.max = Math.max(10, opts.max ?? JOURNAL_MAX)
    this.path = join(opts.dir, 'journal.jsonl')
  }

  /** The folder and the file, on first use. */
  private open(): void {
    if (this.opened) return
    this.opened = true
    mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 })
    const loaded = this.load()
    if (loaded.length) {
      const last = loaded[loaded.length - 1]
      this._epoch = last.epoch
      // One epoch per file: lines from an earlier one (a file stitched by hand, a crash mid-rewrite) are
      // not this journal's and would make seq go backwards.
      this.entries = loaded.filter((entry) => entry.epoch === last.epoch).slice(-this.max)
      this._seq = last.seq
    } else {
      this._epoch = (this.opts.newEpoch ?? (() => randomBytes(6).toString('hex')))()
      if (existsSync(this.path)) this.rewrite()   // unreadable: start it over rather than append to garbage
    }
  }

  get epoch(): string { this.open(); return this._epoch }
  get seq(): number { this.open(); return this._seq }

  append(input: JournalInput): PairJournalEntry {
    this.open()
    const entry: PairJournalEntry = { epoch: this._epoch, seq: ++this._seq, ...input }
    this.entries.push(entry)
    if (this.entries.length > this.max * 1.25) {
      this.entries = this.entries.slice(-this.max)
      this.rewrite()
    } else {
      try {
        const fresh = !existsSync(this.path)
        appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
        if (fresh) chmodSync(this.path, 0o600)
      } catch (err) {
        console.warn(`[pair] journal append failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return entry
  }

  /**
   * Entries after a cursor. `{ epoch, seq }` reads on from there; `{ at }` reads from a time (the brief
   * asks "since you left"); nothing reads the ring from its start.
   */
  since(cursor: { epoch?: string; seq?: number; at?: number; limit?: number } = {}): PairJournalPage {
    this.open()
    const limit = Math.max(1, Math.min(JOURNAL_PAGE_MAX, cursor.limit ?? JOURNAL_PAGE_MAX))
    const page = (entries: PairJournalEntry[], extra: Partial<PairJournalPage> = {}): PairJournalPage =>
      ({ epoch: this._epoch, seq: this._seq, entries: entries.slice(0, limit), ...extra })
    if (typeof cursor.at === 'number') return page(this.entries.filter((entry) => entry.at >= cursor.at!))
    if (cursor.epoch === undefined || cursor.seq === undefined) return page(this.entries)
    if (cursor.epoch !== this._epoch) return page(this.entries, { reset: true })
    const after = this.entries.filter((entry) => entry.seq > cursor.seq!)
    const first = this.entries[0]?.seq ?? this._seq + 1
    return page(after, first > cursor.seq + 1 ? { truncated: true } : {})
  }

  /** Questions journaled and never answered — what was open before this daemon started. */
  openQuestions(): Map<string, PairJournalEntry> {
    this.open()
    const open = new Map<string, PairJournalEntry>()
    for (const entry of this.entries) {
      if (!entry.requestId) continue
      if (entry.kind === 'question') open.set(entry.requestId, entry)
      else if (entry.kind === 'answered') open.delete(entry.requestId)
    }
    return open
  }

  private load(): PairJournalEntry[] {
    let text: string
    try { text = readFileSync(this.path, 'utf8') } catch { return [] }
    const entries: PairJournalEntry[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as PairJournalEntry
        if (typeof entry?.epoch === 'string' && Number.isSafeInteger(entry.seq) && typeof entry.kind === 'string'
          && typeof entry.agentId === 'string' && typeof entry.at === 'number') entries.push(entry)
      } catch { /* a torn last line after a crash: skip it */ }
    }
    return entries
  }

  private rewrite(): void {
    try {
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, this.entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.path)
    } catch (err) {
      console.warn(`[pair] journal rewrite failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
