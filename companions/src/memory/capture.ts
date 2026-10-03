/** Incremental capture of host-registered native transcripts. Never scans another session's history. */
import { randomUUID } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'
import { z } from 'zod'
import { digest } from './admission.js'
import { decodeMemoryRecord } from './native.js'
import { OpenCodeMemoryCapture } from './opencodeCapture.js'
import type { MemoryPort } from './operations.js'
import { MemoryError, type SourceEvent } from './types.js'

export interface CaptureSession {
  profileId: string; projectId: string | null; engine: 'claude' | 'codex' | 'opencode'; sessionId: string
  /** Native JSONL or SQLite source, bound by the host, never copied from a model-supplied path. */
  transcriptPath: string
  /** Required for SQLite sources to verify native session identity against the host. */
  workspace?: string
  busy: boolean
  /** Host-observed fork/private-mode boundary. Copied older turns are not fresh user statements. */
  liveFrom?: number
}
export interface CaptureOutcome { state: 'captured' | 'idle' | 'learning_off' | 'source_changed' | 'unavailable'; sources: number; reason?: string }
const cursorSchema = z.object({ v: z.literal(1), f: z.string().length(24), o: z.number().int().nonnegative(), a: z.string().length(16),
  e: z.string().uuid().nullable(), l: z.number().int().nonnegative(), i: z.boolean(), s: z.boolean(),
  q: z.number().int().nonnegative().default(0),
  p: z.number().int().nonnegative().default(0),
  // This native turn has been split or has a gap. Later intact segments remain bounded context.
  g: z.boolean().default(false),
  n: z.number().int().nonnegative(), b: z.number().int().nonnegative() }).strict()
type Cursor = z.infer<typeof cursorSchema>
const FRAME_BYTES = 256 * 1024
const POLL_BYTES = 1024 * 1024

export class NativeMemoryCapture {
  private readonly active = new Map<string, Promise<CaptureOutcome>>()
  constructor(private readonly memory: MemoryPort, private readonly now: () => number = Date.now) {}

  poll(session: CaptureSession): Promise<CaptureOutcome> {
    // A native session cannot silently move its previous evidence into another project.
    const streamId = digest([session.profileId, session.engine, session.sessionId])
    const pending = this.active.get(streamId)
    if (pending) return pending
    const operation = (session.engine === 'opencode' ? new OpenCodeMemoryCapture(this.memory, this.now).poll(session, streamId)
      : this.read(session, streamId)).finally(() => this.active.delete(streamId))
    this.active.set(streamId, operation)
    return operation
  }

