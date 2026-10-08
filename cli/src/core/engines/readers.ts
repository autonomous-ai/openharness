/** The core's reader port: bounded calls, no reader implementation and no fallback after a failure. */
import type { EngineTranscript, TranscriptSession } from '../../engines/facets/transcript.js'
import type { HistoryAnswer, HistoryAsk } from '../../engines/facets/transcript.js'
import type { LastTurnText } from '../../engines/kit/events.js'
import {
  EngineReadError, historyAnswer, lastTurnAnswer, readerEngine, READER_ERRORS, READER_HISTORY,
  READER_IN_FLIGHT, READER_LAST_TURN, READER_SERVICES, READER_VERSION, READER_WAIT_MS,
  type ReaderEngine,
} from '../../engines/worker/protocol.js'

export interface EngineReaderDeps {
  isolated: ReadonlySet<string>
  call(service: string, type: string, payload: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>
  /** Only supplied by the explicit inline/older-master compatibility path. */
  inline?: (engine: string) => EngineTranscript | undefined
}

export function createEngineReaders(deps: EngineReaderDeps) {
  const states = new Map(Object.values(READER_SERVICES).map((service) => [service as string, { generation: 0, connected: false, pending: 0 }]))
  const read = async (engine: ReaderEngine, type: string, session: TranscriptSession, ask?: HistoryAsk): Promise<unknown> => {
    const service = READER_SERVICES[engine]
    const state = states.get(service)!
    if (state.pending >= READER_IN_FLIGHT) throw new EngineReadError('ENGINE_BUSY')
    // A cold request expects the first connection; a reconnect must not validate an older answer.
    const generation = state.generation + (state.connected ? 0 : 1)
    state.pending++
    try {
      const reply = await deps.call(service, type, {
        version: READER_VERSION,
        session: { sessionId: session.sessionId, transcriptPath: session.transcriptPath,
          touchedAt: session.touchedAt, codexHome: session.codexHome },
        ...(ask ? { ask: { limit: ask.limit || undefined, before: ask.before } } : {}),
      }, READER_WAIT_MS)
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
    } finally { state.pending-- }
  }
  const makeReader = (engine: ReaderEngine): EngineTranscript => ({
    historyPage: (session, ask) => read(engine, READER_HISTORY, session, ask) as Promise<HistoryAnswer>,
    lastTurnText: async (session) => {
      if (!session.transcriptPath) return null
      return read(engine, READER_LAST_TURN, session) as Promise<LastTurnText | null>
    },
  })
  const readers = { claude: makeReader('claude'), codex: makeReader('codex') }
  return {
    forEngine(engine: string): EngineTranscript | undefined {
      if (!readerEngine(engine)) return undefined
      return deps.isolated.has(READER_SERVICES[engine]) ? readers[engine] : deps.inline?.(engine) ?? readers[engine]
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
