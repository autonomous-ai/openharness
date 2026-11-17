/**
 * Whether each engine worker is linked to the core right now, and a bounded wait for one to be. A read
 * refused because its worker restarted under it (`ENGINE_STALE_REPLY`, `ENGINE_UNAVAILABLE`) can wait here for
 * the new link and be made again: a read is idempotent. A write is never retried this way.
 */
import { workerEngine, workerService } from '../../engines/worker/protocol.js'

export function createEngineLinks() {
  const linked = new Set<string>()
  const waiting = new Map<string, Array<() => void>>()
  return {
    connected(service: string): void {
      linked.add(service)
      for (const wake of waiting.get(service)?.splice(0) ?? []) wake()
    },
    disconnected(service: string): void { linked.delete(service) },
    /** Once the engine's worker is linked, or after `ms`, whichever comes first. */
    ready(engine: string, ms: number): Promise<void> {
      if (!workerEngine(engine) || linked.has(workerService(engine))) return Promise.resolve()
      const service = workerService(engine)
      return new Promise<void>(resolve => {
        const timer = setTimeout(wake, ms)
        function wake() {
          clearTimeout(timer)
          const pending = waiting.get(service), index = pending?.indexOf(wake) ?? -1
          if (index >= 0) pending!.splice(index, 1)
          if (!pending?.length) waiting.delete(service)
          resolve()
        }
        waiting.set(service, [...waiting.get(service) ?? [], wake])
      })
    },
  }
}

export type EngineLinks = ReturnType<typeof createEngineLinks>
