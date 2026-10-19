import { publishObservers } from './observers.js'
import { retainContributions } from './retention.js'
import { configurationObservation } from './configuration.js'
import { NativeRecorder, nativeJournalFile } from './native.js'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CoreApi, TurnDelivery } from '../core/api.js'
import { shellQuote } from '../orchestrator/prompts.js'

type Json = Record<string, unknown>
export class SuperTabHostError extends Error {
  constructor(readonly code: string, message: string, readonly status = 503) { super(message) }
}
export { identifier, object } from './wire.js'
import { identifier, object } from './wire.js'

/** The core signs each request. Neither the service nor its journal holds an account credential. */
export async function backend(core: CoreApi, method: string, path: string, body?: unknown): Promise<unknown> {
  const reply = await core.account.backend(method, path, body)
  if (reply.status < 200 || reply.status >= 300 || reply.body.success === false) {
    const error = object(reply.body.error)
    throw new SuperTabHostError(String(error.code ?? reply.body.code ?? 'BACKEND_UNAVAILABLE'),
      String(error.message ?? reply.body.message ?? 'Could not reach this Super Tab.'), reply.status)
  }
  return reply.body.data
}

interface Entry {
  tabId: string
  agentId: string
  harnessId: string
  deliveryId: string
  claimId: string
  stage: 'prepared' | 'submitting' | 'delivered' | 'uncertain'
  receipt?: string
}
interface Journal { version: 1; machineId: string; entries: Record<string, Entry> }
interface HostAgent { tabId: string; agent: { id: string; harnessId: string; machineId: string } }
export interface SuperTabHostOptions {
  now?: () => number
  write?: (file: string, journal: Journal) => void
  log?: (message: string) => void
  observers?: typeof publishObservers
}

