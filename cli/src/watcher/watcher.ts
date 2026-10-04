/** Registration-driven JSONL tailer. It watches only transcript files already admitted by the
 * tmux-backed registry, so inactive Claude/Codex history is never discovered or exposed. */

import { EventEmitter } from 'events'
import chokidar, { type FSWatcher } from 'chokidar'
import { open, readFile, stat } from 'fs/promises'
import { basename, dirname } from 'path'
import type { AgentEngine } from '../engines/types.js'

export interface WatchedSession {
  sessionId: string
  engine: AgentEngine
  transcriptPath: string
}

export interface LineEvent {
  sessionId: string
  engine: AgentEngine
  projectDir: string
  text: string
  seq: number
  ts: number
}

/**
 * Lines that were ALREADY ON DISK when this tail started reading them — a `fromStart` attach of a file
 * with content, or a re-read after the file shrank under us. They are emitted as one batch, on
 * `'history'` rather than `'line'`, because the consumer has to know where the batch ENDS: everything in
 * it is the past except a turn still open at its last line, and only the whole batch can say which.
 * Measured on prod (2026-09-17): one agent's 42 turns landed in the same second, all of them re-reads of
 * prompts already answered — counted as 42 turns started that day.
 */
export interface HistoryEvent {
  sessionId: string
  engine: AgentEngine
  lines: LineEvent[]
}

/** A tailed session's delivery, held by an attach (see `Watcher.hold`). */
export interface TailHold {
  /** The byte the next undelivered line starts at. */
  readonly offset: number
  /** The hold let go on its own after its timeout: delivery resumed into whatever it was feeding, from
   *  where it had stopped, and a later `release` changes nothing. */
  readonly expired: boolean
  /** Resume delivery — from `offset` when given (where the caller's own read stopped), unless the tail
   *  was moved under the hold (`setTail`), whose position then stands. Idempotent. */
  release(offset?: number | null): void
}

/** A transcript rewritten in place with more history than one batch should hold — a long one whose
 *  owner rewrote it. The tail now starts at its new end; the session's state is rebuilt by attaching it
 *  again, from its end. */
export interface RewrittenEvent {
  sessionId: string
  engine: AgentEngine
  transcriptPath: string
}

/** How much the tail reads at once: a tail that fell behind reads its backlog a chunk at a time, never
 *  in one buffer as large as everything appended since. */
export const READ_CHUNK_BYTES = 8 * 1024 * 1024
/** The most history replayed as one batch. A file that shrank to more than this is attached again. */
export const HISTORY_MAX_BYTES = 32 * 1024 * 1024

/** The longest a session's live delivery may stay held. An attach still running by then lets it go
 *  (`TailHold.expired`) and must keep the normalizer delivery went back to. */
export const HOLD_TIMEOUT_MS = 30_000

interface FileState extends WatchedSession {
  offset: number
  /** Bytes below this were on disk before the current read cursor was placed — history, not live. */
  historicalUntil: number
  /** The end of the file not yet ending in a newline: raw bytes, decoded only once the line is whole,
   *  so a character split between two reads is not mangled and positions stay byte-exact. Kept as the
   *  pieces read, joined once when the line ends: a long line is not copied again at every read. */
  partial: Buffer[]
  partialBytes: number
  seq: number
  debounce: NodeJS.Timeout | null
  reading: boolean
  pending: boolean
  /** Attaches holding delivery (see `hold`); nothing is read while any does. */
  holds: Set<TailHold>
  /** Settled when the last hold is released: what a drain waits on. */
  unheld: Promise<void> | null
  settleUnheld: (() => void) | null
  /** How many times `setTail` moved the tail: a hold taken before a move cannot put it back. */
  moves: number
  cursorLines: string[]
}

const DEBOUNCE_MS = 40

export class Watcher extends EventEmitter {
  private watcher: FSWatcher | null = null
  private files = new Map<string, FileState>()
  private bySession = new Map<string, string>()

  private readonly readChunkBytes: number
  private readonly historyMaxBytes: number
  private readonly openFile: (filePath: string) => ReturnType<typeof open>

  /** `openFile` is how a transcript is opened for reading: swapped in tests for one cut short as it is read. */
  constructor(options: { readChunkBytes?: number; historyMaxBytes?: number; openFile?: (filePath: string) => ReturnType<typeof open> } = {}) {
    super()
    this.readChunkBytes = options.readChunkBytes ?? READ_CHUNK_BYTES
    this.historyMaxBytes = options.historyMaxBytes ?? HISTORY_MAX_BYTES
    this.openFile = options.openFile ?? ((filePath) => open(filePath, 'r'))
  }

