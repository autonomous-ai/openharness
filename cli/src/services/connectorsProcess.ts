/**
 * Connected services in their own process (`harness __service connectors`, in the edge host): the same
 * bridge and `connectors` handler as in the core's process (services/connectors.ts). It asks the core
 * nothing; the bridge's listener and the services' network calls are this process's alone.
 */
import { runServiceProcess, type ServiceProcess } from './process.js'
import { processCoreApi } from './processCoreApi.js'
import { startConnectors } from './connectors.js'

export interface ConnectorsServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for one that opens no port and reads no home. */
  start?: typeof startConnectors
}

export function runConnectorsService(options: ConnectorsServiceOptions): ServiceProcess {
  return (options.run ?? runServiceProcess)({
    name: 'connectors',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: (options.start ?? startConnectors)(processCoreApi(options.dataDir, 'connectors')),
  })
}
