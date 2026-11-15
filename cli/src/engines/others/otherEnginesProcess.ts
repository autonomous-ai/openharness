/**
 * The worker of the fourteen engines besides Claude Code and Codex (`engine-others`): one process for all of them,
 * started on demand by the master's service supervisor like theirs (harnessd/services.ts `SERVICE_HOSTS`). What it runs
 * of an engine is that engine's own code, loaded on its first use (engines/inProcess.ts), so an engine nobody runs
 * costs it nothing either.
 *
 * It holds no core capability: the core sends it snapshots and reads what it answers, bounded and checked, and
 * denies every query it might make (core/engines/readers.ts `answer`).
 */
import { runServiceProcess, type ServiceProcess } from '../../services/process.js'
import type { ServiceRequests } from '../../core/api.js'
import type { ServiceProcessOptions } from '../../serviceProcess.js'
import { OTHER_ENGINES_SERVICE } from '../otherEngines.js'
import { otherReaderRequests } from './readerRequests.js'

export interface OtherEnginesOptions extends ServiceProcessOptions {
  run?: typeof runServiceProcess
  requests?: ServiceRequests
}

export function runOtherEngines(options: OtherEnginesOptions): ServiceProcess {
  return (options.run ?? runServiceProcess)({
    name: OTHER_ENGINES_SERVICE, socketPath: options.socketPath, machineId: options.machineId, token: options.token,
    requests: options.requests ?? { ...otherReaderRequests() },
  })
}
