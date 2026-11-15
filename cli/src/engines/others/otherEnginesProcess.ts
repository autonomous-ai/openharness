/**
 * The worker of the fourteen engines besides Claude Code and Codex (`engine-others`): one process for all of them,
 * started on demand by the master's service supervisor like theirs (harnessd/services.ts `SERVICE_HOSTS`). It reads their
 * history and last turns, and follows their live conversations (engines/others/streams.ts). What it runs of an engine is
 * that engine's own code, loaded on its first use (engines/inProcess.ts), so an engine nobody runs costs it nothing.
 *
 * It holds no core capability: the core sends it snapshots and reads what it answers, bounded and checked, and
 * denies every query it might make (core/engines/readers.ts `answer`). What it follows is the core's: a core that goes
 * takes its streams with it, and the next one opens its own.
 */
import { runServiceProcess, type ServiceProcess } from '../../services/process.js'
import type { ServiceRequests } from '../../core/api.js'
import type { ServiceProcessOptions } from '../../serviceProcess.js'
import { Watcher } from '../../watcher/watcher.js'
import { OTHER_ENGINES_SERVICE } from '../otherEngines.js'
import { createReplyParts, otherReaderRequests } from './readerRequests.js'
import { otherStreamRequests } from './streamRequests.js'
import { createOtherStreams } from './streams.js'

export interface OtherEnginesOptions extends ServiceProcessOptions {
  run?: typeof runServiceProcess
  requests?: ServiceRequests
}

/** The core's own asking, as its link to the process gives it: the owner, on this computer, from no client's connection. */
const THE_CORE = { owner: true, local: true } as const

/**
 * The reads and the live streams, sharing the replies kept in parts: what the process serves, and what the core's
 * inline path asks in its own process (services/inline.ts) under a master too old to run them, each within its wait.
 */
export function otherEngineRequests(watcher: Watcher = new Watcher()) {
  const parts = createReplyParts()
  const streams = createOtherStreams({ watcher })
  const requests: ServiceRequests = { ...otherReaderRequests({ parts }), ...otherStreamRequests({ streams, parts }) }
  return {
    requests,
    clear: () => streams.clear(),
    call(type: string, payload: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>> {
      const handle = Object.hasOwn(requests, type) ? requests[type] : undefined
      if (!handle) return Promise.resolve({ error: 'UNKNOWN_REQUEST' })
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<Record<string, unknown>>((resolve) => { timer = setTimeout(() => resolve({ error: 'SERVICE_UNAVAILABLE' }), waitMs) })
      return Promise.race([Promise.resolve().then(() => handle(payload, THE_CORE)).then(
        (answer) => answer as Record<string, unknown>, () => ({ error: 'SERVICE_FAILED' })), late]).finally(() => clearTimeout(timer))
    },
  }
}

export function runOtherEngines(options: OtherEnginesOptions): ServiceProcess {
  const served = options.requests ? null : otherEngineRequests()
  return (options.run ?? runServiceProcess)({
    name: OTHER_ENGINES_SERVICE, socketPath: options.socketPath, machineId: options.machineId, token: options.token,
    requests: options.requests ?? served!.requests,
    onDisconnected: () => served?.clear(),
  })
}