export const hostJournalFile = (dataDir: string, machineId: string) => join(dataDir, 'super-tabs', `host-${machineId}.json`)
const typedId = (entry: Entry) => `team:service:superTabs:${entry.deliveryId}`
const writeJournal = (file: string, journal: Journal) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.next`
  writeFileSync(temporary, JSON.stringify(journal), { mode: 0o600, flush: true })
  renameSync(temporary, file)
}

/** Owns only the handoff between a durable backend claim and the core's native input.
 * A process restart never interprets a lost acknowledgement as permission to type twice. */
export class SuperTabHost {
  private readonly file: string
  private readonly journal: Journal
  private readonly now: () => number
  private readonly write: (file: string, journal: Journal) => void
  private readonly log: (message: string) => void
  private retentionError: string | null = null
  private readonly observers: typeof publishObservers
  private readonly active = new Set<string>()
  private readonly authorized = new Map<string, number>()
  private readonly stopHearing: () => void
  private stopped = false
  private running: Promise<void> | null = null
  private stopsRunning: Promise<void> | null = null
  private nextStopsAt = 0
  private receiptsRunning: Promise<void> | null = null
  private nextReceiptsAt = 0
  private receiptCursor = 0
  private configurationsRunning: Promise<void> | null = null
  private nextConfigurationsAt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private native: NativeRecorder | null = null

  constructor(private readonly core: CoreApi, readonly machineId: string, options: SuperTabHostOptions = {}) {
    if (!identifier(machineId)) throw new SuperTabHostError('MACHINE_UNAVAILABLE', 'This machine is not signed in.')
    this.file = hostJournalFile(core.dataDir, machineId)
    this.observers = options.observers ?? publishObservers
    this.now = options.now ?? Date.now
    this.write = options.write ?? writeJournal
    this.log = options.log ?? (message => console.warn(`[super-tabs] ${message}`))
    this.journal = { version: 1, machineId, entries: {} }
    if (existsSync(this.file)) {
      const raw = readFileSync(this.file, 'utf8')
      if (raw.length > 4 * 1024 * 1024) throw new Error('Super Tab host journal is too large. Reconcile it before resuming.')
      const saved = object(JSON.parse(raw))
      if (saved.version !== 1 || saved.machineId !== machineId || !saved.entries || typeof saved.entries !== 'object') {
        throw new Error('Super Tab host journal is unreadable. Reconcile it before resuming.')
      }
      for (const [id, value] of Object.entries(saved.entries)) {
        const e = object(value)
        if (id !== e.deliveryId || ![e.tabId, e.agentId, e.harnessId, e.deliveryId, e.claimId].every(identifier)
          || !['prepared', 'submitting', 'delivered', 'uncertain'].includes(String(e.stage))) throw new Error('Invalid Super Tab delivery receipt.')
        const entry = e as unknown as Entry
        // The old process may have typed it, even when it never heard the core's receipt.
        if (entry.stage === 'submitting') {
          entry.stage = 'uncertain'
          entry.receipt = 'The host restarted before native delivery was confirmed. Inspect the session before retrying.'
        }
        this.journal.entries[id] = entry
      }
    }
    this.persist()
    this.stopHearing = core.turns.onDelivery(event => this.heard(event))
    if (existsSync(nativeJournalFile(core.dataDir, machineId))) {
      try { this.native = new NativeRecorder(core, machineId) } catch (error) { this.log(String(error)) }
    }
  }

  private persist(): void { this.write(this.file, this.journal) }
  start(): void {
    if (this.stopped || this.timer) return
    this.timer = setInterval(() => { void this.tick(); void this.reconcileStops(); void this.reconcileReceipts(); this.recordNative() }, 1_000)
    this.timer.unref?.()
    void this.tick()
    void this.reconcileStops()
    void this.reconcileReceipts()
    this.recordNative()
  }
  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.stopHearing()
    this.native?.stop()
    this.authorized.clear()
    try { this.observers(this.core.dataDir, this.machineId, [], 0) } catch { /* The old snapshot expires. */ }
    void this.core.turns.leaseDeliveries('superTabs', {})
    for (const id of this.active) this.core.turns.cancelDelivery(id)
    this.active.clear()
  }
  prepareNative(tabId: unknown, contextId: unknown, renew: boolean, closed?: AbortSignal) {
    this.native ??= new NativeRecorder(this.core, this.machineId)
    return this.native.prepare(tabId, contextId, renew, closed)
  }
  private recordNative(): void {
    if (!this.native?.hasWork || this.stopped) return
    const failed = (error: unknown) => this.log(error instanceof Error ? error.message : String(error))
    void this.native.capture().catch(failed)
    void this.native.flush().catch(failed)
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.running ??= this.poll().catch(error => {
      this.log(error instanceof Error ? error.message : String(error))
    }).finally(() => { this.running = null })
  }

  /** A saved native stop, never a timeout or missing live snapshot, releases
   * ownership. This also runs for contributions withdrawn while working. */
  reconcileStops(): Promise<void> {
    if (this.stopped || !this.core.agents.stopped || this.now() < this.nextStopsAt) return Promise.resolve()
    return this.stopsRunning ??= this.checkStops().catch(error => {
      this.log(error instanceof Error ? error.message : String(error))
    }).finally(() => { this.stopsRunning = null; this.nextStopsAt = this.now() + 5_000 })
  }
  private async checkStops(): Promise<void> {
    const rows = await backend(this.core, 'GET', `/api/super-tabs/hosts/${this.machineId}/assignments`)
    if (!Array.isArray(rows)) throw new Error('Invalid Super Tab execution list.')
    for (const value of rows) {
      if (this.stopped) return
      const work = object(value)
      if (![work.tabId, work.assignmentId, work.harnessId].every(identifier)) continue
      if (!await this.core.agents.stopped!(String(work.harnessId)) || this.stopped) continue
      await backend(this.core, 'POST', `/api/super-tabs/${work.tabId}/stopped`, {
        assignmentId: work.assignmentId,
        receipt: `native-stopped:${this.machineId}:${work.harnessId}:${work.assignmentId}`,
      })
    }
  }

  /** Retire local intent only after an authoritative terminal delivery state.
   * This runs independently so a slow receipt lookup cannot stall live leases. */
  reconcileReceipts(): Promise<void> {
    if (this.stopped || this.now() < this.nextReceiptsAt) return Promise.resolve()
    return this.receiptsRunning ??= this.checkReceipts().catch(error => {
      this.log(error instanceof Error ? error.message : String(error))
    }).finally(() => { this.receiptsRunning = null; this.nextReceiptsAt = this.now() + 5_000 })
  }
  private async checkReceipts(): Promise<void> {
    const pending = Object.values(this.journal.entries).filter(e => e.stage === 'uncertain' || e.stage === 'delivered')
    for (let i = 0; i < Math.min(pending.length, 20); i++) {
      if (this.stopped) return
      const entry = pending[(this.receiptCursor++) % pending.length]
      try {
        const result = object(await backend(this.core, 'GET', `/api/super-tabs/${entry.tabId}/agents/${entry.agentId}/deliveries/${entry.deliveryId}`))
        if (this.stopped) return
        if (result.id !== entry.deliveryId || !['delivered', 'confirmed', 'superseded', 'cancelled'].includes(String(result.status))) continue
        if (this.journal.entries[entry.deliveryId] !== entry || this.active.has(typedId(entry))) continue
        delete this.journal.entries[entry.deliveryId]
        this.persist()
      } catch { /* Missing authority or a network failure is not a receipt. */ }
    }
  }

  private async leases(): Promise<boolean> {
    return this.core.turns.leaseDeliveries('superTabs', Object.fromEntries(this.authorized))
  }
  private async poll(): Promise<void> {
    const requestedAt = this.now()
    const data = await backend(this.core, 'GET', `/api/super-tabs/hosts/${this.machineId}`)
    if (this.stopped) return
    if (!Array.isArray(data)) throw new Error('Invalid Super Tab host roster.')
    // Multiply was closed by the ordinary 30-minute idle cleanup while still a
    // shared member. Membership outlives its task, terminal view and host process.
    // Retention only pauses cleanup when it fails; it must never hold up delivery.
    try {
      retainContributions(this.core.dataDir, this.machineId, data)
      this.retentionError = null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== this.retentionError) this.log(message)
      this.retentionError = message
    }
    this.observers(this.core.dataDir, this.machineId, data, requestedAt + 2500)
    // Runtime observations cannot delay the live input leases. A stale host
    // observation is fenced by the backend's per-agent configuration version.
    if (!this.configurationsRunning && this.now() >= this.nextConfigurationsAt) {
      this.configurationsRunning = this.recordConfigurations(data).finally(() => {
        this.configurationsRunning = null
        this.nextConfigurationsAt = this.now() + 5_000
      })
    }
    const seen = new Set<string>()
    for (const item of data) {
      const row = object(item), agent = object(row.agent)
      if (!identifier(row.tabId) || !identifier(agent.id) || !identifier(agent.harnessId) || agent.machineId !== this.machineId) continue
      const target = row as unknown as HostAgent
      // Never adopt another live session as a replacement for the recorded harness.
      if (!this.core.agents.byAgent(target.agent.harnessId) || !this.core.agents.terminalAvailable(target.agent.harnessId)) continue
      const path = `/api/super-tabs/${target.tabId}/agents/${target.agent.id}/deliveries`
      try {
        const deliveries = await backend(this.core, 'GET', path)
        if (this.stopped) return
        if (!Array.isArray(deliveries)) throw new Error('Invalid Super Tab delivery list.')
        for (const item of deliveries) {
          const delivery = object(item)
          if (!identifier(delivery.id)) continue
          seen.add(delivery.id)
          await this.accept(target, delivery, path)
        }
      } catch (error) {
        // Authority checks and network failures both withhold input. A later fresh read may grant it again.
        this.log(error instanceof Error ? error.message : String(error))
      }
    }
    if (this.stopped) return
    for (const entry of Object.values(this.journal.entries)) {
      const id = typedId(entry)
      if (!seen.has(entry.deliveryId)) {
        this.authorized.delete(id)
        if (this.active.delete(id)) {
          entry.stage = 'uncertain'
          entry.receipt = 'Authority or the recorded native session became unavailable. Inspect the session before retrying.'
          this.persist()
          this.core.turns.cancelDelivery(id)
        }
      }
    }
    await this.leases()
  }

  private async accept(target: HostAgent, delivery: Json, path: string): Promise<void> {
    const deliveryId = delivery.id as string
    let entry = this.journal.entries[deliveryId]
    if (!entry) {
      if (Object.keys(this.journal.entries).length >= 1_000) throw new Error('Reconcile pending Super Tab deliveries before accepting more.')
      if (delivery.claimId && !identifier(delivery.claimId)) throw new Error('Invalid Super Tab delivery claim.')
      // Losing the host journal cannot turn a backend claim into fresh input.
      // Retain its identity and expose the uncertainty for a human to resolve;
      // this neither takes over its execution nor says whether it was written.
      entry = { tabId: target.tabId, agentId: target.agent.id, harnessId: target.agent.harnessId,
        deliveryId, claimId: delivery.claimId as string || randomUUID(),
        stage: delivery.claimId ? 'uncertain' : 'prepared',
        ...(delivery.claimId ? { receipt: delivery.status === 'uncertain' && typeof delivery.receipt === 'string' && delivery.receipt
          ? delivery.receipt
          : 'The host has no local receipt for this claimed instruction. Inspect the native session before confirming or resending it.' } : {}) }
      this.journal.entries[deliveryId] = entry
      this.persist()
      if (delivery.claimId) this.core.turns.cancelDelivery(typedId(entry))
    }
    const id = typedId(entry)
    if (entry.stage === 'submitting' && !this.active.has(id)) {
      entry.stage = 'uncertain'
      entry.receipt = 'Native submission was interrupted. Inspect the session before retrying.'
      this.persist()
    }
    if (entry.stage === 'delivered' || entry.stage === 'uncertain') {
      if (delivery.status === 'uncertain' && delivery.receipt === entry.receipt) return
      await backend(this.core, 'POST', `${path}/${deliveryId}`, { type: 'ack', claimId: entry.claimId,
        receipt: entry.receipt, uncertain: entry.stage === 'uncertain' })
      if (entry.stage === 'delivered') { delete this.journal.entries[deliveryId]; this.persist() }
      this.authorized.delete(id)
      return
    }
    if (this.active.has(id)) {
      this.authorized.set(id, this.now() + 2_500)
      return
    }
    const result = object(await backend(this.core, 'POST', `${path}/${deliveryId}`, { type: 'claim', claimId: entry.claimId }))
    if (this.stopped) return
    const message = object(result.message)
    if (typeof message.text !== 'string' || !identifier(message.conversationId)) throw new Error('The delivery has no message.')
    this.authorized.set(id, this.now() + 2_500)
    if (!(await this.leases()) || this.stopped) { this.authorized.delete(id); return }
    if (this.active.has(id)) return
    // The durable intent must exist before the core can write. A thrown disk write must not deliver.
    entry.stage = 'submitting'
    this.persist()
    this.active.add(id)
    this.core.turns.deliver(entry.harnessId, this.prompt(entry, message), id)
  }

  private async recordConfigurations(rows: unknown[]): Promise<void> {
    for (const row of rows) {
      if (this.stopped) return
      try {
        const observation = configurationObservation(this.core, this.machineId, row)
        if (observation) await backend(this.core, 'POST', observation.path, observation.body)
      } catch (error) {
        this.log(error instanceof Error ? error.message : String(error))
      }
    }
  }

  private prompt(entry: Entry, message: Json): string {
    const command = `${this.core.daemon.command} super-tab --port ${this.core.daemon.port} --machine ${shellQuote(this.machineId)} --tab ${shellQuote(entry.tabId)} --agent ${shellQuote(entry.agentId)}`
    const group = message.conversationId as string
    const reply = identifier(message.replyTo)
      ? `In reply to message ${message.replyTo}. Read it before interpreting the answer: ${command} message ${shellQuote(group)} ${shellQuote(message.replyTo)}\n\n`
      : ''
    const source = object(message.source)
    const native = source.kind === 'native'
      ? `This is an observed native ${String(source.phase)} in ${String(object(message.author).name ?? 'an agent')}’s terminal, opened by ${String(object(source.operator).name ?? 'a collaborator')}. The input already reached that agent. Keep the shared work coordinated; do not replay the same instruction.\n\n`
      : ''
    return `You are participating in a shared Super Tab conversation (${group}). Other humans and agents see messages posted there.\n`
      + `Read its state: ${command} status\nRead this conversation: ${command} messages ${shellQuote(group)}\n`
      + `Reply there: ${command} post ${shellQuote(group)} 'your message' UNIQUE_OPERATION_ID\n`
      + `Manage agreed work and delegation: ${command} help. Leads: route before starting or assigning: ${command} route GROUP JSON. Use independently verifiable outcomes; local helper subagents need no separate group.\n`
      + `Ask questions and post results in this conversation. Include the exact revision, evidence and usable output links. Replies to these delivered instructions must be posted here explicitly.\n\n`
      + native + reply + `Message ${String(message.id)} from ${String(object(message.author).name ?? 'a collaborator')}:\n${message.text}`
  }

  private heard(event: TurnDelivery): void {
    const entry = Object.values(this.journal.entries).find(e => typedId(e) === event.deliveryId)
    if (this.stopped || !entry || event.sessionId !== entry.harnessId || !this.active.has(event.deliveryId)) return
    if (event.state === 'queued') return
    this.active.delete(event.deliveryId)
    this.authorized.delete(event.deliveryId)
    if (event.state === 'rejected' && event.reason?.startsWith('team_waiting_')) {
      // The core explicitly withheld the terminal write (busy, human draft, or
      // expired authority). A later fresh check may retry the same claim safely.
      entry.stage = 'prepared'
      delete entry.receipt
    } else {
      entry.stage = event.state === 'delivered' || event.state === 'started' ? 'delivered' : 'uncertain'
      entry.receipt = `${event.state}: ${event.reason ?? 'Native session input receipt'}`.slice(0, 2000)
    }
    try { this.persist() } catch (error) {
      // The on-disk 'submitting' intent remains the truth if saving its outcome failed.
      this.log(error instanceof Error ? error.message : String(error))
    }
    void this.leases()
  }
}
