/** Incremental capture of a single host-registered OpenCode SQLite conversation. */
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { digest } from './admission.js'
import type { CaptureOutcome, CaptureSession } from './capture.js'
import type { MemoryPort } from './operations.js'
import { decodeOpenCodeMemoryMessage, openCodeMessageSettled, type OpenCodeSourceMessage } from './opencodeSource.js'
import { openCodeMemoryTail, readOpenCodeMemoryMessage, readOpenCodeMemorySession } from './opencodeRead.js'
import { MemoryError, type SourceEvent } from './types.js'

const integer = z.number().int().nonnegative().safe()
const cursorSchema = z.object({ v: z.literal(2), f: z.string().length(24), t: integer,
  m: z.string().max(64).regex(/^[A-Za-z0-9_]*$/), a: z.string().length(16), e: z.string().uuid().nullable(),
  l: integer, q: integer, p: integer, g: z.boolean(), n: integer, b: integer }).strict()
type Cursor = z.infer<typeof cursorSchema>
type Boundary = 'open' | 'complete' | 'bounded' | 'incomplete'
function anchor(message: OpenCodeSourceMessage | null): string {
  // Later replies change settlement, not the already acknowledged source payload.
  return digest(message && [message.id, message.created, message.updated, message.data, message.parts]).slice(0, 16)
}

export class OpenCodeMemoryCapture {
  constructor(private readonly memory: MemoryPort, private readonly now: () => number = Date.now) {}

