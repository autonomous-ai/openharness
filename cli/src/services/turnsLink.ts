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
 * what its listener would have done at the end, and the core never waits for it. An end names its turn by a hash of its prompt and
 * a number, and what that turn answered is asked of the core (`turns.answerOf`).
 */
import type { CoreApi, TurnDelivery, TurnEnd } from '../core/api.js'

type Payload = Record<string, unknown>
type DeliveryTurns = Pick<CoreApi['turns'], 'deliver' | 'cancelDelivery' | 'onDelivery' | 'onEnd' | 'answerOf'>

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

/** A turn's end as the core sent it, or null when it is not one: it says which turn it was, by a prompt's hash and a number. */
export function endIn(payload: Payload): TurnEnd | null {
  const event = payload.kind === 'turn_end' ? payload.event as Payload | undefined : undefined
  if (!event || typeof event.agentId !== 'string' || typeof event.sessionId !== 'string' || typeof event.aborted !== 'boolean'
    || typeof event.prompt !== 'string' || !/^[0-9a-f]{32}$/.test(event.prompt) || !Number.isSafeInteger(event.turnId) || (event.turnId as number) < 1) return null
  return { agentId: event.agentId, sessionId: event.sessionId, aborted: event.aborted, prompt: event.prompt, turnId: event.turnId as number,
    ...event.compacted === true ? { compacted: true as const } : {} }
}

/** The core could not give the answer of a turn, named by its own code (the error it answered, or INVALID_ANSWER): read as no
 *  answer, a core without the question (an older one) or one that will not answer this process would leave every reply owed and
 *  none ever posted, with nothing in the log. */
class AnswerFailure extends Error {
  constructor(code: string) { super('The core could not give the answer of the turn.'); this.name = code }
}

/** `query` asks the core (`CoreConnection.query`, services/process.ts); it rejects when the link goes. */
export function turnsLink(query: (query: string, payload: Payload) => Promise<Payload>, log: (line: string) => void = (line) => console.warn(line)) {
  const listeners = new Set<(event: TurnDelivery) => void>()
  const endListeners = new Set<(event: TurnEnd) => void>()
  let saidNoTurn = false
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
      void query('deliver', { agentId, text, deliveryId, ...(options?.answersQuestion ? { answersQuestion: true, writtenAt: options.writtenAt } : {}), ...(options?.personsOwn ? { personsOwn: true } : {}), ...(options?.quiet ? { quiet: true } : {}) }).then(
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
    answerOf: async ({ sessionId, prompt, turnId }) => {
      const answer = await query('turn_answer', { sessionId, prompt, turnId })
      if (typeof answer.error === 'string') throw new AnswerFailure(answer.error)
      if (answer.answer === null || typeof answer.answer === 'string') return answer.answer
      throw new AnswerFailure('INVALID_ANSWER')
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
        saidNoTurn = false
        for (const listener of endListeners) {
          try { listener(end) } catch (error) {
            log(`[turns] a turn-end listener failed on ${end.agentId.slice(0, 40)} · ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return true
      }
      // A core of the release before tells a turn end that names no turn, as does one that sends it wrong: nothing here can answer for
      // it until that core is restarted. Said once, and again after a core that names its turns was heard.
      if (payload.kind === 'turn_end' && !saidNoTurn) {
        saidNoTurn = true
        log('[turns] a turn end named no turn: the core is older than this process, or sent it wrong, so no reply is posted for a turn like it until the core is restarted')
      }
      const event = deliveryIn(payload)
      if (!event) return false
      tell(event)
      return true
    },
  }
}
