import { join } from 'node:path'
import { startEngineSetup } from './engineSetup.js'
import { runServiceProcess, type ServiceProcess } from './process.js'

export function runEngineSetupService(options: {
  dataDir: string; socketPath: string; machineId: string; token: string
  run?: typeof runServiceProcess; start?: typeof startEngineSetup
}): ServiceProcess {
  const setup = (options.start ?? startEngineSetup)(join(options.dataDir, 'native-installations'))
  const service = (options.run ?? runServiceProcess)({
    name: 'engineSetup', socketPath: options.socketPath, machineId: options.machineId, token: options.token,
    requests: setup.requests, onDisconnected: setup.stop,
  })
  return { stop() { setup.stop(); return service.stop() } }
}
