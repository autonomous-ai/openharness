import { join } from 'node:path'
import { createAgentUsage } from './agentUsage.js'
/**
 * Account usage in its own process (`harness __service usage`, in the edge host): `usage_read`, the same
 * handler as in the core's process (services/usage.ts). It asks the core nothing. Its two vendor round
 * trips and the Keychain reads through `security` are this process's alone.
 */
import { runServiceProcess, type ServiceProcess } from './process.js'
import { processCoreApi } from './processCoreApi.js'
import { startUsage } from './usage.js'

export interface UsageServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for usage that reads no Keychain and calls no vendor. */
  start?: typeof startUsage
}

export function runUsageService(options: UsageServiceOptions): ServiceProcess {
  const reader = createAgentUsage(join(options.dataDir, 'agent-token-usage'))
  const service = (options.run ?? runServiceProcess)({
    name: 'usage',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: { ...(options.start ?? startUsage)(processCoreApi(options.dataDir, 'usage')), agentUsage: payload => reader.read(payload) },
  })
  return { stop: () => { service.stop(); reader.stop() } }
}
