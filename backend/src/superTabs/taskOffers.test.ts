import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { acceptOffer, declineOffer, offerKey, offerState, offerTask, OFFER_ANSWER_MS, OFFER_TAKE_MS, OFFERS_PER_HOUR } from './taskOffers.js'
import { SuperTabError } from './model.js'

type Row = { id: string; tabId: string; projectId: string; repository: string; number: number; agentId: string; offeredAt: Date; expiresAt: Date
  acceptedAt: Date | null; declinedAt: Date | null; declined: string | null }
type Raw = Record<string, unknown>

/** A time as a raw command carries it, as the Date it stands for. */
const date = (value: unknown): unknown => value && typeof value === 'object' && '$date' in value ? new Date((value as { $date: string }).$date) : value

/** The collection as MongoDB keeps it: an update changes the one document its filter matches; an upsert that matches none
 *  inserts the task's id, and where a document of that id stands is refused as a duplicate key, as the update command says it. */
function database() {
  const rows = new Map<string, Row>()
  const matches = (row: Row, query: Raw) => Object.entries(query).every(([field, want]) => {
    const have = field === '_id' ? row.id : row[field as keyof Row]
    if (want === null || typeof want !== 'object') return have === want
    const { $lte, $gt } = want as { $lte?: unknown; $gt?: unknown }, time = (have as Date).getTime()
    return ($lte === undefined || time <= (date($lte) as Date).getTime()) && ($gt === undefined || time > (date($gt) as Date).getTime())
  })
  const set = (fields: Raw) => Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, date(value)]))
  const stored = (row: Row) => Object.fromEntries(Object.entries(row).map(([field, value]) =>
    [field === 'id' ? '_id' : field, value instanceof Date ? { $date: value.toISOString() } : value]))
  const db = {
    superTabTaskOffer: { findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null },
    $runCommandRaw: async (command: Raw) => {
      if (!('findAndModify' in command)) {
        const [{ q, u }] = command.updates as [{ q: Raw & { _id: string }; u: { $set: Raw } }]
        const row = rows.get(q._id)
        if (row && !matches(row, q)) return { ok: 1, n: 0, writeErrors: [{ code: 11000 }] }
        rows.set(q._id, { ...row, id: q._id, ...set(u.$set) } as Row)
        return { ok: 1, n: 1 }
      }
      const { query, update } = command as { query: Raw & { _id: string }; update: { $set: Raw } }
      const row = rows.get(query._id)
      if (!row || !matches(row, query)) return { ok: 1, value: null }
      Object.assign(row, set(update.$set))
      return { ok: 1, value: stored(row) }
    },
  } as unknown as PrismaClient
  return { db, rows }
}
const NOW = 1_800_000_000_000
const KEY = 'tab|acme/app|14'
const offer = (db: PrismaClient, over: Partial<Parameters<typeof offerTask>[1]> = {}) =>
  offerTask(db, { tabId: 'tab', projectId: 'web', byAgentId: 'juno', repository: 'Acme/App', number: 14, agentId: 'oak', now: NOW, ...over })
const answer = (agentId: string, now: number) => ({ tabId: 'tab', repository: 'acme/app', number: 14, agentId, now })
const refusal = async (body: () => Promise<unknown>) => {
  try { await body(); return null } catch (error) { if (error instanceof SuperTabError) return error; throw error }
}