  private async read(session: CaptureSession, streamId: string): Promise<CaptureOutcome> {
    let handle: FileHandle | undefined
    let captured = 0
    try {
      const controls = await this.memory.request('capturePolicy', [session.projectId, session.engine, session.sessionId])
      if (!controls.learn) return { state: 'learning_off', sources: 0 }
      if (!controls.included) return { state: 'unavailable', sources: 0, reason: 'source_ineligible' }
      if (session.liveFrom !== undefined && (!Number.isSafeInteger(session.liveFrom) || session.liveFrom < 0)) throw new MemoryError('invalid_capture_boundary')
      const notBefore = Math.max(controls.learnSince ?? Infinity, session.liveFrom ?? 0, controls.liveFrom)
      handle = await open(session.transcriptPath, 'r')
      const stat = await handle.stat()
      if (!stat.isFile()) return { state: 'unavailable', sources: 0, reason: 'source_unavailable' }
      const identity = digest([stat.dev, stat.ino, stat.birthtimeMs]).slice(0, 24)
      let raw = await this.memory.request('cursor', [streamId])
      let cursor: Cursor | null = null
      if (raw) {
        try { cursor = cursorSchema.parse(JSON.parse(raw)) } catch { throw new MemoryError('capture_cursor_invalid') }
      }
      const base = { streamId, engine: session.engine, sessionId: session.sessionId, projectId: session.projectId, generation: controls.generation }
      const commit = async (next: Cursor, events: SourceEvent[] = [], boundary: 'open' | 'complete' | 'bounded' | 'incomplete' = 'open', episodeOverride?: string): Promise<void> => {
        const to = JSON.stringify(next)
        const episodeId = episodeOverride ?? cursor?.e ?? next.e
        if (raw === to && !events.length) return
        if (episodeId) await this.memory.request('capture', [{ ...base, from: raw, to, episodeId, events, boundary }])
        else await this.memory.request('checkpoint', [{ ...base, from: raw, to }])
        raw = to; cursor = next
      }
      const seal = async (boundary: 'complete' | 'bounded' | 'incomplete' = 'complete'): Promise<void> => {
        if (!cursor?.e) return
        const context = boundary === 'incomplete' || cursor.i ? 'incomplete' : boundary === 'bounded' || cursor.g ? 'bounded' : 'complete'
        await commit({ ...cursor, e: null, i: false, n: 0, b: 0, g: context !== 'complete' }, [], context)
      }
      if (cursor?.e && !await this.memory.request('episodeOpen', [streamId, cursor.e])) {
        // Keep the acknowledged byte position. A cancelled episode must never be replayed under
        // a new ID, nor prevent fresh native records from starting the next episode.
        const next = { ...cursor, e: null, i: false, n: 0, b: 0 }
        const to = JSON.stringify(next)
        await this.memory.request('checkpoint', [{ ...base, from: raw, to }])
        raw = to; cursor = next
      }
      const changed = cursor && (cursor.f !== identity || stat.size < cursor.o || await anchor(handle, cursor.o) !== cursor.a)
      const paused = cursor && (cursor.l !== controls.captureEpoch || cursor.q !== controls.sessionEpoch || cursor.p !== controls.projectEpoch)
      if (!cursor || changed || paused) {
        if (cursor?.e) await seal('incomplete')
        // New sessions start at byte zero. Enabling learning in an old conversation reads only its
        // recent tail, and the native timestamps below reject anything before consent.
        // Rewritten transcripts establish a new EOF baseline; replay is not new independent evidence.
        let start = changed ? stat.size : paused ? cursor!.o : stat.birthtimeMs >= (controls.learnSince ?? this.now()) ? 0 : Math.max(0, stat.size - FRAME_BYTES)
        if (!paused && start && start < stat.size) {
          const first = await frame(handle, start, stat.size, true)
          start = first?.end ?? stat.size
        }
        await commit({ v: 1, f: identity, o: start, a: await anchor(handle, start), e: null, l: controls.captureEpoch,
          q: controls.sessionEpoch, p: controls.projectEpoch, i: false, s: false, g: false, n: 0, b: 0 })
        if (changed) return { state: 'source_changed', sources: 0, reason: 'transcript_rewritten' }
      }
      if (!cursor) throw new MemoryError('capture_cursor_invalid')
      const start = cursor.o
      for (let lines = 0; lines < 128 && cursor.o < stat.size && cursor.o - start < POLL_BYTES; lines++) {
        const line = await frame(handle, cursor.o, stat.size, cursor.s)
        if (!line) break // A partial UTF-8/JSON record is left intact for the next append.
        const record = line.text === null ? { parts: [], ended: false, incomplete: true } : line.text.trim()
          ? decodeMemoryRecord(session.engine as 'claude' | 'codex', line.text) : { parts: [], ended: false, incomplete: false }
        const events: SourceEvent[] = record.parts.filter(part => part.observedAt >= notBefore).map(part => {
          const id = digest([session.profileId, session.engine, session.sessionId, part.nativeEventId])
          return { ...part, id, profileId: session.profileId, projectId: session.projectId, engine: session.engine,
            sessionId: session.sessionId, rootIds: [id], eligibility: 'coding' }
        })
        const bytes = events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0)
        if (bytes > 90_000) { events.length = 0; record.incomplete = true }
        // Keep unreadable records in their own incomplete episode. Never let one large tool
        // result discard every intact user instruction before or after it in a long native turn.
        if (cursor.e && !cursor.i && record.incomplete) await seal('bounded')
        if (cursor.e && cursor.i && !record.incomplete && (events.length || record.ended)) await seal('incomplete')
        if (cursor.e && (cursor.n + events.length > 128 || cursor.b + bytes > 90_000)) await seal('bounded')
        const episode = cursor.e ?? (events.length || record.incomplete ? randomUUID() : null)
        const next: Cursor = { ...cursor, o: line.end, a: await anchor(handle, line.end), s: line.continued,
          e: episode, i: cursor.i || record.incomplete, g: cursor.g || record.incomplete,
          n: cursor.n + events.length, b: cursor.b + (events.length ? bytes : 0) }
        const ended = record.ended && episode !== null
        await commit(record.ended ? { ...next, e: null, i: false, g: false, n: 0, b: 0 } : next, events,
          ended ? next.i ? 'incomplete' : next.g ? 'bounded' : 'complete' : next.i ? 'incomplete' : 'open', episode ?? undefined)
        captured += events.length
      }
      // Native Claude transcripts sometimes rely on a Stop hook instead of a final stop_reason.
      // The host's settled state plus an unchanged file closes that episode without inventing a reply.
      const after = await handle.stat()
      if (cursor.e && cursor.o === after.size && !cursor.s && !session.busy && this.now() - after.mtimeMs >= 5_000) {
        await seal()
        await commit({ ...cursor, g: false })
      }
      return { state: captured ? 'captured' : 'idle', sources: captured }
    } catch (error) {
      return { state: 'unavailable', sources: captured, reason: error instanceof MemoryError ? error.code : 'source_unavailable' }
    } finally { await handle?.close().catch(() => {}) }
  }
}

async function anchor(handle: FileHandle, offset: number): Promise<string> {
  const buffer = Buffer.alloc(Math.min(offset, 64))
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset - buffer.length)
  return digest(buffer.subarray(0, bytesRead).toString('base64')).slice(0, 16)
}

/** Bounded reads, byte-accurate cursors, and no decoding across an unfinished UTF-8 line. */
async function frame(handle: FileHandle, offset: number, end: number, skipping: boolean): Promise<{ end: number; text: string | null; continued: boolean } | null> {
  let position = offset
  const parts: Buffer[] = []
  while (position < end && position - offset < FRAME_BYTES) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - position, FRAME_BYTES - (position - offset)))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    if (!bytesRead) return null
    const chunk = buffer.subarray(0, bytesRead)
    const newline = chunk.indexOf(10)
    if (newline !== -1) {
      if (!skipping) parts.push(chunk.subarray(0, newline))
      return { end: position + newline + 1, text: skipping ? null : Buffer.concat(parts).toString('utf8').replace(/\r$/, ''), continued: false }
    }
    if (!skipping) parts.push(chunk)
    position += bytesRead
  }
  return position - offset >= FRAME_BYTES || skipping
    ? { end: position, text: null, continued: true } : null
}
