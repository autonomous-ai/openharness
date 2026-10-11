/**
 * The router in its own process (`harness __service router`): the same handler as in the core's process
 * (services/router.ts). The person's own OpenRouter key and the Jev calls made with it are this process's
 * alone; a call on Harness's key goes through the core, which holds the sign-in (`backend`).
 */
import { startRouter } from './router.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
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
  let core: CoreConnection | null = null
  const ask = (query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> =>
    core ? core.query(query, payload) : Promise.reject(new Error('not connected to the core'))
  return (options.run ?? runServiceProcess)({
    name: 'router',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: (options.start ?? startRouter)(processCoreApi(options.dataDir, 'router', { ask })),
    onConnected: (connection) => { core = connection },
    onDisconnected: () => { core = null },
  })
}
