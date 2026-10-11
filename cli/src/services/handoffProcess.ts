/** The edge host asks for each retained conversation fact when it needs it. It keeps no registry
 * snapshot, and reads database history here, not back in the core (quiet-machine QA extraction). */
import { HandoffError, handoffBaseName, type HandoffOutcome } from '../lib/handoffAuthority.js'
import type { CoreApi } from '../core/api.js'
import { ENGINES, type AgentEngine } from '../engines/types.js'
import { databaseHistory } from '../lib/databaseHistory.js'
import { startHandoff } from './handoff.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { isSession, processCoreApi } from './processCoreApi.js'

type Payload = Record<string, unknown>
const text = (value: unknown): value is string => typeof value === 'string'
const texts = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.every(text)) throw new HandoffError('HANDOFF_UNAVAILABLE')
  return value
}

export function handoffCoreApi(dataDir: string, ask: (query: string, payload: Payload) => Promise<Payload>): CoreApi {
  const core = processCoreApi(dataDir, 'handoff')
  const read = async (query: string, payload: Payload): Promise<unknown> => {
    const answer = await ask(query, payload)
    // An unreadable stopped record used to answer INTERNAL. Never disguise it as UNKNOWN_AGENT or
    // render a partial file from guessed facts merely because the read crossed a process boundary.
    if (answer.error || !Object.hasOwn(answer, 'value')) {
      const known: HandoffError['code'][] = ['UNKNOWN_AGENT', 'NO_PROJECT', 'BAD_CHANGE_ID', 'BUSY', 'TIMEOUT',
        'IDENTITY_UNAVAILABLE', 'HANDOFF_UNAVAILABLE', 'CHANGE_CONFLICT']
      throw new HandoffError(known.includes(answer.error as HandoffError['code']) ? answer.error as HandoffError['code'] : 'HANDOFF_UNAVAILABLE')
    }
    return answer.value
  }
  core.conversations = {
    publish: async (prepared, permit) => {
      if (!permit.current(prepared.request)) throw new HandoffError('HANDOFF_UNAVAILABLE')
      const value = await read('publish', { prepared, originRequestId: permit.requestId }) as HandoffOutcome | undefined
      // The core may return the retained snapshot of this same intent after a lost reply.
      const file = `.harness/handoff/${handoffBaseName(prepared.request.agentId, prepared.request.changeId)}.md`
      if (!value || value.cwd !== prepared.result.cwd || value.file !== null && value.file !== file || typeof value.gitRepo !== 'boolean'
        || !Array.isArray(value.degraded) || value.degraded.some(item => !['git', 'file', 'transcript'].includes(item))) throw new HandoffError('HANDOFF_UNAVAILABLE')
      return value
    },
    resolve: async (id) => { const value = await read('resolve', { id }); if (value !== null && !isSession(value)) throw new HandoffError('IDENTITY_UNAVAILABLE'); return value as Awaited<ReturnType<CoreApi['conversations']['resolve']>> },
    recentAsks: async (id, n) => texts(await read('recentAsks', { id, n })),
    lastFullText: async (id) => { const value = await read('lastFullText', { id }); if (value !== null && !text(value)) throw new HandoffError('HANDOFF_UNAVAILABLE'); return value as string | null },
    recaps: async (id, n) => texts(await read('recaps', { id, n })),
    discover: async (id) => {
      const value = await read('discover', { id }) as Payload | null | undefined
      if (value === null) return null
      if (!value || !text(value.engine) || !(ENGINES as readonly string[]).includes(value.engine) || !text(value.sessionId) || !text(value.transcriptPath)) {
        throw new HandoffError('IDENTITY_UNAVAILABLE')
      }
      return { engine: value.engine as AgentEngine, sessionId: value.sessionId, transcriptPath: value.transcriptPath }
    },
    findTranscript: async (engine, id, options) => {
      const value = await read('findTranscript', { engine, id, ...options })
      if (value !== null && !text(value)) throw new HandoffError('HANDOFF_UNAVAILABLE'); return value as string | null
    },
    transcriptOk: async (engine, path, codexHome) => {
      const value = await read('transcriptOk', { engine, path, codexHome })
      if (typeof value !== 'boolean') throw new HandoffError('IDENTITY_UNAVAILABLE')
      return value
    },
  }
  core.transcripts.databaseHistory = databaseHistory
  return core
}

export interface HandoffServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  run?: typeof runServiceProcess
  start?: typeof startHandoff
}

export function runHandoffService(options: HandoffServiceOptions): ServiceProcess {
  let connection: CoreConnection | null = null
  const core = handoffCoreApi(options.dataDir, (query, payload) => connection?.query(query, payload) ?? Promise.resolve({ error: 'SERVICE_UNAVAILABLE' }))
  return (options.run ?? runServiceProcess)({
    name: 'handoff', socketPath: options.socketPath, machineId: options.machineId, token: options.token,
    requests: (options.start ?? startHandoff)(core),
    onConnected: (linked) => { connection = linked },
  })
}
