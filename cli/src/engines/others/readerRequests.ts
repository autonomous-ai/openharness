/**
 * The other engines' history and last turn on their worker's link: the private reader methods Claude Code's and
 * Codex's workers answer (engines/worker/process.ts), at the same version, for any of the fourteen engines, which each
 * read names. Only the core's own call reaches them: they are no client's route.
 *
 * Two things differ from those workers, because one process serves fourteen engines and their conversations have no
 * pages of their own (or none for some asks):
 *
 * - A reply past one frame of the link is kept and taken in parts (`READER_PART`): one of their histories can be a
 *   conversation's whole replay, which the core used to send on as it was.
 * - A read past its deadline is answered unavailable and keeps its place until it ends: recycling the worker for it,
 *   as Claude Code's and Codex's do, would fail every other engine's reads with it. Only a read still running a minute
 *   past its deadline is stuck, and recycles the worker, said in the log.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { ServiceRequests } from '../../core/api.js'
import type { EngineTranscript, TranscriptSession } from '../facets/transcript.js'
import { isOtherEngine, readWaitMs, type OtherEngine } from '../otherEngines.js'
import {
  EngineReadError, record, READER_HISTORY, READER_IN_FLIGHT, READER_LAST_TURN, READER_PART, READER_PART_BYTES,
  READER_PARTED_BYTES, READER_REPLY_BYTES, READER_VERSION, type ReaderErrorCode,
} from '../worker/protocol.js'
import { askOf, readerPath } from '../worker/readerChecks.js'
import { otherTranscriptFor } from './transcripts.js'

/** All fourteen engines' reads at once in the one worker; each engine holds at most `READER_IN_FLIGHT` of them. */
export const OTHER_READS_IN_FLIGHT = 16
/** How long past its deadline a read may still run before it counts as stuck. */
export const OTHER_READ_STUCK_MS = 60_000
/** Replies kept for the core to take in parts: a few at once, bounded in bytes, the oldest dropped first. */
const KEPT_REPLIES = 4
const KEPT_BYTES = 2 * READER_PARTED_BYTES

/** The read's engine and the snapshot it reads: what the core sent, and nothing else of it. */
function readOf(value: unknown): { engine: OtherEngine; session: TranscriptSession } | null {
  if (!record(value) || typeof value.engine !== 'string' || !isOtherEngine(value.engine)
    || typeof value.sessionId !== 'string' || value.sessionId.length > 200
    || (value.transcriptPath !== null && !readerPath(value.transcriptPath))
    || typeof value.touchedAt !== 'number' || !Number.isFinite(value.touchedAt) || Math.abs(value.touchedAt) > 8.64e15
    || (value.store != null && !readerPath(value.store))) return null
  return { engine: value.engine, session: { sessionId: value.sessionId, transcriptPath: value.transcriptPath,
    touchedAt: value.touchedAt, store: (value.store as string | null | undefined) ?? null } }
}

/**
 * Replies past one frame of the link, kept for the core to take in parts (`READER_PART`): the reads' and the live
 * streams' (engines/others/streamRequests.ts), through the one part request.
 */
export function createReplyParts(limits: { inline?: number; part?: number; parted?: number } = {}) {
  const inlineBytes = limits.inline ?? READER_REPLY_BYTES
  const partBytes = limits.part ?? READER_PART_BYTES
  const partedBytes = limits.parted ?? READER_PARTED_BYTES
  const kept = new Map<string, { bytes: Buffer; hash: string }>()
  let keptBytes = 0
  const forget = (id: string): void => {
    const reply = kept.get(id)
    if (reply) { kept.delete(id); keptBytes -= reply.bytes.length }
  }
  const part = (id: string, reply: { bytes: Buffer; hash: string }, offset: number): Record<string, unknown> => {
    // The last part lets the reply go: the core asks for each part once, in order.
    if (offset + partBytes >= reply.bytes.length) forget(id)
    return { version: READER_VERSION, part: id, offset, bytes: reply.bytes.length, hash: reply.hash,
      data: reply.bytes.subarray(offset, offset + partBytes).toString('base64') }
  }
  return {
    /** The reply, or its first part. Serialized and counted here, before it can cost the core's memory. */
    send(result: Record<string, unknown>): Record<string, unknown> {
      const bytes = Buffer.from(JSON.stringify(result))
      if (bytes.length <= inlineBytes) return result
      if (bytes.length > partedBytes) return { version: READER_VERSION, error: 'ENGINE_REPLY_TOO_LARGE', retryable: new EngineReadError('ENGINE_REPLY_TOO_LARGE').retryable }
      while (kept.size >= KEPT_REPLIES || keptBytes + bytes.length > KEPT_BYTES) forget(kept.keys().next().value!)
      const id = randomUUID()
      const reply = { bytes, hash: createHash('sha256').update(bytes).digest('hex') }
      kept.set(id, reply); keptBytes += bytes.length
      return part(id, reply, 0)
    },
    /** The next part of a reply kept, by its offset; stale once it was let go. */
    next(id: string, offset: number): Record<string, unknown> | null {
      const reply = kept.get(id)
      return reply && offset < reply.bytes.length ? part(id, reply, offset) : null
    },
  }
}
export type ReplyParts = ReturnType<typeof createReplyParts>

