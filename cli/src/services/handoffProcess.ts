/** The edge host asks for each retained conversation fact when it needs it. It keeps no registry
 * snapshot, and reads database history here, not back in the core (quiet-machine QA extraction). */
import type { CoreApi } from '../core/api.js'
import { ENGINES, type AgentEngine } from '../engines/types.js'
import { databaseHistory } from '../lib/databaseHistory.js'
import { startHandoff } from './handoff.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { isSession, processCoreApi } from './processCoreApi.js'

type Payload = Record<string, unknown>
const text = (value: unknown): value is string => typeof value === 'string'
const texts = (value: unknown): string[] => Array.isArray(value) ? value.filter(text) : []

export function handoffCoreApi(dataDir: string, ask: (query: string, payload: Payload) => Promise<Payload>): CoreApi {
  const core = processCoreApi(dataDir, 'handoff')
  const read = async (query: string, payload: Payload): Promise<unknown> => {
    const answer = await ask(query, payload)
    // An unreadable stopped record used to answer INTERNAL. Never disguise it as UNKNOWN_AGENT or
    // render a partial file from guessed facts merely because the read crossed a process boundary.
    if (answer.error) throw new Error('the core did not answer a conversation read')
    return answer.value
  }
  core.conversations = {
    resolve: async (id) => { const value = await read('resolve', { id }); return isSession(value) ? value : null },
    recentAsks: async (id, n) => texts(await read('recentAsks', { id, n })),
    lastFullText: async (id) => { const value = await read('lastFullText', { id }); return text(value) ? value : null },
    recaps: async (id, n) => texts(await read('recaps', { id, n })),
    discover: async (id) => {
      const value = await read('discover', { id }) as Payload | null | undefined
      return value && text(value.engine) && (ENGINES as readonly string[]).includes(value.engine) && text(value.sessionId) && text(value.transcriptPath)
        ? { engine: value.engine as AgentEngine, sessionId: value.sessionId, transcriptPath: value.transcriptPath } : null
    },
    findTranscript: async (engine, id, options) => {
      const value = await read('findTranscript', { engine, id, ...options })
      return text(value) ? value : null
    },
    transcriptOk: async (engine, path, codexHome) => (await read('transcriptOk', { engine, path, codexHome })) === true,
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
  const core = handoffCoreApi(options.dataDir, (query, payload) => connection?.query(query, payload) ?? Promise.resolve({}))
  return (options.run ?? runServiceProcess)({
    name: 'handoff', socketPath: options.socketPath, machineId: options.machineId, token: options.token,
    requests: (options.start ?? startHandoff)(core),
    onConnected: (linked) => { connection = linked },
  })
}
