/**
 * A project's Buddy proposals its PM has not answered (the Tasks view's Proposals, #2569), by #2867's rule as the chat shows
 * it (threads.ts askOf): no mark from a task opened from it, and no reply in its thread from the project chat's lead agent.
 *
 * Desktop reads it every minute, and finding the roots among the project chat's rows walked the whole chat each time (Ken's
 * prod scan 11-04, task #2777). So the chat's roots not yet seen answered are kept apart (SuperTabOpenProposal): each root's
 * row is written with it (store.ts writeMessages), and the read takes those roots by id. It reads their threads as the chat
 * page does and forgets the ones it finds answered, which stay answered by that rule: a task's mark never reverts to an ask,
 * and the lead's reply stays in the thread. A chat read before it had any is scanned once, as before, to seed them.
 */
import type { Prisma } from '@prisma/client'
import type { Actor, Conversation, SuperTabState } from './model.js'
import { pageThreads, type ThreadReply } from './pageReads.js'
import { readBy } from './parts/indexed.js'
import { readConversation, readProject } from './projects.js'
import { proposalPriority, type TaskPriority } from './taskPriority.js'
import { threadSummaries } from './threads.js'

type Transaction = Prisma.TransactionClient

/** The most a read lists: the newest open ones, shown oldest first. Far above today's under 10 open per project. */
export const MAX_PROPOSALS = 100
/** The most proposal roots one read looks through, newest first, for the open ones: answered ones past this are not read. */
export const MAX_ROOTS = 1_000
/** The words buddy.propose puts before a proposal's name (commands.ts), which the apps leave out. */
const ROOT_PREFIX = "Let's build: "

export interface OpenProposal { messageId: string; title: string; personId?: string
  /** Its Buddy's low, normal or high on the tasks' one scale (taskPriority.ts). */
  priority: TaskPriority; at: number }
/** How long after a chat's seed its reads scan it again: a server still on the release before writes a proposal with no row
 *  in the open set, and a rolling release replaces them within minutes. */
export const SEED_SETTLE_MS = 30 * 60_000

/** A proposal's root as the read takes it from the chat. */
export interface ProposalRoot { id: string; sequence: number; text: string; source: Record<string, unknown>; createdAt: Date }
/** One root in the chat's open set. */
export interface ListedProposal { id: string; sequence: number }
export interface ProposalReads {
  /** When the chat's open set was first seeded from its rows; null before. */
  seededAt(): Promise<number | null>
  /** Puts [roots] in the open set and marks the chat seeded, its first seed's time kept. */
  seed(roots: ListedProposal[]): Promise<void>
  /** The open set's roots newest first, before a sequence (all of them without one). */
  listed(before: number | undefined, take: number): Promise<ListedProposal[]>
  /** The chat's proposal roots of [ids]; one not in the chat, or no proposal's root, is left out. */
  rootsById(ids: string[]): Promise<ProposalRoot[]>
  /** The chat's proposal roots newest first, before a sequence: the seed's scan of the chat. */
  roots(before: number | undefined, take: number): Promise<ProposalRoot[]>
  /** The threads of some roots, as the chat page reads them. */
  threads(rootIds: string[]): Promise<ThreadReply[]>
  /** Takes [ids] out of the open set. */
  forget(ids: string[]): Promise<void>
  /** Those of [ids] closed by hand (closeProposal). */
  closed(ids: string[]): Promise<Set<string>>
}

/** The project chat [projectId] names, for a reader who may read it, as the messages read checks it; else NOT_FOUND. */
export function proposalChat(state: SuperTabState, actor: Actor, projectId: string): Conversation {
  return readConversation(state, actor, readProject(state, actor, projectId).leadConversationId)
}

