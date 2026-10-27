/** A Lead tags people in its message; each tag waits in the person's Swarm-wide list until they reply in that
 *  conversation or mark it done. Tags live in SuperTabMention, never in the tab state, so an older backend still
 *  reads and writes a tab that has them. Called inside SuperTabStore's transactions. */
import type { Prisma, PrismaClient } from '@prisma/client'
import { fail, isLeads, person, stableId, type Actor, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { canReadGroup, groupProject, ledProject, projectOf } from './projects.js'

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

export async function readMention(tx: Tx, tabId: string, id: string): Promise<MentionTarget | undefined> {
  return await tx.superTabMention.findFirst({ where: { id, tabId }, select: { id: true, personId: true, conversationId: true } }) ?? undefined
}

/** Marking an answered tag done again keeps how it was answered. */
export async function markDone(tx: Tx, tabId: string, id: string, personId: string, now: number): Promise<void> {
  await tx.superTabMention.updateMany({ where: { id, tabId, personId, ...waiting }, data: { resolvedAt: new Date(now), resolvedBy: 'done' } })
}

/** The person's own unexpired tags in conversations they can still read, newest first. The badge counts this same list.
 *  ponytail: capped at 500 per state; page it if a person ever gets more in 30 days. */
async function readable(tx: Tx, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>, now: number, open: boolean) {
  person(state, actor.userId)
  const rows = await tx.superTabMention.findMany({ where: { tabId, personId: actor.userId, createdAt: { gt: new Date(now - MENTION_EXPIRY_MS) },
    ...(open ? waiting : { resolvedAt: { not: null } }) }, orderBy: { createdAt: 'desc' }, take: 500 })
  return rows.filter(row => {
    const group = state.conversations.find(c => c.id === row.conversationId)
    return !!group && !isLeads(group) && canReadGroup(state, actor, group)
  })
}

export async function mentionsWaiting(tx: Tx, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>, now: number): Promise<number> {
  return (await readable(tx, tabId, state, actor, now, true)).length
}

export async function listMentions(tx: Tx, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>, now: number, open: boolean) {
  const rows = await readable(tx, tabId, state, actor, now, open)
  const messages = rows.length ? await tx.superTabMessage.findMany({ where: { tabId, id: { in: rows.map(r => r.messageId) } },
    select: { id: true, text: true, author: true } }) : []
  return rows.map(row => {
    const group = state.conversations.find(c => c.id === row.conversationId)!
    const message = messages.find(m => m.id === row.messageId)
    const author = message?.author as { name?: string; displayName?: string } | undefined
    return { id: row.id, projectId: row.projectId, projectName: projectOf(state, group.projectId ?? 'lead').name,
      conversationId: row.conversationId, conversationTitle: group.title, messageId: row.messageId,
      leadId: row.authorAgentId, leadName: author?.displayName ?? author?.name ?? 'Lead', text: (message?.text ?? '').slice(0, 200),
      createdAt: row.createdAt, resolvedAt: row.resolvedAt, resolvedBy: row.resolvedBy }
  })
}