export interface OtherReaderDeps {
  transcriptFor?: (engine: string) => EngineTranscript | undefined
  /** A read still running long past its deadline holds what it read: recycle this worker, never the core. */
  recycle?: () => void
  log?: (line: string) => void
  /** Small bounds let a test take a reply in parts without building megabytes. */
  limits?: { inline?: number; part?: number; parted?: number }
  /** The replies kept in parts, shared with the live streams' (engines/others/streamRequests.ts). */
  parts?: ReplyParts
}

/** Their readers keep no pager: none of them pages a transcript by line, and what they read whole is bounded. */
const NO_PAGER = { page: () => Promise.reject(new Error('the other engines read no pages')) }

export function otherReaderRequests(deps: OtherReaderDeps = {}): ServiceRequests {
  const transcriptFor = deps.transcriptFor ?? otherTranscriptFor
  const recycle = deps.recycle ?? (() => process.exit(1))
  const log = deps.log ?? ((line: string) => console.warn(line))
  const parts = deps.parts ?? createReplyParts(deps.limits)
  const pending = new Map<OtherEngine, number>()
  let total = 0
  const failure = (code: ReaderErrorCode) => ({ version: READER_VERSION, error: code, retryable: new EngineReadError(code).retryable })
  const send = parts.send
  // Only core.call supplies an owner without a client connection. These methods are not public routes.
  const fromCore = (payload: Record<string, unknown>, asker: Parameters<ServiceRequests[string]>[1]): boolean =>
    asker.owner && asker.local && asker.connection === undefined && payload.version === READER_VERSION
  const handle = (type: string): ServiceRequests[string] => async (payload, asker, closed) => {
    if (!fromCore(payload, asker)) return failure('ENGINE_INVALID_REQUEST')
    const read = readOf(payload.session)
    const ask = type === READER_HISTORY ? askOf(payload.ask) : {}
    if (!read || !ask) return failure('ENGINE_INVALID_REQUEST')
    if (closed?.aborted) return failure('ENGINE_UNAVAILABLE')
    const { engine, session } = read
    if ((pending.get(engine) ?? 0) >= READER_IN_FLIGHT || total >= OTHER_READS_IN_FLIGHT) return failure('ENGINE_BUSY')
    const kind = type === READER_HISTORY ? 'history' : 'last turn'
    const waitMs = readWaitMs(engine, type === READER_HISTORY)
    pending.set(engine, (pending.get(engine) ?? 0) + 1)
    total++
    const stuck = setTimeout(() => {
      log(`[engine ${engine}] ${kind} still read ${Math.round((waitMs + OTHER_READ_STUCK_MS) / 1000)} s after it began · recycling this worker`)
      recycle()
    }, waitMs + OTHER_READ_STUCK_MS)
    stuck.unref?.()
    let late = false
    const reading = (async (): Promise<Record<string, unknown>> => {
      const reader = transcriptFor(engine)!
      let answer: unknown
      try {
        answer = type === READER_HISTORY ? await reader.historyPage(session, ask, NO_PAGER) : await reader.lastTurnText(session)
      } catch {
        // A store that cannot be read (locked past its wait, or no way to read SQLite here): said, and answered as
        // unavailable, which the core reports as an error it can retry.
        log(`[engine ${engine}] ${type === READER_HISTORY ? 'HISTORY_READ_FAILED' : 'LAST_TURN_READ_FAILED'}`)
        return failure('ENGINE_UNAVAILABLE')
      }
      // A read the core has already been answered for is not kept for parts nobody will ask for.
      if (closed?.aborted || late) return failure('ENGINE_UNAVAILABLE')
      return send({ version: READER_VERSION, answer })
    })().finally(() => {
      // The place is the read's until it ends, past its deadline too: a slow engine holds at most its own four.
      clearTimeout(stuck)
      pending.set(engine, pending.get(engine)! - 1)
      total--
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<Record<string, unknown>>((resolve) => {
      timer = setTimeout(() => {
        late = true
        log(`[engine ${engine}] ${kind} not read within ${waitMs / 1000} s · answered unavailable`)
        resolve(failure('ENGINE_UNAVAILABLE'))
      }, waitMs)
    })
    try { return await Promise.race([deadline, reading]) } finally { clearTimeout(timer) }
  }
  const nextPart: ServiceRequests[string] = async (payload, asker) => {
    if (!fromCore(payload, asker) || typeof payload.part !== 'string' || typeof payload.offset !== 'number'
      || !Number.isSafeInteger(payload.offset) || payload.offset < 0) return failure('ENGINE_INVALID_REQUEST')
    return parts.next(payload.part, payload.offset) ?? failure('ENGINE_STALE_REPLY')
  }
  return { [READER_HISTORY]: handle(READER_HISTORY), [READER_LAST_TURN]: handle(READER_LAST_TURN), [READER_PART]: nextPart }
}
