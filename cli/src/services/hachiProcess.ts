/**
 * Hachi's side of the daemon in its own process (`harness __service hachi`, in the edge host): the same service as in
 * the core's process (services/hachi.ts), on the live agents and the daemon's address the core names as each look
 * begins (`service_query live`, `daemon`), counting through the core (core/agentQueries.ts `count`). The apps ask it
 * nothing.
 */
import type { DaemonAddress } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { startHachi } from './hachi.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { agentsIn, daemonIn, processCoreApi } from './processCoreApi.js'

export interface HachiServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests. */
  start?: typeof startHachi
}

export function runHachiService(options: HachiServiceOptions): ServiceProcess {
  let live: RegisteredSession[] = []
  let daemon: DaemonAddress | null = null
  let core: CoreConnection | null = null
  const ask = async (query: string, payload: Record<string, unknown>) => core!.query(query, payload)
  const hachi = (options.start ?? startHachi)(processCoreApi(options.dataDir, 'hachi', { live: () => live, daemon: () => daemon, ask }), {
    // A core that cannot say leaves none: no Hachi is followed on a list that may be stale.
    refresh: async () => {
      live = agentsIn(await ask('live', {}).catch(() => null)) ?? []
      daemon = daemonIn(await ask('daemon', {}).catch(() => null)) ?? daemon
    },
  })
  const service = (options.run ?? runServiceProcess)({
    name: 'hachi',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: {},
    onConnected: (connection) => { core = connection },
  })
  return { stop: () => { hachi.stop(); return service.stop() } }
}
