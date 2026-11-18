/**
 * The home bridge in its own process (`harness __service homeBridge`, in the edge host): the same service as in the core's
 * process (services/homeBridge.ts), on this process's data folder and socket. A core that starts again makes its socket
 * again, so each connection to it is a check, which serves the old paths once more. The apps ask it nothing.
 */
import { startHomeBridge } from './homeBridge.js'
import { runServiceProcess, type ServiceProcess } from './process.js'
import { processCoreApi } from './processCoreApi.js'

export interface HomeBridgeServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests. */
  start?: typeof startHomeBridge
}

export function runHomeBridgeService(options: HomeBridgeServiceOptions): ServiceProcess {
  const bridge = (options.start ?? startHomeBridge)(processCoreApi(options.dataDir, 'homeBridge'), { socket: options.socketPath })
  const service = (options.run ?? runServiceProcess)({
    name: 'homeBridge',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: {},
    onConnected: () => bridge.connected(),
  })
  return { stop: () => { bridge.stop(); return service.stop() } }
}
