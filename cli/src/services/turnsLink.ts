/**
 * Delivered turns, as a service in its own process makes them (the core's side is core/deliveries.ts): it
 * asks the core to write each one and to take one back, and the core tells it what became of each of its
 * own (`service_event` kind `delivery`), which it hands to whoever listens here.
 *
 * Asked over the one link the service has, in order: a delivery and the cancel that follows it reach the
 * core in the order they were made, so a cancel never arrives before the turn it takes back. Whether a
 * cancel took a delivery back cannot be answered at once here (`cancelDelivery` says false); a caller that
 * can wait asks `cancel`. A delivery the core never heard of (the link went before it was answered) is said
 * to be `unknown`: it may have been written, and nothing here can tell.
 *
 * The core also tells a service that asked for them (`TURN_END_HEARERS`) each live turn's end (`service_event` kind
 * `turn_end`), which it hands to whoever listens here (`turns.onEnd`). An end the link misses is gone: it costs that turn
 * what its listener would have done at the end, and the core never waits for it.
 */
import type { CoreApi, TurnDelivery, TurnEnd } from '../core/api.js'

type Payload = Record<string, unknown>
type DeliveryTurns = Pick<CoreApi['turns'], 'deliver' | 'cancelDelivery' | 'onDelivery' | 'onEnd'>

const STATES: ReadonlySet<string> = new Set(['queued', 'delivered', 'started', 'rejected', 'unknown'])

/** A delivery's progress as the core sent it, or null when it is not one. */
export function deliveryIn(payload: Payload): TurnDelivery | null {
  const event = payload.kind === 'delivery' ? payload.event as Payload | undefined : undefined
  if (!event || typeof event.deliveryId !== 'string' || typeof event.sessionId !== 'string' || !STATES.has(String(event.state))) return null
  return {
    deliveryId: event.deliveryId,
    sessionId: event.sessionId,
    state: event.state as TurnDelivery['state'],
    ...(typeof event.reason === 'string' ? { reason: event.reason } : {}),
  }
}

/** A turn's end as the core sent it, or null when it is not one. */
export function endIn(payload: Payload): TurnEnd | null {
  const event = payload.kind === 'turn_end' ? payload.event as Payload | undefined : undefined
  if (!event || typeof event.agentId !== 'string' || typeof event.sessionId !== 'string' || typeof event.aborted !== 'boolean') return null
  return { agentId: event.agentId, sessionId: event.sessionId, aborted: event.aborted }
}

/** `query` asks the core (`CoreConnection.query`, services/process.ts); it rejects when the link goes. */
export function turnsLink(query: (query: string, payload: Payload) => Promise<Payload>, log: (line: string) => void = (line) => console.warn(line)) {
  const listeners = new Set<(event: TurnDelivery) => void>()
  const endListeners = new Set<(event: TurnEnd) => void>()
  const tell = (event: TurnDelivery): void => {
    for (const listener of listeners) {
      try { listener(event) } catch (error) {
        log(`[deliveries] a listener failed on ${event.deliveryId.slice(0, 40)} · ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  const cancel = async (deliveryId: string): Promise<boolean> =>
    (await query('cancel_delivery', { deliveryId }).catch((): Payload => ({}))).cancelled === true
  const turns: DeliveryTurns = {
    deliver: (agentId, text, deliveryId, options) => {
      void query('deliver', { agentId, text, deliveryId, ...(options?.answersQuestion ? { answersQuestion: true, writtenAt: options.writtenAt } : {}) }).then(
        (answer) => { if (typeof answer.error === 'string') tell({ deliveryId, sessionId: agentId, state: 'rejected', reason: answer.error }) },
        () => tell({ deliveryId, sessionId: agentId, state: 'unknown', reason: 'The core did not confirm this delivery.' }),
      )
    },
    // The core decides, later than this answer can wait: false here, and a delivery it did take back is
    // heard `rejected` (`cancelled`), after the cancel, on the same link.
    cancelDelivery: (deliveryId) => { void cancel(deliveryId); return false },
    onDelivery: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    onEnd: (listener) => {
      endListeners.add(listener)
      return () => { endListeners.delete(listener) }
    },
  }
  return {
    turns,
    /** Take back a delivery and hear whether the core could, for a caller that can wait for the answer. */
    cancel,
    /** What the core told this service: true when it was a delivery's progress or a turn's end, now heard here. */
    heard(payload: Payload): boolean {
      const end = endIn(payload)
      if (end) {
        for (const listener of endListeners) {
          try { listener(end) } catch (error) {
            log(`[turns] a turn-end listener failed on ${end.agentId.slice(0, 40)} · ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return true
      }
      const event = deliveryIn(payload)
      if (!event) return false
      tell(event)
      return true
    },
  }
}
