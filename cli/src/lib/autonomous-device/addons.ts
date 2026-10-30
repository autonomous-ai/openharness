import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AutonomousDeviceFrame } from './service.js'

/**
 * Device add-ons v1 (docs/autonomous-device-addons.md): agents on this computer read what a paired device
 * chose to publish about itself, and propose what it might do. The device stays the judge: a proposal is
 * a suggestion it keeps or drops, never a command, and this computer never learns more than the device
 * published.
 *
 * Device-agnostic on purpose. Which topics are safe to publish, which acts a device understands and what a
 * proposal may change are the device's own policy; this layer bounds sizes, rates and lifetimes so that one
 * agent cannot flood a device and one device cannot grow this daemon's memory.
 *
 * Nothing here is durable. Published values and proposals live in RAM. A hello clears what a device
 * published, and the device publishes its whole set again after it, so a topic it no longer offers (a
 * person withdrew consent) is gone, not left readable. When the service restarts under a session the
 * gateway kept, there is no hello: the device is asked to publish again (`addon.republish`). A proposal
 * lives at most `HOLDS_MAX_MS` before it lapses.
 */
export const DEVICE_ADDON_CAPABILITIES = ['addon.publish', 'addon.decision'] as const

export const TOPICS_MAX = 32
export const VALUE_MAX_BYTES = 4096
export const PUBLISH_BATCH_MAX = 16
export const HOLDS_MIN_MS = 1000
export const HOLDS_MAX_MS = 30_000
export const PARAMS_MAX_BYTES = 2048
export const NOTE_MAX_BYTES = 300
/** Per device and add-on, in any rolling minute. */
export const PROPOSALS_PER_MINUTE = 6
/** Per device, whatever the add-ons call themselves: the name is the caller's, so it cannot be the bound. */
export const DEVICE_PROPOSALS_PER_MINUTE = 12
/** Per device: proposals sent and not yet decided or lapsed. */
export const OPEN_PROPOSALS_MAX = 4
const PROPOSALS_RETAINED = 256
const RATE_WINDOW_MS = 60_000
/** How long a settled proposal stays readable by `addon proposal`. */
const SETTLED_TTL_MS = 10 * 60_000

const requestId = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/)
/** `room/presence`, `mood/state`: two to four lowercase segments, as a device names its own state. */
const topic = z.string().max(96).regex(/^[a-z][a-z0-9_]*(\/[a-z][a-z0-9_]*){1,3}$/)
const word = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)
const reason = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/)
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
/** Key order does not change an intent: the same proposal written twice is one proposal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(value)
}

export const DeviceAddonRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('addon.publish'), requestId,
    values: z.array(z.strictObject({ topic,
      // null: the device no longer offers this topic.
      value: z.record(z.string(), z.unknown()).nullable(),
      at: z.number().int().min(0).optional() })).min(1).max(PUBLISH_BATCH_MAX) }),
  z.strictObject({ type: z.literal('addon.decision'), requestId, proposalId: z.uuid(),
    decision: z.enum(['kept', 'dropped']), reason: reason.optional() }),
])

/** What an agent asks for through `harness autonomous-device addon propose`. */
export const AddonProposeSchema = z.strictObject({
  deviceId: z.string().min(1).max(64).optional(),
  addon: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  act: word,
  why: word.optional(),
  sure: z.number().min(0).max(1).optional(),
  holdsMs: z.number().int().min(HOLDS_MIN_MS).max(HOLDS_MAX_MS),
  params: z.record(z.string(), z.unknown()).optional(),
  note: z.string().min(1).regex(/^[^\x00-\x09\x0b-\x1f\x7f]+$/).optional(),
})
export type AddonPropose = z.infer<typeof AddonProposeSchema>

export type ProposalState = 'sent' | 'kept' | 'dropped' | 'expired'
/** The machine a proposal came from, as the link that carried it proves it (Asker.machine), never as its payload says. */
export interface ProposalSource { machineId: string; label: string | null }
export interface AddonProposal {
  proposalId: string; deviceId: string; addon: string; idempotencyKey: string
  act: string; why?: string; sure?: number; holdsMs: number; params?: Record<string, unknown>; note?: string
  from?: ProposalSource
  state: ProposalState; reason: string | null; sentAt: number; expiresAt: number; decidedAt: number | null
}
export interface AddonTopicValue { value: Record<string, unknown>; at: number | null; receivedAt: number }
export interface AddonDeviceState { deviceId: string; online: boolean; topics: Record<string, AddonTopicValue> }

export class DeviceAddonError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
const fail = (code: string, message: string): never => { throw new DeviceAddonError(code, message) }

export interface DeviceAddonsOptions {
  machineId: string
  serverInstanceId: string
  /** To that device's links alone. A proposal is never broadcast and never in the replay log. */
  send: (deviceId: string, frame: AutonomousDeviceFrame) => void
  now?: () => number
}

