/**
 * The Harness OS computer's management in its own process (`harness __service osDevice`, in the edge host): the
 * same handler as in the core's process (services/osDevice.ts). It asks the core nothing; the commands it runs
 * are this process's alone, and those that must outlive it (an update, a Wi-Fi join) run detached.
 */
import { startOsDevice } from './osDevice.js'
import { runServiceProcess, type ServiceProcess } from './process.js'
import { processCoreApi } from './processCoreApi.js'

export interface OsDeviceServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for one that runs no command. */
  start?: typeof startOsDevice
}

export function runOsDeviceService(options: OsDeviceServiceOptions): ServiceProcess {
  return (options.run ?? runServiceProcess)({
    name: 'osDevice',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: (options.start ?? startOsDevice)(processCoreApi(options.dataDir, 'osDevice')),
  })
}
