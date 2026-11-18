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
 */
import type { CoreApi, TurnDelivery } from '../core/api.js'
import type { SessionInputProgress } from '../lib/sessionInput.js'

type Payload = Record<string, unknown>
type DeliveryTurns = Pick<CoreApi['turns'], 'deliver' | 'cancelDelivery' | 'onDelivery'>

const STATES: ReadonlySet<string> = new Set(['queued', 'delivered', 'started', 'rejected', 'unknown'])
const INPUT_PHASES = new Set(['waiting_for_writer', 'waiting_for_user', 'waiting_for_turn', 'dispatching', 'written', 'composer_available', 'unconfirmed'])

/** No malformed or unbounded service fact enters a component's receipt state. */
export function inputIn(payload: Payload): SessionInputProgress | null {
  const event = payload.kind === 'input' && payload.event && typeof payload.event === 'object' ? payload.event as Payload : null
  const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200
  if (!event || !id(event.agentId) || !id(event.deliveryId) || !['composer', 'turn'].includes(String(event.when))
    || !INPUT_PHASES.has(String(event.phase)) || event.sessionId !== undefined && (typeof event.sessionId !== 'string' || event.sessionId.length > 200)
    || event.duringTurn !== undefined && typeof event.duringTurn !== 'boolean'
    || event.activity !== undefined && (!event.activity || typeof event.activity !== 'object' || Array.isArray(event.activity)
      || typeof (event.activity as Payload).epoch !== 'string' || !(event.activity as Payload).epoch || String((event.activity as Payload).epoch).length > 128
      || !Number.isSafeInteger((event.activity as Payload).revision) || Number((event.activity as Payload).revision) < 0)
    || event.content !== undefined && (typeof event.content !== 'string' || Buffer.byteLength(event.content) > 24 * 1024)) return null
  return { agentId: event.agentId, deliveryId: event.deliveryId, when: event.when as SessionInputProgress['when'],
    phase: event.phase as SessionInputProgress['phase'], ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId as string }),
    ...(event.duringTurn === undefined ? {} : { duringTurn: event.duringTurn as boolean }),
    ...(event.activity === undefined ? {} : { activity: { epoch: (event.activity as Payload).epoch as string, revision: (event.activity as Payload).revision as number } }),
    ...(event.content === undefined ? {} : { content: event.content as string }) }
}

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

/** `query` asks the core (`CoreConnection.query`, services/process.ts); it rejects when the link goes. */
export function turnsLink(query: (query: string, payload: Payload) => Promise<Payload>, log: (line: string) => void = (line) => console.warn(line)) {
  const listeners = new Set<(event: TurnDelivery) => void>()
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
      // `quiet`: a core older than this process ignores it, and the turn it starts tells as any turn does.
      void query(options?.when ? 'input' : 'deliver', { agentId, text, deliveryId,
        ...(options?.when ? { version: 1, when: options.when } : {}), ...(options?.quiet ? { quiet: true } : {}) }).then(
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
  }
  return {
    turns,
    /** Take back a delivery and hear whether the core could, for a caller that can wait for the answer. */
    cancel,
    /** What the core told this service: true when it was a delivery's progress, now heard here. */
    heard(payload: Payload): boolean {
      const event = deliveryIn(payload)
      if (!event) return false
      tell(event)
      return true
    },
  }
}
