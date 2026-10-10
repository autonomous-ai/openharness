/**
 * The router in its own process (`harness __service router`): the same handler as in the core's process
 * (services/router.ts). It asks the core nothing; the OpenRouter key it reads and the Jev calls it makes
 * are this process's alone.
 */
import { startRouter } from './router.js'
import { runServiceProcess, type ServiceProcess } from './process.js'
import { processCoreApi } from './processCoreApi.js'

export interface RouterServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for a router that runs no model. */
  start?: typeof startRouter
}

export function runRouterService(options: RouterServiceOptions): ServiceProcess {
  return (options.run ?? runServiceProcess)({
    name: 'router',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: (options.start ?? startRouter)(processCoreApi(options.dataDir, 'router')),
  })
}