describe('a task offered to one agent', () => {
  it('keeps one document for a task: its Swarm, the repository in lower case and the issue, live for two minutes', async () => {
    const { db, rows } = database()
    expect(await offer(db)).toEqual({ repository: 'acme/app', number: 14, agentId: 'oak', state: 'offered', offeredAt: NOW, expiresAt: NOW + OFFER_ANSWER_MS })
    expect([...rows.values()]).toEqual([{ id: KEY, tabId: 'tab', projectId: 'web', repository: 'acme/app', number: 14, agentId: 'oak',
      offeredAt: new Date(NOW), expiresAt: new Date(NOW + 2 * 60_000), acceptedAt: null, declinedAt: null, declined: null }])
    expect(offerKey('tab', 'Acme/App', 14)).toBe(KEY)
  })

  it('refuses a second offer of a task while one is live, and answers the same offer again without writing', async () => {
    const { db, rows } = database()
    await offer(db)
    expect(await refusal(() => offer(db, { agentId: 'ash', now: NOW + 1 }))).toMatchObject({ code: 'OFFER_LIVE', status: 409 })
    expect(await offer(db, { repository: 'acme/app', now: NOW + 60_000 })).toMatchObject({ agentId: 'oak', offeredAt: NOW, expiresAt: NOW + OFFER_ANSWER_MS })
    expect(rows.get(KEY)).toMatchObject({ agentId: 'oak', offeredAt: new Date(NOW) })
    // Another task of the repository, and the same task in another Swarm, are records of their own.
    expect(await offer(db, { agentId: 'ash', number: 15 })).toMatchObject({ agentId: 'ash', number: 15 })
    expect(await offer(db, { agentId: 'ash', tabId: 'other' })).toMatchObject({ agentId: 'ash' })
    expect(rows.size).toBe(3)
  })

  it('lets a later offer take the place of one that lapsed or was declined, and of no live one', async () => {
    const { db, rows } = database()
    await offer(db)
    expect(await refusal(() => offer(db, { agentId: 'ash', now: NOW + OFFER_ANSWER_MS - 1 }))).toMatchObject({ code: 'OFFER_LIVE' })
    const later = NOW + OFFER_ANSWER_MS
    expect(await offer(db, { agentId: 'ash', projectId: 'api', now: later })).toEqual({ repository: 'acme/app', number: 14, agentId: 'ash', state: 'offered',
      offeredAt: later, expiresAt: later + OFFER_ANSWER_MS })
    expect(rows.get(KEY)).toMatchObject({ agentId: 'ash', projectId: 'api', acceptedAt: null, declinedAt: null, declined: null })
    // Accepted, it is live for ten minutes more; declined, not a moment longer, and what it said goes with it.
    await acceptOffer(db, answer('ash', later))
    expect(await refusal(() => offer(db, { now: later + OFFER_TAKE_MS - 1 }))).toMatchObject({ code: 'OFFER_LIVE' })
    await declineOffer(db, { ...answer('ash', later + 1), reason: 'memory' })
    expect(await offer(db, { now: later + 1 })).toMatchObject({ agentId: 'oak', state: 'offered', offeredAt: later + 1 })
    expect(rows.get(KEY)).toMatchObject({ agentId: 'oak', acceptedAt: null, declinedAt: null, declined: null })
    expect(rows.size).toBe(1)
  })

  it('is accepted only while it is live and only by its own agent, and asking twice extends nothing', async () => {
    const { db, rows } = database()
    await offer(db)
    expect(await refusal(() => acceptOffer(db, answer('ash', NOW + 1)))).toMatchObject({ code: 'OFFER_NOT_LIVE', status: 409 })
    expect(await refusal(() => acceptOffer(db, { ...answer('oak', NOW + 1), number: 15 }))).toMatchObject({ code: 'OFFER_NOT_LIVE' })
    const at = NOW + 60_000
    const accepted = { repository: 'acme/app', number: 14, agentId: 'oak', state: 'accepted', offeredAt: NOW, acceptedAt: at, expiresAt: at + OFFER_TAKE_MS }
    expect(await acceptOffer(db, answer('oak', at))).toEqual(accepted)
    // Accepted, it is still no other agent's to accept or to be told of.
    expect(await refusal(() => acceptOffer(db, answer('ash', at + 1)))).toMatchObject({ code: 'OFFER_NOT_LIVE' })
    expect(await acceptOffer(db, answer('oak', at + 5 * 60_000))).toEqual(accepted)
    expect(rows.get(KEY)!.expiresAt).toEqual(new Date(at + 10 * 60_000))
    expect(await refusal(() => acceptOffer(db, answer('oak', at + OFFER_TAKE_MS)))).toMatchObject({ code: 'OFFER_NOT_LIVE' })
  })

  it('is not accepted once its two minutes passed with no answer', async () => {
    const { db, rows } = database()
    await offer(db)
    expect(await refusal(() => acceptOffer(db, answer('oak', NOW + OFFER_ANSWER_MS)))).toMatchObject({ code: 'OFFER_NOT_LIVE', status: 409 })
    expect(rows.get(KEY)).toMatchObject({ acceptedAt: null, expiresAt: new Date(NOW + OFFER_ANSWER_MS) })
  })

  it('is declined only while it is live and only by its own agent, with its reason, and ends at once', async () => {
    const { db, rows } = database()
    await offer(db)
    expect(await refusal(() => declineOffer(db, { ...answer('ash', NOW + 1), reason: 'disk' }))).toMatchObject({ code: 'OFFER_NOT_LIVE', status: 409 })
    const declined = { repository: 'acme/app', number: 14, agentId: 'oak', state: 'declined', offeredAt: NOW, expiresAt: NOW + 5, declined: 'memory' }
    expect(await declineOffer(db, { ...answer('oak', NOW + 5), reason: 'memory' })).toEqual(declined)
    // The same decline again is no change; an accept after it is too late, and another agent is told nothing of it.
    expect(await declineOffer(db, { ...answer('oak', NOW + 9), reason: 'disk' })).toEqual(declined)
    expect(await refusal(() => declineOffer(db, { ...answer('ash', NOW + 9), reason: 'disk' }))).toMatchObject({ code: 'OFFER_NOT_LIVE' })
    expect(await refusal(() => acceptOffer(db, answer('oak', NOW + 9)))).toMatchObject({ code: 'OFFER_NOT_LIVE' })
    expect(rows.get(KEY)).toMatchObject({ declined: 'memory', declinedAt: new Date(NOW + 5), expiresAt: new Date(NOW + 5) })
    // One that lapsed unanswered is not declined after the fact.
    await offer(db, { number: 15 })
    expect(await refusal(() => declineOffer(db, { ...answer('oak', NOW + OFFER_ANSWER_MS), number: 15, reason: 'disk' }))).toMatchObject({ code: 'OFFER_NOT_LIVE' })
    expect(rows.get('tab|acme/app|15')).toMatchObject({ declinedAt: null })
  })

  // Review of #4152: an accept whose clock read a moment before a decline's matched the declined record, and held its task ten
  // minutes more (on MongoDB, an accept and a decline at once with clocks a millisecond apart: 16 of 40 ended so).
  it('is not accepted once it was declined, nor declined again, whatever moment the answer\'s clock reads', async () => {
    const { db, rows } = database()
    await offer(db)
    await declineOffer(db, { ...answer('oak', NOW + 5), reason: 'memory' })
    expect(await refusal(() => acceptOffer(db, answer('oak', NOW + 4)))).toMatchObject({ code: 'OFFER_NOT_LIVE', status: 409 })
    expect(await declineOffer(db, { ...answer('oak', NOW + 4), reason: 'disk' })).toMatchObject({ state: 'declined', declined: 'memory', expiresAt: NOW + 5 })
    expect(rows.get(KEY)).toMatchObject({ acceptedAt: null, declined: 'memory', declinedAt: new Date(NOW + 5), expiresAt: new Date(NOW + 5) })
  })

  it('may be declined after it was accepted, while it is live', async () => {
    const { db } = database()
    await offer(db)
    await acceptOffer(db, answer('oak', NOW + 1))
    expect(await declineOffer(db, { ...answer('oak', NOW + 60_000), reason: 'limit' })).toMatchObject({ state: 'declined', declined: 'limit', expiresAt: NOW + 60_000 })
    expect(await offer(db, { agentId: 'ash', now: NOW + 60_000 })).toMatchObject({ agentId: 'ash', state: 'offered' })
  })

  it('answers by who won when another offer of the task was written first', async () => {
    const { db, rows } = database()
    await offer(db)
    const later = NOW + OFFER_ANSWER_MS
    // Another server's offer lands between this one's look and its write: the write then meets the unique id.
    const racing = (winner: string) => ({ ...db, $runCommandRaw: async () => {
      rows.set(KEY, { ...rows.get(KEY)!, agentId: winner, offeredAt: new Date(later), expiresAt: new Date(later + OFFER_ANSWER_MS) })
      return { ok: 1, n: 0, writeErrors: [{ code: 11000 }] }
    } }) as unknown as PrismaClient
    expect(await offer(racing('ash'), { agentId: 'ash', now: later })).toMatchObject({ agentId: 'ash', offeredAt: later })
    rows.set(KEY, { ...rows.get(KEY)!, expiresAt: new Date(later) })
    expect(await refusal(() => offer(racing('elm'), { agentId: 'ash', now: later }))).toMatchObject({ code: 'OFFER_LIVE', status: 409 })
    expect(rows.get(KEY)!.agentId).toBe('elm')
  })

  it('says a write that failed as a failure, never as an offer made or one refused', async () => {
    const { db, rows } = database()
    const failing = { ...db, $runCommandRaw: async () => ({ ok: 1, n: 0, writeErrors: [{ code: 50 }] }) } as unknown as PrismaClient
    await expect(offer(failing)).rejects.toThrow('A task offer could not be stored.')
    expect(rows.size).toBe(0)
  })

  it('refuses a Product Manager past its hourly new offers, never a repeat of a standing one, and no other', async () => {
    const { db } = database()
    for (let i = 0; i < OFFERS_PER_HOUR; i++) await offer(db, { byAgentId: 'busy', number: i + 1, now: NOW + 1 })
    expect(await offer(db, { byAgentId: 'busy', number: 1, now: NOW + 2 })).toMatchObject({ number: 1 })
    expect(await refusal(() => offer(db, { byAgentId: 'busy', number: 9001, now: NOW + 2 }))).toMatchObject({ code: 'RATE_LIMITED', status: 429 })
    expect(await offer(db, { byAgentId: 'calm', number: 9002, now: NOW + 2 })).toMatchObject({ number: 9002 })
  })

  // Review of #4152: each refusal of a task another agent's offer holds counted against the hour, so a PM refused 1,199 times was
  // refused every new offer for the rest of it.
  it('counts no offer refused because another agent\'s holds the task against the Product Manager\'s hour', async () => {
    const { db } = database()
    const patient = (over: Partial<Parameters<typeof offerTask>[1]>) => offer(db, { tabId: 'patient-tab', byAgentId: 'patient', ...over })
    await patient({ number: 1 })
    for (let i = 0; i < OFFERS_PER_HOUR; i++) {
      expect(await refusal(() => patient({ number: 1, agentId: 'ash', now: NOW + 1 })), String(i)).toMatchObject({ code: 'OFFER_LIVE', status: 409 })
    }
    expect(await patient({ number: 2, now: NOW + 2 })).toMatchObject({ number: 2, state: 'offered' })
  })

  it('reads as what its times say on the clock it is read by', () => {
    const row = { offeredAt: new Date(NOW), expiresAt: new Date(NOW + OFFER_ANSWER_MS), acceptedAt: null, declinedAt: null }
    expect(offerState(row, NOW + OFFER_ANSWER_MS - 1)).toBe('offered')
    expect(offerState(row, NOW + OFFER_ANSWER_MS)).toBe('lapsed')
    expect(offerState({ ...row, acceptedAt: new Date(NOW + 1) }, NOW + 2)).toBe('accepted')
    expect(offerState({ ...row, acceptedAt: new Date(NOW + 1) }, NOW + OFFER_ANSWER_MS)).toBe('lapsed')
    expect(offerState({ ...row, acceptedAt: new Date(NOW + 1), declinedAt: new Date(NOW + 2), expiresAt: new Date(NOW + 2) }, NOW + 2)).toBe('declined')
  })
})
