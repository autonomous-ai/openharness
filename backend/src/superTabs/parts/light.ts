/**
 * Read-only loading for the read API (group 3b). The parts a change read or a host form needs, selected as `loadActive`
 * selects them, but conversations with only the fields those reads use: never a brief, a task (beyond its owned paths),
 * checks, or a finished work's result. Group 6's benchmark (b4b28aec8): an idle Desktop change read sent 2.8 KB and loaded
 * 1.17 MB, a whole reassembled Swarm, every 3 s per window. What these loads return is for reading checks, derived values
 * and host rows; it is never sent to a client as a conversation.
 */
import type { Prisma } from '@prisma/client'
import type { AgentStart } from '../model.js'
import type { GroupData, HeadData, Part, PartKind, SwarmParts } from './types.js'
import { delegate, partId, type PartRow } from './write.js'

type Transaction = Prisma.TransactionClient

/** Work that is not done, stopped or cancelled (model.ts activeWork). */
const RUNNING = ['planned', 'working', 'needs_human', 'blocked', 'review', 'reconciling']
const running = { $in: ['$data.assignment.status', RUNNING] }
const whenRunning = (field: string) => ({ $cond: [running, `$data.${field}`, '$$REMOVE'] })
/** The conversation fields reads use: who reads it and who is in it, and its work. Finished work keeps only who did it and
 *  how it ended; running work also its id, machine, result, title and owned paths (other projects' work, host rows). */
const LIGHT_GROUP = {
  _id: 0, key: 1, version: 1, changedAt: 1, ordinal: 1, dormant: 1,
  ...Object.fromEntries(['id', 'kind', 'projectId', 'leadId', 'agentIds', 'archived', 'audience', 'dormant', 'assignment.agentId', 'assignment.status']
    .map(field => [`data.${field}`, 1])),
  ...Object.fromEntries(['title', 'task.owns', 'assignment.id', 'assignment.execution', 'assignment.result'].map(field => [`data.${field}`, whenRunning(field)])),
}

/** A date as `aggregateRaw` returns it: Extended JSON. */
function ms(value: unknown): number {
  const date = (value as { $date?: unknown } | null)?.$date ?? value
  if (typeof date === 'string') return Date.parse(date)
  if (typeof date === 'number') return date
  return Number((date as { $numberLong?: string }).$numberLong)
}

function lightGroup(row: Record<string, unknown>): Part<GroupData> {
  const raw = (row.data ?? {}) as Partial<GroupData> & { task?: { owns?: string[] } }
  // A conversation with no work has nothing to project there; never read it as having work.
  // Finished work comes without its id, machine or result: placeholders keep the shape, and nothing reads them.
  const work = raw.assignment?.status ? raw.assignment as Partial<NonNullable<GroupData['assignment']>> : null
  const assignment = work && { id: '', execution: { machineId: '', harnessId: '', machineOwnerId: '' }, result: null, ...work }
  const data = { title: '', ...raw, brief: '', checks: [], assignment,
    ...(raw.task?.owns ? { task: { goal: '', changes: '', constraints: '', owns: raw.task.owns } } : {}) } as GroupData
  return { kind: 'group', key: row.key as string, version: row.version as number, changedAt: ms(row.changedAt), ordinal: row.ordinal as number, data,
    ...(row.dormant ? { dormant: true as const } : {}) }
}

const toPart = <T>(kind: PartKind, row: PartRow): Part<T> => ({ kind, key: row.key, version: row.version, changedAt: row.changedAt.getTime(),
  ordinal: row.ordinal, data: row.data as T })

/**
 * The live parts of one Swarm with conversations light. Conversations: every active one (`groups: 'active'`, as
 * `loadActive`), or only the Lead conversations and those with running work (`'working'`: what visibility and derived
 * values read once every finished worker's decision is stored); plus those named by id and those the named agents are in,
 * dormant ones too. Starts: unfinished, or every live start with `includeRecentStarts`.
 */
export async function loadLight(tx: Transaction, tabId: string,
  opts: { groupIds?: string[]; agentIds?: string[]; includeRecentStarts?: boolean; groups?: 'active' | 'working' } = {}): Promise<SwarmParts> {
  const head = await tx.swarmHead.findUnique({ where: { id: partId(tabId, 'head') } })
  if (!head) throw Object.assign(new Error(`Swarm ${tabId} has no parts`), { code: 'PARTS_MISSING' })
  const live = { tabId, deleted: false }
  const starts = (await delegate(tx, 'start').findMany({ where: opts.includeRecentStarts ? live : { ...live, finishedAt: null } })).map(row => toPart<AgentStart>('start', row))
  const { projects, leadsConversationId, invitations } = head.data as unknown as HeadData
  // Besides the Lead conversations and running work, the conversations a start or an invitation names: a reader sees
  // those only alongside their conversation (model.ts visibleState).
  const working = [...projects ? projects.map(p => p.leadConversationId) : ['lead'], leadsConversationId ?? '',
    ...starts.map(s => s.data!.request.conversationId), ...invitations.map(i => i.conversationId)]
  const which = opts.groups === 'working' ? [{ key: { $in: working } }, { executionMachineId: { $ne: null } }] : [{ dormant: false }]
  const named = [...which, ...opts.groupIds?.length ? [{ key: { $in: opts.groupIds } }] : [], ...opts.agentIds?.length ? [{ agentIds: { $in: opts.agentIds } }] : []]
  const [members, agents, machines, progress, groups] = await Promise.all([
    ...(['member', 'agent', 'machine'] as const).map(kind => delegate(tx, kind).findMany({ where: live }).then(rows => rows.map(row => toPart(kind, row)))),
    delegate(tx, 'progress').findMany({ where: live }).then(rows => rows.map(row => toPart('progress', row))),
    tx.swarmGroup.aggregateRaw({ pipeline: [{ $match: { tabId, deleted: false, $or: named } }, { $project: LIGHT_GROUP }] })
      .then(rows => (rows as unknown as Array<Record<string, unknown>>).map(lightGroup)),
  ])
  return { tabId, head: toPart<HeadData>('head', head as unknown as PartRow), members, agents, groups, machines, starts, progress,
    sequenceBase: head.sequenceBase, visibilityEpoch: head.visibilityEpoch, groupCounter: head.groupCounter } as SwarmParts
}
