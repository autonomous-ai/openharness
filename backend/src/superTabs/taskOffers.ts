/**
 * A task offered to one agent (package 16 of the allocator, docs/design/2026-11-11-swarm-allocator/offers.md). The PM's person's
 * daemon gives a task by putting `builder:<name>` on its GitHub issue, and GitHub cannot set a label "only if unset": two writers
 * can each label one task, and its builder's own computer is never asked whether it has room. So the offer is a record here, the
 * referee of who may take the task: one document for a task, live until the server's clock passes its expiry. Its agent's own
 * daemon accepts or declines it; declined or lapsed, a later offer of the task takes its place.
 *
 * The server referees this one record and decides nothing (Swarm plan, "Not built": a workflow in server code): it picks no
 * agent, offers nothing again, runs no timer and writes nothing on GitHub. A row holds ids, a repository's name, an issue's
 * number, times and one word: no task text, no login, no quota number. Each goes a day after it ended.
 */
import type { PrismaClient } from '@prisma/client'
import { ensureIndex } from '../lib/db/indexes.js'
import { metrics } from '../lib/metrics.js'
import { createRateLimiter } from '../lib/rateLimit.js'
import { fail } from './model.js'
import { readBy } from './parts/indexed.js'
import { prismaRow } from './rawRows.js'

/** How long an offer waits for its agent's daemon: it answers by code within seconds of being told, and reads its offers once a
 *  minute besides, so two minutes cover a lost push and one more read. */
export const OFFER_ANSWER_MS = 2 * 60_000
/** How long an accepted offer holds its task from the accept: its agent's time to take it, as a task given by label and not
 *  taken goes to another after ten minutes (cli superTabs/githubAssign.ts WAIT_TAKE_MS). */
export const OFFER_TAKE_MS = 10 * 60_000
/** How long an ended offer is still listed for its project: the PM's daemon reads once a minute, and must see a decline. */
export const OFFER_SHOWN_MS = 10 * 60_000
/** A record is kept this long after it ended. */
const OFFER_EXPIRY_MS = 24 * 60 * 60_000
/** New offers one Product Manager may make in an hour: ten times what thirty builders take (four an hour each), low enough that a
 *  loop cannot fill the collection. */
export const OFFERS_PER_HOUR = 1_200
/** Offers one read lists at most: a project's, and an agent's own. */
export const PROJECT_OFFERS_MAX = 200, AGENT_OFFERS_MAX = 20

const offerLimit = createRateLimiter('task-offer', 60 * 60_000, OFFERS_PER_HOUR)
const COLLECTION = 'SuperTabTaskOffer'
/** MongoDB's code for a write the unique index refused. */
const DUPLICATE_KEY = 11000
/** A time as a raw command takes it. */
const at = (time: number) => ({ $date: new Date(time).toISOString() })

/** The stored id of a task's one record in a Swarm: a repository's name is any case on GitHub. */
export const offerKey = (tabId: string, repository: string, number: number): string => `${tabId}|${repository.toLowerCase()}|${number}`

/** Run by the release's schema step before db push (lib/db/schemaRelease.ts), as the verdict records' expiry is. */
export async function ensureOfferExpiry(db: PrismaClient): Promise<void> {
  await ensureIndex(db, COLLECTION, { key: { expiresAt: 1 }, name: 'task_offer_expiry', expireAfterSeconds: OFFER_EXPIRY_MS / 1000 })
}

type Offers = Pick<PrismaClient, 'superTabTaskOffer' | '$runCommandRaw'>
interface Row { repository: string; number: number; agentId: string; offeredAt: Date; expiresAt: Date; acceptedAt: Date | null; declinedAt: Date | null
  declined: string | null }

export type OfferState = 'offered' | 'accepted' | 'declined' | 'lapsed'
/** An offer as a reader is told it, its times in epoch milliseconds on the server's clock. */
export interface TaskOffer { repository: string; number: number; agentId: string; state: OfferState; offeredAt: number; expiresAt: number
  acceptedAt?: number; declined?: string }

/** What a record is at [now], worked out as it is read: nothing stores a state, and nothing moves one. Live is one comparison,
 *  as a decline brings the expiry to the moment it was made. */
