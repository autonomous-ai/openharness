/** A message tags people; each tag waits in the person's Swarm-wide list until they reply in that
 *  conversation or mark it done. Tags live in SuperTabMention, never in the tab state, so an older backend still
 *  reads and writes a tab that has them. Called inside SuperTabStore's transactions. */
import type { Prisma, PrismaClient } from '@prisma/client'
import { fail, isLeads, person, stableId, type Actor, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { canReadGroup, projectOf } from './projects.js'

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
  await db.$runCommandRaw({ createIndexes: 'SuperTabMention', indexes: [{ key: { createdAt: 1 }, name: 'mention_expiry',
    expireAfterSeconds: MENTION_EXPIRY_MS / 1000 }] })
}

/** Anyone who posts in a project's conversation mentions other people who can read it (collaboration protocol): the poster's
 *  own access is checked by message.send. Never in the Leads conversation, which no person's list shows. */
export function checkMentions(state: SuperTabState, actor: Actor, group: Conversation, personIds: string[]): string[] {
  // A person's mention of themselves would only wait in their own list.
  const ids = [...new Set(personIds)].filter(id => actor.kind !== 'person' || id !== actor.userId)
  if (!ids.length) return ids
  if (isLeads(group)) fail('MENTION_FORBIDDEN', 'People can be mentioned only in a project’s conversations.', 403)
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
    for (const row of await tx.swarmGroup.findMany({ where: { tabId, deleted: false, key: { in: missing } }, select: { key: true, data: true } })) {
      groups.set(row.key, row.data as unknown as Conversation)
    }
  }
  return rows.flatMap(row => {
    const group = groups.get(row.conversationId)
    return group && !isLeads(group) && canReadGroup(state, actor, group) ? [{ row, group }] : []
  })
}

export async function mentionsWaiting(tx: Tx, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>, now: number): Promise<number> {
  return (await readable(tx, tabId, state, actor, now, true)).length
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
      leadName: author?.displayName ?? author?.name ?? 'Lead', text: (message?.text ?? '').slice(0, 200),
      createdAt: row.createdAt, resolvedAt: row.resolvedAt, resolvedBy: row.resolvedBy }
  })
}