  start(): void {
    if (this.watcher) return
    this.watcher = chokidar.watch([], { ignoreInitial: false, alwaysStat: true })
    this.watcher
      .on('add', (filePath: string) => this.schedule(filePath))
      .on('change', (filePath: string) => { this.noteChange(filePath); this.schedule(filePath) })
      .on('unlink', (filePath: string) => {
        const state = this.files.get(filePath)
        if (state) state.pending = true // keep registration; a rotate/recreate may follow
      })
      .on('error', (err: unknown) => console.error('[watcher] error:', err))
    if (this.files.size) this.watcher.add([...this.files.keys()])
  }

  /** Attach one trusted transcript. Runtime hydration is handled by cli.ts; the tail starts at EOF, or at
   *  `fromOffset` — where that hydration stopped reading — so a record written while it read is tailed
   *  rather than lost between the two. */
  async addSession(session: WatchedSession, opts: { fromStart?: boolean; fromOffset?: number } = {}): Promise<void> {
    const oldPath = this.bySession.get(session.sessionId)
    if (oldPath && oldPath !== session.transcriptPath) await this.removeSession(session.sessionId)

    let offset = 0
    let cursorLines: string[] = []
    let size = 0
    try { size = (await stat(session.transcriptPath)).size } catch { size = 0 }
    if (!opts.fromStart) {
      // A file that shrank since is a rewrite; its tail starts at the new end, as without an offset.
      offset = opts.fromOffset !== undefined && opts.fromOffset <= size ? opts.fromOffset : size
      if (session.engine === 'cursor') {
        try { cursorLines = completeLines(await readFile(session.transcriptPath, 'utf8')) } catch { cursorLines = [] }
      }
    }
    const existing = this.files.get(session.transcriptPath)
    if (existing) {
      existing.engine = session.engine
      existing.sessionId = session.sessionId
      this.bySession.set(session.sessionId, session.transcriptPath)
      return
    }
    // Two rounds of "the CLI accepted it but the adapter never saw the line" were spent guessing whether
    // this registration had happened at all. Say it once per file, with the offset it starts from.
    console.log(`[watcher] tail ${session.engine} ${session.sessionId.slice(0, 8)} @${offset} · ${session.transcriptPath}`)
    this.files.set(session.transcriptPath, {
      ...session,
      offset,
      // A `fromStart` tail of a file that already has content reads that content as history.
      historicalUntil: opts.fromStart ? size : 0,
      partial: [],
      partialBytes: 0,
      seq: 0,
      debounce: null,
      reading: false,
      pending: false,
      holds: new Set(),
      unheld: null,
      settleUnheld: null,
      moves: 0,
      cursorLines,
    })
    this.bySession.set(session.sessionId, session.transcriptPath)
    this.watcher?.add(session.transcriptPath)
    if (opts.fromStart || offset < size) this.schedule(session.transcriptPath)
  }

  /**
   * Stop delivering a tailed session's lines from `transcriptPath`, and say where delivery stopped: the
   * byte its next line starts at. Waits out a read already in progress. Null when that file is not the
   * one being tailed for the session.
   *
   * A re-attach rebuilds the session's normalizer from the transcript while the old one is still the
   * one being fed. Holding the tail is what lets it read exactly up to where the old one stopped and
   * hand everything after that to the new one: a line written meanwhile is neither lost to the
   * normalizer being replaced nor read twice. Every hold must be released. One held past `timeoutMs`
   * lets go on its own and says so (`expired`), so a stream is never frozen for good; the attach that
   * held it must then keep the normalizer delivery resumed into, which has seen every line since.
   */
  async hold(sessionId: string, transcriptPath: string, timeoutMs = HOLD_TIMEOUT_MS): Promise<TailHold | null> {
    const state = this.bySession.get(sessionId) === transcriptPath ? this.files.get(transcriptPath) : undefined
    if (!state) return null
    if (!state.holds.size) state.unheld = new Promise((resolve) => { state.settleUnheld = resolve })
    if (state.debounce) { clearTimeout(state.debounce); state.debounce = null }
    const moves = state.moves
    let offset = 0
    let released = false
    let expired = false
    const release = (to: number | null = null): void => {
      if (released) return
      released = true
      clearTimeout(timer)
      state.holds.delete(hold)
      if (to !== null && state.moves === moves) {
        state.offset = to
        state.partial = []
        state.partialBytes = 0
      }
      if (state.holds.size) return
      state.settleUnheld?.()
      state.unheld = null
      state.settleUnheld = null
      if (this.files.get(transcriptPath) === state) this.schedule(transcriptPath)
    }
    // Counted from the request: an attach that never lets go is hung however long its read took.
    const timer = setTimeout(() => {
      console.warn(`[watcher] ${sessionId.slice(0, 8)} held for ${timeoutMs} ms — letting its tail go`)
      expired = true
      release()
    }, timeoutMs)
    timer.unref()
    const hold: TailHold = {
      get offset() { return offset },
      get expired() { return expired },
      release,
    }
    state.holds.add(hold)
    while (state.reading) await new Promise((resolve) => setTimeout(resolve, 5))
    offset = state.offset - state.partialBytes
    return hold
  }

