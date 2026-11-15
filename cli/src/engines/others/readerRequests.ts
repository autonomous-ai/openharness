/**
 * The other engines' history and last turn on their worker's link: the private reader methods Claude Code's and
 * Codex's workers answer (engines/worker/process.ts), at the same version, under the same bounds, for any of the
 * fourteen engines, which each read names. Only the core's own call reaches them: they are no client's route.
 */
import { isAbsolute } from 'node:path'
import type { ServiceRequests } from '../../core/api.js'
import type { EngineTranscript, HistoryAsk, TranscriptSession } from '../facets/transcript.js'
import { historyWaitMs, isOtherEngine, type OtherEngine } from '../otherEngines.js'
import {
  EngineReadError, record, READER_HISTORY, READER_IN_FLIGHT, READER_LAST_TURN, READER_REPLY_BYTES, READER_VERSION,
  READER_WAIT_MS, type ReaderErrorCode,
} from '../worker/protocol.js'
import { otherTranscriptFor } from './transcripts.js'

/** All fourteen engines' reads at once in the one worker; each engine holds at most `READER_IN_FLIGHT` of them. */
export const OTHER_READS_IN_FLIGHT = 16

const path = (value: unknown): value is string => typeof value === 'string' && value.length <= 32_768
  && !value.includes('\0') && isAbsolute(value)

/** The read's engine and the snapshot it reads: what the core sent, and nothing else of it. */
function readOf(value: unknown): { engine: OtherEngine; session: TranscriptSession } | null {
  if (!record(value) || typeof value.engine !== 'string' || !isOtherEngine(value.engine)
    || typeof value.sessionId !== 'string' || value.sessionId.length > 200
    || (value.transcriptPath !== null && !path(value.transcriptPath))
    || typeof value.touchedAt !== 'number' || !Number.isFinite(value.touchedAt) || Math.abs(value.touchedAt) > 8.64e15
    || (value.store != null && !path(value.store))) return null
  return { engine: value.engine, session: { sessionId: value.sessionId, transcriptPath: value.transcriptPath,
    touchedAt: value.touchedAt, store: (value.store as string | null | undefined) ?? null } }
}

function askOf(value: unknown): HistoryAsk | null {
  if (value === undefined) return {}
  if (!record(value) || (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 500))
    || (value.before !== undefined && (typeof value.before !== 'string' || value.before.length > 2_000))) return null
  return { limit: value.limit as number | undefined, before: value.before as string | undefined }
}

export interface OtherReaderDeps {
  transcriptFor?: (engine: string) => EngineTranscript | undefined
  /** A timed-out read may still hold resources while heartbeats look healthy: recycle this worker, never the core. */
  recycle?: () => void
  log?: (line: string) => void
}

/** Their readers keep no pager: none of them pages a transcript by line, and what they read whole is bounded. */
const NO_PAGER = { page: () => Promise.reject(new Error('the other engines read no pages')) }

export function otherReaderRequests(deps: OtherReaderDeps = {}): ServiceRequests {
  const transcriptFor = deps.transcriptFor ?? otherTranscriptFor
  const recycle = deps.recycle ?? (() => process.exit(1))
  const log = deps.log ?? ((line: string) => console.warn(line))
  const pending = new Map<OtherEngine, number>()
  let total = 0
  const failure = (code: ReaderErrorCode) => ({ version: READER_VERSION, error: code, retryable: new EngineReadError(code).retryable })
  const handle = (type: string): ServiceRequests[string] => async (payload, asker, closed) => {
    // Only core.call supplies an owner without a client connection. These methods are not public routes.
    if (!asker.owner || !asker.local || asker.connection !== undefined || payload.version !== READER_VERSION) return failure('ENGINE_INVALID_REQUEST')
    const read = readOf(payload.session)
    const ask = type === READER_HISTORY ? askOf(payload.ask) : {}
    if (!read || !ask) return failure('ENGINE_INVALID_REQUEST')
    if (closed?.aborted) return failure('ENGINE_UNAVAILABLE')
    const { engine, session } = read
    if ((pending.get(engine) ?? 0) >= READER_IN_FLIGHT || total >= OTHER_READS_IN_FLIGHT) return failure('ENGINE_BUSY')
    pending.set(engine, (pending.get(engine) ?? 0) + 1)
    total++
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<Record<string, unknown>>((resolve) => {
      timer = setTimeout(() => { resolve(failure('ENGINE_UNAVAILABLE')); recycle() },
        type === READER_HISTORY ? historyWaitMs(engine, READER_WAIT_MS) : READER_WAIT_MS)
    })
    try {
      return await Promise.race([deadline, (async () => {
        const reader = transcriptFor(engine)!
        let answer: unknown
        try {
          answer = type === READER_HISTORY ? await reader.historyPage(session, ask, NO_PAGER) : await reader.lastTurnText(session)
        } catch (error) {
          // A store that cannot be read (locked past its wait, or no way to read SQLite here): said, and answered as
          // unavailable, which the core reports as an error it can retry.
          log(`[engine ${engine}] ${type === READER_HISTORY ? 'history' : 'last turn'} unreadable · ${error instanceof Error ? error.message : String(error)}`)
          return failure('ENGINE_UNAVAILABLE')
        }
        if (closed?.aborted) return failure('ENGINE_UNAVAILABLE')
        const result = { version: READER_VERSION, answer }
        // Serialization and size accounting happen here, before the result can consume the core's memory.
        return Buffer.byteLength(JSON.stringify(result)) <= READER_REPLY_BYTES ? result : failure('ENGINE_REPLY_TOO_LARGE')
      })()])
    } finally {
      clearTimeout(timer)
      pending.set(engine, pending.get(engine)! - 1)
      total--
    }
  }
  return { [READER_HISTORY]: handle(READER_HISTORY), [READER_LAST_TURN]: handle(READER_LAST_TURN) }
}
