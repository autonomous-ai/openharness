/** Engine-owned parsers with core-owned checkpoints. No stream progresses until core pulls it. */
import { stat } from 'node:fs/promises'
import type { EngineLive, LiveParser, LiveTurn } from '../facets/live.js'
import type { LiveEvent } from '../kit/events.js'
import { isWholeRecord, locateAttachSpan, type AttachSpan } from '../../lib/attachTranscript.js'
import type { RuntimeField, RuntimeRecord } from '../facets/runtime.js'
import { streamRecords } from '../../lib/transcriptTail.js'
import { sameStamp, stampAt } from './liveFiles.js'
import { closeFileIdentity, replayCloses, verifyCloses } from '../../lib/transcriptControls.js'
import { LIVE_CACHE_SESSIONS, LIVE_HISTORY_BYTES, LIVE_PAGE_BYTES, type LiveCursor, type LiveFrame, type LivePage, type LiveSession,
  type LivePull, type LiveStamp } from './liveProtocol.js'

interface Stream {
  session: LiveSession
  parser: LiveParser
  span: AttachSpan
  turn: LiveTurn
  closed: LiveCursor['closed']
  cursor: LiveCursor | null
  lastStarted: LiveEvent | null
  head: boolean
  activation: { end: number; history: boolean } | null
  closeThrough(offset: number): void
  closes: string
}

/** Where a read found its file rewritten: the length then, and the bytes and file identity there. */
interface Rewrite { offset: number; device: number; inode: number; stamp: LiveStamp | null }

const emptySpan = (): AttachSpan => ({ end: 0, turnFrom: 0, profileFrom: 0, head: null, seeds: [] })
const sameCursor = (a: LiveCursor | null, b: LiveCursor | null): boolean => JSON.stringify(a) === JSON.stringify(b)
const binding = (s: LiveSession): string => JSON.stringify([s.agentId, s.sessionId, s.engine, s.transcriptPath, s.codexHome])
function changed(): never { throw new Error('ENGINE_TRANSCRIPT_CHANGED') }

export class LiveStreams {
  private readonly streams = new Map<string, Stream>()
  /**
   * Where each stream's read found its file rewritten, by the stream's token, until core forgets that token.
   * Core re-attaches a second later (core/engines/liveSessions.ts `retry`), and the file's end by then is
   * not where it was rewritten: the turn an agent ran in that second was folded into history and never
   * reached a client as a turn (e2e/bounded.e2e.ts, broken by #1019, found 2026-10-08). The legacy tailer
   * put the boundary where it noticed the rewrite (watcher.ts), and the re-attach puts it here.
   */
  private readonly rewrites = new Map<string, Rewrite>()
  constructor(private readonly adapter: EngineLive, private readonly fields: (session: LiveSession, raw: string) => readonly RuntimeField[],
    private readonly runtime?: (raw: string) => RuntimeRecord | null) {}

  private frame(frame: LiveFrame): LiveFrame {
    return this.runtime ? { ...frame, runtime: this.runtime(frame.raw) } : frame
  }

  forget(token: string, release = false): void {
    this.streams.delete(token)
    if (release) this.rewrites.delete(token)
  }

  /** The file as it is at `offset` now, or null when it cannot be read there. */
  private async at(file: string, offset: number): Promise<Rewrite | null> {
    try {
      const { dev, ino } = await stat(file)
      return { offset, device: dev, inode: ino, stamp: await stampAt(file, offset) }
    } catch { return null }
  }

  /** Whether the file has only grown since `rewrite` was noted: same file, same bytes at its boundary. */
  private async unchangedSince(file: string, rewrite: Rewrite): Promise<boolean> {
    const now = await this.at(file, rewrite.offset)
    return !!now && now.device === rewrite.device && now.inode === rewrite.inode && sameStamp(rewrite.stamp, now.stamp)
  }

  /**
   * Note where a read with a cursor found the file rewritten. Core keeps pulling with that cursor until
   * it re-attaches, and each pull finds the change again: the first one's boundary stands while the file
   * has only grown since, so the records appended after the rewrite stay live.
   */
  private async noteRewrite(ask: LivePull): Promise<void> {
    const file = ask.session.transcriptPath
    if (!file) return
    const known = this.rewrites.get(ask.token)
    if (known && await this.unchangedSince(file, known)) return
    let size: number
    try { size = (await stat(file)).size } catch { this.rewrites.delete(ask.token); return }
    const rewrite = await this.at(file, size)
    this.rewrites.delete(ask.token)
    if (!rewrite) return
    this.rewrites.set(ask.token, rewrite)
    // Bounded like the replies: one per stream core still holds, and core holds at most this many.
    if (this.rewrites.size > LIVE_CACHE_SESSIONS) this.rewrites.delete(this.rewrites.keys().next().value!)
  }

