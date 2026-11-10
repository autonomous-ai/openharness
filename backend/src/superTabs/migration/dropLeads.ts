/**
 * Removes the Leads conversations older Swarms still store (anh Dee, 2026-11-09: "drop them all"): the Swarm-wide chat of v1-v3,
 * which no read has sent since its removal (model.ts leadsRemoved), and the messages and deliveries written in it.
 *
 * SwarmGroup is shared with Swarm v4 (project chats, a person's chat with each agent, the PM's, channels), so only a row of kind
 * `leads` is ever chosen, and its conversation goes through the parts' own write (store.ts dropLeads), never a raw delete: a
 * tombstone at its next version, so every cache and client drops it as any removed conversation. Its messages and their
 * deliveries go after, by their Swarm and that conversation's exact id, a chunk at a time: never by the id `lead`, which is
 * v4's first project chat, and never a message of any other conversation. Mentions, activity and reactions of those messages
 * stay (the Mentions family, slice S11, is held).
 *
 * One bounded pass over SwarmGroup by `_id` (no index reads `data.kind`; a one-time job in the worker, never on a request),
 * a pause between chunks. A tombstone keeps its kind until it is purged, so a run that stopped between a conversation and
 * its messages finds them again. Safe from two pods at once: the second's write finds the conversation gone, and removing a
 * removed row removes nothing. Delete it with dropLegacyJob.ts, not before 2026-12-10.
 */
import type { PrismaClient } from '@prisma/client'
import type { SuperTabStore } from '../store.js'

/** Rows read or removed by one command. */
const CHUNK = 500

/** Counts only: no Swarm, conversation or message id. */
export interface LeadsDropReport {
  /** Swarms whose Leads conversation this pass removed. */
  swarms: number
  conversations: number
  messages: number
  deliveries: number
  /** This pass removed nothing: the job stops. A Leads conversation of a Swarm still in one row or deleted is left to that
   *  Swarm's own migration or purge. */
  done: boolean
}

type Find = { cursor: { firstBatch: Array<Record<string, unknown>> } }

/** One chunk of the Leads groups after [after], live or tombstoned, by `_id`: their Swarm, key and whether removed. */
async function leadsGroups(db: Pick<PrismaClient, '$runCommandRaw'>, after: string | null) {
  const found = await db.$runCommandRaw({ find: 'SwarmGroup', filter: { 'data.kind': 'leads', ...after ? { _id: { $gt: after } } : {} },
    projection: { _id: 1, tabId: 1, key: 1, deleted: 1 }, sort: { _id: 1 }, hint: '_id_', limit: CHUNK, batchSize: CHUNK, singleBatch: true } as never) as Find
  return found.cursor.firstBatch.map(row => ({ id: String(row._id), tabId: String(row.tabId), key: String(row.key), deleted: row.deleted === true }))
}

/** Removes the messages of [conversationIds] in [tabId], each chunk's deliveries first: their counts. */
async function dropMessages(db: Pick<PrismaClient, '$runCommandRaw'>, tabId: string, conversationIds: string[], pause?: () => Promise<void>, signal?: AbortSignal) {
  let messages = 0, deliveries = 0
  while (!signal?.aborted) {
    const found = await db.$runCommandRaw({ find: 'SuperTabMessage', filter: { tabId, conversationId: { $in: conversationIds } }, projection: { _id: 1 },
      sort: { tabId: 1, conversationId: 1, sequence: 1, _id: 1 }, hint: { tabId: 1, conversationId: 1, sequence: 1, _id: 1 }, limit: CHUNK,
      batchSize: CHUNK, singleBatch: true } as never) as Find
    const ids = found.cursor.firstBatch.map(row => String(row._id))
    if (!ids.length) break
    const delivered = await db.$runCommandRaw({ delete: 'SuperTabDelivery', deletes: [{ q: { tabId, messageId: { $in: ids } }, limit: 0,
      hint: { tabId: 1, messageId: 1 } }] } as never) as { n?: number }
    // The message's own Swarm and conversation are checked again, by its id: a row that is not this conversation's stays.
    const removed = await db.$runCommandRaw({ delete: 'SuperTabMessage', deletes: [{ q: { _id: { $in: ids }, tabId, conversationId: { $in: conversationIds } },
      limit: 0, hint: { _id: 1 } }] } as never) as { n?: number }
    deliveries += delivered.n ?? 0
    messages += removed.n ?? 0
    if (ids.length < CHUNK) break
    await pause?.()
  }
  return { messages, deliveries }
}

/** One pass: every Swarm's Leads conversations, then their messages. */
export async function dropLeadsChats(db: Pick<PrismaClient, '$runCommandRaw'>, store: Pick<SuperTabStore, 'dropLeads'>,
  { pause, signal }: { pause?: () => Promise<void>; signal?: AbortSignal } = {}): Promise<LeadsDropReport> {
  const report: LeadsDropReport = { swarms: 0, conversations: 0, messages: 0, deliveries: 0, done: false }
  let after: string | null = null
  while (!signal?.aborted) {
    const groups = await leadsGroups(db, after)
    if (!groups.length) break
    after = groups.at(-1)!.id
    const bySwarm = new Map<string, typeof groups>()
    for (const group of groups) bySwarm.set(group.tabId, [...bySwarm.get(group.tabId) ?? [], group])
    for (const [tabId, chats] of bySwarm) {
      if (signal?.aborted) break
      const keys = chats.map(chat => chat.key)
      const removed = await store.dropLeads(tabId, chats.filter(chat => !chat.deleted).map(chat => chat.key))
      if (removed.length) { report.swarms++; report.conversations += removed.length }
      // Only conversations removed now or before: one its Swarm kept (still in one row, or deleted) keeps its messages too.
      const dropped = await dropMessages(db, tabId, keys.filter(key => chats.find(chat => chat.key === key)!.deleted || removed.includes(key)), pause, signal)
      report.messages += dropped.messages
      report.deliveries += dropped.deliveries
    }
    if (groups.length < CHUNK) break
    await pause?.()
  }
  report.done = !signal?.aborted && report.conversations === 0 && report.messages === 0 && report.deliveries === 0
  return report
}
