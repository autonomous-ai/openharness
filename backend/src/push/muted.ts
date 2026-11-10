import type { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'
import type { PhoneNotice } from './sender.js'

/**
 * `notices` less the tags, and an agent's words in its 1:1 chat, whose chat their person muted (anh Dee, 2026-11-09): a muted
 * chat rings no phone; a tag there stays in the person's tags and on the badge. One read of the tags' settings by id, after the write
 * committed, so the write never waits on it. A read that fails sends every tag, and says so: a tag is never lost to it.
 */
export async function dropMuted(db: PrismaClient, notices: PhoneNotice[]): Promise<PhoneNotice[]> {
  const ids = [...new Set(notices.flatMap(n => n.setting ? [n.setting] : []))]
  if (!ids.length) return notices
  try {
    // By `_id` in a plain $match: Prisma sends `in` as $expr, which no index bounds (AGENTS.md rule 3).
    const rows = await db.superTabChatSetting.aggregateRaw({ pipeline: [{ $match: { _id: { $in: ids }, notify: 'muted' } },
      { $project: { _id: 1 } }] }) as unknown as Array<{ _id: string }>
    const muted = new Set(rows.map(row => row._id))
    return muted.size ? notices.filter(n => !n.setting || !muted.has(n.setting)) : notices
  } catch (error) {
    logger.warn('phone push mutes not read', { tags: ids.length, error: error instanceof Error ? error.message : String(error) })
    return notices
  }
}