  /** Whether `transcriptPath` is the file being tailed for the session. */
  tails(sessionId: string, transcriptPath: string): boolean {
    return this.bySession.get(sessionId) === transcriptPath && this.files.has(transcriptPath)
  }

  /** Move a byte-tailed session's read cursor to a known length after the file was rewritten in place
   *  by a trusted producer (e.g. the Codex resume reasoning-id repair). The repair shrinks the rollout
   *  mid-history; left alone, the next read would see `size < offset`, treat it as a truncation, reset
   *  to 0 and re-emit the whole conversation into the live normalizer. Pinning the offset to the new
   *  length keeps the invariant that every line is emitted exactly once. No-op when the session is not
   *  registered (the post-reboot restore path repairs before it re-attaches, so there is nothing to
   *  move). Call synchronously in the same tick as the rewrite, before the producer appends again. */
  setTail(sessionId: string, offset: number): void {
    const filePath = this.bySession.get(sessionId)
    if (!filePath) return
    const state = this.files.get(filePath)
    if (!state) return
    if (state.debounce) { clearTimeout(state.debounce); state.debounce = null }
    state.offset = offset
    state.partial = []
    state.partialBytes = 0
    // An attach holding the tail read the file as it was; where it stopped is no position in this one.
    state.moves++
  }

  async removeSession(sessionId: string): Promise<void> {
    const filePath = this.bySession.get(sessionId)
    if (!filePath) return
    this.bySession.delete(sessionId)
    const state = this.files.get(filePath)
    if (state?.debounce) clearTimeout(state.debounce)
    // Nothing is left to drain: a drain waiting for a hold here is done.
    state?.settleUnheld?.()
    this.files.delete(filePath)
    await this.watcher?.unwatch(filePath)
  }

  async stop(): Promise<void> {
    for (const state of this.files.values()) {
      if (state.debounce) clearTimeout(state.debounce)
      state.settleUnheld?.()
    }
    this.files.clear()
    this.bySession.clear()
    if (this.watcher) await this.watcher.close()
    this.watcher = null
  }

  /** Re-read every registered file to EOF. Used by the low-frequency full reconciliation pass. */
  async pollAll(): Promise<void> {
    await Promise.all([...this.files.keys()].map(async (filePath) => {
      await this.readNew(filePath)
      // A chokidar read may already own this file. readNew() marks it pending in that case;
      // wait for the owner to finish its pending pass so reconciliation really reaches EOF.
      while (this.files.get(filePath)?.reading) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }))
  }

  /** Deliver everything on disk now. A hold stops delivery where it is until its attach lets go —
   *  whether it landed before this drain or during its read — so the drain waits for it and reads on,
   *  until nothing holds the tail and no read asked for is left undone. */
  async pollSession(sessionId: string): Promise<void> {
    const filePath = this.bySession.get(sessionId)
    if (!filePath) return
    for (let state = this.files.get(filePath); state; state = this.files.get(filePath)) {
      if (state.unheld) { await state.unheld; continue }
      await this.readNew(filePath)
      while (state.reading) await new Promise((resolve) => setTimeout(resolve, 10))
      if (!state.holds.size && !state.pending) return
    }
  }

  /** Chokidar told us the file moved. Logged for commandcode/devin only, whose whole turn lifecycle rides
   *  on these reads — for claude the hooks say the same thing and this would just be noise. */
  private noteChange(filePath: string): void {
    const state = this.files.get(filePath)
    if (state && (state.engine === 'commandcode' || state.engine === 'devin')) {
      console.log(`[watcher] change ${state.engine} ${state.sessionId.slice(0, 8)} @${state.offset}`)
    }
  }

  private schedule(filePath: string): void {
    const state = this.files.get(filePath)
    if (!state) return
    if (state.debounce) clearTimeout(state.debounce)
    state.debounce = setTimeout(() => {
      state.debounce = null
      void this.readNew(filePath)
    }, DEBOUNCE_MS)
  }

  private async readNew(filePath: string): Promise<void> {
    const state = this.files.get(filePath)
    if (!state) return
    if (state.reading || state.holds.size) { state.pending = true; return }
    state.reading = true
    try {
      do {
        state.pending = false
        await this.readOnce(filePath, state)
        // A hold taken during this read stops it here; `release` reads what is left.
      } while (state.pending && !state.holds.size && this.files.get(filePath) === state)
    } finally {
      state.reading = false
    }
  }

