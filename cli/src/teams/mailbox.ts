import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { SessionInputDelivery } from '../lib/sessionInput.js'
import { Delivery, Receipt, requireTeam, type MemberRuntime } from './model.js'
import { TeamStore } from './store.js'

const RecordSchema = Delivery.partial({ agentId: true, text: true, expiresAt: true }).extend({ receipt: Receipt, submitted: z.boolean(), held: z.boolean().default(false) })
type DeliveryRecord = z.infer<typeof RecordSchema>
export interface MailboxDependencies {
  stateDir: string
  runtime(agentId: string): MemberRuntime | null
  send(agentId: string, text: string, deliveryId: string): void
  cancel(deliveryId: string): boolean
  channelsEnabled?(): boolean
  now?(): number
}

/** The destination owns the terminal receipt, including across coordinator reconnects. */
export class TeamMailbox {
  private readonly store: TeamStore<DeliveryRecord>
  private readonly records = new Map<string, DeliveryRecord>()
  private timer: ReturnType<typeof setInterval> | null = null
  private loaded = false
  private stopped = false
  constructor(private readonly deps: MailboxDependencies) {
    this.store = new TeamStore(deps.stateDir, RecordSchema)
  }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private key(id: string): string { return createHash('sha256').update(id).digest('hex').slice(0, 32) }
  start(): void {
    if (this.loaded) return
    for (const id of this.store.ids()) {
      const record = this.store.read(id)!
      requireTeam(id === this.key(record.id), 'CORRUPT_STATE', 'Delivery identity does not match its record.')
      // A recorded write may have reached the engine. Never automatically paste it again.
      if (record.submitted && ['queued', 'submitted', 'delivered'].includes(record.receipt.state)) {
        record.receipt = { id: record.id, state: 'unknown', reason: 'Daemon restarted after submission. Read the inbox or inspect the harness.', updatedAt: this.now() }
        this.store.write(id, record)
      }
      this.records.set(record.id, record)
    }
    this.loaded = true
    this.timer = setInterval(() => { try { this.pump() } catch { /* no external write without a durable reservation */ } }, 2000)
    this.timer.unref?.()
  }
  private save(record: DeliveryRecord): void {
    this.store.write(this.key(record.id), record)
    this.records.set(record.id, record)
  }
  accept(raw: unknown): Receipt {
    this.start()
    const delivery = Delivery.parse(raw)
    const prior = this.records.get(delivery.id)
    if (prior) {
      requireTeam(!prior.agentId || (prior.agentId === delivery.agentId && prior.text === delivery.text && prior.expiresAt === delivery.expiresAt && prior.channel === delivery.channel),
        'ID_CONFLICT', 'That delivery ID already refers to different content.')
      if (!prior.agentId) this.save({ ...prior, ...delivery, receipt: prior.receipt.state === 'pending' ? { ...prior.receipt, state: 'queued' } : prior.receipt })
      return structuredClone(prior.receipt)
    }
    requireTeam(this.records.size < 10000, 'MAILBOX_FULL', 'This machine has reached its team delivery retention limit.')
    const runtime = this.deps.runtime(delivery.agentId)
    requireTeam(runtime && runtime.engine !== 'terminal', 'AGENT_UNAVAILABLE', 'Choose an existing agent session, not a plain terminal.')
    requireTeam([...this.records.values()].filter(r => r.agentId === delivery.agentId && ['queued', 'submitted'].includes(r.receipt.state)).length < 32,
      'QUEUE_FULL', 'This teammate already has too many pending notices.')
    const receipt: Receipt = { id: delivery.id, state: 'queued', updatedAt: this.now() }
    this.save({ ...delivery, receipt, submitted: false, held: false })
    return structuredClone(receipt)
  }
  status(id: string): Receipt | null {
    Receipt.shape.id.parse(id)
    this.start()
    return structuredClone(this.records.get(id)?.receipt ?? null)
  }
  canWrite(id: string): boolean {
    const record = this.records.get(id)
    return !!record && (!record.channel || this.deps.channelsEnabled?.() === true) && !record.held && (record.expiresAt ?? 0) > this.now()
      && ['queued', 'submitted'].includes(record.receipt.state)
  }
  cancel(id: string, received = false): Receipt {
    Receipt.shape.id.parse(id)
    this.start()
    const prior = this.records.get(id)
    // A tombstone closes the send/cancel race across separate network connections.
    if (!prior) {
      requireTeam(this.records.size < 10000, 'MAILBOX_FULL', 'The retained team delivery limit was reached.')
      const receipt: Receipt = { id, state: received ? 'received' : 'cancelled', updatedAt: this.now() }
      this.save({ id, receipt, submitted: false, held: false })
      return receipt
    }
    const record = structuredClone(prior)
    if (['received', 'cancelled'].includes(record.receipt.state)) return record.receipt
    if (received) {
      record.receipt = { id, state: 'received', reason: 'Read through the team inbox.', updatedAt: this.now() }
      this.save(record)
      this.deps.cancel(id)
    } else {
      // Suppress a write still waiting for a host writer, even if its input reservation
      // is already in flight. An actual paste remains honestly uncertain/started.
      record.held = true
      this.save(record)
      if (!record.submitted || this.deps.cancel(id)) {
        record.receipt = { id, state: 'cancelled', updatedAt: this.now() }
        this.save(record)
      }
    }
    return structuredClone(this.records.get(id)!.receipt)
  }
  hold(id: string, held: boolean): Receipt | null {
    Receipt.shape.id.parse(id)
    this.start()
    const prior = this.records.get(id)
    if (!prior && !held) return null
    if (!prior) requireTeam(this.records.size < 10000, 'MAILBOX_FULL', 'The retained team delivery limit was reached.')
    const record: DeliveryRecord = prior ? structuredClone(prior) : { id, receipt: { id, state: 'pending', updatedAt: this.now() }, submitted: false, held }
    if (prior?.held === held) return structuredClone(record.receipt)
    record.held = held
    if (held && record.submitted && this.deps.cancel(id)) record.submitted = false
    if (!record.submitted && !['received', 'cancelled'].includes(record.receipt.state)) {
      record.receipt = { id, state: record.agentId ? 'queued' : 'pending', updatedAt: this.now(), ...(held ? { reason: 'Team communication is paused.' } : {}) }
    }
    this.save(record)
    return structuredClone(record.receipt)
  }
  observe(event: SessionInputDelivery): void {
    const prior = this.records.get(event.deliveryId)
    if (!prior || prior.agentId !== event.sessionId || ['received', 'cancelled'].includes(prior.receipt.state)) return
    const record = structuredClone(prior)
    // These refusals prove no paste was attempted, so a later idle boundary can safely try.
    const held = event.state === 'rejected' && (event.reason?.startsWith('team_waiting_')
      || ['queue_full', 'queue_expired', 'agent_gone', 'runtime_gone_pre_paste'].includes(event.reason ?? ''))
    record.receipt = { id: record.id, state: held ? 'queued' : event.state, reason: event.reason, updatedAt: this.now() }
    if (held) record.submitted = false
    this.save(record)
  }
  pump(): void {
    if (this.stopped) return
    this.start()
    for (const prior of this.records.values()) {
      if (prior.channel && this.deps.channelsEnabled?.() !== true) {
        if (prior.submitted && ['queued', 'submitted'].includes(prior.receipt.state) && this.deps.cancel(prior.id)) {
          this.save({ ...prior, submitted: false, receipt: { id: prior.id, state: 'queued', updatedAt: this.now(), reason: 'Swarm collaboration is off.' } })
        }
        continue
      }
      if (prior.submitted || prior.held || !prior.agentId || !prior.text || !prior.expiresAt || prior.receipt.state !== 'queued') continue
      const record = structuredClone(prior)
      if (record.expiresAt! <= this.now()) {
        record.receipt = { id: record.id, state: 'cancelled', reason: 'Question deadline passed before delivery.', updatedAt: this.now() }
        this.save(record)
        continue
      }
      const runtime = this.deps.runtime(record.agentId!)
      if (!runtime?.available) {
        const reason = runtime?.reason ?? 'Teammate is offline. Waiting for this same harness.'
        if (record.receipt.reason !== reason) {
          record.receipt = { id: record.id, state: 'queued', reason, updatedAt: this.now() }
          this.save(record)
        }
        continue
      }
      record.submitted = true
      record.receipt = { id: record.id, state: 'submitted', updatedAt: this.now() }
      this.save(record)
      try { this.deps.send(record.agentId!, record.text!, record.id) }
      catch { this.observe({ sessionId: record.agentId!, deliveryId: record.id, state: 'unknown', reason: 'Submission could not be confirmed. Inspect the harness or read its inbox.' }) }
    }
  }
  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
