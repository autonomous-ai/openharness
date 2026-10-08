import type { CoreConnection } from '../../services/process.js'
import { engineModelControlRequests } from './modelControlRequests.js'
/** One engine's facets, hosted by the master's existing service supervisor. */
import { isAbsolute } from 'node:path'
import type { ServiceRequests } from '../../core/api.js'
import { TranscriptPager } from '../../lib/transcriptPages.js'
import { runServiceProcess, type ServiceProcess } from '../../services/process.js'
import type { ServiceProcessOptions } from '../../serviceProcess.js'
import type { EngineTranscript, HistoryAsk, TranscriptSession } from '../facets/transcript.js'
import { engineLiveRequests } from './liveRequests.js'
import { engineScreenRequests } from './screenRequests.js'
import { engineRuntimeRequests } from './runtimeRequests.js'
import {
  EngineReadError, record, READER_HISTORY, READER_IN_FLIGHT, READER_LAST_TURN, READER_REPLY_BYTES,
  READER_SERVICES, READER_VERSION, READER_WAIT_MS, type ReaderEngine, type ReaderErrorCode,
} from './protocol.js'

const loadReader = {
  claude: async () => (await import('../claude/transcript.js')).transcript,
  codex: async () => (await import('../codex/transcript.js')).transcript,
}
const path = (value: unknown): value is string => typeof value === 'string' && value.length <= 32_768
  && !value.includes('\0') && isAbsolute(value)

function sessionOf(value: unknown): TranscriptSession | null {
  if (!record(value) || (typeof value.sessionId !== 'string' || value.sessionId.length > 200)
    || (value.transcriptPath !== null && !path(value.transcriptPath))
    || typeof value.touchedAt !== 'number' || !Number.isFinite(value.touchedAt) || Math.abs(value.touchedAt) > 8.64e15
    || (value.codexHome != null && !path(value.codexHome))) return null
  return { sessionId: value.sessionId, transcriptPath: value.transcriptPath,
    touchedAt: value.touchedAt, ...(value.codexHome === undefined ? {} : { codexHome: value.codexHome }) }
}

function askOf(value: unknown): HistoryAsk | null {
  if (value === undefined) return {}
  if (!record(value) || (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 500))
    || (value.before !== undefined && (typeof value.before !== 'string' || value.before.length > 2_000))) return null
  return { limit: value.limit as number | undefined, before: value.before as string | undefined }
}

export interface ReaderRequestDeps {
  load?: () => Promise<EngineTranscript>
  /** A timed-out async read may still hold resources while heartbeats look healthy. Recycle this
   *  worker rather than releasing its slot and accumulating abandoned reads. Never restarts core. */
  recycle?: () => void
}

export function engineReaderRequests(engine: ReaderEngine, deps: ReaderRequestDeps = {}): ServiceRequests {
  const load = deps.load ?? loadReader[engine]
  const recycle = deps.recycle ?? (() => process.exit(1))
  // The old shared pager held 256 indexes. Split that bound across the two reader processes.
  const pages = new TranscriptPager({ capacity: 128 })
  let reader: Promise<EngineTranscript> | null = null
  let pending = 0
  const failure = (code: ReaderErrorCode) => ({ version: READER_VERSION, error: code, retryable: new EngineReadError(code).retryable })
  const handle = (type: string): ServiceRequests[string] => async (payload, asker, closed) => {
    // Only core.call supplies an owner without a client connection. These methods are not public routes.
    if (!asker.owner || !asker.local || asker.connection !== undefined || payload.version !== READER_VERSION) return failure('ENGINE_INVALID_REQUEST')
    const session = sessionOf(payload.session)
    const ask = askOf(payload.ask)
    if (!session || !ask) return failure('ENGINE_INVALID_REQUEST')
    if (closed?.aborted) return failure('ENGINE_UNAVAILABLE')
    if (pending >= READER_IN_FLIGHT) return failure('ENGINE_BUSY')
    pending++
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<Record<string, unknown>>((resolve) => {
      timer = setTimeout(() => { resolve(failure('ENGINE_UNAVAILABLE')); recycle() }, READER_WAIT_MS)
    })
    try {
      return await Promise.race([deadline, (async () => {
        // An import failure belongs to this worker; retry a later request if the import was transient.
        const adapter = await (reader ??= load().catch((error) => { reader = null; throw error }))
        const answer = type === READER_HISTORY ? await adapter.historyPage(session, ask, pages) : await adapter.lastTurnText(session)
        if (closed?.aborted) return failure('ENGINE_UNAVAILABLE')
        const result = { version: READER_VERSION, answer }
        // Serialization and size accounting happen here, before the result can consume core's memory.
        return Buffer.byteLength(JSON.stringify(result)) <= READER_REPLY_BYTES ? result : failure('ENGINE_REPLY_TOO_LARGE')
      })()])
    } finally { clearTimeout(timer); pending-- }
  }
  return { [READER_HISTORY]: handle(READER_HISTORY), [READER_LAST_TURN]: handle(READER_LAST_TURN) }
}

export interface EngineProcessOptions extends ServiceProcessOptions {
  run?: typeof runServiceProcess
  requests?: ServiceRequests
}

export function runEngineReader(engine: ReaderEngine, options: EngineProcessOptions): ServiceProcess {
  let core: CoreConnection | null = null
  return (options.run ?? runServiceProcess)({
    name: READER_SERVICES[engine], socketPath: options.socketPath, machineId: options.machineId,
    token: options.token, requests: options.requests ?? { ...engineReaderRequests(engine), ...engineLiveRequests(engine), ...engineRuntimeRequests(engine), ...engineScreenRequests(engine), ...engineModelControlRequests(engine, {
      query: (query, payload) => core ? core.query(query, payload) : Promise.reject(new Error('core disconnected')),
    }) },
    onConnected: connected => { core = connected }, onDisconnected: () => { core = null },
  })
}
