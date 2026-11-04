/**
 * A project's Buddy proposals its PM has not answered (the Tasks view's Proposals, #2569), by #2867's rule as the chat shows
 * it (threads.ts askOf): no mark from a task opened from it, and no reply in its thread from the project chat's lead agent.
 * Nothing is stored for it: the roots are read from the project chat, and their threads as the chat page reads them.
 */
import type { Prisma } from '@prisma/client'
import type { Actor, Conversation, SuperTabState } from './model.js'
import { pageThreads, type ThreadReply } from './pageReads.js'
import { readBy } from './parts/indexed.js'
import { readConversation, readProject } from './projects.js'
import { threadSummaries } from './threads.js'

type Transaction = Prisma.TransactionClient

/** The most a read lists: the newest open ones, shown oldest first. Far above today's under 10 open per project. */
export const MAX_PROPOSALS = 100
/** The most proposal roots one read looks through, newest first, for the open ones: answered ones past this are not read. */
export const MAX_ROOTS = 1_000
/** The words buddy.propose puts before a proposal's name (commands.ts), which the apps leave out. */
const ROOT_PREFIX = "Let's build: "

export interface OpenProposal { messageId: string; title: string; personId?: string; at: number }
/** A proposal's root as the read takes it from the chat. */
export interface ProposalRoot { id: string; sequence: number; text: string; source: Record<string, unknown>; createdAt: Date }
/** The chat's proposal roots newest first, before a sequence (all of them without one); and the threads of some roots. */
export interface ProposalReads {
  roots(before: number | undefined, take: number): Promise<ProposalRoot[]>
  threads(rootIds: string[]): Promise<ThreadReply[]>
}

/** The project chat [projectId] names, for a reader who may read it, as the messages read checks it; else NOT_FOUND. */
export function proposalChat(state: SuperTabState, actor: Actor, projectId: string): Conversation {
  return readConversation(state, actor, readProject(state, actor, projectId).leadConversationId)
}

/** The open proposals in [chat], oldest first: the newest MAX_PROPOSALS, read a batch of roots at a time. */
export async function openProposals(state: SuperTabState, chat: Conversation, reads: ProposalReads): Promise<OpenProposal[]> {
  const open: OpenProposal[] = []
  for (let before: number | undefined, read = 0; open.length < MAX_PROPOSALS && read < MAX_ROOTS;) {
    const roots = await reads.roots(before, MAX_PROPOSALS)
    if (!roots.length) break
    read += roots.length
    // A root with no reply has no summary: nobody answered it.
    const asks = new Map(threadSummaries(state, chat, await reads.threads(roots.map(r => r.id))).map(t => [t.id, t.ask]))
    for (const root of roots) {
      if (asks.has(root.id) && asks.get(root.id) !== 'proposal') continue
      const personId = root.source.personId
      open.push({ messageId: root.id, title: root.text.startsWith(ROOT_PREFIX) ? root.text.slice(ROOT_PREFIX.length) : root.text,
        ...typeof personId === 'string' ? { personId } : {}, at: root.createdAt.getTime() })
    }
    if (roots.length < MAX_PROPOSALS) break
    before = roots.at(-1)!.sequence
  }
  return open.slice(0, MAX_PROPOSALS).reverse()
}

const date = (value: unknown): Date => new Date((value as { $date?: string } | null)?.$date ?? value as string)

/** The reads of [chatId], from the database: its roots by the conversation's sequence index, newest first; its threads as
 *  the chat page reads them (pageThreads). A proposal root is the only row of its command, so no other shares its sequence. */
export function databaseProposalReads(tx: Transaction, tabId: string, chatId: string): ProposalReads {
  return {
    roots: async (before, take) => (await readBy(tx, 'SuperTabMessage', 'sequence', [
      { $match: { tabId, conversationId: chatId, ...before === undefined ? {} : { sequence: { $lt: before } }, 'source.kind': 'buddy-proposal' } },
      // Its own thread's root (none before threads).
      { $match: { $expr: { $eq: [{ $ifNull: ['$thread', '$_id'] }, '$_id'] } } },
      { $sort: { sequence: -1, _id: -1 } }, { $limit: take }, { $project: { _id: 1, sequence: 1, text: 1, source: 1, createdAt: 1 } }]))
      .map(row => ({ id: row._id as string, sequence: row.sequence as number, text: row.text as string, source: row.source as Record<string, unknown>,
        createdAt: date(row.createdAt) })),
    threads: rootIds => pageThreads(tx, tabId, chatId, rootIds),
  }
}