interface DeviceRecord { online: boolean; topics: Map<string, AddonTopicValue> }

export class DeviceAddons {
  private readonly devices = new Map<string, DeviceRecord>()
  private readonly proposals = new Map<string, AddonProposal & { digest: string }>()
  private readonly now: () => number
  constructor(private readonly options: DeviceAddonsOptions) { this.now = options.now ?? Date.now }

  /** A device's `addon.*` request, after the relay authenticated it as `deviceId`. */
  request(deviceId: string, raw: Record<string, unknown>): Record<string, unknown> {
    const parsed = DeviceAddonRequestSchema.safeParse(raw)
    if (!parsed.success) fail('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid add-on request')
    const req = parsed.data!
    if (req.type === 'addon.publish') return this.publish(deviceId, req.values)
    return this.decide(deviceId, req.proposalId, req.decision, req.reason)
  }

  private publish(deviceId: string, values: Array<{ topic: string; value: Record<string, unknown> | null; at?: number }>): Record<string, unknown> {
    // Checked whole before anything is kept: a batch is taken or refused as one.
    for (const item of values) if (item.value && bytes(item.value) > VALUE_MAX_BYTES) fail('PAYLOAD_TOO_LARGE', `${item.topic} exceeds ${VALUE_MAX_BYTES} bytes`)
    const record = this.devices.get(deviceId) ?? { online: true, topics: new Map<string, AddonTopicValue>() }
    const after = new Set(record.topics.keys())
    for (const item of values) item.value ? after.add(item.topic) : after.delete(item.topic)
    if (after.size > TOPICS_MAX) fail('BACKPRESSURE', `A device publishes at most ${TOPICS_MAX} topics`)
    const receivedAt = this.now()
    for (const item of values) {
      if (item.value) record.topics.set(item.topic, { value: structuredClone(item.value), at: item.at ?? null, receivedAt })
      else record.topics.delete(item.topic)
    }
    record.online = true
    this.devices.set(deviceId, record)
    return { topics: record.topics.size }
  }

  private decide(deviceId: string, proposalId: string, decision: 'kept' | 'dropped', why?: string): Record<string, unknown> {
    this.prune()
    const proposal = this.proposals.get(proposalId)
    // Another device's proposal reads the same as one never sent: a device learns nothing of others.
    if (!proposal || proposal.deviceId !== deviceId) fail('PROPOSAL_UNKNOWN', 'No such proposal for this device')
    const p = proposal!
    if (p.state === 'kept' || p.state === 'dropped') {
      if (p.state !== decision) fail('IDEMPOTENCY_CONFLICT', `Proposal was already ${p.state}`)
      return { proposalId, state: p.state }
    }
    // Late (lapsed here) is still recorded: the device's clock and its judge are what decided.
    p.state = decision; p.reason = why ?? null; p.decidedAt = this.now()
    return { proposalId, state: p.state }
  }

  /** An agent's proposal: validated, rate-limited, then sent to the device's links, with the machine it came
   *  from when the caller proved one. */
  propose(input: unknown, from?: ProposalSource): AddonProposal {
    const parsed = AddonProposeSchema.safeParse(input)
    if (!parsed.success) fail('INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid proposal')
    const req = parsed.data!
    if (req.params && bytes(req.params) > PARAMS_MAX_BYTES) fail('PAYLOAD_TOO_LARGE', `params exceed ${PARAMS_MAX_BYTES} bytes`)
    if (req.note && Buffer.byteLength(req.note) > NOTE_MAX_BYTES) fail('PAYLOAD_TOO_LARGE', `note exceeds ${NOTE_MAX_BYTES} bytes`)
    this.prune()
    const { deviceId: _target, idempotencyKey: _key, ...intent } = req
    const digest = createHash('sha256').update(canonical(intent)).digest('hex')
    for (const existing of this.proposals.values()) {
      // A key is the proposing machine's own: another machine's same key is another proposal, and says nothing of it.
      if (existing.addon !== req.addon || existing.idempotencyKey !== req.idempotencyKey || existing.from?.machineId !== from?.machineId) continue
      if (existing.digest !== digest || (req.deviceId && req.deviceId !== existing.deviceId)) fail('IDEMPOTENCY_CONFLICT', 'Key already belongs to a different proposal')
      return this.view(existing)
    }
    const deviceId = this.target(req.deviceId)
    const now = this.now()
    const recent = [...this.proposals.values()].filter(p => p.deviceId === deviceId && now - p.sentAt < RATE_WINDOW_MS)
    if (recent.length >= DEVICE_PROPOSALS_PER_MINUTE) fail('RATE_LIMITED', `At most ${DEVICE_PROPOSALS_PER_MINUTE} proposals a minute to one device`)
    if (recent.filter(p => p.addon === req.addon).length >= PROPOSALS_PER_MINUTE) fail('RATE_LIMITED', `At most ${PROPOSALS_PER_MINUTE} proposals a minute per add-on`)
    const open = [...this.proposals.values()].filter(p => p.deviceId === deviceId && p.state === 'sent')
    if (open.length >= OPEN_PROPOSALS_MAX) fail('BACKPRESSURE', 'The device has not answered earlier proposals yet')
    // Room is made before anything is sent: a proposal the limits still count is never dropped for it.
    if (this.proposals.size >= PROPOSALS_RETAINED && !this.evict(now)) fail('BACKPRESSURE', 'Too many recent proposals are kept; try again in a minute')
    const proposal = { proposalId: randomUUID(), deviceId, addon: req.addon, idempotencyKey: req.idempotencyKey, act: req.act,
      ...(req.why ? { why: req.why } : {}), ...(req.sure !== undefined ? { sure: req.sure } : {}), holdsMs: req.holdsMs,
      ...(req.params ? { params: structuredClone(req.params) } : {}), ...(req.note ? { note: req.note } : {}),
      ...(from ? { from: { machineId: from.machineId, label: from.label } } : {}),
      state: 'sent' as ProposalState, reason: null, sentAt: now, expiresAt: now + req.holdsMs, decidedAt: null, digest }
    this.proposals.set(proposal.proposalId, proposal)
    const { deviceId: _d, idempotencyKey: _i, state: _s, reason: _r, sentAt: _t, decidedAt: _a, digest: _g, ...payload } = proposal
    this.options.send(deviceId, { type: 'event', serverInstanceId: this.options.serverInstanceId, machineId: this.options.machineId,
      kind: 'addon.proposal', payload })
    return this.view(proposal)
  }

