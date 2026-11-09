/**
 * Live turn ends, told to whoever listens: the services in the core's process, and the services in their own processes
 * that asked for them (`TURN_END_HEARERS`). The event funnel says each one as it happens (core/turns/funnel.ts); a turn read
 * back from a transcript at attach is never one. The core keeps nothing of them and waits for nobody: a process that is
 * not connected misses an end, and costs that turn the answer it would have posted, nothing else.
 *
 * Every real end is told, a turn that ends just before a queued follow-up starts included: each message a person sends an
 * agent is its own turn, and the Swarm host answers each in its own order (superTabs/agentReplies.ts).
 */
import type { TurnEnd } from '../api.js'

export interface TurnEndsDeps {
  /** The services in their own processes that want each end. */
  hearers: ReadonlySet<string>
  /** Tell one of them (core/serviceLinks.ts `notify`); a process that is not connected hears nothing. */
  tell(service: string, event: TurnEnd): void
  log?: (line: string) => void
}

export function createTurnEnds(deps: TurnEndsDeps) {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const listeners = new Set<(event: TurnEnd) => void>()
  return {
    /** `CoreApi.turns.onEnd`. */
    onEnd(listener: (event: TurnEnd) => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** A live turn ended. A listener that throws costs that listener this end, never another listener or the funnel. */
    ended(event: TurnEnd): void {
      for (const listener of listeners) {
        try { listener(event) } catch (error) {
          log(`[turns] a turn-end listener failed on ${event.agentId.slice(0, 40)} · ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      for (const service of deps.hearers) deps.tell(service, event)
    },
  }
}

export type TurnEnds = ReturnType<typeof createTurnEnds>
