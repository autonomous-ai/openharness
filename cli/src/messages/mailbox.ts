/**
 * Agent Messages' deliveries to this machine's own agents (docs/design/2026-10-10-agent-messages.md,
 * "Delivery"). Each waits until it is delivered; none expires. Two routes race for it, decided by one rename
 * in the pane's inbox (inbox.ts):
 * 1. the messages hook takes it at the agent's next tool call (engines/kit/messagesHook.ts), while it works;
 * 2. the core types it into an idle agent: a team delivery (`team:` id), written only into an empty composer,
 *    never over a draft, a dialog or a running turn (engines/kit/screen.ts `teamHold`), and never twice.
 * Before handing the core a typed attempt the mailbox takes the file back from the hook; a refusal that proves
 * nothing was typed gives it back, and the next attempt waits a little longer. A refusal that may have left
 * text in the composer ends the delivery there, its hook copy withdrawn: never delivered twice.
 *
 * An inbox file names the conversation it is for, and the hook delivers it to that conversation only: a pane
 * number tmux gives out again (after a reboot, or to a person's own session) never takes another's message.
 * While its harness is stopped a file is withdrawn, and put back when the harness returns.
 */
import { createHash } from 'node:crypto'
import type { TurnDelivery } from '../core/api.js'
import { isMessageHold } from '../lib/messageHolds.js'
import { TERMINAL_LEASE_REFUSED } from '../lib/terminalTypes.js'
import type { PaneInbox } from './inbox.js'
import type { DeliveryStatus, Message } from './model.js'
import type { LocalDelivery, MessageStore } from './store.js'

export const PUMP_MS = 2_000
/** The longest wait between typed attempts at an agent that keeps working. */
export const MAX_BACKOFF_MS = 30_000
/** How long a typed attempt the core never acknowledged is waited for before it is taken back: the core says
 *  `queued` as it takes any, so one it never mentioned never reached it. */
export const ATTEMPT_MS = 120_000
/**
 * How long the core may hold a typed attempt it said it queued before the mailbox takes it for one held behind a
 * running turn. The core queues a delivery while the agent's turn is open and writes it only once the turn ends
 * (lib/sessionInput.ts `submit`); one it can write now it writes within seconds, a lease wait and a slow paste
 * included. Found end to end: a message for an agent twenty seconds into a turn sat in the core's queue, out of
 * the hook's reach, and was typed at the end. Long enough that a write in progress is never taken for one.
 */
export const PARK_MS = 20_000
/** How long a parked attempt is left with the core before it is forgotten: the core may have lost it. */
export const PARKED_MAX_MS = 10 * 60_000
/** How long a finished delivery is kept: its outcome lives on in the history. */
export const FINISHED_KEEP_MS = 24 * 3600_000

/** An agent as the mailbox needs it: where its pane is, which conversation is in it, and whether it runs. */
export interface MailboxAgent { pane: string; session: string; available: boolean }

export interface MailboxDeps {
  store: MessageStore
  inbox: PaneInbox
  agent(agentId: string): MailboxAgent | null
  /** Hand a typed attempt to the core (`core.turns.deliver`). */
  deliver(agentId: string, text: string, deliveryId: string): void
  /** Null while a delivery may still be made; otherwise why it can no longer be (it left the tab, the tab
   *  turned Agent Messages off). */
  refused(delivery: LocalDelivery): string | null
  /** Whether who may message whom is known yet: until it is, nothing is typed and nothing refused. */
  ready(): boolean
  /** The text an agent reads for a delivery: the message, and the roster note when it is new to the agent. */
  text(delivery: LocalDelivery, message: Message): string
  /** A delivery changed; the store is saved after. */
  changed(status: DeliveryStatus, delivery: LocalDelivery): void
  /** Whether a typed attempt may be written changed: its process tells the core (services/messagesProcess.ts). */
  writable?(): void
  now?(): number
}

/** The reasons a refused typed attempt waits, as a person reads them. */
const WAITING: Record<string, string> = {
  team_waiting_idle: 'working: arrives at its next tool call',
  team_waiting_draft: 'someone is typing in its pane',
  team_waiting_user: 'a dialog is open in its pane',
  team_waiting_unavailable: 'its pane is unavailable',
  team_waiting_control: 'waiting to be written',
}

/** Refusals that prove nothing was typed (lib/sessionInput.ts): the attempt goes back to the hook. Any other
 *  (`enter_withheld`: typed, its Enter held back; `paste_failed`: perhaps partly typed) may have left text. */
const NOT_TYPED: ReadonlySet<string> = new Set(['agent_gone', 'runtime_gone_pre_paste', 'queue_full', 'queue_expired', 'cancelled', TERMINAL_LEASE_REFUSED])
const notTyped = (reason: string | undefined): boolean =>
  !!reason && (reason.startsWith('team_waiting_') || NOT_TYPED.has(reason) || isMessageHold(reason))

