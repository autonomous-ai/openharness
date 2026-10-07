/** Shell policy and durable receipts run in the edge host. Every launch and live read goes to the core. */
import type { CoreApi } from '../core/api.js'
import { startShell } from './shell.js'
import { processCoreApi } from './processCoreApi.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'

type Payload = Record<string, unknown>
export function shellCoreApi(dataDir: string, ask: (query: string, payload: Payload) => Promise<Payload>): CoreApi {
  const core = processCoreApi(dataDir, 'shell')
  core.terminals.open = async (request) => {
    const answer = await ask('open', { ...request })
    if (answer.ok === true && typeof answer.agentId === 'string' && answer.agentId) return { ok: true, agentId: answer.agentId }
    if (answer.ok === false && typeof answer.error === 'string') return { ok: false, error: answer.error,
      ...(typeof answer.detail === 'string' ? { detail: answer.detail } : {}) }
    // A missing reply might follow a successful launch. The receipt must stay unconfirmed, never retry it.
    throw new Error('the core did not confirm the terminal launch')
  }
  core.terminals.describe = async (agentId) => {
    const answer = await ask('describe', { agentId })
    if (answer.error) throw new Error('the core did not answer the terminal read')
    const agent = answer.agent
    return agent && typeof agent === 'object' && !Array.isArray(agent) ? agent as Payload : null
  }
  core.terminals.visitStatus = async (agentId) => ({ exited: (await ask('visitStatus', { agentId })).exited === true })
  return core
}

export interface ShellServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  run?: typeof runServiceProcess
  start?: typeof startShell
}
export function runShellService(options: ShellServiceOptions): ServiceProcess {
  let connection: CoreConnection | null = null
  const core = shellCoreApi(options.dataDir, (query, payload) => {
    if (!connection) return Promise.reject(new Error('the core is disconnected'))
    return connection.query(query, payload)
  })
  return (options.run ?? runServiceProcess)({
    name: 'shell', socketPath: options.socketPath, machineId: options.machineId, token: options.token,
    requests: (options.start ?? startShell)(core),
    onConnected: linked => { connection = linked },
    onDisconnected: () => { connection = null },
  })
}
