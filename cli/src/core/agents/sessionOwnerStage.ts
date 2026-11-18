/** Bounded current-link admission into the sole accepted session view, with no provider policy or durable state. */
import type { SessionFactoryOwner } from '../../harnessd/services.js'
import { readSessionFacts } from '../../lib/sessionFactsAdmission.js'
import { copySessionValue, measureSessionValue, type SessionValueCharge } from '../../lib/sessionFactValues.js'
import { SESSION_FACTS_FORMAT, retainSessionFacts, sessionFactsWire, sessionOwnerCreatedAt, sessionOwnerFactory, sessionOwnerId,
  type RetainedSession, type SessionFacts } from '../../lib/sessionPresentation.js'
import { sessionImageHash, SESSION_OWNER_CHUNK_BYTES, SESSION_OWNER_CHUNK_ROWS, type OwnerAppend, type OwnerBegin, type OwnerCard, type OwnerCheckpoint,
  type OwnerFailure, type OwnerResult, type SessionOwnerLimits } from '../../lib/sessionOwnerWire.js'
import { boundedJsonBytes } from '../../lib/boundedJsonBytes.js'
import { types } from 'node:util'

export interface OwnerAuthority { service: string; identity: object; current(): boolean }
export const ownerIncarnation = Symbol('owner')
export type Owner = RetainedSession & { [ownerIncarnation]: { revoked?: true } }
type Owners = Map<string, Owner>
const failure = (error: OwnerFailure): OwnerResult & { ok: false } => ({ ok: false, error })
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const fields = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === null || prototype === Object.prototype) && required.every(key => Object.hasOwn(value, key))
    && Reflect.ownKeys(value).every(key => {
      if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return !!descriptor && descriptor.enumerable === true && 'value' in descriptor
    })
}
const freshCharge = (): SessionValueCharge => ({ bytes: 2, objects: 0, properties: 0, slots: 0 })

