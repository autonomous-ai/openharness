import type { Prisma, SuperTabDelivery, SuperTabMessage } from '@prisma/client'
import { routingRow } from './buddies.js'
import { ms } from './parts/light.js'
import type { ReactionRow } from './reactions.js'
import { agentOnly, stableId, type Author } from './model.js'
import { readBy } from './parts/indexed.js'
import { prismaRow } from './rawRows.js'

type Transaction = Prisma.TransactionClient

// A page's rows are read by a plain {tabId, messageId: {$in}} match. Prisma sends `messageId: { in }` as an $expr $or: Mongo
// cannot bound an index by it, and on 2026-10-28 each page read scanned every delivery of its Swarm (prod at 100% CPU).
// Each read here uses its tabId+messageId index and examines only the rows it returns (integration/superTabIndexes.test.ts).

/** The reactions on one page of messages. */
export async function pageReactions(tx: Transaction, tabId: string, messageIds: string[]): Promise<ReactionRow[]> {
  return await tx.superTabReaction.aggregateRaw({ pipeline: [{ $match: { tabId, messageId: { $in: messageIds } } },
    { $project: { _id: 0, messageId: 1, emoji: 1, actorKind: 1, actorId: 1 } }] }) as unknown as ReactionRow[]
}

export type PageDelivery = Pick<SuperTabDelivery, 'id' | 'messageId' | 'agentId' | 'status' | 'receipt' | 'holdReason' | 'holdSince'
  | 'claimFailingSince' | 'claimFailures' | 'deliveredAt' | 'answeredAt' | 'createdAt' | 'updatedAt'>

const date = (value: unknown) => value == null ? null : value instanceof Date ? value : new Date(ms(value))

/** The deliveries of one page of messages: who each message went to and how far it got, from the live rows and the
 *  compacted receipts (deliveryCompaction.ts), a live row winning for the same agent. As Prisma read them: dates as Dates,
 *  and an optional field an older record lacks as null. A compacted receipt gives only these fields, never its host's. */
export async function pageDeliveries(tx: Transaction, tabId: string, messageIds: string[]): Promise<PageDelivery[]> {
  const rows = await tx.superTabDelivery.aggregateRaw({ pipeline: [{ $match: { tabId, messageId: { $in: messageIds } } },
    { $project: { messageId: 1, agentId: 1, status: 1, receipt: 1, holdReason: 1, holdSince: 1, claimFailingSince: 1, claimFailures: 1, deliveredAt: 1, answeredAt: 1, createdAt: 1, updatedAt: 1 } }] }) as
    unknown as Array<Record<string, unknown>>
  // After the rows, never beside them: a delivery compacted between the two reads is then in both, never in neither.
  const compacted = await compactedReceipts(tx, tabId, messageIds)
  const live = rows.map(row => pageDelivery({ ...row, id: row._id }))
  const held = new Set(live.map(d => `${d.messageId}\0${d.agentId}`))
  return [...live, ...compacted.filter(d => !held.has(`${d.messageId}\0${d.agentId}`)).map(pageDelivery)]
}

const pageDelivery = (row: Record<string, unknown>): PageDelivery => ({ id: row.id as string, messageId: row.messageId as string, agentId: row.agentId as string,
  status: row.status as string, receipt: (row.receipt ?? null) as string | null, holdReason: (row.holdReason ?? null) as string | null, holdSince: date(row.holdSince),
  claimFailingSince: date(row.claimFailingSince), claimFailures: (row.claimFailures ?? null) as number | null,
  deliveredAt: date(row.deliveredAt), answeredAt: date(row.answeredAt), createdAt: date(row.createdAt)!, updatedAt: date(row.updatedAt)! })

/** The fields a receipt document keeps of each of its deliveries, rather than per receipt. */
const RECEIPT_DOCUMENT = new Set(['id', 'tabId', 'conversationId', 'messageId', 'agentId'])