  /** Where a re-attach's history ends: where `rewrittenFrom`'s read found the rewrite, while that still holds. */
  private async rewriteBoundary(ask: LivePull): Promise<number | undefined> {
    const file = ask.session.transcriptPath
    const rewrite = ask.rewrittenFrom === undefined ? undefined : this.rewrites.get(ask.rewrittenFrom)
    return file && rewrite && await this.unchangedSince(file, rewrite) ? rewrite.offset : undefined
  }

  private ingest(stream: Stream, token: string, raw: string, offset: number): ReturnType<LiveParser['ingest']> {
    const before = stream.parser.snapshot().identity
    const result = stream.parser.ingest(raw)
    const after = stream.parser.snapshot()
    if (after.identity !== before) {
      stream.turn = { ...after, identity: `${token}:${offset.toString(36)}` }
      stream.closed = false
    } else {
      stream.turn = { ...after, identity: stream.turn.identity }
      if (after.turnOpen) stream.closed = false
    }
    for (const event of result.events) if (event.type === 'turn_started') stream.lastStarted = event
    return result
  }

  private async create(ask: LivePull): Promise<Stream> {
    const parser = this.adapter.create(ask.session)
    const stream: Stream = { session: { ...ask.session }, parser, span: emptySpan(),
      turn: { ...parser.snapshot(), identity: `${ask.token}:empty` }, closed: false,
      cursor: null, lastStarted: null, head: true, activation: null,
      closes: JSON.stringify(ask.closes ?? []), closeThrough: replayCloses(ask.closes ?? [], reason => {
        parser.closeTurn(reason)
        stream.closed = reason
        stream.turn = { ...stream.turn, turnOpen: false }
      }) }
    const file = ask.session.transcriptPath
    const boundary = !ask.cursor && ask.rewritten ? await this.rewriteBoundary(ask) : undefined
    if (!ask.cursor && (ask.liveStart || ask.rewritten)) {
      let end = 0
      try { if (file) end = (await stat(file)).size }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (boundary !== undefined) end = boundary
      if (ask.liveStart || end <= LIVE_HISTORY_BYTES) {
        stream.activation = { end, history: !!ask.rewritten }
        return stream
      }
    }
    if (!file) return stream
    const cursor = ask.cursor
    if (cursor && !sameStamp(cursor.stamp, await stampAt(file, cursor.offset, closeFileIdentity(ask.closes)))) changed()
    const end = cursor ? cursor.origin : ask.rewritten ? boundary : ask.end
    const rules = this.adapter.attachRules!((line) => this.fields(ask.session, line))
    try {
      stream.span = await locateAttachSpan(file, rules, { end, fromStart: ask.fromStart, closes: ask.closes })
        ?? changed()
      if (ask.closes?.length) stream.span.end = Math.min(end ?? Infinity, (await stat(file)).size)
    } catch (error) {
      // An announced path can precede its file. It is an empty stream only before any byte is accepted.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || (cursor && cursor.offset > 0)) throw error
    }
    parser.windowStart(stream.span.turnFrom)
    for (const seed of stream.span.seeds) this.ingest(stream, ask.token, seed, stream.span.turnFrom)
    if (cursor) {
      // Rebuild only through core's acknowledged position. No recovered event is delivered again.
      const start = Math.min(stream.span.turnFrom, cursor.offset)
      if (cursor.offset > start) {
        const read = await streamRecords(file, start, cursor.offset, (raw, offset) => {
          stream.closeThrough(offset)
          this.ingest(stream, ask.token, raw, offset)
        }, isWholeRecord, undefined, closeFileIdentity(ask.closes))
        if (!read || read.next !== cursor.offset) changed()
      }
      stream.closeThrough(cursor.offset)
      if (!sameStamp(cursor.stamp, await stampAt(file, cursor.offset, closeFileIdentity(ask.closes)))) changed()
      if (cursor.closed) parser.closeTurn(cursor.closed)
      stream.turn = { ...cursor.turn }
      stream.closed = cursor.closed
      stream.cursor = cursor
      stream.head = false
    }
    return stream
  }

  private async get(ask: LivePull): Promise<Stream> {
    let stream = this.streams.get(ask.token)
    if (!stream || binding(stream.session) !== binding(ask.session) || !sameCursor(stream.cursor, ask.cursor)
      || stream.closes !== JSON.stringify(ask.closes ?? [])) {
      stream = await this.create(ask)
      this.streams.set(ask.token, stream)
    }
    return stream
  }

  async pull(ask: LivePull): Promise<LivePage> {
    try {
      if (ask.session.transcriptPath && ask.closes) verifyCloses(ask.session.transcriptPath, ask.closes)
      const page = await this.read(ask)
      if (ask.session.transcriptPath && ask.closes) verifyCloses(ask.session.transcriptPath, ask.closes)
      return page
    } catch (error) {
      if (ask.cursor && error instanceof Error && error.message === 'ENGINE_TRANSCRIPT_CHANGED') await this.noteRewrite(ask)
      throw error
    }
  }

