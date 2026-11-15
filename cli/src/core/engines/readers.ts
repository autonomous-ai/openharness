/** The core's reader port: bounded calls, no reader implementation and no fallback after a failure. */
import { createHash } from 'node:crypto'
import type { EngineTranscript, TranscriptSession } from '../../engines/facets/transcript.js'
import type { HistoryAnswer, HistoryAsk } from '../../engines/facets/transcript.js'
import type { LastTurnText } from '../../engines/kit/events.js'
import { isOtherEngine, OTHER_ENGINES, OTHER_ENGINES_SERVICE, readWaitMs } from '../../engines/otherEngines.js'
import {
  checkedHistory, EngineReadError, lastTurnAnswer, readerEngine, READER_ERRORS, READER_HISTORY, READER_IN_FLIGHT,
  READER_LAST_TURN, READER_PART, READER_PART_BYTES, READER_PARTED_BYTES, READER_SERVICES, READER_VERSION, READER_WAIT_MS,
} from '../../engines/worker/protocol.js'

export interface EngineReaderDeps {
  /** The services the master runs in their own processes; the other engines' worker only once it reads their transcripts. */
  isolated: ReadonlySet<string>
  call(service: string, type: string, payload: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>
  /** Only supplied by the explicit inline/older-master compatibility path. */
  inline?: (engine: string) => EngineTranscript | undefined
  log?: (line: string) => void
}

/** The worker that reads `engine`'s transcripts, and what the core sends it of a session: Claude Code's and Codex's the
 *  fields they always had, the other engines' their engine and store too. */
function route(engine: string, session: TranscriptSession): { service: string; session: Record<string, unknown> } {
  if (readerEngine(engine)) return { service: READER_SERVICES[engine], session: { sessionId: session.sessionId,
    transcriptPath: session.transcriptPath, touchedAt: session.touchedAt, codexHome: session.codexHome } }
  return { service: OTHER_ENGINES_SERVICE, session: { engine, sessionId: session.sessionId, transcriptPath: session.transcriptPath,
    touchedAt: session.touchedAt, store: session.store ?? null } }
}

export function createEngineReaders(deps: EngineReaderDeps) {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const services = [...Object.values(READER_SERVICES), OTHER_ENGINES_SERVICE]
  const states = new Map(services.map((service) => [service as string, { generation: 0, connected: false }]))
  // Per engine: the other engines share one worker, and one busy engine must not hold another's reads back.
  const pending = new Map<string, number>()
  /**
   * A reply its worker sent in parts, put back together: each part asked for by its offset, all of them within a wait
   * as long as the read's, and the whole held to the core's own bound before any of it is kept.
   */
  const joined = async (first: Record<string, unknown>, ask: (offset: number) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> => {
    const id = first.part, size = first.bytes, hash = first.hash
    if (typeof id !== 'string' || !id || id.length > 200 || typeof size !== 'number' || !Number.isSafeInteger(size)
      || size <= 0 || size > READER_PARTED_BYTES || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new EngineReadError('ENGINE_INVALID_REPLY')
    const body = Buffer.allocUnsafe(size)
    let offset = 0, reply = first
    for (;;) {
      if (reply.part !== id || reply.bytes !== size || reply.hash !== hash || reply.offset !== offset || typeof reply.data !== 'string'
        || reply.data.length > Math.ceil(READER_PART_BYTES / 3) * 4) throw new EngineReadError('ENGINE_INVALID_REPLY')
      const part = Buffer.from(reply.data, 'base64')
      if (!part.length || part.length > size - offset || part.toString('base64') !== reply.data) throw new EngineReadError('ENGINE_INVALID_REPLY')
      part.copy(body, offset); offset += part.length
      if (offset === size) break
      reply = await ask(offset)
    }
    if (createHash('sha256').update(body).digest('hex') !== hash) throw new EngineReadError('ENGINE_INVALID_REPLY')
    try { return JSON.parse(body.toString('utf8')) as Record<string, unknown> } catch { throw new EngineReadError('ENGINE_INVALID_REPLY') }
  }
  const read = async (engine: string, type: string, session: TranscriptSession, ask?: HistoryAsk): Promise<unknown> => {
    const { service, session: snapshot } = route(engine, session)
    const state = states.get(service)!
    if ((pending.get(engine) ?? 0) >= READER_IN_FLIGHT) throw new EngineReadError('ENGINE_BUSY')
    // A cold request expects the first connection; a reconnect must not validate an older answer.
    const generation = state.generation + (state.connected ? 0 : 1)
    const waitMs = isOtherEngine(engine) ? readWaitMs(engine, type === READER_HISTORY) : READER_WAIT_MS
    pending.set(engine, (pending.get(engine) ?? 0) + 1)
    try {
      const answered = (reply: Record<string, unknown>): Record<string, unknown> => {
        if (reply.error === 'SERVICE_UNAVAILABLE' || reply.error === 'SERVICE_FAILED') throw new EngineReadError('ENGINE_UNAVAILABLE')
        if (state.generation !== generation) throw new EngineReadError('ENGINE_STALE_REPLY')
        if (reply.version !== READER_VERSION) throw new EngineReadError('ENGINE_INVALID_REPLY')
        if (reply.error !== undefined) {
          throw new EngineReadError(READER_ERRORS.includes(reply.error as EngineReadError['code']) ? reply.error as EngineReadError['code'] : 'ENGINE_INVALID_REPLY')
        }
        return reply
      }
      let reply = answered(await deps.call(service, type, {
        version: READER_VERSION,
        session: snapshot,
        ...(ask ? { ask: { limit: ask.limit || undefined, before: ask.before } } : {}),
      }, waitMs))
      if (reply.part !== undefined) {
        const part = reply.part, deadline = performance.now() + waitMs
        reply = answered(await joined(reply, async (offset) => {
          const left = Math.ceil(deadline - performance.now())
          if (left <= 0) throw new EngineReadError('ENGINE_UNAVAILABLE')
          return answered(await deps.call(service, READER_PART, { version: READER_VERSION, part, offset }, left))
        }))
      }
      if (type !== READER_HISTORY) {
        if (!lastTurnAnswer(reply.answer)) throw new EngineReadError('ENGINE_INVALID_REPLY')
        return reply.answer
      }
      const checked = checkedHistory(reply.answer)
      if (!checked) throw new EngineReadError('ENGINE_INVALID_REPLY')
      if (checked.dropped) log(`[engine ${engine}] history · left out ${checked.dropped} event(s) its reader sent that the core could not check`)
      return checked.answer
    } catch (error) {
      throw error instanceof EngineReadError ? error : new EngineReadError('ENGINE_UNAVAILABLE')
    } finally { pending.set(engine, pending.get(engine)! - 1) }
  }
  const makeReader = (engine: string): EngineTranscript => ({
    historyPage: (session, ask) => read(engine, READER_HISTORY, session, ask) as Promise<HistoryAnswer>,
    lastTurnText: async (session) => {
      // A conversation kept in a store has no transcript path: its store is what is read.
      if (!session.transcriptPath && !session.store) return null
      return read(engine, READER_LAST_TURN, session) as Promise<LastTurnText | null>
    },
  })
  const readers = new Map<string, EngineTranscript>([...Object.keys(READER_SERVICES), ...OTHER_ENGINES].map((engine) => [engine, makeReader(engine)]))
  return {
    forEngine(engine: string): EngineTranscript | undefined {
      if (readerEngine(engine)) {
        return deps.isolated.has(READER_SERVICES[engine]) ? readers.get(engine) : deps.inline?.(engine) ?? readers.get(engine)
      }
      if (!isOtherEngine(engine)) return undefined
      return deps.isolated.has(OTHER_ENGINES_SERVICE) ? readers.get(engine) : deps.inline?.(engine)
    },
    connected(service: string): void {
      const state = states.get(service)
      if (state) { state.generation++; state.connected = true }
    },
    disconnected(service: string): void {
      const state = states.get(service)
      if (state) { state.generation++; state.connected = false }
    },
    /** Readers receive a snapshot with each call and have no reason to query or act on the core. */
    answer(service: string): Record<string, unknown> | null {
      return states.has(service) ? { error: 'READER_HAS_NO_CORE_CAPABILITIES' } : null
    },
  }
}
