/**
 * Each chat's newest main row a person reads (servedTops.ts): the row at its stored main sequence, read alone, and the rows before
 * it only for a chat where that row is not one. The rows are those a page shows a person (store.ts messages): never an agent-only
 * notice, a delivered copy of a Lead's notice, or a row of a project they no longer read in their Buddy chat. Every read is
 * bounded by an index range and a limit, and a range read since its chat last changed is not read again (rangeCache.ts). This is
 * what is left of the person's inbox read, gone with Swarm v4 (2026-11-10).
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { agentOnly, type Author, type Conversation, type SuperTabState } from '../model.js'
import { deliveredCopies } from '../pageReads.js'
import { sessionReadsRow } from '../buddySessions.js'
import { READ_BATCH } from '../parts/indexed.js'
import { chatTop, chatVersion, rangeCache, rangeKey } from './rangeCache.js'

/** Rows read back from an older chat's newest message for its newest main one: a chat written before the server kept its
 *  main stream's newest number (lastMainSequence), or one where an older backend stored a hidden copy there. */
const LATEST_SCAN = 50
/** What the read keeps of a row: what decides whether a person reads it, and where it is. Never its words. */
const FIELDS = { sequence: 1, author: 1, thread: 1, alsoInChat: 1, source: 1, recipientIds: 1, buddyProject: 1 }
/** A row as the read keeps it. */
interface Row { id: string; conversationId: string; sequence: number; author: Author; thread: string | null; alsoInChat: boolean; source: unknown
  recipientIds: string[]; buddyProject: string | null }
const row = (raw: Record<string, unknown>): Row => ({ id: raw._id as string, conversationId: raw.conversationId as string, sequence: raw.sequence as number,
  author: raw.author as Author, thread: (raw.thread ?? null) as string | null, alsoInChat: raw.alsoInChat === true, source: raw.source ?? null,
  recipientIds: (raw.recipientIds ?? []) as string[], buddyProject: typeof raw.buddyProject === 'string' ? raw.buddyProject : null })
/** A thread reply: in a thread whose root is another row. */
const isReply = (m: Row) => !!m.thread && m.thread !== m.id
/** A row of the chat's main stream (parts/commit.ts numberMessages): a top-level message, or a reply also sent to the chat. */
const isMain = (m: Row) => !isReply(m) || m.alsoInChat
/** `rows` by `key`, each list in the rows' order. */
function groupBy(rows: Row[], key: (m: Row) => string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>()
  for (const m of rows) {
    const group = groups.get(key(m))
    if (group) group.push(m)
    else groups.set(key(m), [m])
  }
  return groups
}

/** The rows of `rows` a person reads, as a page filters them for a person (store.ts messages, readsRow): no agent-only notice,
 *  no row of a project they no longer read in their one Buddy chat (buddySessions.ts sessionReadsRow: its PM's lines and its
 *  sessions' threads; security review 1 of #2435, a lost private project's PM line showed as the chat's preview), and no task
 *  chat copy of a Lead's notice that reached the Lead (pageReads.ts deliveredCopies). */
async function readable(db: PrismaClient, tabId: string, rows: Row[], state: SuperTabState): Promise<Row[]> {
  const checks = new Map<string, (row: Row) => boolean>()
  const sessionRead = (m: Row) => {
    let check = checks.get(m.conversationId)
    if (!check) {
      const group = state.conversations.find(g => g.id === m.conversationId)
      // A chat this read does not hold reads nothing: the rows come from the chats it chose.
      check = group ? sessionReadsRow(undefined, group, state) : () => false
      checks.set(m.conversationId, check)
    }
    return check(m)
  }
  const shown = rows.filter(m => !agentOnly(m.source, m.recipientIds) && sessionRead(m))
  const copies = shown.length ? await deliveredCopies(db, tabId, shown) : new Set<string>()
  return shown.filter(m => !copies.has(m.id))
}

/** Ranges one read covers: each is a few stages of its pipeline, well under Mongo's limit on stages. */
const CHATS_PER_READ = 100

/** Runs each range's own pipeline inside one aggregate per CHATS_PER_READ ranges ($unionWith), so the reads stay few whatever
 *  the chat count, and each range's rows are still bounded by its own index range and limit: one $in over every chat could not
 *  bound each by its own read mark, and would walk a busy chat's history for a chat never opened. */
