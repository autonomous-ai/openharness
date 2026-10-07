/**
 * The window names in their own process (`harness __service windowNames`, in the edge host): the same
 * handler as in the core's process (services/windowNames.ts), on the agents the core names as each request
 * starts (`service_query agents`, which carries the name the apps show for each). The model runs and their
 * time are this process's alone.
 */
import type { ServiceRequests } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { agentsIn, processCoreApi } from './processCoreApi.js'
import { startWindowNames } from './windowNames.js'

export interface WindowNamesServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for one that runs no model and reads no disk. */
  start?: typeof startWindowNames
}

export function runWindowNamesService(options: WindowNamesServiceOptions): ServiceProcess {
  let agents: RegisteredSession[] = []
  let core: CoreConnection | null = null
  /** The agents now, with their shown names. A core that cannot say leaves the last ones it said. */
  const refresh = async (): Promise<void> => {
    agents = agentsIn(await core?.query('agents').catch(() => null)) ?? agents
  }
  const answers = (options.start ?? startWindowNames)(processCoreApi(options.dataDir, 'windowNames', { live: () => agents }))
  const requests: ServiceRequests = Object.fromEntries(Object.entries(answers).map(([type, handle]) =>
    [type, async (payload: Record<string, unknown>, asker: Parameters<typeof handle>[1]) => { await refresh(); return handle(payload, asker) }]))
  return (options.run ?? runServiceProcess)({
    name: 'windowNames',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests,
    onConnected: (connection) => { core = connection },
  })
}
