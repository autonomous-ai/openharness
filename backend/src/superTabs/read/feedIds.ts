import type { PrismaClient } from '@prisma/client'
import type { Conversation } from '../model.js'

type FeedFields = Pick<Conversation, 'projectId' | 'kind' | 'audience' | 'reviewOf' | 'requesterId' | 'taskApproval' | 'proposal' | 'assignment' | 'foldedInto'>

/** A person at one membership, as an approval or a proposal names them: a later membership of the same account matches none. */
export const askedKey = (personId: string, generation: string): string => `${personId}:${generation}`
/** Every task of a project, which Activity reads for each project its reader may read (task #4689). A conversation stored with
 *  no project is the default one's (projects.ts groupProject). Ids are hex, so no person or agent key starts `p:`. */
export const projectKey = (projectId: string | null | undefined): string => `p:${projectId ?? 'lead'}`
/** A task waiting on this person's Accept, at their membership: Activity pins every one, however old (task #4689). */
export const waitingKey = (personId: string, generation: string): string => `w:${personId}:${generation}`

/**
 * The keys whose Tasks feed lists a task (read/personalTasks.ts, task #4203), exactly as the feed counts a task as the
 * reader's: who asked (the approver or proposal senders at their membership, else the requester), the login its agent runs
 * under, which outlives the agent, and the agent doing it or suggested for it. Stored as the conversation's indexed `feedIds`
 * on every write (parts/write.ts extracted), so a page is one read of the reader's keys and own agents. Every task also carries
 * its project's key, and while it waits on someone's Accept their waiting key: Activity's pages (task #4689). A conversation
 * that is no task, a proposal merged into another, and a task closed into another (foldedInto), names nobody.
 */
export function feedIdsOf(group: FeedFields): string[] {
  if (group.kind || group.audience || group.reviewOf || group.proposal?.mergedInto || group.foldedInto) return []
  const approval = group.taskApproval
  const asked = approval ? [askedKey(approval.personId, approval.generation)]
    : group.proposal ? group.proposal.senders.map(s => askedKey(s.personId, s.generation)) : [group.requesterId]
  const ids = [...asked, group.assignment?.execution?.contributorId, group.assignment?.agentId ?? approval?.suggestedAgentId, projectKey(group.projectId),
    approval?.state === 'proposal' ? waitingKey(approval.personId, approval.generation) : undefined]
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && !!id))]
}

const BATCH = 500
type Stored = { _id: string; tabId: string; version: number; data?: FeedFields }

/** The rows markFeedIds sets: written before the column, or a task written before its project key (task #4689). A task here is
 *  what feedIdsOf counts as one, so every row it sets leaves the match; a row with no data is none (review of #3576). */
const UNSET = { $or: [{ feedIds: { $exists: false } }, { data: { $type: 'object' }, 'data.kind': null, 'data.audience': null, 'data.reviewOf': null, 'data.proposal.mergedInto': null,
  'data.foldedInto': null, feedIds: { $not: { $regex: '^p:' } } }] }

/** Run once by the worker at startup, as markFinishedGroups is: sets `feedIds` on every part written before it, and on every task
 *  written before Activity's keys, 500 at a time. Remove it, and its call in worker.ts, after 2026-12-07: by then every Swarm's
 *  rows carry both (its unindexed match reads the whole collection on each start).
 *  An assignment from before its agent's login was stored takes it from the agent's row while that row (or its tombstone) is
 *  there. Every later write sets the column itself, and a row written while this runs keeps that write's (the update names the
 *  version it read). Returns how many it set; throws when the database refuses any write. */
export async function markFeedIds(db: PrismaClient): Promise<number> {
  let set = 0
  for (;;) {
    const rows = await db.swarmGroup.aggregateRaw({ pipeline: [{ $match: UNSET }, { $limit: BATCH },
      { $project: { tabId: 1, version: 1, 'data.projectId': 1, 'data.kind': 1, 'data.audience': 1, 'data.reviewOf': 1, 'data.requesterId': 1, 'data.taskApproval': 1, 'data.proposal.senders': 1,
        'data.proposal.mergedInto': 1, 'data.foldedInto': 1, 'data.assignment.agentId': 1, 'data.assignment.execution.contributorId': 1 } }] }) as unknown as Stored[]
    if (!rows.length) return set
    const agentOf = (row: Stored) => row.data?.assignment && !row.data.assignment.execution?.contributorId ? `${row.tabId}:${row.data.assignment.agentId}` : null
    const named = [...new Set(rows.map(agentOf).filter((id): id is string => !!id))]
    const agents = named.length ? await db.swarmAgent.aggregateRaw({ pipeline: [{ $match: { _id: { $in: named } } }, { $project: { contributorId: 1 } }] }) as
      unknown as Array<{ _id: string; contributorId?: string }> : []
    const contributors = new Map(agents.map(a => [a._id, a.contributorId]))
    const reply = await db.$runCommandRaw({ update: 'SwarmGroup', updates: rows.map(row => {
      const data = row.data ?? {} as FeedFields, contributorId = contributors.get(agentOf(row) ?? '')
      const filled = contributorId ? { ...data, assignment: { ...data.assignment!, execution: { ...data.assignment!.execution, contributorId } } } : data
      return { q: { _id: row._id, version: row.version }, u: { $set: { feedIds: row.data ? feedIdsOf(filled) : [] } } }
    }) }) as { writeErrors?: unknown[]; n?: number }
    // A refused row would come back in the next batch, and that batch again, for ever.
    if (reply.writeErrors?.length) throw new Error(`The database refused ${reply.writeErrors.length} of ${rows.length} Tasks feed id writes`)
    set += reply.n ?? 0
    if (rows.length < BATCH) return set
  }
}