/** The open proposals in [chat], oldest first: the newest MAX_PROPOSALS, from its open set once seeded, else from its rows. */
export async function openProposals(state: SuperTabState, chat: Conversation, reads: ProposalReads, now = Date.now()): Promise<OpenProposal[]> {
  const seededAt = await reads.seededAt()
  if (seededAt === null || now - seededAt < SEED_SETTLE_MS) {
    // A proposal closed by hand stays closed, whatever its thread says (task #2926).
    const found = await scanned(state, chat, reads)
    const closed = found.length ? await reads.closed(found.map(root => root.id)) : new Set<string>()
    const open = found.filter(root => !closed.has(root.id))
    await reads.seed(open.map(root => ({ id: root.id, sequence: root.sequence })))
    return open.map(shown).reverse()
  }
  const open: ProposalRoot[] = []
  for (let before: number | undefined, read = 0; open.length < MAX_PROPOSALS && read < MAX_ROOTS;) {
    const listed = await reads.listed(before, MAX_PROPOSALS)
    if (!listed.length) break
    read += listed.length
    const found = new Map((await reads.rootsById(listed.map(r => r.id))).map(root => [root.id, root]))
    const roots = listed.flatMap(r => found.get(r.id) ?? [])
    const unanswered = new Set(await unansweredOf(state, chat, reads, roots))
    const forget = listed.filter(r => !unanswered.has(r.id)).map(r => r.id)
    if (forget.length) await reads.forget(forget)
    open.push(...roots.filter(root => unanswered.has(root.id)))
    if (listed.length < MAX_PROPOSALS) break
    before = listed.at(-1)!.sequence
  }
  return open.slice(0, MAX_PROPOSALS).map(shown).reverse()
}

/** The ids of [roots] nobody answered. A root with no reply has no summary: nobody answered it. */
async function unansweredOf(state: SuperTabState, chat: Conversation, reads: ProposalReads, roots: ProposalRoot[]): Promise<string[]> {
  if (!roots.length) return []
  const asks = new Map(threadSummaries(state, chat, await reads.threads(roots.map(r => r.id))).map(t => [t.id, t.ask]))
  return roots.filter(root => !asks.has(root.id) || asks.get(root.id) === 'proposal').map(root => root.id)
}

/** The chat's open proposal roots, newest first: the newest MAX_PROPOSALS among its newest MAX_ROOTS, read a batch at a time. */
async function scanned(state: SuperTabState, chat: Conversation, reads: ProposalReads): Promise<ProposalRoot[]> {
  const open: ProposalRoot[] = []
  for (let before: number | undefined, read = 0; open.length < MAX_PROPOSALS && read < MAX_ROOTS;) {
    const roots = await reads.roots(before, MAX_PROPOSALS)
    if (!roots.length) break
    read += roots.length
    const unanswered = new Set(await unansweredOf(state, chat, reads, roots))
    open.push(...roots.filter(root => unanswered.has(root.id)))
    if (roots.length < MAX_PROPOSALS) break
    before = roots.at(-1)!.sequence
  }
  return open.slice(0, MAX_PROPOSALS)
}

function shown(root: ProposalRoot): OpenProposal {
  const personId = root.source.personId
  return { messageId: root.id, title: root.text.startsWith(ROOT_PREFIX) ? root.text.slice(ROOT_PREFIX.length) : root.text,
    ...typeof personId === 'string' ? { personId } : {}, priority: proposalPriority(root.source.priority), at: root.createdAt.getTime() }
}

const date = (value: unknown): Date => new Date((value as { $date?: string } | null)?.$date ?? value as string)
const OPEN = 'SuperTabOpenProposal'
const ROOT_FIELDS = { $project: { _id: 1, tabId: 1, conversationId: 1, sequence: 1, text: 1, source: 1, thread: 1, createdAt: 1 } }
const rootOf = (row: Record<string, unknown>): ProposalRoot => ({ id: row._id as string, sequence: row.sequence as number, text: row.text as string,
  source: row.source as Record<string, unknown>, createdAt: date(row.createdAt) })
/** Its own thread's root (none before threads), posted by buddy.propose. */
const isRoot = (row: Record<string, unknown>) => (row.source as { kind?: unknown } | null)?.kind === 'buddy-proposal' && (row.thread ?? row._id) === row._id

/** The sequence of a root closed by hand in the open set: below the open roots' (`listed` reads 0 and up) and the seed mark's. */
export const CLOSED_SEQUENCE = -2

/** Closes a proposal by hand with its reason (commands.ts proposal.close, River 11-04, task #2926): many were answered before
 *  threads, or built without the task's link, and read as open for ever. Its row stays in the open set, out of every read,
 *  so a seed's scan, which only inserts, never opens it again. */
export async function closeProposal(tx: Transaction, tabId: string, close: { messageId: string; conversationId: string; reason: string }, by: string, at: Date): Promise<void> {
  await tx.$runCommandRaw({ update: OPEN, updates: [{ q: { _id: close.messageId }, upsert: true,
    u: { $set: { tabId, conversationId: close.conversationId, sequence: CLOSED_SEQUENCE, closed: { reason: close.reason, by, at: { $date: at.toISOString() } } },
      $setOnInsert: { createdAt: { $date: at.toISOString() } } } }] as unknown as Prisma.InputJsonArray })
}