/** A delivery row as its compacted receipt stores it in its message's SuperTabReceipt (deliveryCompaction.ts), for a raw `$set`
 *  (dates as extended JSON): the row as it was, under its agent's id and with its own as `deliveryId`, without what the
 *  document holds once (its message, Swarm and conversation). The whole row is kept: a host that still holds the delivery is
 *  answered from it (store.ts deliveryReceipt, deliver), as from the row. */
export function receiptFields(row: SuperTabDelivery): Prisma.InputJsonObject {
  const stored: Record<string, Prisma.InputJsonValue | null> = { deliveryId: row.id }
  for (const [key, value] of Object.entries(row)) {
    if (!RECEIPT_DOCUMENT.has(key)) stored[key] = value instanceof Date ? { $date: value.toISOString() } : value as Prisma.InputJsonValue | null
  }
  return stored as Prisma.InputJsonObject
}

/** A receipt document as raw reads return it. */
interface ReceiptDocument { _id: string; tabId: string; conversationId: string; receipts?: Record<string, Record<string, unknown>> }

/** One compacted receipt as the delivery row it was: dates as Dates, a field the row did not have as null. */
function compactedRow(document: ReceiptDocument, agentId: string, stored: Record<string, unknown>): SuperTabDelivery {
  const row: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(stored)) {
    row[key] = value && typeof value === 'object' && '$date' in value ? date(value) : value
  }
  const { deliveryId, ...fields } = row
  return { ...fields, id: deliveryId as string, tabId: document.tabId, conversationId: document.conversationId, messageId: document._id, agentId } as SuperTabDelivery
}

/** The compacted receipts of these messages, one per agent. By the primary key; the Swarm checked in the match. */
async function compactedReceipts(tx: Transaction, tabId: string, messageIds: string[]): Promise<SuperTabDelivery[]> {
  const documents = await readBy(tx, 'SuperTabReceipt', 'id', [{ $match: { _id: { $in: messageIds }, tabId } }]) as unknown as ReceiptDocument[]
  return documents.flatMap(document => Object.entries(document.receipts ?? {}).map(([agentId, stored]) => compactedRow(document, agentId, stored)))
}

/** A delivery of this agent that was compacted, as the row it was, found by its id (index [tabId, deliveryIds]); null when
 *  there is none. A host back after weeks offline still settles what its journal holds (store.ts deliveryReceipt, deliver). */
export async function compactedDelivery(tx: Transaction, tabId: string, agentId: string, deliveryId: string): Promise<SuperTabDelivery | null> {
  const [document] = await readBy(tx, 'SuperTabReceipt', 'delivery', [{ $match: { tabId, deliveryIds: deliveryId } }, { $limit: 1 }]) as unknown as ReceiptDocument[]
  const stored = document?.receipts?.[agentId]
  return document && stored?.deliveryId === deliveryId ? compactedRow(document, agentId, stored) : null
}

/** The deliveries a host is still told about (the rest are answered, cancelled or confirmed). */
export const OPEN_DELIVERY = ['queued', 'claimed', 'uncertain'] as const

/** An agent's open deliveries, oldest first and each conversation's tied rows in its order: one indexed read, and the tied
 *  messages' sequences only when there are ties. */
export async function agentOpenDeliveries(tx: Transaction, tabId: string, agentId: string): Promise<SuperTabDelivery[]> {
  // By the agent index (parts/indexed.ts): Prisma sent `status: { in }` as an $expr $or, planned as one scan per status.
  const rows = await readBy(tx, 'SuperTabDelivery', 'agentOpen', [{ $match: { tabId, agentId, status: { $in: [...OPEN_DELIVERY] } } },
    { $sort: { createdAt: 1 } }, { $limit: 100 }])
  return inConversationOrder(tx, tabId, rows.map(row => prismaRow<SuperTabDelivery>('SuperTabDelivery', row)))
}

