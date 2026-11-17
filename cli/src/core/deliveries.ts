/**
 * Delivered turns: text a feature writes into an agent under a delivery id of its own, and what becomes of
 * it. The Wi-Fi device, Agent Messages and the orchestrator each deliver their turns this way, one path for the
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
import { randomUUID } from 'node:crypto'
import type { CoreApi, TurnDelivery } from './api.js'

type Payload = Record<string, unknown>

/** The most deliveries held while the core starts: Agent Messages' mailbox resumes a few at most. */
export const HELD_DELIVERIES = 1_000

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
  /** The turn a quiet delivery (`DeliveryOptions.quiet`) started is open in [agentId]: said once, as the input says that
   *  delivery `started` (core/turns/recaps.ts `quietTurn`); absent, nobody listens. */
  quietStarted?: (agentId: string) => void
  log?: (line: string) => void
  /** A new id, unique on this computer (an acknowledged input's); a random UUID unless a test gives one. */
  newId?: () => string
  now?: () => number
}

/**
 * How long an acknowledged input waits by default in each of its two phases: until its words are pasted (`ackMs`; the
 * daemon checks the runtime and waits for the engine and the pane first, 8.6 to 15.7 s under load on a lamp), then from
 * the paste until the engine's turn starts (`takenMs`). What `harness reply` waits by default.
 */
export const ACK_DEFAULT_MS = 30_000
/** Bounds on each phase: a second at least, so a typed line has a look to land in, and the longest wait OpenClaw's own
 *  submission check makes (three 10 s windows, lib/sessionInput.ts) with room, at most. */
export const ACK_MIN_MS = 1_000
export const ACK_MAX_MS = 120_000

