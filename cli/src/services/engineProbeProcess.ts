/**
 * The engine probe in its own process (`harness __service engineProbe`, in the edge host): the same handler as in
 * the core's process (services/engineProbe.ts). It asks the core nothing: which engines this machine has is read
 * from the machine, and the login shells a probe starts are this process's alone.
 */
import { startEngineProbe } from './engineProbe.js'
import { runServiceProcess, type ServiceProcess } from './process.js'
import { processCoreApi } from './processCoreApi.js'

export interface EngineProbeServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for one that starts no shell. */
  start?: typeof startEngineProbe
}

export function runEngineProbeService(options: EngineProbeServiceOptions): ServiceProcess {
  return (options.run ?? runServiceProcess)({
    name: 'engineProbe',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: (options.start ?? startEngineProbe)(processCoreApi(options.dataDir, 'engineProbe')),
  })
}
