/**
 * Removes the Leads conversations older Swarms still store (anh Dee, 2026-11-09: "drop them all"): the Swarm-wide chat of v1-v3,
 * which no read has sent since its removal (model.ts leadsRemoved), and what was written in it.
 *
 * SwarmGroup is shared with Swarm v4 (project chats, a person's chat with each agent, the PM's, channels), so only a row of kind
 * `leads` is ever chosen, and its conversation goes through the parts' own write (store.ts dropLeads), never a raw delete: a
 * tombstone at its next version, so every cache and client drops it as any removed conversation. What was written in it goes
 * after, by its Swarm and that conversation's exact id, never by the id `lead` (v4's first project chat): its messages a chunk at
 * a time and, for each chunk, as the store's own message delete does, their deliveries, compacted receipts and reactions, and
 * their files released to the unsent-file sweep; then any delivery left of a message removed earlier. Mentions and activity
 * stay (the Mentions family, slice S11, is held).
 *
 * One pass over SwarmGroup by `_id`, [CHUNK] documents a read (no index reads `kind`; a one-time job in the worker, never on a
 * request), a pause after each chunk and each Swarm written. A tombstone keeps its kind until it is purged, so a run that stopped
 * between a conversation and its messages finds them again. A Swarm whose write fails is counted and left for the next run; the
 * others go on. Safe from two pods at once: the second's write finds the conversation gone, and removing a removed row removes
 * nothing. Delete it with dropLegacyJob.ts, not before 2026-12-10.
 */
import type { PrismaClient } from '@prisma/client'
import type { SuperTabStore } from '../store.js'
import { EXPIRED_UPLOAD } from '../attachments.js'

/** Documents read, or rows removed, by one command. */
const CHUNK = 500

/** Counts only: no Swarm, conversation or message id. */
export interface LeadsDropReport {
  /** Swarms whose Leads conversation this pass removed. */
  swarms: number
  conversations: number
  messages: number
  deliveries: number
  /** Swarms whose write or removal failed this pass: left for the next run. */
  failed: number
  /** This pass removed nothing and nothing failed: the job stops. A Leads conversation of a Swarm still in one row or deleted is
   *  left to that Swarm's own migration or purge. */
  done: boolean
}

type Db = Pick<PrismaClient, '$runCommandRaw'>
type Find = { cursor: { firstBatch: Array<Record<string, unknown>> } }
type Written = { n?: number; writeErrors?: unknown[] }

/** A write's count, or a named failure when the database refused any of it: never counted as done. */
function counted(answer: Written, what: string): number {
  if (answer.writeErrors?.length) throw new Error(`The database refused some of ${what}`)
  return answer.n ?? 0
}

/** The next [CHUNK] groups after [after] by `_id`, whatever their kind (each read examines at most that many), and of them the
 *  Leads ones, live or tombstoned. Null once the collection is read to its end. */
async function nextGroups(db: Db, after: string | null) {
  const found = await db.$runCommandRaw({ find: 'SwarmGroup', filter: after ? { _id: { $gt: after } } : {}, projection: { _id: 1, tabId: 1, key: 1, deleted: 1, kind: 1 },
    sort: { _id: 1 }, hint: { _id: 1 }, limit: CHUNK, batchSize: CHUNK, singleBatch: true } as never) as Find
  const rows = found.cursor.firstBatch
  if (!rows.length) return null
  return { last: String(rows.at(-1)!._id), full: rows.length === CHUNK,
    leads: rows.filter(row => row.kind === 'leads').map(row => ({ tabId: String(row.tabId), key: String(row.key), deleted: row.deleted === true })) }
}

