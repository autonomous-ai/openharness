/**
 * Add-ons for a device that is this machine, in their own process (`harness __service machineAddons`, in the devices'
 * process): the same handler as in the core's process (services/machineAddons.ts). It asks the core only where this
 * daemon runs, for this machine's id; what it holds is RAM, bounded as v1's add-ons are.
 */
import { startMachineAddons } from './machineAddons.js'
import { runServiceProcess, type ServiceProcess } from './process.js'
import { processCoreApi } from './processCoreApi.js'

export interface MachineAddonsServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
}

export function runMachineAddonsService(options: MachineAddonsServiceOptions): ServiceProcess {
  const core = processCoreApi(options.dataDir, 'machineAddons')
  // This machine's id is the master's to give: the core's own answer would need a round trip per request.
  const machineId = options.machineId
  return (options.run ?? runServiceProcess)({
    name: 'machineAddons',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: startMachineAddons({ ...core, daemon: { ...core.daemon, machineId: () => machineId } }),
  })
}