/** An agent's open deliveries, read by creation time, with each conversation's tied rows put in its message order. One
 *  write's deliveries share a creation time, and Mongo breaks that tie by insertion order alone. Each conversation keeps its
 *  places among the others; only tied rows have their messages' sequences read. */
export async function inConversationOrder<T extends Pick<SuperTabDelivery, 'conversationId' | 'messageId' | 'createdAt'>>(
  tx: Transaction, tabId: string, rows: T[]): Promise<T[]> {
  const ties = new Map<string, number[]>()
  rows.forEach((row, index) => {
    const key = `${row.conversationId}\0${row.createdAt.getTime()}`
    ties.set(key, [...ties.get(key) ?? [], index])
  })
  const tied = [...ties.values()].filter(places => places.length > 1)
  if (!tied.length) return rows
  // Matched by id alone: with tabId in the match, the planner can cover it from the tabId+conversationId+sequence index
  // and walk every message key of the Swarm. The Swarm is checked here instead.
  const found = await tx.superTabMessage.aggregateRaw({ pipeline: [
    { $match: { _id: { $in: tied.flat().map(index => rows[index]!.messageId) } } }, { $project: { tabId: 1, sequence: 1 } }] }) as
    unknown as Array<{ _id: string; tabId: string; sequence: number }>
  const sequence = new Map(found.filter(message => message.tabId === tabId).map(message => [message._id, message.sequence]))
  const ordered = [...rows]
  for (const places of tied) {
    const group = places.map(index => rows[index]!)
      .sort((a, b) => (sequence.get(a.messageId) ?? Infinity) - (sequence.get(b.messageId) ?? Infinity))
    places.forEach((index, at) => { ordered[index] = group[at]! })
  }
  return ordered
}

/** Where a page of messages starts: past this sequence, and within it past this id when one is given. */
export interface MessageEdge { sequence: number; id?: string }

/**
 * Up to `limit` messages of one conversation past `edge` (from the newest or oldest without one), in (sequence, id) order
 * forward or backward. A cursor inside a sequence is two reads its index bounds: the rest of that sequence by id, then the
 * sequences past it. As one `$or`, the planner could not bound it: reading on from inside a sequence walked the whole
 * conversation before it (roadmap Phase 3.5; integration/superTabNamedReads.test.ts).
 */
export async function messagesPast(tx: Transaction, at: { tabId: string; conversationId: string; messageId?: string; thread?: string },
  edge: MessageEdge | undefined, forward: boolean, limit: number): Promise<SuperTabMessage[]> {
  const [op, dir] = forward ? ['$gt', 1] as const : ['$lt', -1] as const
  const index = at.messageId ? 'id' : at.thread ? 'thread' : 'sequence'
  const read = async (sequence: unknown, after: string | undefined, take: number) => take <= 0 ? [] : (await readBy(tx, 'SuperTabMessage', index, [
    { $match: { tabId: at.tabId, conversationId: at.conversationId, ...at.thread ? { thread: at.thread } : {},
      ...at.messageId || after !== undefined ? { _id: { ...at.messageId ? { $eq: at.messageId } : {}, ...after !== undefined ? { [op]: after } : {} } } : {},
      ...sequence !== undefined ? { sequence } : {} } },
    { $sort: { sequence: dir, _id: dir } }, { $limit: take }])).map(row => prismaRow<SuperTabMessage>('SuperTabMessage', row))
  const same = edge?.id !== undefined ? await read(edge.sequence, edge.id, limit) : []
  return [...same, ...await read(edge ? { [op]: edge.sequence } : undefined, undefined, limit - same.length)]
}

/**
 * The messages of one conversation with these ids, by the id index: what a page's rows name as their thread or reply-to but
 * the page does not hold (store.ts messages), so what this reader may see of them can be checked. Named, not Prisma's `id in`,
 * which is sent as $expr and left to the planner (roadmap Phase 3; plan test in integration/superTabNamedReads.test.ts).
 */