/** Removes what was written in [conversationIds] of [tabId]: its counts. */
async function dropWritten(db: Db, tabId: string, conversationIds: string[], pause?: () => Promise<void>, signal?: AbortSignal) {
  let messages = 0, deliveries = 0
  while (!signal?.aborted) {
    const found = await db.$runCommandRaw({ find: 'SuperTabMessage', filter: { tabId, conversationId: { $in: conversationIds } }, projection: { _id: 1, attachments: 1 },
      sort: { tabId: 1, conversationId: 1, sequence: 1, _id: 1 }, hint: { tabId: 1, conversationId: 1, sequence: 1, _id: 1 }, limit: CHUNK, batchSize: CHUNK,
      singleBatch: true } as never) as Find
    const rows = found.cursor.firstBatch
    if (!rows.length) break
    const ids = rows.map(row => String(row._id))
    const files = rows.flatMap(row => Array.isArray(row.attachments) ? (row.attachments as Array<{ id?: unknown }>).flatMap(a => typeof a?.id === 'string' ? [a.id] : []) : [])
    deliveries += counted(await db.$runCommandRaw({ delete: 'SuperTabDelivery', deletes: [{ q: { tabId, messageId: { $in: ids } }, limit: 0,
      hint: { tabId: 1, messageId: 1 } }] } as never) as Written, 'the deliveries')
    // A delivery compacted after its last change is kept as its message's receipt (deliveryCompaction.ts), by the message's id.
    counted(await db.$runCommandRaw({ delete: 'SuperTabReceipt', deletes: [{ q: { _id: { $in: ids }, tabId }, limit: 0 }] } as never) as Written, 'the receipts')
    counted(await db.$runCommandRaw({ delete: 'SuperTabReaction', deletes: [{ q: { tabId, messageId: { $in: ids } }, limit: 0,
      hint: { tabId: 1, messageId: 1 } }] } as never) as Written, 'the reactions')
    // Its files go to the unsent-file sweep with their stored bytes, as a deleted message's do (store.ts writeDelete).
    if (files.length) {
      counted(await db.$runCommandRaw({ update: 'SuperTabAttachment', updates: [{ q: { _id: { $in: files }, tabId, usedBy: { $in: ids } },
        u: { $set: { usedBy: EXPIRED_UPLOAD } }, multi: true }] } as never) as Written, 'the files')
    }
    // The message's own Swarm and conversation are checked again, by its id: a row that is not this conversation's stays.
    messages += counted(await db.$runCommandRaw({ delete: 'SuperTabMessage', deletes: [{ q: { _id: { $in: ids }, tabId, conversationId: { $in: conversationIds } },
      limit: 0, hint: { _id: 1 } }] } as never) as Written, 'the messages')
    if (rows.length < CHUNK) break
    await pause?.()
  }
  // A delivery of a message removed earlier (a v3 delete without replies cancelled its deliveries and took the row): by the
  // Swarm's own index, this Swarm's deliveries alone.
  if (!signal?.aborted) {
    deliveries += counted(await db.$runCommandRaw({ delete: 'SuperTabDelivery', deletes: [{ q: { tabId, conversationId: { $in: conversationIds } }, limit: 0,
      hint: { tabId: 1, status: 1 } }] } as never) as Written, 'the deliveries')
  }
  return { messages, deliveries }
}

/** One pass: every Swarm's Leads conversations, then what was written in them. */
export async function dropLeadsChats(db: Db, store: Pick<SuperTabStore, 'dropLeads'>,
  { pause, signal }: { pause?: () => Promise<void>; signal?: AbortSignal } = {}): Promise<LeadsDropReport> {
  const report: LeadsDropReport = { swarms: 0, conversations: 0, messages: 0, deliveries: 0, failed: 0, done: false }
  let after: string | null = null
  while (!signal?.aborted) {
    const chunk = await nextGroups(db, after)
    if (!chunk) break
    after = chunk.last
    const bySwarm = new Map<string, typeof chunk.leads>()
    for (const group of chunk.leads) bySwarm.set(group.tabId, [...bySwarm.get(group.tabId) ?? [], group])
    for (const [tabId, chats] of bySwarm) {
      if (signal?.aborted) break
      try {
        const live = chats.filter(chat => !chat.deleted).map(chat => chat.key)
        const removed = live.length ? await store.dropLeads(tabId, live) : []
        if (removed.length) { report.swarms++; report.conversations += removed.length }
        // Only conversations removed now or before: one its Swarm kept (still in one row, or deleted) keeps what was written in it.
        const gone = chats.filter(chat => chat.deleted || removed.includes(chat.key)).map(chat => chat.key)
        if (gone.length) {
          const dropped = await dropWritten(db, tabId, gone, pause, signal)
          report.messages += dropped.messages
          report.deliveries += dropped.deliveries
        }
        if (removed.length) await pause?.()
      } catch {
        report.failed++
      }
    }
    if (!chunk.full) break
    await pause?.()
  }
  report.done = !signal?.aborted && !report.failed && report.conversations === 0 && report.messages === 0 && report.deliveries === 0
  return report
}