export const deliveryKey = (messageId: string, agentId: string): string =>
  `${messageId}-${createHash('sha256').update(agentId).digest('hex').slice(0, 8)}`

export class Mailbox {
  private timer: ReturnType<typeof setInterval> | null = null
  private started = false
  constructor(private readonly deps: MailboxDeps) {}
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private get local(): LocalDelivery[] { return this.deps.store.state.local }

  start(): void {
    if (this.started) return
    this.started = true
    this.takeBackAttempts()
    // Anything left taken back from a hook goes back to it, unless its delivery is over.
    for (const [pane, key] of this.deps.inbox.reclaimed()) {
      const delivery = this.local.find((d) => d.pane === pane && d.key === key)
      if (delivery?.state === 'queued') this.deps.inbox.restore(pane, key)
      else this.deps.inbox.typed(pane, key)
    }
    // Finished deliveries are only kept a day: their outcome is in the history.
    this.deps.store.state.local = this.local.filter((d) => d.state === 'queued' || this.now() - d.at < FINISHED_KEEP_MS)
    this.save()
    this.timer = setInterval(() => { try { this.pump() } catch { /* the next pump looks again */ } }, PUMP_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Forget every typed attempt in flight, giving its message back to the hook: as the service starts, and when
   * it reaches a new core, which holds none of them (an update restarts the core, not this process). Whatever
   * the old core still holds it may no longer write: none is writable now.
   */
  takeBackAttempts(): void {
    let any = false
    for (const delivery of this.local) {
      if (delivery.state !== 'queued' || !delivery.attempt) continue
      if (!delivery.attempt.parked && delivery.pane) this.deps.inbox.restore(delivery.pane, delivery.key)
      delivery.attempt = undefined
      delivery.nextTryAt = this.now()
      any = true
    }
    if (any) { this.save(); this.deps.writable?.() }
  }

  /** A message for one of this machine's agents: it waits in the agent's inbox from now on. */
  accept(message: Message, agentId: string): LocalDelivery {
    const key = deliveryKey(message.id, agentId)
    const known = this.local.find((d) => d.key === key)
    if (known) return known
    const delivery: LocalDelivery = { key, messageId: message.id, agentId, pane: '', state: 'queued', tries: 0, nextTryAt: this.now(), at: this.now() }
    this.local.push(delivery)
    this.save()
    this.pump()
    return delivery
  }

  /** Whether the core may write a typed attempt now: only the current attempt of a delivery still waiting, and
   *  not one parked behind a turn, which the hook has again. */
  canWrite(deliveryId: string): boolean {
    return this.local.some((d) => d.state === 'queued' && d.attempt?.id === deliveryId && !d.attempt.parked)
  }

  /** What the core says became of a typed attempt. */
  observe(event: TurnDelivery): void {
    const delivery = this.local.find((d) => d.attempt?.id === event.deliveryId)
    if (!delivery || delivery.state !== 'queued') return
    const attempt = delivery.attempt!
    if (event.state === 'queued') {
      attempt.queuedAt ??= this.now()
      return this.save()
    }
    if (event.state === 'delivered' || event.state === 'started') return this.finish(delivery, 'prompt')
    // It may have reached the engine: never typed again.
    if (event.state === 'unknown') return this.finish(delivery, 'prompt', 'unconfirmed: inspect its pane')
    if (!notTyped(event.reason)) {
      return this.finish(delivery, 'prompt', event.reason === 'enter_withheld'
        ? 'typed into its composer; a dialog opened before Enter' : 'unconfirmed: inspect its pane')
    }
    // Refused before anything was written: back to the hook, and the next attempt waits longer. A parked one is
    // the hook's already, and its turn has ended: the next attempt finds the agent idle.
    delivery.attempt = undefined
    delivery.nextTryAt = this.now() + (attempt.parked ? 0 : Math.min(MAX_BACKOFF_MS, PUMP_MS * 2 ** Math.min(delivery.tries, 4)))
    if (!attempt.parked) this.deps.inbox.restore(delivery.pane, delivery.key)
    this.report(delivery, WAITING[event.reason ?? ''] ?? event.reason ?? 'waiting')
    this.save()
  }

  /** Look at every delivery still waiting: taken by the hook, refused, moved, stopped, or due a typed attempt. */
  pump(): void {
    // Each folder read once per look, however many deliveries wait: hundreds may.
    const taken = this.deps.inbox.claimedNames()
    const panes = new Map<string, Set<string>>()
    const waiting = (pane: string, key: string): boolean => {
      if (!panes.has(pane)) panes.set(pane, this.deps.inbox.keys(pane))
      return panes.get(pane)!.has(key)
    }
    for (const delivery of this.local) {
      if (delivery.state !== 'queued') continue
      if (delivery.pane && taken.has(`${delivery.pane.slice(1)}-${delivery.key}`) && this.deps.inbox.claimed(delivery.pane, delivery.key)) { this.finish(delivery, 'hook'); continue }
      if (delivery.attempt) { this.watch(delivery); continue }
      if (!this.deps.ready()) continue
      const refused = this.deps.refused(delivery)
      if (refused) { this.fail(delivery, refused); continue }
      const agent = this.deps.agent(delivery.agentId)
      const message = this.deps.store.entry(delivery.messageId)?.message
      if (!message) { this.fail(delivery, 'the message is no longer kept'); continue }
      if (!agent?.available || !agent.pane) {
        // Withdrawn while its harness is stopped: its pane number may be another's by the time it is back.
        if (delivery.pane) { this.deps.inbox.withdraw(delivery.pane, delivery.key); delivery.pane = ''; this.save() }
        this.report(delivery, 'its harness is stopped')
        continue
      }
      // A harness restarted in another pane, or into another conversation: its inbox file follows it.
      if (agent.pane !== delivery.pane || agent.session !== (delivery.session ?? '') || !waiting(delivery.pane, delivery.key)) {
        if (delivery.pane && agent.pane !== delivery.pane) this.deps.inbox.withdraw(delivery.pane, delivery.key)
        delivery.pane = agent.pane
        delivery.session = agent.session
        this.put(delivery, message, agent)
        if (delivery.reason === 'its harness is stopped') this.report(delivery, undefined)
        this.save()
      }
      if (this.now() < delivery.nextTryAt) continue
      if (!this.deps.inbox.reclaim(delivery.pane, delivery.key)) continue
      delivery.tries += 1
      delivery.attempt = { id: `team:msg:${delivery.key}:${delivery.tries}`, at: this.now() }
      this.save()
      this.deps.deliver(delivery.agentId, this.deps.text(delivery, message), delivery.attempt.id)
    }
  }

  /** Withdraw what waits for an agent's messages in a tab that turned off, or that it left. */
  refuseAll(): void {
    if (!this.deps.ready()) return
    for (const delivery of this.local) {
      if (delivery.state !== 'queued' || delivery.attempt) continue
      const refused = this.deps.refused(delivery)
      if (refused) this.fail(delivery, refused)
    }
  }

  /** A typed attempt in flight: parked once the core has held it behind a turn, forgotten when the core never
   *  took it or kept it too long. */
  private watch(delivery: LocalDelivery): void {
    const attempt = delivery.attempt!
    const now = this.now()
    if (!attempt.parked && attempt.queuedAt !== undefined && now - attempt.queuedAt >= PARK_MS) {
      attempt.parked = true
      attempt.parkedAt = now
      this.deps.inbox.restore(delivery.pane, delivery.key)
      this.report(delivery, WAITING.team_waiting_idle)
      this.save()
      this.deps.writable?.()
    } else if ((attempt.parked && now - (attempt.parkedAt ?? now) > PARKED_MAX_MS)
      || (!attempt.parked && attempt.queuedAt === undefined && now - (attempt.at ?? now) > ATTEMPT_MS)) {
      // Never acknowledged, or held too long: the core lost it, or will be refused if it asks. The hook has it.
      if (!attempt.parked) this.deps.inbox.restore(delivery.pane, delivery.key)
      delivery.attempt = undefined
      delivery.nextTryAt = now
      this.save()
      this.deps.writable?.()
    }
  }

  private put(delivery: LocalDelivery, message: Message, agent: MailboxAgent): void {
    try { this.deps.inbox.put(agent.pane, delivery.key, { session: agent.session, text: this.deps.text(delivery, message) }) }
    catch { /* the next pump puts it again */ }
  }

  private finish(delivery: LocalDelivery, via: 'hook' | 'prompt', reason?: string): void {
    delivery.state = 'delivered'
    delivery.via = via
    delivery.reason = reason
    delivery.attempt = undefined
    delivery.at = this.now()
    // Delivered one way: whatever copy the other way still holds goes.
    if (delivery.pane) this.deps.inbox.withdraw(delivery.pane, delivery.key)
    this.deps.changed(this.status(delivery), delivery)
    this.save()
  }

  private fail(delivery: LocalDelivery, reason: string): void {
    delivery.state = 'failed'
    delivery.reason = reason
    delivery.at = this.now()
    if (delivery.pane) this.deps.inbox.withdraw(delivery.pane, delivery.key)
    this.deps.changed(this.status(delivery), delivery)
    this.save()
  }

  /** Say why a delivery waits, when that changed. */
  private report(delivery: LocalDelivery, reason?: string): void {
    if (delivery.reason === reason) return
    delivery.reason = reason
    this.deps.changed(this.status(delivery), delivery)
  }

  private status(delivery: LocalDelivery): DeliveryStatus {
    return { messageId: delivery.messageId, machineId: '', agentId: delivery.agentId, state: delivery.state,
      ...(delivery.via ? { via: delivery.via } : {}), ...(delivery.reason ? { reason: delivery.reason } : {}), at: this.now() }
  }

  private save(): void {
    try { this.deps.store.save() } catch { /* kept in memory; the next change saves again */ }
  }
}
