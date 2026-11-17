/**
 * The worker of the fourteen engines besides Claude Code and Codex (`engine-others`): one process for all of them,
 * started on demand by the master's service supervisor like theirs (harnessd/services.ts `SERVICE_HOSTS`). It reads their
 * history and last turns, and follows their live conversations (engines/others/streams.ts). What it runs of an engine is
 * that engine's own code, loaded on its first use (engines/inProcess.ts), so an engine nobody runs costs it nothing.
 *
 * It holds no core capability: the core sends it snapshots and reads what it answers, bounded and checked, and
 * denies every query except writes under a core-issued question grant. What it follows is the core's: a core that goes
 * takes its streams with it, and the next one opens its own.
 */
import { runServiceProcess, type ServiceProcess, type CoreConnection } from '../../services/process.js'
import type { ServiceRequests } from '../../core/api.js'
import type { ServiceProcessOptions } from '../../serviceProcess.js'
import { Watcher } from '../../watcher/watcher.js'
import { OTHER_ENGINES_SERVICE } from '../otherEngines.js'
import { createReplyParts, otherReaderRequests } from './readerRequests.js'
import { otherStreamRequests } from './streamRequests.js'
import { createOtherStreams } from './streams.js'
import { otherRuntimeRequests } from './runtimeRequests.js'
import { STREAM_OPEN, STREAM_VERSION } from '../worker/otherStreamProtocol.js'

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
export function otherEngineRequests(watcher: Watcher = new Watcher(), query: (query: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>> = async () => ({ error: 'SERVICE_UNAVAILABLE' })) {
  const runtime = otherRuntimeRequests({ query })
  const parts = createReplyParts()
  const streams = createOtherStreams({ watcher })
  const handlers: ServiceRequests = { ...otherReaderRequests({ parts }), ...otherStreamRequests({ streams, parts }), ...runtime.requests }
  const active = new Set<AbortController>()
  let stopping: Promise<void> = Promise.resolve()
  const requests: ServiceRequests = Object.fromEntries(Object.entries(handlers).map(([name, handle]) => [name,
    async (payload, asker, signal) => {
      const closed = new AbortController()
      const abort = () => closed.abort()
      if (signal?.aborted) abort()
      signal?.addEventListener('abort', abort, { once: true })
      active.add(closed)
      try {
        // A reconnect may arrive while the old watcher is still closing its filesystem handles.
        if (name === STREAM_OPEN) await stopping
        if (closed.signal.aborted) return { version: STREAM_VERSION, error: 'ENGINE_UNAVAILABLE' }
        return await handle(payload, asker, closed.signal)
      } finally { active.delete(closed); signal?.removeEventListener('abort', abort) }
    },
  ]))
  return {
    requests,
    clear: () => {
      for (const controller of active) controller.abort()
      streams.clear()
      runtime.clear()
      stopping = watcher.stop()
    },
    call(type: string, payload: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>> {
      const handle = Object.hasOwn(requests, type) ? requests[type] : undefined
      if (!handle) return Promise.resolve({ error: 'UNKNOWN_REQUEST' })
      const closed = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<Record<string, unknown>>((resolve) => { timer = setTimeout(() => { closed.abort(); resolve({ error: 'SERVICE_UNAVAILABLE' }) }, waitMs) })
      return Promise.race([Promise.resolve().then(() => handle(payload, THE_CORE, closed.signal)).then(
        (answer) => answer as Record<string, unknown>, () => ({ error: 'SERVICE_FAILED' })), late]).finally(() => clearTimeout(timer))
    },
  }
}

export function runOtherEngines(options: OtherEnginesOptions): ServiceProcess {
  let core: CoreConnection | null = null
  const served = options.requests ? null : otherEngineRequests(undefined, (query, payload) => core ? core.query(query, payload) : Promise.resolve({ error: 'SERVICE_UNAVAILABLE' }))
  return (options.run ?? runServiceProcess)({
    name: OTHER_ENGINES_SERVICE, socketPath: options.socketPath, machineId: options.machineId, token: options.token,
    requests: options.requests ?? served!.requests,
    onConnected: connected => { core = connected },
    onDisconnected: () => { core = null; served?.clear() },
  })
}
