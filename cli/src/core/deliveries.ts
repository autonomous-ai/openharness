/**
 * Delivered turns: text a feature writes into an agent under a delivery id of its own, and what becomes of
 * it. The Wi-Fi device, the teams and the orchestrator each deliver their turns this way, one path for the
 * three (docs/design/2026-10-06-core-boundary-next.md, "Experimental features: move only"). It is what
 * lets a feature that delivers turns run in a process of its own: before, each was a slot on the socket
 * (`onMessage`, `onCancelOrchestratorMessage`, `orchestratorDelivery`, `teamDelivery`) that only code in
 * the core's process could call.
 *
 * In the core's process a service delivers through `turns` (`CoreApi.turns`) and hears every delivery's
 * progress, as the socket's features always did: each ignores the ids that are not its own. A service in its
 * own process delivers by asking the core (`answer`, services/turnsLink.ts) and hears only its own
 * deliveries, told to it until it has them: a delivery it made is its business and no other process's.
 */
import type { CoreApi, TurnDelivery } from './api.js'

type Payload = Record<string, unknown>

/** The most deliveries whose maker is remembered: past it the oldest is forgotten, and what becomes of it
 *  is told to no process. A delivery settles within minutes (its queue item lives five), and a process
 *  makes a few a minute. */
export const KEPT_DELIVERERS = 10_000

export interface DeliveriesDeps {
  /** Write the text into the agent under the delivery id (core/input.ts `submitAgent`). */
  submit(agentId: string, text: string, deliveryId: string): void
  /** Take back a delivery not yet being written (`SessionInputController.cancelDelivery`). */
  cancel(deliveryId: string): boolean
  /** Tell a service in its own process what became of a delivery it made. */
  tell(service: string, event: TurnDelivery): void
  /** The services in their own processes that may deliver turns: writing into an agent is no other's to ask. */
  deliverers: ReadonlySet<string>
  log?: (line: string) => void
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export function createDeliveries(deps: DeliveriesDeps) {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const listeners = new Set<(event: TurnDelivery) => void>()
  /** Which process made each delivery, oldest first. */
  const makers = new Map<string, string>()

  const turns: Pick<CoreApi['turns'], 'deliver' | 'cancelDelivery' | 'onDelivery'> = {
    deliver: (agentId, content, deliveryId) => deps.submit(agentId, content, deliveryId),
    cancelDelivery: (deliveryId) => deps.cancel(deliveryId),
    onDelivery: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  return {
    /** The delivery members of the core's own `CoreApi`, for the services in its process. */
    turns,

    /** The core's input says what became of a delivery: every listener here hears it, each guarded, and the
     *  process that made it is told. A listener that throws costs that listener the event, never the input
     *  that said it or another listener. */
    settled(event: TurnDelivery): void {
      for (const listener of listeners) {
        try { listener(event) } catch (error) {
          log(`[deliveries] a listener failed on ${event.deliveryId.slice(0, 40)} · ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const maker = makers.get(event.deliveryId)
      if (maker) deps.tell(maker, event)
    },

    /** A service in its own process delivering a turn, or taking one back (`service_query`): null when the
     *  query is not one of these. Refused for a service that is not a deliverer. */
    answer(service: string, query: string, payload: Payload): Payload | null {
      if (query !== 'deliver' && query !== 'cancel_delivery') return null
      if (!deps.deliverers.has(service)) return { error: 'NOT_A_DELIVERER' }
      const deliveryId = text(payload.deliveryId)
      if (!deliveryId) return { error: 'INVALID_DELIVERY' }
      if (query === 'cancel_delivery') return { cancelled: deps.cancel(deliveryId) }
      const agentId = text(payload.agentId)
      if (!agentId || typeof payload.text !== 'string') return { error: 'INVALID_DELIVERY' }
      // Known before it is written: the input says `queued` as it takes it, and that is the maker's to hear.
      makers.delete(deliveryId)
      makers.set(deliveryId, service)
      if (makers.size > KEPT_DELIVERERS) makers.delete(makers.keys().next().value!)
      deps.submit(agentId, payload.text, deliveryId)
      return {}
    },
  }
}

export type Deliveries = ReturnType<typeof createDeliveries>
