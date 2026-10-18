/**
 * Shared machines in their own process (`harness __service sharedMachines`, in the edge host): the same
 * `shared_machines` handler as in the core's process (services/sharedMachines.ts). It asks the core one
 * thing, `shared_machines` (core/sharedMachinesQueries.ts): this machine's sharing and the machines shared
 * with this account, read and written through the core's sign-in, and the gateway's trust stores, which
 * only the gateway holds. The core tells it `machines_changed` (`service_event` kind `notice`).
 */
import type { BackendNotice } from '../core/api.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { processCoreApi } from './processCoreApi.js'
import { startSharedMachines } from './sharedMachines.js'
import { sharedMachinesPortOf } from '../lib/sharedMachinesPort.js'

export interface SharedMachinesServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for one that keeps no timer. */
  start?: typeof startSharedMachines
}

export function runSharedMachinesService(options: SharedMachinesServiceOptions): ServiceProcess {
  let core: CoreConnection | null = null
  const ask = (query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> =>
    core ? core.query(query, payload) : Promise.reject(new Error('not connected to the core'))
  const listeners = new Set<(notice: BackendNotice) => void>()
  const api = processCoreApi(options.dataDir, 'sharedMachines', {
    onNotice: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  })
  // A refusal or no core reads as the backend unreachable: the next round tries again.
  const port = sharedMachinesPortOf((op, payload = {}) => ask('shared_machines', { ...payload, op }).catch((error: unknown) => ({ error: String(error) })))
  return (options.run ?? runServiceProcess)({
    name: 'sharedMachines',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: (options.start ?? startSharedMachines)(api, { port }),
    onEvent: (payload) => {
      if (payload.kind !== 'notice' || !payload.notice || typeof payload.notice !== 'object') return
      for (const listener of listeners) listener(payload.notice as BackendNotice)
    },
    onConnected: (connection) => { core = connection },
    onDisconnected: () => { core = null },
  })
}