export async function messagesById(tx: Transaction, tabId: string, conversationId: string, ids: string[]):
  Promise<Array<Pick<SuperTabMessage, 'id' | 'source' | 'recipientIds' | 'thread' | 'buddySession'>>> {
  if (!ids.length) return []
  const rows = await readBy(tx, 'SuperTabMessage', 'id', [{ $match: { _id: { $in: ids }, tabId, conversationId } },
    { $project: { source: 1, recipientIds: 1, thread: 1, buddySession: 1 } }])
  return rows.map(row => {
    const { id, source, recipientIds, thread, buddySession } = prismaRow<SuperTabMessage>('SuperTabMessage', row)
    return { id, source, recipientIds, thread: thread ?? null, buddySession: buddySession ?? null }
  })
}

/** The Lead's notices that leave a copy in a task's chat when the Lead hears them in its own chat (terminal.ts toLead). */
const LEAD_COPY_KINDS = new Set<unknown>(['work-lost', 'work-resumed'])

/** Of `rows`, the task chat copies stored before #2177 marked them (liveness.ts leadNoticeRows) whose project chat copy
 *  reached the Lead: that same notice, so read by no one either (re-check of #2177). A copy whose Lead copy reached no one,
 *  or that has none, stays shown: a person is then the only one who can act. Each Lead copy is read by its id alone, its
 *  Swarm checked here (inConversationOrder), and only when a row could be such a copy. */
export async function deliveredCopies(tx: Transaction, tabId: string, rows: ReadonlyArray<{ id: string; source: unknown; recipientIds: readonly string[] }>):
  Promise<Set<string>> {
  const copies = rows.filter(row => {
    const source = row.source as { kind?: unknown; recipientsOnly?: unknown } | null | undefined
    return !row.recipientIds.length && LEAD_COPY_KINDS.has(source?.kind) && source?.recipientsOnly !== true
  })
  if (!copies.length) return new Set()
  const leads = await tx.superTabMessage.aggregateRaw({ pipeline: [
    { $match: { _id: { $in: copies.map(row => stableId(row.id, 'lead')) } } }, { $project: { tabId: 1, recipientIds: 1 } }] }) as
    unknown as Array<{ _id: string; tabId: string; recipientIds?: string[] }>
  const reached = new Set(leads.filter(lead => lead.tabId === tabId && lead.recipientIds?.length).map(lead => lead._id))
  return new Set(copies.filter(row => reached.has(stableId(row.id, 'lead'))).map(row => row.id))
}

/** `routing`: a route, override or rule row (buddies.ts routingRow), which a Buddy never reads, as a reply or a thread's root.
 *  `count`: how many of the thread's rows this one stands for (pageThreads); a row without it is one. */
export interface ThreadReply { thread: string; id: string; author: Author; mentions: string[]; sequence: number; createdAt: Date; agentOnly: boolean; routing: boolean
  count?: number
  /** A reply in a Buddy thread session's thread (buddySessions.ts), which the main Buddy never counts. */
  session?: boolean }

/** The rows of one thread that every reader sees or skips alike: one author, and one kind of row (agentOnly, routingRow). */
interface ThreadPart { thread: string; root: boolean; kind?: unknown; only?: unknown; to: boolean; session?: boolean | null }
/** One row of a part, by its place in the thread. */
interface ThreadPlace { s: number; i: string; at: unknown; author: Author; slot?: number }
/** What the database sums up of some threads' rows (threadFacet), as it returns it: the same whoever reads. */
export interface ThreadFacet {
  parts: Array<{ _id: ThreadPart; count: number; oldest: ThreadPlace; newest: ThreadPlace; root?: { source?: unknown; recipientIds?: string[] } | null }>
  mentions: Array<{ _id: ThreadPart & { person: string }; first: ThreadPlace }>
}

