/**
 * Connected services in their own process (`harness __service connectors`, in the edge host): the same
 * bridge and `connectors` handler as in the core's process (services/connectors.ts). The bridge's listener
 * and the services' network calls are this process's alone. It asks the core one thing, `connector_vault`
 * (core/connectorsQueries.ts): the account's sealed connections, read and written through the core's
 * sign-in and sealed by the gateway, which holds the identity. The core tells it `connectors_changed` and
 * `device_keys_changed` (`service_event` kind `notice`), and asks it, as an agent launches on a profile home, to write
 * that home's entries (`syncProfileHome`, the port's member, sent by the core alone: core/connectorsLink.ts).
 */
import { emptyPorts, type BackendNotice } from '../core/api.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { processCoreApi } from './processCoreApi.js'
import { startConnectors } from './connectors.js'
import { vaultPortOf } from '../lib/connectors/vaultSync.js'

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
  let core: CoreConnection | null = null
  const ask = (query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> =>
    core ? core.query(query, payload) : Promise.reject(new Error('not connected to the core'))
  const listeners = new Set<(notice: BackendNotice) => void>()
  const api = processCoreApi(options.dataDir, 'connectors', {
    onNotice: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  })
  // A refusal or no core reads as the backend unreachable: the next notice or round tries again.
  const vaultPort = vaultPortOf((op, payload = {}) => ask('connector_vault', { ...payload, op }).catch((error: unknown) => ({ error: String(error) })))
  const ports = emptyPorts()
  const answers = (options.start ?? startConnectors)(api, ports, { vaultPort })
  if (!ports.connectors) throw new Error('connected services did not start')
  const connectors = ports.connectors
  return (options.run ?? runServiceProcess)({
    name: 'connectors',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: {
      ...answers,
      syncProfileHome: async (payload) => {
        const { engine, folder } = payload
        if ((engine !== 'claude' && engine !== 'codex') || typeof folder !== 'string') return { names: [] }
        return { names: await connectors.syncProfileHome(engine, folder) }
      },
    },
    onEvent: (payload) => {
      if (payload.kind !== 'notice' || !payload.notice || typeof payload.notice !== 'object') return
      for (const listener of listeners) listener(payload.notice as BackendNotice)
    },
    onConnected: (connection) => { core = connection },
    onDisconnected: () => { core = null },
  })
}
