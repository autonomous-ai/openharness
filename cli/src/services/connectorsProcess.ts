/** Connected-service bridge and profile projection in edge. Only sync/status metadata crosses the core. */
import { emptyPorts, type BackendNotice } from '../core/api.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
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
  let core: CoreConnection | null = null
  const ask = (query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> =>
    core ? core.query(query, payload) : Promise.reject(new Error('not connected to the core'))
  const listeners = new Set<(notice: BackendNotice) => void>()
  const api = processCoreApi(options.dataDir, 'connectors', {
    onNotice: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  })
  const connectorSync = async (refresh: boolean) => {
    const answer = await ask('connector_vault', { op: 'sync', refresh })
    if (typeof answer.shared !== 'boolean' || answer.error) throw new Error('CONNECTORS_SYNC_UNAVAILABLE')
    return { shared: answer.shared }
  }
  const ports = emptyPorts()
  const answers = (options.start ?? startConnectors)(api, ports, { connectorSync })
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
    onConnected: (connection) => {
      core = connection
      for (const listener of listeners) listener({ type: 'connectors_changed', revision: 0 })
    },
    onDisconnected: () => { core = null },
  })
}
