import { randomUUID } from 'node:crypto'
import type { Asker, ServiceRequests } from '../../core/api.js'
import { DeviceAddonError, DeviceAddons, type AddonProposal, type ProposalSource } from './addons.js'

/**
 * Add-ons for a device that is itself a Harness machine (openharness#1654): the lampOS V2 lamp runs Harness and
 * is one of its person's machines, so it has no paired device channel to publish on. Its own add-on service, a
 * process of the same user on that machine, publishes and decides through this daemon's credential-checked
 * loopback routes; agents on the person's other machines read and propose over the machine link
 * (`machine_addon`, sealed like every machine request), and agents on the device itself through the same request.
 *
 * The contract, bounds, rates and lifetimes are v1's (addons.ts, docs/autonomous-device-addons.md), kept in RAM
 * and never judged here. Two things are added: each proposal says the machine it came from, as the link proved
 * it (`Asker.machine`), so the device can ask its person's yes per computer; and the device's own service takes
 * its proposals from a short inbox (`proposals`), waiting for the next one rather than polling.
 */
export const MACHINE_ADDON_OPS = ['state', 'propose', 'proposal'] as const
/** Only a process on this machine: the device's own service. */
export const LOCAL_OPS = ['hello', 'publish', 'decision', 'proposals'] as const
export type MachineAddonOp = typeof MACHINE_ADDON_OPS[number]
/** Proposals kept for the device's service to take; older ones are past their 30 s hold long before. */
export const INBOX_MAX = 32
/** The longest a take waits for the next proposal. */
export const TAKE_WAIT_MAX_MS = 20_000

export interface InboxEntry { seq: number; proposal: Record<string, unknown> }
export interface MachineAddonsOptions {
  /** This machine's id: the device the published state belongs to. */
  machineId: () => string
  now?: () => number
}

type Answer = { result: Record<string, unknown> } | { error: { code: string; message: string } }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export class MachineAddons {
  private readonly addons: DeviceAddons
  private inbox: InboxEntry[] = []
  private seq = 0
  private readonly waiters = new Set<() => void>()

  constructor(private readonly options: MachineAddonsOptions) {
    this.addons = new DeviceAddons({ machineId: '', serverInstanceId: randomUUID(), now: options.now,
      send: (_deviceId, frame) => { if (frame.kind === 'addon.proposal') this.received(frame.payload as Record<string, unknown>) } })
  }

  private get self(): string { return this.options.machineId() }

  private received(proposal: Record<string, unknown>): void {
    this.inbox.push({ seq: ++this.seq, proposal: structuredClone(proposal) })
    if (this.inbox.length > INBOX_MAX) this.inbox.splice(0, this.inbox.length - INBOX_MAX)
    for (const wake of [...this.waiters]) wake()
  }

  // ── the device's own service, over this machine's loopback (lib/deviceManagementHttp.ts) ─────────────

  /** The service started: what it published before is cleared, as a device's hello clears it. */
  hello(): Record<string, unknown> {
    this.addons.hello(this.self)
    return { topics: 0 }
  }

  publish(values: unknown): Record<string, unknown> {
    return this.addons.request(this.self, { type: 'addon.publish', requestId: randomUUID(), values })
  }

  decide(input: { proposalId: unknown; decision: unknown; reason?: unknown }): Record<string, unknown> {
    return this.addons.request(this.self, { type: 'addon.decision', requestId: randomUUID(), proposalId: input.proposalId,
      decision: input.decision, ...(input.reason !== undefined ? { reason: input.reason } : {}) })
  }

  /**
   * The proposals after `after`, waiting up to `waitMs` for one when there are none. `next` is the cursor for the
   * next take. A cursor ahead of this daemon's (it restarted) reads from the start, said by `reset`.
   */
  async proposals(after: number, waitMs = 0): Promise<{ proposals: InboxEntry[]; next: number; reset?: true }> {
    const reset = after > this.seq
    const from = reset ? 0 : after
    if (!reset && waitMs > 0 && !this.inbox.some(entry => entry.seq > from)) {
      await new Promise<void>(resolve => {
        const wake = (): void => { clearTimeout(timer); this.waiters.delete(wake); resolve() }
        const timer = setTimeout(wake, Math.min(waitMs, TAKE_WAIT_MAX_MS))
        this.waiters.add(wake)
      })
    }
    return { proposals: this.inbox.filter(entry => entry.seq > from).map(entry => structuredClone(entry)), next: this.seq,
      ...(reset ? { reset: true as const } : {}) }
  }

  // ── agents: on the person's other machines over the machine link, or on this one ────────────────────

  /** `machine_addon` {op, input}: who may ask, and the machine a proposal is said to come from, are the asker's. */
  request(payload: Record<string, unknown>, asker: Asker): Answer | Promise<Answer> {
    if ((LOCAL_OPS as readonly unknown[]).includes(payload.op)) return this.local(payload, asker)
    if (asker.guest !== undefined || !asker.owner || (!asker.local && asker.accountOwner !== true)) {
      return { error: { code: 'OWNER_REQUIRED', message: 'Only the owner\'s own machines may use this machine\'s add-ons.' } }
    }
    const op = payload.op, input = object(payload.input) ? payload.input : {}
    const from: ProposalSource | undefined = asker.local ? { machineId: this.self, label: null } : asker.machine
    try {
      if (op === 'state') return { result: { devices: this.addons.state(this.self) } }
      if (op === 'propose') {
        if (!from) return { error: { code: 'MACHINE_REQUIRED', message: 'A proposal comes from one of the owner\'s machines, which this link did not prove.' } }
        const { deviceId: _ignored, ...rest } = input
        return { result: { proposal: this.addons.propose({ ...rest, deviceId: this.self }, from) } }
      }
      if (op === 'proposal') {
        const found = this.addons.proposal(typeof input.proposalId === 'string' ? input.proposalId : '')
        // A machine reads back its own proposals only; another's reads as one never sent.
        const visible = found && (asker.local || found.from?.machineId === from?.machineId) ? found : null
        if (!visible) return { error: { code: 'PROPOSAL_UNKNOWN', message: 'No such proposal' } }
        return { result: { proposal: visible as AddonProposal } }
      }
      return { error: { code: 'INVALID_REQUEST', message: `op is one of ${MACHINE_ADDON_OPS.join(', ')}` } }
    } catch (error) {
      if (error instanceof DeviceAddonError) return { error: { code: error.code, message: error.message } }
      throw error
    }
  }

  private async local(payload: Record<string, unknown>, asker: Asker): Promise<Answer> {
    if (!asker.local || !asker.owner) return { error: { code: 'LOCAL_ONLY', message: 'Only the device\'s own service, on this machine, publishes and decides.' } }
    const input = object(payload.input) ? payload.input : {}
    try {
      if (payload.op === 'hello') return { result: this.hello() }
      if (payload.op === 'publish') return { result: this.publish(input.values) }
      if (payload.op === 'decision') return { result: this.decide({ proposalId: input.proposalId, decision: input.decision, reason: input.reason }) }
      const whole = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
      return { result: { ...await this.proposals(whole(input.after), whole(input.waitMs)) } }
    } catch (error) {
      if (error instanceof DeviceAddonError) return { error: { code: error.code, message: error.message } }
      throw error
    }
  }

  requests(): ServiceRequests {
    return { machine_addon: (payload, asker) => this.request(payload, asker) }
  }
}
