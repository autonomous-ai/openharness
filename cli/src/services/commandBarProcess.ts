/**
 * The command bar in its own process (`harness __service commandBar`): the same handlers as in the core's
 * process (services/commandBar.ts). It asks the core nothing; the OpenRouter key it reads, the JEV calls it
 * makes and the zod schemas it validates them with are this process's alone.
 */
import { startCommandBar } from './commandBar.js'
import { runServiceProcess, type ServiceProcess } from './process.js'
import { processCoreApi } from './processCoreApi.js'

export interface CommandBarServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for a command bar that calls no JEV. */
  start?: typeof startCommandBar
}

export function runCommandBarService(options: CommandBarServiceOptions): ServiceProcess {
  return (options.run ?? runServiceProcess)({
    name: 'commandBar',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: (options.start ?? startCommandBar)(processCoreApi(options.dataDir, 'commandBar')),
  })
}