  private async readOnce(filePath: string, state: FileState): Promise<void> {
    if (state.engine === 'cursor') {
      await this.readCursor(filePath, state)
      return
    }
    let size: number
    try { size = (await stat(filePath)).size } catch { return }
    if (size < state.offset) {
      state.partial = []
      state.partialBytes = 0
      if (size > this.historyMaxBytes) {
        // Too much to replay as one batch of history: the tail starts at the new end, and the session is
        // attached again, which reads what it needs from that end (lib/attachTranscript.ts).
        state.offset = size
        state.historicalUntil = 0
        this.emit('rewritten', { sessionId: state.sessionId, engine: state.engine, transcriptPath: filePath } satisfies RewrittenEvent)
        return
      }
      // The file shrank: rewritten in place (or recreated). Whatever it holds now is read from byte 0,
      // and none of it is new to the world — it is history until the write that grows it past this.
      state.offset = 0
      state.historicalUntil = size
    }
    if (size <= state.offset) return

    const history: LineEvent[] = []
    try {
      const fh = await this.openFile(filePath)
      try {
        while (state.offset < size) {
          const start = state.offset
          const chunk = Buffer.alloc(Math.min(this.readChunkBytes, size - start))
          const { bytesRead } = await fh.read(chunk, 0, chunk.length, start)
          if (!bytesRead) break
          state.offset = start + bytesRead
          this.takeChunk(filePath, state, chunk.subarray(0, bytesRead), start, history)
          // A hold taken meanwhile stops the read here; `release` reads what is left.
          if (state.holds.size) break
        }
      } finally {
        await fh.close()
      }
    } catch (err) {
      console.error(`[watcher] read failed (${basename(filePath)}):`, err)
    }
    if (history.length) this.flushHistory(state, history)
  }

  /**
   * Lines are cut on the newline BYTE and decoded only once whole. Each line's byte position tells the
   * historical prefix of a read from its live rest: a file appended to between the cursor being placed
   * and this read has both. A line carried over from the last chunk began `partialBytes` before `start`.
   */
  private takeChunk(filePath: string, state: FileState, chunk: Buffer, start: number, history: LineEvent[]): void {
    let lineStart = 0
    for (let newline = chunk.indexOf(10); newline >= 0; newline = chunk.indexOf(10, lineStart)) {
      const linePos = lineStart === 0 ? start - state.partialBytes : start + lineStart
      const piece = chunk.subarray(lineStart, newline)
      const bytes = state.partial.length ? Buffer.concat([...state.partial, piece]) : piece
      state.partial = []
      state.partialBytes = 0
      lineStart = newline + 1
      const text = bytes.toString('utf8').replace(/\r$/, '')
      if (!text.trim()) continue
      const evt: LineEvent = {
        sessionId: state.sessionId,
        engine: state.engine,
        projectDir: basename(dirname(filePath)),
        text,
        seq: state.seq++,
        ts: Date.now(),
      }
      if (linePos < state.historicalUntil) { history.push(evt); continue }
      if (history.length) this.flushHistory(state, history)
      this.emit('line', evt)
    }
    if (lineStart < chunk.length) {
      // A copy of a chunk's tail, so the rest of the chunk is not kept for it; a chunk that is all one
      // line is kept as read.
      state.partial.push(lineStart ? Buffer.from(chunk.subarray(lineStart)) : chunk)
      state.partialBytes += chunk.length - lineStart
    }
  }

  private flushHistory(state: FileState, lines: LineEvent[]): void {
    this.emit('history', { sessionId: state.sessionId, engine: state.engine, lines: lines.splice(0) } satisfies HistoryEvent)
  }

  private async readCursor(filePath: string, state: FileState): Promise<void> {
    let next: string[]
    try { next = completeLines(await readFile(filePath, 'utf8')) } catch { return }
    let common = 0
    while (common < state.cursorLines.length && common < next.length && state.cursorLines[common] === next[common]) common++
    state.cursorLines = next
    state.offset = 0
    state.partial = []
    state.partialBytes = 0
    state.historicalUntil = 0
    // `completeLines` has already dropped blank lines.
    for (const text of next.slice(common)) {
      this.emit('line', {
        sessionId: state.sessionId,
        engine: state.engine,
        projectDir: basename(dirname(filePath)),
        text,
        seq: state.seq++,
        ts: Date.now(),
      } satisfies LineEvent)
    }
  }
}

function completeLines(content: string): string[] {
  const lines = content.split('\n')
  if (!content.endsWith('\n')) lines.pop()
  return lines.map((line) => line.replace(/\r$/, '')).filter((line) => line.trim())
}
