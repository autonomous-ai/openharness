import { z } from 'zod'
import { fail, type SuperTabState } from './model.js'

/** The small set a message can be reacted with, in the order counts show. Desktop draws each (👍 🎉 ❤️ 😄 👀 🚀). */
export const REACTIONS = ['thumbs_up', 'tada', 'heart', 'laugh', 'eyes', 'rocket'] as const
export const reactionSchema = z.enum(REACTIONS)
export type Reaction = (typeof REACTIONS)[number]

/** The message a `message.react` names, found by the store in that conversation and readable by the actor, and whether
 *  the actor already reacted to it with that emoji. */
export interface ReactionTarget { messageId: string; reacted: boolean }
/** A stored reaction (schema.prisma SuperTabReaction): one row per message, reactor and emoji. */
export interface ReactionRow { messageId: string; emoji: string; actorKind: string; actorId: string }
export interface ReactionCount { emoji: Reaction; count: number; by: Array<{ kind: 'person' | 'agent'; id: string }> }

/** `message.react`: adds or removes the actor's reaction. Only a change bumps the group, so every reader's next change
 *  read picks it up; a repeated add or remove changes nothing. The store writes the row. */
export function react(group: { reactionSeq?: number }, messageId: string, on: boolean, target: ReactionTarget | undefined): boolean {
  if (target?.messageId !== messageId) fail('NOT_FOUND', 'This message is unavailable.', 404)
  const changed = target.reacted !== on
  if (changed) group.reactionSeq = (group.reactionSeq ?? 0) + 1
  return changed
}

/** Each message's counts, emoji in REACTIONS order. A reactor who left the Swarm, or an agent no longer in it, drops out. */
export function reactionCounts(state: SuperTabState, rows: ReactionRow[]): Map<string, ReactionCount[]> {
  const present = (row: ReactionRow) => row.actorKind === 'person' ? state.people.some(p => p.id === row.actorId)
    : row.actorKind === 'agent' && state.agents.some(a => a.id === row.actorId)
  const counts = new Map<string, ReactionCount[]>()
  for (const messageId of new Set(rows.map(r => r.messageId))) {
    const mine = rows.filter(r => r.messageId === messageId && present(r))
    const shown = REACTIONS.flatMap(emoji => {
      const by = mine.filter(r => r.emoji === emoji).map(r => ({ kind: r.actorKind as 'person' | 'agent', id: r.actorId }))
      return by.length ? [{ emoji, count: by.length, by }] : []
    })
    if (shown.length) counts.set(messageId, shown)
  }
  return counts
}
