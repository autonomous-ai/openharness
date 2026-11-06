import type { PrismaClient } from '@prisma/client'
import type { Conversation } from '../model.js'

/**
 * The people and agents whose Tasks feed lists a task (read/personalTasks.ts, task #4203): who asked for it, who approves
 * it and the agent suggested, who proposed it, and the agent it is assigned to. Stored as the conversation's indexed
 * `feedIds` on every write (parts/write.ts extracted), so a person's feed is one read of the person and their own agents.
 * A conversation that is no task names nobody. A superset: the feed still checks membership generations and access.
 */
export function feedIdsOf(group: Pick<Conversation, 'kind' | 'audience' | 'reviewOf' | 'requesterId' | 'taskApproval' | 'proposal' | 'assignment'>): string[] {
  if (group.kind || group.audience || group.reviewOf) return []
  const ids = [group.requesterId, group.taskApproval?.personId, group.taskApproval?.suggestedAgentId,
    ...group.proposal?.senders?.map(s => s.personId) ?? [], group.assignment?.agentId]
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && !!id))]
}

/** `feedIdsOf` as a pipeline update computes it from the stored data. */
const STORED_FEED_IDS = { $cond: {
  if: { $or: [{ $ne: [{ $ifNull: ['$data.kind', null] }, null] }, { $ne: [{ $ifNull: ['$data.audience', null] }, null] }, { $eq: [{ $type: '$data.reviewOf' }, 'string'] }] },
  then: [],
  else: { $filter: { input: { $setUnion: [['$data.requesterId', '$data.taskApproval.personId', '$data.taskApproval.suggestedAgentId', '$data.assignment.agentId'],
    { $ifNull: ['$data.proposal.senders.personId', []] }] }, cond: { $and: [{ $eq: [{ $type: '$$this' }, 'string'] }, { $ne: ['$$this', ''] }] } } },
} }

/** Run once by the worker at startup, as markFinishedGroups is: sets `feedIds` on every part written before it. Every later
 *  write sets it itself. Returns how many it set. */
export async function markFeedIds(db: PrismaClient): Promise<number> {
  const reply = await db.$runCommandRaw({ update: 'SwarmGroup', updates: [
    { q: { feedIds: { $exists: false } }, u: [{ $set: { feedIds: STORED_FEED_IDS } }], multi: true },
  ] }) as { nModified?: number }
  return Number(reply.nModified ?? 0)
}
