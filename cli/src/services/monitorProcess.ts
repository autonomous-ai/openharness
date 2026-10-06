/**
 * The machine monitor in its own process (`harness __service monitor`, in the edge host).
 *
 * The same readers as in the core's process (services/monitor.ts), answering two askers:
 * - the Monitor's own request, `machine_resources`;
 * - the core, for the readings `agents_list` adds to its rows and for a purge's forgetting, through its
 *   port (core/monitorLink.ts). Those two requests are named as the port's members, `resources` and
 *   `storage`, so that a test's fault names the same member whichever process the monitor runs in.
 *
 * One sample and one cache serve both, here as in the core's process. The agents a sample reads are the
 * ones the core advertises as it starts (`service_query advertised`). The `ps`, `nvidia-smi` and `ioreg`
 * runs, and the parse of up to 8 MB of ioreg output at each Monitor poll, are this process's alone.
 */
import { emptyPorts } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { startMonitor } from './monitor.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { agentsIn, processCoreApi } from './processCoreApi.js'

export interface MonitorServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for readers that run no `ps` and measure no folder. */
  start?: typeof startMonitor
}

export function runMonitorService(options: MonitorServiceOptions): ServiceProcess {
  let advertised: RegisteredSession[] = []
  let core: CoreConnection | null = null
  /** The agents the core advertises now: what a sample starting now reads. A core that cannot say leaves
   *  the last ones it said. */
  const refresh = async (): Promise<void> => {
    advertised = agentsIn(await core?.query('advertised').catch(() => null)) ?? advertised
  }
  const ports = emptyPorts()
  const answers = (options.start ?? startMonitor)(processCoreApi(options.dataDir, 'monitor', { advertised: () => advertised }), ports)
  if (!ports.monitor) throw new Error('the monitor did not start')
  const monitor = ports.monitor
  const machineResources = answers.machine_resources
  return (options.run ?? runServiceProcess)({
    name: 'monitor',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: {
      // The machine's own totals read no agent; the agents' readings read the ones advertised now.
      machine_resources: async (payload, asker) => {
        if (payload.harnesses === true) await refresh()
        return machineResources(payload, asker)
      },
      // The port's members, asked only by the core (core/monitorLink.ts). Their failures are answered
      // SERVICE_FAILED, which the core reads as its fallbacks: rows without readings, nothing forgotten.
      resources: async () => {
        await refresh()
        return { snapshot: await monitor.resources() }
      },
      storage: async (payload) => ({
        entries: [...await monitor.storage(agentsIn(payload) ?? [], payload.invalidate === true)],
      }),
    },
    onConnected: (connection) => { core = connection },
  })
}
