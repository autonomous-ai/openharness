/** A member thanks the author of a message, with an optional one-line note: a fun count on profiles, never points. One per
 *  giver and message. Kudos live in SuperTabKudos, never in the tab state or the message row, so an older backend still
 *  reads and writes a tab that has them. Every read checks again that the reader can read the kudos' conversation.
 *  Called inside SuperTabStore's transactions. */
import type { Prisma } from '@prisma/client'
import { actorKey, fail, stableId, type Actor, type Author, type Conversation, type SuperTabState } from './model.js'
import { canReadGroup } from './projects.js'

type Tx = Prisma.TransactionClient
export const MAX_KUDOS_NOTE = 120
export interface Member { kind: 'person' | 'agent'; id: string }
/** The message `kudos.give` names, read from this tab and conversation by the store. */
export interface KudosTarget { id: string; conversationId: string; author: Author; agentOnly: boolean }
/** What the store writes for a `kudos.give` (commands.ts). */
export interface KudosEffect { conversationId: string; messageId: string; from: Author; to: Member; note: string | null }
export interface KudosView { from: Omit<Author, 'membershipGeneration'>; to: Member; note: string | null; createdAt: Date }

export const memberKey = (member: Member): string => `${member.kind}:${member.id}`
const member = (key: string): Member => ({ kind: key.slice(0, key.indexOf(':')) as Member['kind'], id: key.slice(key.indexOf(':') + 1) })

/** The message's author receives it: still a member, and never the giver. An agent-only notice is no one's to thank. */
export function kudosFor(state: SuperTabState, actor: Actor, group: Conversation, target: KudosTarget | undefined): Member {
  if (!target || target.conversationId !== group.id || target.agentOnly) fail('NOT_FOUND', 'This message is unavailable.', 404)
  const to: Member = { kind: target.author.kind, id: target.author.id }
  if (memberKey(to) === actorKey(actor)) fail('KUDOS_SELF', 'You cannot thank yourself.', 400)
  const present = to.kind === 'person' ? state.people.some(p => p.id === to.id) : state.agents.some(a => a.id === to.id)
  if (!present) fail('KUDOS_UNAVAILABLE', `${target.author.displayName ?? target.author.name} is no longer in this Swarm.`)
  return to
}

/** A repeat keeps the first note; a concurrent give conflicts on the id and its retry finds this one. */
export async function writeKudos(tx: Tx, tabId: string, kudos: KudosEffect, now: number): Promise<void> {
  const { membershipGeneration: _generation, ...from } = kudos.from
  const id = stableId(tabId, 'kudos', `${from.kind}:${from.id}`, kudos.messageId)
  await tx.superTabKudos.upsert({ where: { id }, update: {}, create: { id, tabId, conversationId: kudos.conversationId, messageId: kudos.messageId,
    from, toKey: memberKey(kudos.to), note: kudos.note, createdAt: new Date(now) } })
}

/** The kudos on these messages of one conversation, oldest first; the caller has checked the reader reads it. */
export async function kudosOn(tx: Tx, tabId: string, conversationId: string, messageIds: string[]): Promise<Map<string, KudosView[]>> {
  const rows = messageIds.length ? await tx.superTabKudos.findMany({ where: { tabId, conversationId, messageId: { in: messageIds } },
    orderBy: { createdAt: 'asc' } }) : []
  const byMessage = new Map<string, KudosView[]>()
  for (const row of rows) byMessage.set(row.messageId, [...byMessage.get(row.messageId) ?? [],
    { from: row.from as unknown as KudosView['from'], to: member(row.toKey), note: row.note ?? null, createdAt: row.createdAt }])
  return byMessage
}

/** Kudos each member received in the conversations this reader can read, dormant ones included, by memberKey.
 *  ponytail: one count per conversation and member on every read; keep a per-member tally if Swarms collect many. */
export async function kudosReceived(tx: Tx, tabId: string, state: SuperTabState, actor: Actor): Promise<Record<string, number>> {
  const rows = await tx.superTabKudos.groupBy({ by: ['conversationId', 'toKey'], where: { tabId }, _count: { _all: true } })
  const groups = new Map<string, Conversation>(state.conversations.map(c => [c.id, c]))
  const missing = [...new Set(rows.map(r => r.conversationId))].filter(id => !groups.has(id))
  if (missing.length) {
    for (const row of await tx.swarmGroup.findMany({ where: { tabId, key: { in: missing }, deleted: false }, select: { key: true, data: true } })) {
      groups.set(row.key, row.data as unknown as Conversation)
    }
  }
  const readable = new Map<string, boolean>()
  const reads = (id: string) => {
    if (!readable.has(id)) {
      const group = groups.get(id)
      try { readable.set(id, !!group && canReadGroup(state, actor, group)) } catch { readable.set(id, false) }
    }
    return readable.get(id)!
  }
  const counts: Record<string, number> = {}
  for (const row of rows) if (reads(row.conversationId)) counts[row.toKey] = (counts[row.toKey] ?? 0) + row._count._all
  return counts
}