/** This is the same sole accepted Map that reads and operation authority use; staging keeps no history. */
export function stageSessionOwners(options: {
  limits: SessionOwnerLimits
  factoryOwner(factory: unknown): SessionFactoryOwner | undefined
  native(id: string): boolean
  rows(): Owners
  commit(next: Owners, before: Owners, cards: ReadonlyMap<string, OwnerCard>, service: string): void
}) {
  const { limits, factoryOwner, native } = options
  type Stage = { authority: OwnerAuthority; transfer: string; before: Owners; after: string; count: number; next: Owners
    hash: ReturnType<typeof sessionImageHash>; received: number; charge: SessionValueCharge; cardCharge: SessionValueCharge
    cards: Map<string, OwnerCard>; expires: number; timer: ReturnType<typeof setTimeout> }
  let stage: Stage | null = null
  const serviceOf = (owner: Owner): string => {
    // Every retained owner passed ownsFactory below; this build's factory lookup cannot change after admission.
    return (factoryOwner(sessionOwnerFactory(owner)) as Extract<SessionFactoryOwner, { kind: 'service' }>).service
  }
  const ownsFactory = (service: string, factory: unknown): boolean => {
    const owner = factoryOwner(factory)
    return owner?.kind === 'service' && owner.service === service
  }
  // Every cancellation/commit clears the current timer synchronously before another stage can begin.
  const drop = (): void => { if (stage) clearTimeout(stage.timer); stage = null }
  const fingerprint = (rows: Owners, service: string, requireCurrent: boolean): OwnerCheckpoint => {
    const digest = sessionImageHash()
    let count = 0
    for (const owner of rows.values()) if (serviceOf(owner) === service) {
      if (requireCurrent && (owner[ownerIncarnation].revoked || native(sessionOwnerId(owner)))) return failure('SESSION_OWNER_CONFLICT')
      if (count++) digest.update(',')
      digest.update(JSON.stringify(sessionFactsWire(owner)))
    }
    return { fingerprint: digest.update(']').digest('hex') }
  }
  const active = (authority: OwnerAuthority, transfer: string): Stage | OwnerResult => {
    if (!authority.current()) return failure('SERVICE_UNAVAILABLE')
    if (!stage || stage.transfer !== transfer || stage.authority.identity !== authority.identity
      || stage.authority.service !== authority.service) return failure('SESSION_OWNER_EXPIRED')
    if (!stage.authority.current() || performance.now() >= stage.expires) { drop(); return failure('SESSION_OWNER_EXPIRED') }
    return stage
  }
  const add = (charge: SessionValueCharge, value: SessionValueCharge, ceiling: SessionValueCharge): void => {
    for (const key of ['bytes', 'objects', 'properties', 'slots'] as const) {
      charge[key] += value[key]
      if (charge[key] > ceiling[key]) throw new Error('SESSION_OWNER_LIMIT')
    }
  }
  const retainedCharge = (facts: SessionFacts, charge: SessionValueCharge, comma: boolean): SessionValueCharge => {
    const app = Object.hasOwn(facts, 'app'), activityObject = facts.activity != null
    return { bytes: charge.bytes + Number(comma), objects: charge.objects - Number(app) - Number(activityObject) + 1,
      // Root incarnation plus the possible revocation flag are reserved even while that token is still empty.
      properties: charge.properties - Number(app) - Number(activityObject) + 2
        + Number(app && Object.keys(facts.app!).length === 0), slots: charge.slots }
  }
  const remaining = (charge: SessionValueCharge) => ({ depth: limits.catalogue.depth,
    bytes: Math.min(limits.rowBytes, limits.catalogue.bytes - charge.bytes),
    // A detached row may have the root/activity wrappers that disappear in its flat retained record.
    objects: limits.catalogue.objects - charge.objects + 2, properties: limits.catalogue.properties - charge.properties + 2,
    slots: limits.catalogue.slots - charge.slots })
  const guarded = (run: () => OwnerResult): OwnerResult => {
    try { return run() }
    catch (error) { drop(); return failure(error instanceof Error && error.message === 'SESSION_OWNER_LIMIT' ? 'SESSION_OWNER_LIMIT' : 'SESSION_OWNER_INVALID') }
  }
  return {
    checkpoint(authority: OwnerAuthority, factory: string): OwnerCheckpoint {
      if (!authority.current()) return failure('SERVICE_UNAVAILABLE')
      if (!ownsFactory(authority.service, factory)) return failure('SESSION_OWNER_INVALID')
      return fingerprint(options.rows(), authority.service, true)
    },
    begin(authority: OwnerAuthority, input: OwnerBegin): OwnerResult {
      if (!authority.current()) return failure('SERVICE_UNAVAILABLE')
      return guarded(() => {
        if (boundedJsonBytes(input, 4096) === null || !fields(input, ['format', 'transfer', 'factory', 'before', 'after', 'count'])
          || input.format !== SESSION_FACTS_FORMAT || typeof input.transfer !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.transfer)
          || !ownsFactory(authority.service, input.factory) || !hash(input.before) || !hash(input.after)
          || !Number.isSafeInteger(input.count) || input.count < 0 || input.count > limits.count) return failure('SESSION_OWNER_INVALID')
        if (stage && (!stage.authority.current() || performance.now() >= stage.expires)) drop()
        if (stage) return failure('SESSION_OWNER_BUSY')
        const before = options.rows(), checkpoint = fingerprint(before, authority.service, false)
        if (!('fingerprint' in checkpoint) || checkpoint.fingerprint !== input.before) return failure('SESSION_OWNER_CONFLICT')
        const next: Owners = new Map(), charge = freshCharge()
        // Other declared services keep the same rows, tokens and relative order. No other view is retained.
        for (const [id, owner] of before) if (serviceOf(owner) !== authority.service) {
          const facts = sessionFactsWire(owner)
          add(charge, retainedCharge(facts, measureSessionValue(facts, remaining(charge)), next.size > 0), limits.catalogue)
          next.set(id, owner)
        }
        if (input.count + next.size > limits.count) return failure('SESSION_OWNER_LIMIT')
        const value: Stage = { authority, transfer: input.transfer, before, after: input.after, count: input.count, next,
          hash: sessionImageHash(), received: 0, charge, cardCharge: freshCharge(), cards: new Map(),
          expires: performance.now() + limits.timeoutMs, timer: setTimeout(drop, limits.timeoutMs).unref() }
        stage = value
        return { ok: true }
      })
    },
    append(authority: OwnerAuthority, input: OwnerAppend): OwnerResult {
      if (!authority.current()) return failure('SERVICE_UNAVAILABLE')
      return guarded(() => {
        if (boundedJsonBytes(input, SESSION_OWNER_CHUNK_BYTES) === null || !fields(input, ['transfer', 'index', 'rows'])
          || typeof input.transfer !== 'string' || !Array.isArray(input.rows) || !input.rows.length
          || input.rows.length > SESSION_OWNER_CHUNK_ROWS) return failure('SESSION_OWNER_INVALID')
        // Do not invoke a caller-supplied iterator, getter or sparse/inherited element on the inline path.
        if (Reflect.ownKeys(input.rows).length !== input.rows.length + 1) return failure('SESSION_OWNER_INVALID')
        const value = active(authority, input.transfer)
        if ('ok' in value) return value
        if (input.index !== value.received || input.rows.length > value.count - value.received) { drop(); return failure('SESSION_OWNER_INVALID') }
        for (let index = 0; index < input.rows.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(input.rows, index)
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('SESSION_OWNER_INVALID')
          const item = descriptor.value as OwnerAppend['rows'][number]
          if (!fields(item, ['facts'], ['card'])) throw new Error('SESSION_OWNER_INVALID')
          const admitted = readSessionFacts(item.facts, remaining(value.charge), factory => ownsFactory(authority.service, factory))
          const { facts } = admitted, prior = value.before.get(facts.id)
          if (value.next.has(facts.id) || prior && serviceOf(prior) !== authority.service) throw new Error('SESSION_OWNER_INVALID')
          const token: Owner[typeof ownerIncarnation] = prior && sessionOwnerFactory(prior) === facts.engine
            && sessionOwnerCreatedAt(prior) === facts.createdAt ? prior[ownerIncarnation] : {}
          if (token.revoked || native(facts.id)) { drop(); return failure('SESSION_OWNER_CONFLICT') }
          const owner = retainSessionFacts(facts) as Owner
          Object.defineProperty(owner, ownerIncarnation, { value: token })
          const encoded = JSON.stringify(sessionFactsWire(owner))
          add(value.charge, retainedCharge(facts, admitted.charge, value.next.size > 0), limits.catalogue)
          if (item.card !== undefined) {
            const left = { depth: limits.cards.depth, bytes: limits.cards.bytes - value.cardCharge.bytes,
              objects: limits.cards.objects - value.cardCharge.objects, properties: limits.cards.properties - value.cardCharge.properties,
              slots: limits.cards.slots - value.cardCharge.slots }
            const admittedCard = copySessionValue(item.card, left), card = admittedCard.value
            if (!fields(card, ['type', 'agentId', 'dbSessionId', 'payload'], ['name']) || card.type !== 'commander_event'
              || card.agentId !== facts.id || card.dbSessionId !== facts.id || card.name !== undefined && card.name !== facts.name
              || !card.payload || typeof card.payload !== 'object' || Array.isArray(card.payload)) throw new Error('SESSION_OWNER_INVALID')
            add(value.cardCharge, { ...admittedCard.charge, bytes: admittedCard.charge.bytes + Number(value.cards.size > 0) }, limits.cards)
            value.cards.set(facts.id, card as unknown as OwnerCard)
          }
          if (value.received++) value.hash.update(',')
          value.hash.update(encoded)
          value.next.set(facts.id, owner)
        }
        const final = active(authority, input.transfer)
        return 'ok' in final ? final : { ok: true }
      })
    },
    end(authority: OwnerAuthority, transfer: string): OwnerResult {
      return guarded(() => {
        const value = active(authority, transfer)
        if ('ok' in value) return value
        if (value.received !== value.count || value.hash.update(']').digest('hex') !== value.after) {
          drop(); return failure('SESSION_OWNER_INVALID')
        }
        for (const owner of value.next.values()) if (serviceOf(owner) === authority.service) {
          if (owner[ownerIncarnation].revoked || native(sessionOwnerId(owner))) { drop(); return failure('SESSION_OWNER_CONFLICT') }
        }
        // Revoked omitted rows can be dropped, but can never send a deletion or a stale card over a native owner.
        const final = active(authority, transfer)
        if ('ok' in final) return final
        drop()
        try { options.commit(value.next, value.before, value.cards, authority.service) }
        catch { return failure('SERVICE_UNAVAILABLE') }
        return { ok: true }
      })
    },
    cancel(authority: OwnerAuthority, transfer: string): OwnerResult {
      if (!authority.current()) return failure('SERVICE_UNAVAILABLE')
      if (stage?.transfer === transfer && stage.authority.identity === authority.identity && stage.authority.service === authority.service) drop()
      return { ok: true }
    },
    stop: drop,
  }
}