export function offerState(row: Pick<Row, 'expiresAt' | 'acceptedAt' | 'declinedAt'>, now: number): OfferState {
  if (row.declinedAt) return 'declined'
  if (row.expiresAt.getTime() <= now) return 'lapsed'
  return row.acceptedAt ? 'accepted' : 'offered'
}

const view = (row: Row, now: number): TaskOffer => ({ repository: row.repository, number: row.number, agentId: row.agentId, state: offerState(row, now),
  offeredAt: row.offeredAt.getTime(), expiresAt: row.expiresAt.getTime(), ...(row.acceptedAt ? { acceptedAt: row.acceptedAt.getTime() } : {}),
  ...(row.declined ? { declined: row.declined } : {}) })

const notLive = (): never => {
  metrics.taskOffer('late')
  // One answer, whether it lapsed, was declined, is another agent's or never was.
  return fail('OFFER_NOT_LIVE', 'This task is not offered to this agent now.', 409)
}

/**
 * Offers task [number] of [repository] to [agentId], for the Product Manager [byAgentId] of [projectId]. One live offer for a
 * task, made true by one write: an upsert of the task's id whose filter is "no longer live". Where no record of the task stands
 * it is inserted; where an ended one stands it is replaced; where a live one stands the filter matches nothing, the insert that
 * follows meets the unique id, and nothing is written. Never a read then a write (Prisma's own updateMany is one: it reads the
 * ids its filter matches, then updates by id alone, so two requests at once both win): of two offers at once MongoDB applies one
 * to the document, and the other then matches nothing. The same offer again (this agent's, still live) answers the standing
 * record and writes nothing, so a daemon's retry costs nothing; only a new offer counts against the Product Manager's hour,
 * every pod together.
 */
export async function offerTask(db: Offers, input: { tabId: string; projectId: string; byAgentId: string; repository: string; number: number
  agentId: string; now: number }): Promise<TaskOffer> {
  const id = offerKey(input.tabId, input.repository, input.number)
  const standing = async () => {
    const held = await db.superTabTaskOffer.findUnique({ where: { id } })
    return held && held.agentId === input.agentId && ['offered', 'accepted'].includes(offerState(held, input.now)) ? held : null
  }
  const again = await standing()
  if (again) {
    metrics.taskOffer('again')
    return view(again, input.now)
  }
  if (!await offerLimit.allows(`${input.tabId}:${input.byAgentId}`, input.now)) {
    metrics.taskOffer('limited')
    fail('RATE_LIMITED', `A Product Manager offers at most ${OFFERS_PER_HOUR} tasks an hour. Try again later.`, 429)
  }
  // Every field written, the unanswered ones as null: the next offer of the task overwrites all of the last one.
  const offer = { tabId: input.tabId, projectId: input.projectId, repository: input.repository.toLowerCase(), number: input.number, agentId: input.agentId,
    acceptedAt: null, declinedAt: null, declined: null }
  const expiresAt = input.now + OFFER_ANSWER_MS
  const written = await db.$runCommandRaw({ update: COLLECTION, updates: [{ q: { _id: id, expiresAt: { $lte: at(input.now) } }, upsert: true,
    u: { $set: { ...offer, offeredAt: at(input.now), expiresAt: at(expiresAt) } } }] }) as { n?: number; writeErrors?: Array<{ code?: number }> }
  if (written.n !== 1) {
    // Only the unique id may have refused it: anything else is a write that failed, and is said as one.
    if (written.writeErrors?.[0]?.code !== DUPLICATE_KEY) throw new Error('A task offer could not be stored.')
    // A live offer of the task stands: this agent's own, made at the same moment, is this one again.
    const won = await standing()
    if (!won) {
      metrics.taskOffer('live')
      fail('OFFER_LIVE', 'This task is offered to another agent until it answers or the offer lapses.', 409)
    }
    metrics.taskOffer('again')
    return view(won, input.now)
  }
  metrics.taskOffer('offered')
  return view({ ...offer, offeredAt: new Date(input.now), expiresAt: new Date(expiresAt) }, input.now)
}

/** One update of a task's record that matches only where [query] holds, and the record after it, or null where it matched
 *  nothing: the condition is in the write itself, so an answer racing a lapse or a newer offer changes nothing. */
