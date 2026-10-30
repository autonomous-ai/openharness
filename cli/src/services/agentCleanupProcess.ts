/**
 * The agent cleanup in its own process (`harness __service agentCleanup`, in the edge host): the same cleanup as in
 * the core's process (services/agentCleanup.ts), on the live agents the core names as each look and each close of a
 * starter's harnesses begins (`service_query live`). The core tells it what happens (`service_event closed`, `typed`)
 * and never waits for it. It asks the core when a harness last moved (`lastActivity`) and to close one
 * (`closeStarted`), which the core does for a harness another agent started and nothing else (core/agentCleanupLink.ts).
 */
import type { CoreApi } from '../core/api.js'
import type { AgentCloseResult } from '../lib/closeAgentService.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { SwarmServices } from '../serviceProcess.js'
import { createAgentCleanup } from './agentCleanup.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { agentsIn, processCoreApi } from './processCoreApi.js'

export interface AgentCleanupServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests. */
  create?: typeof createAgentCleanup
  /** The Swarm's side of this service, while the Swarm is on (serviceProcess.ts, superTabs/inServices.ts). */
  swarm?: Pick<SwarmServices, 'retainedHarnesses'>
}

/** The core API the cleanup runs on here: the light services' (processCoreApi.ts), with the two ways it acts. */
export function agentCleanupCoreApi(dataDir: string, live: () => RegisteredSession[], ask: (query: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>): CoreApi {
  const api = processCoreApi(dataDir, 'agentCleanup', { live })
  return {
    ...api,
    agents: {
      ...api.agents,
      // Not answered (the core gone, a link that dropped) is not closed: asked again at the next look.
      closeStarted: async (agentId, mode) => await ask('closeStarted', { agentId, mode }).catch(() => ({ error: 'SERVICE_UNAVAILABLE' })) as AgentCloseResult,
      lastActivity: async (agentId) => {
        const answer = await ask('lastActivity', { agentId }).catch(() => null)
        return typeof answer?.at === 'number' ? answer.at : null
      },
    },
  }
}

export function runAgentCleanupService(options: AgentCleanupServiceOptions): ServiceProcess {
  let agents: RegisteredSession[] = []
  let core: CoreConnection | null = null
  const ask = (query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> =>
    core ? core.query(query, payload) : Promise.reject(new Error('no core to ask'))
  const cleanup = (options.create ?? createAgentCleanup)(agentCleanupCoreApi(options.dataDir, () => agents, ask), {
    // A core that cannot say leaves none: nothing is closed on a list that may be stale.
    refresh: async () => { agents = agentsIn(await ask('live', {}).catch(() => null)) ?? [] },
    ...(options.swarm ? { retained: options.swarm.retainedHarnesses } : {}),
  })
  const service = (options.run ?? runServiceProcess)({
    name: 'agentCleanup',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    // The apps ask it nothing; the core tells it what happens.
    requests: {},
    onEvent: (payload) => {
      if (typeof payload.agentId !== 'string' || !payload.agentId) return
      if (payload.kind === 'closed') cleanup.port.closed(payload.agentId)
      else if (payload.kind === 'typed') cleanup.port.typed(payload.agentId)
    },
    onConnected: (connection) => { core = connection },
    onDisconnected: () => { core = null },
  })
  return { stop: () => { cleanup.port.stop(); return service.stop() } }
}
