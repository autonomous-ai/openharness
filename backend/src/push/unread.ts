import type { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'
import type { PhoneNotice } from './sender.js'

/**
 * `notices` with each agent-chat notice made quiet while the chat already held words its person has not read (push/notices.ts
 * chatNotices): a chat sounds once until it is read, as the app's own chat notice does (mobile swarm_notices.dart
 * announceChat). The chat's newest main row before the write is what is weighed: unread when it is not the person's own and
 * their read mark (none counts as nothing read) is behind it. So the agent's first words after the person spoke, or after they
 * read the chat, sound; the next ones before they read it are quiet. Two reads by key after the write committed, each bounded
 * by the notices sent; a read that fails leaves every notice as it was, and says so: a notice is never lost to it.
 */
export async function quietUnread(db: PrismaClient, notices: PhoneNotice[]): Promise<PhoneNotice[]> {
  const asked = notices.flatMap(n => n.unreadBefore ? [n.unreadBefore] : [])
  if (!asked.length) return notices
  try {
    // Plain $match by key: Prisma sends `in` as $expr, which no index bounds (AGENTS.md rule 3).
    const [marks, rows] = await Promise.all([
      db.superTabReadMark.aggregateRaw({ pipeline: [{ $match: { _id: { $in: asked.map(a => a.mark) } } }, { $project: { _id: 1, sequence: 1 } }] }),
      db.superTabMessage.aggregateRaw({ pipeline: [{ $match: { $or: asked.map(a => ({ tabId: a.tabId, conversationId: a.conversationId, sequence: a.sequence })) } },
        { $project: { _id: 0, conversationId: 1, sequence: 1, 'author.kind': 1, 'author.id': 1 } }] }),
    ]) as unknown as [Array<{ _id: string; sequence: number }>, Array<{ conversationId: string; sequence: number; author?: { kind?: string; id?: string } }>]
    const read = new Map(marks.map(m => [m._id, m.sequence]))
    const own = new Set(rows.filter(r => r.author?.kind === 'person').map(r => `${r.conversationId}\u0000${r.sequence}\u0000${r.author!.id}`))
    return notices.map(n => {
      const before = n.unreadBefore
      if (!before || own.has(`${before.conversationId}\u0000${before.sequence}\u0000${n.personId}`)) return n
      return (read.get(before.mark) ?? 0) < before.sequence ? { ...n, quiet: true as const } : n
    })
  } catch (error) {
    logger.warn('phone push read marks not read', { chats: asked.length, error: error instanceof Error ? error.message : String(error) })
    return notices
  }
}