  /** A proposal an agent sent, or null once it aged out. */
  proposal(proposalId: string): AddonProposal | null {
    this.prune()
    const found = this.proposals.get(proposalId)
    return found ? this.view(found) : null
  }

  /** What the devices published, newest values only. */
  state(deviceId?: string): AddonDeviceState[] {
    return [...this.devices].filter(([id]) => !deviceId || id === deviceId).map(([id, record]) => ({
      deviceId: id, online: record.online,
      topics: Object.fromEntries([...record.topics].sort(([a], [b]) => a < b ? -1 : 1).map(([t, v]) => [t, structuredClone(v)])) }))
  }

  /** A hello: what it published before is cleared, and it publishes its whole set again (module doc). */
  hello(deviceId: string): void {
    this.devices.delete(deviceId)
  }

  /** Served again after the service restarted, without a hello: the device is asked to publish again. */
  republish(deviceId: string): void {
    this.options.send(deviceId, { type: 'event', serverInstanceId: this.options.serverInstanceId, machineId: this.options.machineId,
      kind: 'addon.republish', payload: {} })
  }

  /** Its last link closed: its values stay readable, marked offline, and nothing is proposed to it. */
  offline(deviceId: string): void {
    const record = this.devices.get(deviceId)
    if (record) record.online = false
  }

  /** Unpaired: everything it published and everything proposed to it is forgotten. */
  revoke(deviceId: string): void {
    this.devices.delete(deviceId)
    for (const [id, p] of this.proposals) if (p.deviceId === deviceId) this.proposals.delete(id)
  }

  private target(deviceId: string | undefined): string {
    if (deviceId) {
      const record = this.devices.get(deviceId)
      if (!record) fail('DEVICE_NOT_FOUND', 'That device has published no add-on state')
      if (!record!.online) fail('DEVICE_OFFLINE', 'That device is not connected')
      return deviceId
    }
    const online = [...this.devices].filter(([, r]) => r.online).map(([id]) => id)
    if (online.length !== 1) fail('MISSING_TARGET', online.length ? 'Several devices are connected; name one with deviceId' : 'No connected device offers add-ons')
    return online[0]
  }

  private view(p: AddonProposal & { digest?: string }): AddonProposal {
    const { digest: _digest, ...rest } = p
    return structuredClone(rest)
  }

  private prune(): void {
    const now = this.now()
    for (const [id, p] of this.proposals) {
      if (p.state === 'sent' && now >= p.expiresAt) { p.state = 'expired'; p.decidedAt = p.expiresAt }
      if (p.state !== 'sent' && now - (p.decidedAt ?? p.expiresAt) > SETTLED_TTL_MS) this.proposals.delete(id)
    }
  }

  /** Over capacity: the oldest settled proposal outside the rate window goes, or none (false). */
  private evict(now: number): boolean {
    for (const [id, p] of this.proposals) {
      if (p.state !== 'sent' && now - p.sentAt >= RATE_WINDOW_MS) { this.proposals.delete(id); return true }
    }
    return false
  }
}