async function perRange(db: PrismaClient, pipelines: Prisma.InputJsonValue[][]): Promise<Row[]> {
  const rows: Row[] = []
  for (let i = 0; i < pipelines.length; i += CHATS_PER_READ) {
    const [first, ...rest] = pipelines.slice(i, i + CHATS_PER_READ)
    // Every row in the first reply (READ_BATCH, as readBy asks): Mongo's default first batch of 101 left the rest of 30 chats'
    // scans to a getMore, 32% of the slow message ops in Ken's log of 11-04 (~419 rows each).
    const raw = await db.superTabMessage.aggregateRaw({ pipeline: [...first!,
      ...rest.map(pipeline => ({ $unionWith: { coll: 'SuperTabMessage', pipeline } }))], options: { batchSize: READ_BATCH } }) as unknown as Array<Record<string, unknown>>
    rows.push(...raw.map(row))
  }
  return rows
}

/** The ranges this process kept (rangeCache.ts). */
const kept = rangeCache<Row>()

/** Up to `limit` rows of one chat, newest first, in its (sequence, id) index range. */
const newestIn = (tabId: string, conversationId: string, sequence: Record<string, number>, limit: number): Prisma.InputJsonValue[] =>
  [{ $match: { tabId, conversationId, sequence } }, { $sort: { sequence: -1, _id: -1 } }, { $limit: limit }, { $project: { ...FIELDS, conversationId: 1 } }] as Prisma.InputJsonValue[]

/** Each chat's `limit` newest rows in its range, newest first, chat by chat, as perRange of each chat's newestIn answers: a range
 *  kept since its chat last changed is not read again, and only the others are, in one perRange. Each range must be bounded by
 *  its chat's chatTop. */
async function chatRanges(db: PrismaClient, tabId: string, of: ReadonlyArray<{ group: Conversation; sequence: Record<string, number> }>,
  limit: number): Promise<Row[]> {
  const keyed = of.map(c => ({ ...c, key: rangeKey(tabId, c.group.id, c.sequence, limit, chatVersion(c.group)) }))
  const held = new Map<string, Row[]>()
  const misses = keyed.filter(c => {
    const rows = kept.get(c.key)
    if (rows) held.set(c.key, rows)
    return !rows
  })
  if (misses.length) {
    const read = groupBy(await perRange(db, misses.map(c => newestIn(tabId, c.group.id, c.sequence, limit))),
      m => m.conversationId)
    for (const c of misses) {
      const rows = read.get(c.group.id) ?? []
      kept.set(c.key, rows)
      held.set(c.key, rows)
    }
  }
  return keyed.flatMap(c => held.get(c.key)!)
}

/** Each chat's newest main message the person reads: the row at its stored main sequence, read alone; the LATEST_SCAN rows
 *  before it only for a chat where that row is not one (an older chat's newest row may be a thread reply or a hidden copy).
 *  `more` when such a chat has none in that range. */
export async function latestIn(db: PrismaClient, tabId: string, state: SuperTabState, chats: Conversation[]): Promise<{ latest: Map<string, Row>; more: boolean }> {
  const tops = chats.flatMap(g => { const top = g.lastMainSequence ?? g.lastMessageSequence; return top ? [{ id: g.id, top, group: g }] : [] })
  const pick = async (rows: Row[]) => {
    const shown = (await readable(db, tabId, rows, state)).filter(isMain)
    const newest = new Map<string, Row>()
    for (const m of shown) if (!newest.has(m.conversationId)) newest.set(m.conversationId, m)
    return newest
  }
  const read = (of: typeof tops, limit: number) => chatRanges(db, tabId, of.map(c => ({ group: c.group, sequence: { $lte: Math.min(c.top, chatTop(c.group)) } })), limit)
  const latest = await pick(await read(tops, 1))
  const missing = tops.filter(c => !latest.has(c.id))
  if (!missing.length) return { latest, more: false }
  const deeper = await read(missing, LATEST_SCAN)
  for (const [id, m] of await pick(deeper)) latest.set(id, m)
  // A chat with LATEST_SCAN rows and none of them a main row the person reads may have one further back.
  const full = new Set([...groupBy(deeper, m => m.conversationId)].filter(([, rows]) => rows.length >= LATEST_SCAN).map(([id]) => id))
  return { latest, more: missing.some(c => !latest.has(c.id) && full.has(c.id)) }
}
