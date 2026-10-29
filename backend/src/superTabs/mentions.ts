/** A Lead tags people in its message; each tag waits in the person's Swarm-wide list until they reply in that
 *  conversation or mark it done. Tags live in SuperTabMention, never in the tab state, so an older backend still
 *  reads and writes a tab that has them. Called inside SuperTabStore's transactions. */
import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { ensureIndex } from '../lib/db/indexes.js'
import { fail, isLeads, person, stableId, type Actor, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { canReadGroup, groupProject, ledProject, projectOf } from './projects.js'
import { groupsBy } from './parts/indexed.js'

type Tx = Prisma.TransactionClient
export const MAX_MENTIONS = 5
/** A tag drops off the list this long after it was made: refused on read, and removed by a TTL index. */
export const MENTION_EXPIRY_MS = 30 * 24 * 60 * 60_000
/** The mention `mention.done` names, read from this tab by the store. */
export interface MentionTarget { id: string; personId: string; conversationId: string }
/** Mongo omits unset fields, so `resolvedAt: null` alone would miss a row written without it. */
const waiting: Prisma.SuperTabMentionWhereInput = { OR: [{ resolvedAt: null }, { resolvedAt: { isSet: false } }] }

/** Run by the singleton worker at startup, like the terminal answer expiry. */
export async function ensureMentionExpiry(db: PrismaClient): Promise<void> {
  await ensureIndex(db, 'SuperTabMention', { key: { createdAt: 1 }, name: 'mention_expiry', expireAfterSeconds: MENTION_EXPIRY_MS / 1000 })
}

/** Only the project's Lead tags, only in that project's conversations, and only people who can read the conversation. */
export function checkMentions(state: SuperTabState, actor: Actor, group: Conversation, personIds: string[]): string[] {
  const ids = [...new Set(personIds)]
  if (!ids.length) return ids
  const led = actor.kind === 'agent' ? ledProject(state, actor.agentId) : undefined
  if (!led) fail('MENTION_FORBIDDEN', 'Only a project’s Lead can tag people.', 403)
  if (isLeads(group) || groupProject(state, group).id !== led.id) fail('MENTION_FORBIDDEN', 'A Lead can tag people only in its own project’s conversations.', 403)
  for (const id of ids) {
    const member = state.people.find(p => p.id === id) ?? fail('INVALID_MENTION', 'Tag a person in this Swarm.', 400)
    if (!canReadGroup(state, { kind: 'person', userId: member.id, email: member.email }, group)) {
      fail('INVALID_MENTION', `${member.email} cannot read this conversation.`, 400)
    }
  }
  return ids
}

export async function writeMentions(tx: Tx, tabId: string, state: SuperTabState, messages: MessageDraft[], now: number): Promise<void> {
  const data = messages.flatMap(message => (message.mentions ?? []).map(personId => ({
    id: stableId(tabId, message.id, personId), tabId, personId, projectId: state.conversations.find(c => c.id === message.conversationId)!.projectId ?? 'lead',
    conversationId: message.conversationId, messageId: message.id, authorAgentId: message.author.id,
    createdAt: new Date(now), resolvedAt: null, resolvedBy: null,
  })))
  if (data.length) await tx.superTabMention.createMany({ data })
}

/** Any post by the tagged person in that conversation answers every earlier tag there, in a thread or not. */
export async function resolveByReply(tx: Tx, tabId: string, conversationId: string, personId: string, now: number): Promise<void> {
  await tx.superTabMention.updateMany({ where: { tabId, conversationId, personId, createdAt: { lte: new Date(now) }, ...waiting },
    data: { resolvedAt: new Date(now), resolvedBy: 'reply' } })
}

/** The tags a person's post in this conversation is about to answer (resolveByReply), for the leaderboard's credit
 *  (leaderboard/record.ts recordPost): only which message and when. */
export async function openTags(tx: Tx, tabId: string, conversationId: string, personId: string, now: number): Promise<Array<{ messageId: string; createdAt: number }>> {
  const rows = await tx.superTabMention.findMany({ where: { tabId, conversationId, personId, createdAt: { gt: new Date(now - MENTION_EXPIRY_MS), lte: new Date(now) },
    ...waiting }, select: { messageId: true, createdAt: true } })
  return rows.map(row => ({ messageId: row.messageId, createdAt: row.createdAt.getTime() }))
}

export async function readMention(tx: Tx, tabId: string, id: string): Promise<MentionTarget | undefined> {
  return await tx.superTabMention.findFirst({ where: { id, tabId }, select: { id: true, personId: true, conversationId: true } }) ?? undefined
}

/** Marking an answered tag done again keeps how it was answered. */
export async function markDone(tx: Tx, tabId: string, id: string, personId: string, now: number): Promise<void> {
  await tx.superTabMention.updateMany({ where: { id, tabId, personId, ...waiting }, data: { resolvedAt: new Date(now), resolvedBy: 'done' } })
}

/** The person's own unexpired tags in conversations they can still read, newest first, each with its conversation. The badge
 *  counts this same list. Ordinary loads leave quiet (dormant) conversations out of the state, so the ones a tag is in are
 *  read here: the count and the list check the same conversations whichever state they get.
 *  ponytail: capped at 500 per state; page it if a person ever gets more in 30 days. */
async function readable(tx: Tx, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>, now: number, open: boolean) {
  person(state, actor.userId)
  const rows = await tx.superTabMention.findMany({ where: { tabId, personId: actor.userId, createdAt: { gt: new Date(now - MENTION_EXPIRY_MS) },
    ...(open ? waiting : { resolvedAt: { not: null } }) }, orderBy: { createdAt: 'desc' }, take: 500 })
  const groups = new Map(state.conversations.map(c => [c.id, c]))
  const missing = [...new Set(rows.map(r => r.conversationId))].filter(id => !groups.has(id))
  if (missing.length) {
    // By id through its index (parts/indexed.ts): every person's read counts these on each poll.
    for (const row of await groupsBy(tx, 'key', [{ $match: { tabId, deleted: false, key: { $in: missing } } }, { $project: { _id: 0, key: 1, data: 1 } }])) {
      groups.set(row.key as string, row.data as unknown as Conversation)
    }
  }
  return rows.flatMap(row => {
    const group = groups.get(row.conversationId)
    return group && !isLeads(group) && canReadGroup(state, actor, group) ? [{ row, group }] : []
  })
}

export async function mentionsWaiting(tx: Tx, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>, now: number): Promise<number> {
  return (await waitingMentions(tx, tabId, state, actor, now)).count
}

/** A person's waiting tags: how many, and a digest of which, as decisions.ts decisionsWaiting. A client reads its lists again
 *  when either moves (a tag made, answered or expired, though the count may stay), not on every change of the Swarm. Only
 *  the person's own tags they can still read go into it, and only their ids. */
export async function waitingMentions(tx: Tx, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>,
  now: number): Promise<{ count: number; digest: string }> {
  const ids = (await readable(tx, tabId, state, actor, now, true)).map(({ row }) => row.id).sort()
  return { count: ids.length, digest: mentionsDigest(ids) }
}

/** Which of these Swarms hold a waiting tag for the person, by one plain match (the index on tabId, personId, createdAt
 *  bounds it; Prisma would send `in` as an $expr that no index can). Raw, so a Swarm list counts a page of Swarms at once. */
export const swarmsWithTags = (tabIds: string[], personId: string, now: number) => [{ $match: { tabId: { $in: tabIds }, personId, resolvedAt: null,
  createdAt: { $gt: { $date: new Date(now - MENTION_EXPIRY_MS).toISOString() } } } }, { $group: { _id: '$tabId' } }]

/** The digest of a sorted list of waiting tag ids; a Swarm with none has this one. */
export function mentionsDigest(ids: string[]): string {
  return createHash('sha256').update(ids.join('\n')).digest('base64url').slice(0, 16)
}

export async function listMentions(tx: Tx, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>, now: number, open: boolean) {
  const tagged = await readable(tx, tabId, state, actor, now, open)
  const messages = tagged.length ? await tx.superTabMessage.findMany({ where: { tabId, id: { in: tagged.map(t => t.row.messageId) } },
    select: { id: true, text: true, author: true } }) : []
  return tagged.map(({ row, group }) => {
    const message = messages.find(m => m.id === row.messageId)
    const author = message?.author as { name?: string; displayName?: string } | undefined
    return { id: row.id, projectId: row.projectId, projectName: projectOf(state, group.projectId ?? 'lead').name,
      conversationId: row.conversationId, conversationTitle: group.title, messageId: row.messageId,
      leadId: row.authorAgentId, leadName: author?.displayName ?? author?.name ?? 'Lead', text: (message?.text ?? '').slice(0, 200),
      createdAt: row.createdAt, resolvedAt: row.resolvedAt, resolvedBy: row.resolvedBy }
  })
}
