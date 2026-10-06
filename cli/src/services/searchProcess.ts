/**
 * Session search in its own process (`harness __service search`, with `HARNESSD_SERVICES=search`).
 *
 * The same index as in the core's process (services/search.ts, lib/sessionSearch/), on a core API built
 * here: the agents come from the core (`service_query agents`, refreshed on every turn boundary it is
 * told of), and everything else — the database readers, the conversations Harness did not start — is
 * read here, as the core would read it. Its SQLite index, its memory and its native code are this
 * process's alone: a crash or a leak in search costs search, and the master starts it again.
 */
import type { CoreApi } from '../core/api.js'
import { ACCOUNT_BACKEND_OFF, AGENT_ACTIONS_OFF, DAEMON_UNKNOWN, DELIVERIES_OFF, emptyPorts, LANE_OFF, resolveAgent, TERMINALS_OFF } from '../core/api.js'
import { databaseHistory } from '../core/transcripts/databaseHistory.js'
import { ExternalSessions, OpenSessions } from '../lib/sessionSearch/external.js'
import { externalProviders } from '../lib/sessionSearch/externals/index.js'
import type { RegisteredSession } from '../lib/registry.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { UNASKED } from './processCoreApi.js'
import { SEARCH_REQUESTS, startSearch } from './search.js'

export interface SearchServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for an index that cannot open, as on a Node without `node:sqlite`. */
  start?: typeof startSearch
  /** Where conversations Harness did not start are found; swapped in tests for none. */
  providers?: ReturnType<typeof externalProviders>
}

/**
 * The core API search runs on in its own process: the agents the core last named, and everything else
 * read here, as the core would read it. What search never asks — windows, sign-in — answers as nothing.
 */
export function searchCoreApi(
  dataDir: string,
  agents: () => Array<RegisteredSession & { displayName?: string }>,
  providers: ReturnType<typeof externalProviders>,
): CoreApi {
  return {
    dataDir,
    terminals: TERMINALS_OFF,
    machine: UNASKED.machine,
    agents: {
      all: agents,
      live: () => agents().filter((agent) => agent.active),
      displayName: (session) => (session as { displayName?: string }).displayName ?? '',
      byAgent: (agentId) => agents().find((agent) => agent.agentId === agentId),
      resolve: (id) => resolveAgent(agents(), id),
      advertised: () => [],
      terminalAvailable: () => false,
      sync: () => {},
      runtimeModels: async () => [],
      runtimeProfile: () => null,
      setRuntime: () => {},
      fork: async () => ({ ok: false, error: 'UNSUPPORTED' }),
      ...AGENT_ACTIONS_OFF,
      activityText: UNASKED.activityText,
    },
    // Search drives no agent: these are never asked of it.
    turns: { send: () => {}, stop: () => {}, recent: async () => [], asks: async () => [], ...DELIVERIES_OFF },
    questions: { answer: () => {}, answerReviewed: async () => false },
    transcripts: { databaseHistory },
    external: {
      sessions: new ExternalSessions({ providers, excluded: [dataDir], log: console.warn }),
      open: new OpenSessions({ providers, log: console.warn }),
    },
    // Search holds no credential, runs no model and talks to no window: these are never asked of it.
    account: {
      mintGridName: async () => null,
      accessToken: () => Promise.reject(new Error('search holds no credential')),
      lane: LANE_OFF,
      privateGridName: async () => null,
      machineName: () => null,
      ...ACCOUNT_BACKEND_OFF,
      ...UNASKED.account,
    },
    clients: { viewerChanged: () => {}, gridNamed: () => {}, gridModelsChanged: () => {}, dshInstallStatus: () => {}, windows: () => {}, observer: () => false, ...UNASKED.clients },
    daemon: DAEMON_UNKNOWN,
    wifi: UNASKED.wifi,
  }
}

export function runSearchService(options: SearchServiceOptions): ServiceProcess {
  let agents: Array<RegisteredSession & { displayName?: string }> = []
  let core: CoreConnection | null = null
  const refresh = async (): Promise<void> => {
    if (!core) return
    const answer = await core.query('agents').catch(() => null)
    if (Array.isArray(answer?.agents)) agents = answer.agents as typeof agents
  }
  const api = searchCoreApi(options.dataDir, () => agents, options.providers ?? externalProviders())
  const ports = emptyPorts()
  const answers = (options.start ?? startSearch)(api, ports)
  const index = ports.search
  // No index here (a Node without `node:sqlite`): search is off, as it would be in the core's process.
  const off = { error: 'SERVICE_UNAVAILABLE', service: 'search', retryable: false }
  const run = options.run ?? runServiceProcess
  const service = run({
    name: 'search',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    // The same handlers as in the core's process (services/search.ts `searchRequests`).
    requests: answers ?? Object.fromEntries(SEARCH_REQUESTS.map((type) => [type, () => off])),
    onEvent: (payload) => {
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
      if (!sessionId || !index) return
      // A turn boundary: the agents may have changed (a new one, a new conversation), and this
      // session has new turns to index. Returned, so a failure is logged rather than left unhandled,
      // which would end this process.
      if (payload.kind === 'touch') return refresh().then(() => index.touch(sessionId))
      if (payload.kind === 'deleteHistory') index.deleteHistory(sessionId)
    },
    onConnected: (connection) => {
      core = connection
      void refresh()
    },
  })
  return {
    stop: () => {
      service.stop()
      index?.stop()
    },
  }
}
