import { communityStarterAuthor } from './communityAccess.js'
import { logger } from '../utils/logger.js'
import { prisma } from './prisma.js'

export type NotificationKind = 'comment' | 'reply' | 'fork'
type Notice = { userId: string; kind: NotificationKind; harnessId: string; harnessTitle: string; actorName: string; targetId: string }

/** How many of a creator's latest notifications their page lists. */
export const notificationPageSize = 50

/**
 * Tells creators what [actorId] did to their work. Nobody is told of their own doing, and the starters'
 * creator is not a person to tell. A failure is logged, never the comment's or the fork's failure.
 */
export async function notify(autonomousEnv: string, actorId: string, notices: Notice[]): Promise<void> {
  const told = new Set<string>()
  const data = notices.filter(notice => {
    if (notice.userId === actorId || notice.userId === communityStarterAuthor || told.has(notice.userId)) return false
    told.add(notice.userId)
    return true
  }).map(notice => ({ ...notice, autonomousEnv, readAt: null }))
  if (!data.length) return
  try {
    await prisma.communityNotification.createMany({ data })
  } catch (err) {
    logger.warn('community notification not saved', { kinds: data.map(row => row.kind), error: String(err) })
  }
}