/**
 * The threads rooted at `roots` in one conversation, roots included, as the database sums them up: it groups the rows of each
 * part (ThreadPart) and returns its oldest and newest row, how many it has, and where each person it tags is first tagged.
 * That is every place a summary reads: first appearances, the newest reply of each author, the count and the last reply. So
 * a poll that brings one reply of a 500-reply thread gets a few rows back, not 500, while the summaries stay what every
 * row gave (integration/superTabIndexes.test.ts). Matched as the page reads are, so the thread index bounds it; the database
 * still examines each of the threads' rows.
 */
export async function threadFacet(tx: Transaction, tabId: string, conversationId: string, roots: string[]): Promise<ThreadFacet> {
  const root = { $eq: ['$_id', '$thread'] }
  const part = { thread: '$thread', root, kind: '$source.kind', only: '$source.recipientsOnly',
    to: { $gt: [{ $size: { $ifNull: ['$recipientIds', []] } }, 0] }, author: { kind: '$author.kind', id: '$author.id' },
    session: { $eq: ['$buddySession', true] } }
  // (sequence, id) lead each place, so the database's min and max order rows as threadReplies sorts them (ids are ASCII).
  const place = { s: '$sequence', i: '$_id', at: '$createdAt', author: '$author' }
  // No $sort: it makes the planner walk the conversation's sequence index instead.
  const [found] = await readBy(tx, 'SuperTabMessage', 'thread', [{ $match: { tabId, conversationId, thread: { $in: roots } } },
    { $facet: {
      parts: [{ $group: { _id: part, count: { $sum: 1 }, oldest: { $min: place }, newest: { $max: place },
        // A root is its part's only row: what deliveredCopies reads of it.
        root: { $first: { $cond: [root, { source: '$source', recipientIds: '$recipientIds' }, '$$REMOVE'] } } } }],
      mentions: [{ $unwind: { path: '$mentions', includeArrayIndex: 'slot' } },
        { $group: { _id: { ...part, person: '$mentions' }, first: { $min: { s: '$sequence', i: '$_id', slot: { $toInt: '$slot' }, at: '$createdAt', author: '$author' } } } }],
    } }]) as unknown as Array<Partial<ThreadFacet>>
  return { parts: found?.parts ?? [], mentions: found?.mentions ?? [] }
}

/** The rows a page's thread summaries are counted from (threads.ts), oldest first, from what threadFacet gave: a few rows that
 *  stand for every row of each thread (`count` on the newest of each part), with what each reader skips marked. */
export async function threadReplies(tx: Transaction, tabId: string, { parts, mentions }: ThreadFacet): Promise<ThreadReply[]> {
  const copies = await deliveredCopies(tx, tabId, parts.flatMap(p => p._id.root && p.root
    ? [{ id: p._id.thread, source: p.root.source, recipientIds: p.root.recipientIds ?? [] }] : []))
  // agentOnly reads only whether a row has recipients, not who they are.
  const hidden = (key: ThreadPart) => (key.root && copies.has(key.thread))
    || agentOnly({ kind: key.kind, recipientsOnly: key.only }, key.to ? ['recipient'] : [])
  const rows = new Map<string, ThreadReply & { slots: Array<[number, string]> }>()
  const row = (key: ThreadPart, at: ThreadPlace) => {
    let kept = rows.get(at.i)
    if (!kept) rows.set(at.i, kept = { thread: key.thread, id: at.i, author: at.author, mentions: [], sequence: at.s, createdAt: new Date(ms(at.at)),
      agentOnly: hidden(key), routing: routingRow({ kind: key.kind }), ...(key.session ? { session: true } : {}), count: 0, slots: [] })
    return kept
  }
  for (const p of parts) {
    row(p._id, p.oldest)
    row(p._id, p.newest).count = p.count
  }
  for (const m of mentions) row(m._id, m.first).slots.push([m.first.slot!, m._id.person])
  return [...rows.values()].map(({ slots, ...reply }) => ({ ...reply, mentions: slots.sort((a, b) => a[0] - b[0]).map(([, person]) => person) }))
    .sort((a, b) => a.sequence - b.sequence || (a.id < b.id ? -1 : 1))
}