const ackWindow = (value: unknown): number =>
  Math.min(ACK_MAX_MS, Math.max(ACK_MIN_MS, typeof value === 'number' && Number.isFinite(value) ? value : ACK_DEFAULT_MS))

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export function createDeliveries(deps: DeliveriesDeps) {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const listeners = new Set<(event: TurnDelivery) => void>()
  /** Which process made each delivery, oldest first. */
  const makers = new Map<string, string>()
  /**
   * What was delivered before the core's input was wired (`ready`), in order. Agent Messages' mailbox resumes
   * its queue on a timer as soon as it starts, in the core's process or in its own, and the socket held such a
   * turn back with "Agent input is not ready" until then; dropped, it would read as written and never be.
   */
  let held: Array<{ agentId: string; text: string; deliveryId: string }> | null = []
  const submit = (agentId: string, content: string, deliveryId: string): void => {
    if (!held) { deps.submit(agentId, content, deliveryId); return }
    held.push({ agentId, text: content, deliveryId })
    if (held.length > HELD_DELIVERIES) {
      const dropped = held.shift()!
      settled({ deliveryId: dropped.deliveryId, sessionId: dropped.agentId, state: 'rejected', reason: 'queue_full' })
    }
  }
  /** Take back a delivery still held, as the input would one still queued, or ask the input. */
  const cancel = (deliveryId: string): boolean => {
    const at = held?.findIndex((delivery) => delivery.deliveryId === deliveryId) ?? -1
    if (at < 0) return deps.cancel(deliveryId)
    const [taken] = held!.splice(at, 1)
    settled({ deliveryId, sessionId: taken.agentId, state: 'rejected', reason: 'cancelled' })
    return true
  }
  /** Mark a delivery in [marks], as the newest: the oldest past KEPT_DELIVERERS is forgotten, so a mark never settled cannot pile up. */
  const keep = (marks: Set<string>, deliveryId: string): void => {
    marks.delete(deliveryId)
    marks.add(deliveryId)
    if (marks.size > KEPT_DELIVERERS) marks.delete(marks.values().next().value!)
  }
  /** Quiet deliveries (`DeliveryOptions.quiet`) whose turn has not been heard to start. Kept while `queued` or only written
   *  (`delivered`): the input says `started` once the turn it typed begins. `rejected` or `unknown` takes one off and says
   *  nothing, as a turn nobody can tie to the line tells as any turn does: none is made quiet on a guess. */
  const quiet = new Set<string>()
  const settled = (event: TurnDelivery): void => {
    // One lookup in a Set that is empty unless a quiet line is on its way.
    if (event.state !== 'queued' && event.state !== 'delivered' && quiet.delete(event.deliveryId) && event.state === 'started') deps.quietStarted?.(event.sessionId)
    for (const listener of listeners) {
      try { listener(event) } catch (error) {
        log(`[deliveries] a listener failed on ${event.deliveryId.slice(0, 40)} · ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const maker = makers.get(event.deliveryId)
    if (maker) deps.tell(maker, event)
  }

  const turns: Pick<CoreApi['turns'], 'deliver' | 'cancelDelivery' | 'onDelivery'> = {
    deliver: (agentId, content, deliveryId, options) => {
      if (options?.quiet) keep(quiet, deliveryId)
      submit(agentId, content, deliveryId)
    },
    cancelDelivery: (deliveryId) => cancel(deliveryId),
    onDelivery: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  /**
   * An acknowledged input (`input_ack`, #4393): words a program on this computer types into a harness it owns, answered
   * only once the engine has taken them, so a program never reads "sent" for words that were lost. Delivered as any
   * feature's turn, under a delivery id of its own (`program:`, never `team:`), and answered at the first of: its turn
   * `started` (taken; for OpenClaw the Gateway's run, not text in the composer), `rejected` (nothing was taken), `unknown`
   * (typed, its turn never confirmed), or a deadline. Two deadlines, one per phase:
   * - [ackMs] until the words are pasted (`delivered`). A delivery not yet being written is then taken back, so a
   *   program told `cancelled: true` may send the words again; one being written is left to finish.
   * - [takenMs] from the paste until the turn starts. Past it the words are said `written`, for the program to follow
   *   (`harness wait --after`) rather than send twice.
   * Each answer is logged with both phases' times: the first numbers to warn at scale (#4393, Design).
   */
  const acknowledged = (payload: Payload, answer: (result: Payload) => void): void => {
    const agentId = text(payload.agentId)
    const content = typeof payload.text === 'string' ? payload.text : ''
    if (!agentId || !content.trim()) { answer({ error: 'INVALID_INPUT' }); return }
    const ackMs = ackWindow(payload.ackMs)
    const takenMs = ackWindow(payload.takenMs)
    const inputId = `program:${(deps.newId ?? randomUUID)()}`
    const now = deps.now ?? Date.now
    const began = now()
    let pastedAt: number | null = null
    let cancelling = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (ms: number, fire: () => void): void => {
      clearTimeout(timer)
      timer = setTimeout(fire, ms)
      timer.unref()
    }
    const finish = (result: Payload): void => {
      clearTimeout(timer)
      stop()
      const end = now()
      const phases = pastedAt === null ? `pre-paste ${end - began}ms` : `pre-paste ${pastedAt - began}ms, paste to ${String(result.state)} ${end - pastedAt}ms`
      log(`[input-ack] ${agentId.slice(0, 8)} ${String(result.state)} in ${end - began}ms (${phases})`)
      answer({ inputId, ...result })
    }
    // Pasted, and its turn not seen to start within [takenMs]: written, to be followed.
    const late = (): void => finish({ state: 'timeout', cancelled: false, written: pastedAt !== null })
    const stop = turns.onDelivery((event) => {
      if (event.deliveryId !== inputId) return
      if (event.state === 'delivered') { pastedAt = now(); arm(takenMs, late) }
      else if (event.state === 'started') finish({ state: 'taken', takenAt: now() })
      // A delivery taken back at the deadline is said `rejected` at once: the deadline's answer, not a refusal.
      else if (event.state === 'rejected') { if (!cancelling) finish({ state: 'rejected', reason: event.reason ?? 'rejected' }) }
      else if (event.state === 'unknown') finish({ state: 'unknown', reason: event.reason ?? 'unknown' })
    })
    arm(ackMs, () => {
      cancelling = true
      const cancelled = cancel(inputId)
      cancelling = false
      if (cancelled) finish({ state: 'timeout', cancelled: true, written: false })
      // Being written now: never taken back mid-paste. Its paste starts the [takenMs] window; a paste that never says
      // so is answered at the end of that window all the same.
      else arm(takenMs, late)
    })
    submit(agentId, content, inputId)
  }

  return {
    /** The delivery members of the core's own `CoreApi`, for the services in its process. */
    turns,

    acknowledged,

    /** The core's input says what became of a delivery: every listener here hears it, each guarded, and the
     *  process that made it is told. A listener that throws costs that listener the event, never the input
     *  that said it or another listener. */
    settled,

    /** The core's input is wired: what was held is written, in order, and the rest as it comes. */
    ready(): void {
      const waiting = held ?? []
      held = null
      for (const delivery of waiting) deps.submit(delivery.agentId, delivery.text, delivery.deliveryId)
    },

    /** A service in its own process delivering a turn, or taking one back (`service_query`): null when the
     *  query is not one of these. Refused for a service that is not a deliverer. */
    answer(service: string, query: string, payload: Payload): Payload | null {
      if (query !== 'deliver' && query !== 'cancel_delivery') return null
      if (!deps.deliverers.has(service)) return { error: 'NOT_A_DELIVERER' }
      const deliveryId = text(payload.deliveryId)
      if (!deliveryId) return { error: 'INVALID_DELIVERY' }
      if (query === 'cancel_delivery') return { cancelled: cancel(deliveryId) }
      const agentId = text(payload.agentId)
      if (!agentId || typeof payload.text !== 'string') return { error: 'INVALID_DELIVERY' }
      // Known before it is written: the input says `queued` as it takes it, and that is the maker's to hear.
      makers.delete(deliveryId)
      makers.set(deliveryId, service)
      if (makers.size > KEPT_DELIVERERS) makers.delete(makers.keys().next().value!)
      if (payload.quiet === true) keep(quiet, deliveryId)
      submit(agentId, payload.text, deliveryId)
      return {}
    },
  }
}

export type Deliveries = ReturnType<typeof createDeliveries>
