/** The core's reader port: bounded calls, no reader implementation and no fallback after a failure. */
import type { EngineTranscript, TranscriptSession } from '../../engines/facets/transcript.js'
import type { HistoryAnswer, HistoryAsk } from '../../engines/facets/transcript.js'
import type { LastTurnText } from '../../engines/kit/events.js'
import { historyWaitMs, isOtherEngine, OTHER_ENGINES_SERVICE, type OtherEngine } from '../../engines/otherEngines.js'
import {
  EngineReadError, historyAnswer, lastTurnAnswer, readerEngine, READER_ERRORS, READER_HISTORY,
  READER_IN_FLIGHT, READER_LAST_TURN, READER_SERVICES, READER_VERSION, READER_WAIT_MS,
} from '../../engines/worker/protocol.js'

export interface EngineReaderDeps {
  /** The services the master runs in their own processes; the other engines' worker only once it reads their transcripts. */
  isolated: ReadonlySet<string>
  call(service: string, type: string, payload: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>
  /** Only supplied by the explicit inline/older-master compatibility path. */
  inline?: (engine: string) => EngineTranscript | undefined
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
  const services = [...Object.values(READER_SERVICES), OTHER_ENGINES_SERVICE]
  const states = new Map(services.map((service) => [service as string, { generation: 0, connected: false }]))
  // Per engine: the other engines share one worker, and one busy engine must not hold another's reads back.
  const pending = new Map<string, number>()
  const read = async (engine: string, type: string, session: TranscriptSession, ask?: HistoryAsk): Promise<unknown> => {
    const { service, session: snapshot } = route(engine, session)
    const state = states.get(service)!
    if ((pending.get(engine) ?? 0) >= READER_IN_FLIGHT) throw new EngineReadError('ENGINE_BUSY')
    // A cold request expects the first connection; a reconnect must not validate an older answer.
    const generation = state.generation + (state.connected ? 0 : 1)
    pending.set(engine, (pending.get(engine) ?? 0) + 1)
    try {
      const reply = await deps.call(service, type, {
        version: READER_VERSION,
        session: snapshot,
        ...(ask ? { ask: { limit: ask.limit || undefined, before: ask.before } } : {}),
      }, type === READER_HISTORY ? historyWaitMs(engine, READER_WAIT_MS) : READER_WAIT_MS)
      if (reply.error === 'SERVICE_UNAVAILABLE' || reply.error === 'SERVICE_FAILED') throw new EngineReadError('ENGINE_UNAVAILABLE')
      if (state.generation !== generation) throw new EngineReadError('ENGINE_STALE_REPLY')
      if (reply.version !== READER_VERSION) throw new EngineReadError('ENGINE_INVALID_REPLY')
      if (reply.error !== undefined) {
        throw new EngineReadError(READER_ERRORS.includes(reply.error as EngineReadError['code']) ? reply.error as EngineReadError['code'] : 'ENGINE_INVALID_REPLY')
      }
      if (!(type === READER_HISTORY ? historyAnswer(reply.answer) : lastTurnAnswer(reply.answer))) throw new EngineReadError('ENGINE_INVALID_REPLY')
      return reply.answer
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
  const readers = new Map<string, EngineTranscript>([...Object.keys(READER_SERVICES)].map((engine) => [engine, makeReader(engine)]))
  const others = new Map<OtherEngine, EngineTranscript>()
  return {
    forEngine(engine: string): EngineTranscript | undefined {
      if (readerEngine(engine)) {
        return deps.isolated.has(READER_SERVICES[engine]) ? readers.get(engine) : deps.inline?.(engine) ?? readers.get(engine)
      }
      if (!isOtherEngine(engine)) return undefined
      if (!deps.isolated.has(OTHER_ENGINES_SERVICE)) return deps.inline?.(engine)
      let reader = others.get(engine)
      if (!reader) { reader = makeReader(engine); others.set(engine, reader) }
      return reader
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