/** The id of [chatId]'s seed mark in the open set. */
export const seedMarkId = (tabId: string, chatId: string) => `seeded:${tabId}:${chatId}`

/** The open-set rows of the proposal roots among [rows], just inserted (store.ts writeMessages). */
export function openProposalRows(tabId: string, rows: ReadonlyArray<{ id: string; conversationId: string; sequence: number; source?: unknown; thread?: string | null }>):
  Array<{ id: string; tabId: string; conversationId: string; sequence: number }> {
  return rows.filter(row => isRoot({ _id: row.id, source: row.source, thread: row.thread }))
    .map(row => ({ id: row.id, tabId, conversationId: row.conversationId, sequence: row.sequence }))
}

/** The reads of [chatId], from the database. Its open set by its own index, newest first, and its roots by id; its threads as
 *  the chat page reads them (pageThreads). The seed's scan reads the chat's roots by the conversation's sequence index, newest
 *  first: a proposal root is the only row of its command, so no other shares its sequence. */
export function databaseProposalReads(tx: Transaction, tabId: string, chatId: string): ProposalReads {
  const mark = seedMarkId(tabId, chatId)
  const upsert = (id: string, sequence: number) => ({ q: { _id: id },
    u: { $setOnInsert: { tabId, conversationId: chatId, sequence, createdAt: { $date: new Date().toISOString() } } }, upsert: true })
  return {
    seededAt: async () => {
      const found = (await readBy(tx, OPEN, 'id', [{ $match: { _id: mark } }, { $project: { createdAt: 1 } }]))[0]
      return found ? date(found.createdAt).getTime() : null
    },
    // The roots first and the mark last: a seed that stops between them is run again.
    seed: async roots => {
      await tx.$runCommandRaw({ update: OPEN, updates: [...roots.map(r => upsert(r.id, r.sequence)), upsert(mark, -1)] as unknown as Prisma.InputJsonArray })
    },
    listed: async (before, take) => (await readBy(tx, OPEN, 'open', [
      { $match: { tabId, conversationId: chatId, sequence: before === undefined ? { $gte: 0 } : { $gte: 0, $lt: before } } },
      { $sort: { sequence: -1 } }, { $limit: take }, { $project: { _id: 1, sequence: 1 } }]))
      .map(row => ({ id: row._id as string, sequence: row.sequence as number })),
    // By `_id` alone, then held to this chat: no other index of the collection can serve it and walk the chat.
    rootsById: async ids => ids.length ? (await readBy(tx, 'SuperTabMessage', 'id', [{ $match: { _id: { $in: ids } } }, ROOT_FIELDS]))
      .filter(row => row.tabId === tabId && row.conversationId === chatId && isRoot(row)).map(rootOf) : [],
    roots: async (before, take) => (await readBy(tx, 'SuperTabMessage', 'sequence', [
      { $match: { tabId, conversationId: chatId, ...before === undefined ? {} : { sequence: { $lt: before } }, 'source.kind': 'buddy-proposal' } },
      // Its own thread's root (none before threads).
      { $match: { $expr: { $eq: [{ $ifNull: ['$thread', '$_id'] }, '$_id'] } } },
      { $sort: { sequence: -1, _id: -1 } }, { $limit: take }, ROOT_FIELDS])).map(rootOf),
    threads: rootIds => pageThreads(tx, tabId, chatId, rootIds),
    forget: async ids => {
      // Never a root closed since it was listed: its reason stays.
      if (ids.length) await tx.$runCommandRaw({ delete: OPEN, deletes: [{ q: { _id: { $in: ids }, tabId, sequence: { $gte: 0 } }, limit: 0 }] as unknown as Prisma.InputJsonArray })
    },
    // By `_id`, as rootsById is: only a seed's scan asks, once per chat.
    closed: async ids => new Set((await readBy(tx, OPEN, 'id', [{ $match: { _id: { $in: ids } } }, { $project: { tabId: 1, sequence: 1 } }]))
      .filter(row => row.tabId === tabId && row.sequence === CLOSED_SEQUENCE).map(row => row._id as string)),
  }
}
