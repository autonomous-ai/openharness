/**
 * Memory in its own process (`harness __service memory`): the same handlers as in the core's process
 * (services/memory.ts). It asks the core nothing; the package command it runs is this process's alone.
 */
import { startMemory } from './memory.js'
import { runServiceProcess, type ServiceProcess } from './process.js'
import { processCoreApi } from './processCoreApi.js'

export interface MemoryServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for a memory service that runs no package command. */
  start?: typeof startMemory
}

export function runMemoryService(options: MemoryServiceOptions): ServiceProcess {
  return (options.run ?? runServiceProcess)({
    name: 'memory',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: (options.start ?? startMemory)(processCoreApi(options.dataDir, 'memory')),
  })
}