  private async read(ask: LivePull): Promise<LivePage> {
    const stream = await this.get(ask)
    const file = ask.session.transcriptPath
    if (!ask.cursor && stream.activation) {
      const { end, history } = stream.activation
      const cursor: LiveCursor = { serial: 1, origin: 0, offset: 0, turn: stream.turn, closed: false,
        prepareEnd: null, completeUntil: history ? null : end || null, stamp: null,
        ...(history && end > 0 ? { historyUntil: end } : {}) }
      stream.cursor = cursor
      return { frames: [], cursor, prepared: true, content: end > 0, more: false, records: 0,
        turnFrom: 0, profileFrom: 0, end, lastStarted: null }
    }
    const preparing = !ask.cursor || ask.cursor.prepareEnd !== null
    const start = ask.cursor?.offset ?? stream.span.profileFrom
    let end = preparing ? stream.span.end : start
    if (file) {
      if (ask.cursor && !sameStamp(ask.cursor.stamp, await stampAt(file, start, closeFileIdentity(ask.closes)))) changed()
      try { if (!preparing) end = ask.cursor?.completeUntil ?? (await stat(file)).size }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || start > 0) throw error }
    }
    if (end < start) changed()
    const frames: LiveFrame[] = []
    let bytes = 0
    let records = 0
    if (preparing && stream.head && stream.span.head !== null) {
      const raw = stream.span.head
      frames.push(this.frame({ raw, profile: true, observe: false, events: [], replay: false, turn: { ...stream.turn } }))
      bytes += Buffer.byteLength(raw)
    }
    stream.head = false
    let stopped = false
    const read = file && end > start ? await streamRecords(file, start, end, (raw, offset) => {
      stream.closeThrough(offset)
      const fold = !preparing || offset >= stream.span.turnFrom
      const result = fold ? this.ingest(stream, ask.token, raw, offset) : { events: [] }
      if (fold) records++
      const events = preparing && !ask.replay ? [] : result.events
      const frame = this.frame({ raw, profile: true, observe: fold, events, replay: offset < (ask.cursor?.historyUntil ?? 0), turn: { ...stream.turn },
        ...(!preparing && result.failure !== undefined ? { failure: result.failure } : {}) })
      frames.push(frame)
      // Account for normalized output as well as raw input. A large record occupies its own page;
      // the reply transport fragments it and enforces the independent hard result bound.
      bytes += Buffer.byteLength(raw) + Buffer.byteLength(JSON.stringify(events)) + Buffer.byteLength(JSON.stringify(frame.runtime ?? null))
      return stopped = bytes >= LIVE_PAGE_BYTES
    }, preparing || ask.cursor?.completeUntil != null ? isWholeRecord : () => false, undefined, closeFileIdentity(ask.closes)) : { next: start, partial: false, records: 0 }
    if (!read) changed()
    stream.closeThrough(read.next)
    const prepared = preparing && (!stopped || read.next >= end)
    const cursor: LiveCursor = { serial: (ask.cursor?.serial ?? 0) + 1, origin: ask.cursor?.origin ?? stream.span.end,
      offset: read.next, turn: { ...stream.turn }, closed: stream.closed,
      prepareEnd: preparing && !prepared ? end : null,
      completeUntil: stopped && read.next < end ? ask.cursor?.completeUntil ?? null : null,
      ...(ask.cursor?.historyUntil !== undefined && read.next < ask.cursor.historyUntil ? { historyUntil: ask.cursor.historyUntil } : {}),
      stamp: file ? await stampAt(file, read.next, closeFileIdentity(ask.closes)) : null }
    // Verify the old boundary again before publishing; a concurrent rewrite invalidates this page.
    if (file && ask.cursor && !sameStamp(ask.cursor.stamp, await stampAt(file, start, closeFileIdentity(ask.closes)))) changed()
    stream.cursor = cursor
    return { frames, cursor, ...(prepared ? { prepared: true } : {}), content: records > 0 || read.partial,
      more: stopped && read.next < end || ask.cursor?.completeUntil != null && cursor.completeUntil === null,
      records, turnFrom: stream.span.turnFrom, profileFrom: stream.span.profileFrom, end,
      lastStarted: prepared ? stream.lastStarted : null }
  }

  async close(ask: LivePull, identity: string, reason: Exclude<LiveCursor['closed'], false>): Promise<{ closed: boolean; cursor: LiveCursor }> {
    if (!ask.cursor) throw new Error('ENGINE_INVALID_REQUEST')
    const stream = await this.get(ask)
    if (stream.turn.identity !== identity || !stream.turn.turnOpen) return { closed: false, cursor: ask.cursor }
    stream.parser.closeTurn(reason)
    stream.closed = reason
    stream.turn = { ...stream.turn, turnOpen: false }
    stream.cursor = { ...ask.cursor, serial: ask.cursor.serial + 1, closed: reason, turn: stream.turn }
    return { closed: true, cursor: stream.cursor }
  }
}