async function change(db: Offers, query: Record<string, unknown>, set: Record<string, unknown>): Promise<Row | null> {
  const reply = await db.$runCommandRaw({ findAndModify: COLLECTION, query: query as never, update: { $set: set } as never, new: true }) as
    { value?: Record<string, unknown> | null }
  return reply.value ? prismaRow<Row>(COLLECTION, reply.value) : null
}

/**
 * [agentId]'s acceptance of the offer of a task: one update that matches only its own live offer not yet accepted, so a lapsed
 * offer, another agent's, and a newer offer of the same task to another agent are each left as they are. Accepted, it holds the
 * task [OFFER_TAKE_MS] from now. Asked again while that stands it answers the same and extends nothing: an agent cannot hold a
 * task by accepting it over and over.
 */
export async function acceptOffer(db: Offers, input: { tabId: string; repository: string; number: number; agentId: string; now: number }): Promise<TaskOffer> {
  const id = offerKey(input.tabId, input.repository, input.number)
  const accepted = await change(db, { _id: id, agentId: input.agentId, expiresAt: { $gt: at(input.now) }, acceptedAt: null },
    { acceptedAt: at(input.now), expiresAt: at(input.now + OFFER_TAKE_MS) })
  if (accepted) {
    metrics.taskOfferAccepted((input.now - accepted.offeredAt.getTime()) / 1000)
    return view(accepted, input.now)
  }
  const held = await db.superTabTaskOffer.findUnique({ where: { id } })
  if (!held || held.agentId !== input.agentId || offerState(held, input.now) !== 'accepted') return notLive()
  metrics.taskOffer('again')
  return view(held, input.now)
}

/**
 * [agentId]'s decline of the offer of a task, with why in one word: one update that matches only its own live offer, accepted or
 * not, and ends it at once by bringing its expiry to now. The same decline again answers the record as it was declined.
 */
export async function declineOffer(db: Offers, input: { tabId: string; repository: string; number: number; agentId: string; reason: string
  now: number }): Promise<TaskOffer> {
  const id = offerKey(input.tabId, input.repository, input.number)
  const declined = await change(db, { _id: id, agentId: input.agentId, expiresAt: { $gt: at(input.now) } },
    { declinedAt: at(input.now), declined: input.reason, expiresAt: at(input.now) })
  if (declined) {
    metrics.taskOffer('declined')
    return view(declined, input.now)
  }
  const held = await db.superTabTaskOffer.findUnique({ where: { id } })
  if (!held || held.agentId !== input.agentId || offerState(held, input.now) !== 'declined') return notLive()
  metrics.taskOffer('again')
  return view(held, input.now)
}

/** The offers of the projects [projectIds] of [tabId], live or ended in the last [OFFER_SHOWN_MS], the ones that end last first:
 *  at most [PROJECT_OFFERS_MAX], and whether there are more. One read by the project index, named. */
export async function projectOffers(db: Offers, tabId: string, projectIds: readonly string[], now: number): Promise<{ offers: TaskOffer[]; more: boolean }> {
  const rows = await readBy(db as never, COLLECTION, 'project', [
    { $match: { tabId, projectId: { $in: [...projectIds] }, expiresAt: { $gt: at(now - OFFER_SHOWN_MS) } } },
    { $sort: { expiresAt: -1 } }, { $limit: PROJECT_OFFERS_MAX + 1 }])
  return { offers: rows.slice(0, PROJECT_OFFERS_MAX).map(row => view(prismaRow<Row>(COLLECTION, row), now)), more: rows.length > PROJECT_OFFERS_MAX }
}

/** The live offers of [agentId] in [tabId], the ones that end first first: at most [AGENT_OFFERS_MAX]. One read by the agent
 *  index, named. */
export async function agentOffers(db: Offers, tabId: string, agentId: string, now: number): Promise<TaskOffer[]> {
  const rows = await readBy(db as never, COLLECTION, 'agent', [
    { $match: { tabId, agentId, expiresAt: { $gt: at(now) } } }, { $sort: { expiresAt: 1 } }, { $limit: AGENT_OFFERS_MAX }])
  return rows.map(row => view(prismaRow<Row>(COLLECTION, row), now))
}