/**
 * The rows the threads rooted at `roots` are summed up from (threadReplies). A Swarm whose summaries are backfilled
 * (threadBackfill.ts) reads them by root id from SuperTabThread, one small document per thread with a reply; any other runs
 * threadFacet over the threads' rows. A root with no summary has no reply, and threads.ts leaves such a thread out, so it is
 * left out here too.
 */
export async function pageThreads(tx: Transaction, tabId: string, conversationId: string, roots: string[]): Promise<ThreadReply[]> {
  if (!await threadsBackfilled(tx, tabId)) return threadReplies(tx, tabId, await threadFacet(tx, tabId, conversationId, roots))
  const stored = await readBy(tx, 'SuperTabThread', 'id', [{ $match: { _id: { $in: roots }, tabId, conversationId } },
    { $project: { parts: 1, mentions: 1 } }]) as unknown as ThreadFacet[]
  return threadReplies(tx, tabId, { parts: stored.flatMap(t => t.parts), mentions: stored.flatMap(t => t.mentions) })
}

/**
 * Rewrites the summaries of the threads rooted at `roots` in one conversation from their rows now: one document per thread
 * with a reply, as threadFacet gives it. Run in the transaction that inserts a reply (refreshReplies), so a summary holds what
 * its rows do: two replies at once write the same document, and one of their transactions runs again.
 */
export async function refreshThreads(tx: Transaction, tabId: string, conversationId: string, roots: string[]): Promise<void> {
  if (!roots.length) return
  const { parts, mentions } = await threadFacet(tx, tabId, conversationId, roots)
  const updatedAt = { $date: new Date().toISOString() }
  const updates = roots.flatMap(root => {
    const own = parts.filter(p => p._id.thread === root)
    if (!own.some(p => !p._id.root)) return []
    return [{ q: { _id: root }, u: { $set: { tabId, conversationId, parts: own, mentions: mentions.filter(m => m._id.thread === root), updatedAt } },
      upsert: true }]
  })
  // Raw, so the stored parts read back as the $facet returns them, dates as dates.
  if (updates.length) await tx.$runCommandRaw({ update: 'SuperTabThread', updates: updates as unknown as Prisma.InputJsonArray })
}

/** Refreshes the summaries of the threads that `rows`, just inserted, reply in (refreshThreads). A row that is its own
 *  thread's root, or has none (written before threads), changes no summary. */
export async function refreshReplies(tx: Transaction, tabId: string,
  rows: ReadonlyArray<{ id: string; conversationId: string; thread?: string | null }>): Promise<void> {
  const roots = new Map<string, Set<string>>()
  for (const row of rows) {
    if (row.thread && row.thread !== row.id) roots.set(row.conversationId, (roots.get(row.conversationId) ?? new Set()).add(row.thread))
  }
  for (const [conversationId, threads] of roots) await refreshThreads(tx, tabId, conversationId, [...threads])
}

/** How long this process trusts what it last read of a Swarm's backfill marker. */
const BACKFILL_CHECK_MS = 60_000
const backfilled = new Map<string, { done: boolean; at: number }>()

/** Whether the Swarm's thread summaries are backfilled (threadBackfill.ts), as this process read it in the last minute. */
async function threadsBackfilled(tx: Transaction, tabId: string): Promise<boolean> {
  const known = backfilled.get(tabId), now = Date.now()
  if (known && now - known.at < BACKFILL_CHECK_MS) return known.done
  const done = !!await tx.superTabThreadBackfill.findUnique({ where: { id: tabId }, select: { id: true } })
  backfilled.set(tabId, { done, at: now })
  return done
}

/** Notes that this process backfilled the Swarm's summaries, so its own reads use them at once. */
export function noteBackfilled(tabId: string): void {
  backfilled.set(tabId, { done: true, at: Date.now() })
}