  /** NativeMemoryCapture serializes calls per owner/engine/session, including this adapter. */
  async poll(session: CaptureSession, streamId: string): Promise<CaptureOutcome> {
    let captured = 0
    try {
      const controls = await this.memory.request('capturePolicy', [session.projectId, session.engine, session.sessionId])
      if (!controls.learn) return { state: 'learning_off', sources: 0 }
      if (!controls.included) return { state: 'unavailable', sources: 0, reason: 'source_ineligible' }
      if (!session.workspace || !isAbsolute(session.workspace) || !isAbsolute(session.transcriptPath)) throw new MemoryError('source_ineligible')
      if (session.liveFrom !== undefined && !integer.safeParse(session.liveFrom).success) throw new MemoryError('invalid_capture_boundary')
      const native = await readOpenCodeMemorySession(session.transcriptPath, session.sessionId)
      if (native.parent_id || await realpath(native.directory) !== await realpath(session.workspace)) throw new MemoryError('source_ineligible')
      // Forks mint fresh row IDs and SQL timestamps but retain message.time.created. Neither
      // a copied fork nor a generated compaction summary is independent personal evidence.
      const notBefore = Math.max(controls.learnSince ?? Infinity, controls.liveFrom, session.liveFrom ?? 0, native.time_created)
      const source = await stat(session.transcriptPath)
      if (!source.isFile()) throw new MemoryError('source_unavailable')
      const identity = digest([source.dev, source.ino, source.birthtimeMs, native.time_created, native.directory]).slice(0, 24)
      let raw = await this.memory.request('cursor', [streamId])
      let cursor: Cursor | null = null
      if (raw) {
        try { cursor = cursorSchema.parse(JSON.parse(raw)) } catch { throw new MemoryError('capture_cursor_invalid') }
      }
      const base = { streamId, engine: session.engine, sessionId: session.sessionId, projectId: session.projectId, generation: controls.generation }
      const commit = async (next: Cursor, events: SourceEvent[] = [], boundary: Boundary = 'open', episode?: string): Promise<void> => {
        const to = JSON.stringify(next), episodeId = episode ?? cursor?.e ?? next.e
        if (raw === to && !events.length) return
        if (episodeId) await this.memory.request('capture', [{ ...base, from: raw, to, episodeId, events, boundary }])
        else await this.memory.request('checkpoint', [{ ...base, from: raw, to }])
        raw = to; cursor = next
      }
      const seal = async (boundary: Exclude<Boundary, 'open'>): Promise<void> => {
        if (!cursor?.e) return
        await commit({ ...cursor, e: null, n: 0, b: 0, g: true }, [], boundary === 'complete' && cursor.g ? 'bounded' : boundary)
      }
      if (cursor?.e && !await this.memory.request('episodeOpen', [streamId, cursor.e])) {
        const next = { ...cursor, e: null, n: 0, b: 0, g: true }, to = JSON.stringify(next)
        await this.memory.request('checkpoint', [{ ...base, from: raw, to }]); cursor = next; raw = to
      }
      const replaced = cursor && cursor.f !== identity
      const paused = cursor && (cursor.l !== controls.captureEpoch || cursor.q !== controls.sessionEpoch || cursor.p !== controls.projectEpoch)
      if (!cursor || replaced || paused) {
        if (cursor?.e) await seal('incomplete')
        const position = replaced ? await openCodeMemoryTail(session.transcriptPath, session.sessionId)
          : cursor ? { t: cursor.t, m: cursor.m } : { t: Math.max(0, notBefore - 1), m: '' }
        const last = position.m ? await readOpenCodeMemoryMessage(session.transcriptPath, session.sessionId, { id: position.m }) : null
        await commit({ v: 2, f: identity, ...position, a: anchor(last), e: null,
          l: controls.captureEpoch, q: controls.sessionEpoch, p: controls.projectEpoch, g: true, n: 0, b: 0 })
        if (replaced) return { state: 'source_changed', sources: 0, reason: 'native_store_replaced' }
      }
      if (!cursor) throw new MemoryError('capture_cursor_invalid')
      // Native undo removes messages/parts after a boundary. Wait for its cleanup; do not copy a
      // reverted tail, reset the high-water mark, or lose the next fresh instruction after undo.
      if (native.revert) {
        await seal('incomplete')
        return { state: 'unavailable', sources: 0, reason: 'native_session_reverted' }
      }
      if (cursor.m) {
        const last = await readOpenCodeMemoryMessage(session.transcriptPath, session.sessionId, { id: cursor.m })
        if (anchor(last) !== cursor.a) {
          await seal('incomplete')
          await commit({ ...cursor, a: anchor(last), g: true })
          return { state: 'source_changed', sources: 0, reason: 'native_message_rewritten' }
        }
      }
      let bytesRead = 0
      for (let count = 0; count < 16 && bytesRead < 1024 * 1024; count++) {
        const message = await readOpenCodeMemoryMessage(session.transcriptPath, session.sessionId, cursor)
        if (!message) {
          // Native completion normally closes the episode. An interrupted/crashed process has
          // only bounded context; inactivity must never manufacture a completed assistant turn.
          if (cursor.e && !session.busy) await seal('bounded')
          break
        }
        if (!openCodeMessageSettled(message, session.busy, this.now())) break
        bytesRead += Buffer.byteLength(JSON.stringify(message))
        const record = decodeOpenCodeMemoryMessage(message)
        const position = { t: message.created, m: message.id, a: anchor(message) }
        if (record.observedAt !== null && record.observedAt < notBefore) {
          await seal('incomplete')
          await commit({ ...cursor, ...position, g: true })
          continue
        }
        const guard = await readOpenCodeMemorySession(session.transcriptPath, session.sessionId)
        const current = await stat(session.transcriptPath)
        if (guard.revert || guard.parent_id || guard.directory !== native.directory || guard.time_created !== native.time_created
          || current.ino !== source.ino || current.dev !== source.dev) throw new MemoryError('source_changed')
        if (record.compacted) {
          await seal('bounded')
          await commit({ ...cursor, ...position, g: true })
          continue
        }
        const events: SourceEvent[] = []
        let bytes = 0
        for (const part of record.parts) {
          const id = digest([session.profileId, session.engine, session.sessionId, part.nativeEventId])
          const event: SourceEvent = { ...part, id, profileId: session.profileId, projectId: session.projectId,
            engine: session.engine, sessionId: session.sessionId, rootIds: [id], eligibility: 'coding' }
          const size = Buffer.byteLength(JSON.stringify(event))
          if (events.length >= 64 || bytes + size > 90_000) { record.incomplete = true; continue }
          events.push(event); bytes += size
        }
        if (cursor.e && (record.started || record.incomplete || cursor.n + events.length > 128 || cursor.b + bytes > 90_000)) await seal('bounded')
        const gap = (record.started ? false : cursor.g) || record.incomplete
        const episode = cursor.e ?? (events.length ? randomUUID() : null)
        const next: Cursor = { ...cursor, ...position, e: episode, g: gap, n: cursor.n + events.length, b: cursor.b + bytes }
        const close = record.ended || record.incomplete
        await commit(close ? { ...next, e: null, n: 0, b: 0, g: true } : next, events,
          close ? gap ? 'bounded' : 'complete' : 'open', episode ?? undefined)
        captured += events.length
      }
      return { state: captured ? 'captured' : 'idle', sources: captured }
    } catch (error) {
      return { state: 'unavailable', sources: captured, reason: error instanceof MemoryError ? error.code : 'source_unavailable' }
    }
  }
}
