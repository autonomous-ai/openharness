/**
 * Hachi's goals in their own process (`harness __service goals`, in the edge host): the same handlers as in the core's
 * process (services/goals.ts), on the live agents the core names as each request starts (`service_query live`), so
 * the pane a request comes from is read as the core sees it then.
 */
import type { ServiceRequests } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { startGoals } from './goals.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { agentsIn, processCoreApi } from './processCoreApi.js'

export interface GoalsServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
}

export function runGoalsService(options: GoalsServiceOptions): ServiceProcess {
  let live: RegisteredSession[] = []
  let core: CoreConnection | null = null
  /** The live agents now. A core that cannot say leaves the last ones it said. */
  const refresh = async (): Promise<void> => {
    live = agentsIn(await core?.query('live').catch(() => null)) ?? live
  }
  // Its measures go to the core, which counts Hachi's and nothing else (core/agentQueries.ts `count`).
  // Only Hachi's requests count, and none is answered as Hachi's before a core has said which harness is Hachi.
  const ask = async (query: string, payload: Record<string, unknown>) => core!.query(query, payload)
  const answers = startGoals(processCoreApi(options.dataDir, 'goals', { live: () => live, ask }))
  const requests: ServiceRequests = Object.fromEntries(Object.entries(answers).map(([type, handle]) =>
    [type, async (payload: Record<string, unknown>, asker: Parameters<typeof handle>[1]) => { await refresh(); return handle(payload, asker) }]))
  return (options.run ?? runServiceProcess)({
    name: 'goals',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests,
    onConnected: (connection) => { core = connection },
  })
}
