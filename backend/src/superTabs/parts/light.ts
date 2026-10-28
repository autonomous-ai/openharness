/**
 * Read-only loading for the read API (group 3b). The parts a change read or a host form needs, selected as `loadActive`
 * selects them, but conversations with only the fields those reads use: never a brief, a task (beyond its owned paths),
 * checks, or a finished work's result. Group 6's benchmark (b4b28aec8): an idle Desktop change read sent 2.8 KB and loaded
 * 1.17 MB, a whole reassembled Swarm, every 3 s per window. What these loads return is for reading checks, derived values
 * and host rows; it is never sent to a client as a conversation.
 */
import type { Prisma } from '@prisma/client'
import { activeWork, type Agent, type AgentStart } from '../model.js'
import type { GroupData, HeadData, Part, PartKind, SwarmParts } from './types.js'
import { delegate, partId, type PartRow } from './write.js'

type Transaction = Prisma.TransactionClient

/** Statuses of finished work, as model.ts activeWork reads them (light.test.ts holds every status to it). */
export const FINISHED: readonly string[] = ['done', 'stopped', 'cancelled', 'lost']
const running = { $and: [{ $ne: [{ $type: '$data.assignment.status' }, 'missing'] }, { $not: [{ $in: ['$data.assignment.status', FINISHED] }] }] }
/**
 * Which conversation fields a light load keeps. `always`: who reads it and who is in it, and how its work ended (a lost
 * task's worker awaits no decision, model.ts awaitingWorkers), with the work's id: a host row tells whether a task lost to a
 * usage limit is still that one before its host resumes it (read/hostRows.ts). `whenRunning`: what other projects' work and host rows read of
 * running work. `unread`: what visibility checks, derived values and host rows never read. light.test.ts fails when
 * model.ts gains a field this does not place.
 */
export const GROUP_FIELDS = {
  always: ['id', 'kind', 'projectId', 'leadId', 'agentIds', 'archived', 'audience', 'dormant', 'assignment.id', 'assignment.agentId', 'assignment.status',
    'assignment.lost'],
  whenRunning: ['title', 'task.owns', 'assignment.execution', 'assignment.result'],
  unread: ['number', 'brief', 'reviewOf', 'checks', 'lastMessageSequence', 'pullRequestUrls', 'messageSeq', 'reportSeq', 'lastActivityAt', 'lostAttempt', 'requesterId', 'ledger', 'reactionSeq',
    'assignment.configuration', 'assignment.recordingProgress', 'assignment.leaseUntil', 'assignment.progressAt'],
} as const
const LIGHT_GROUP = {
  _id: 0, key: 1, version: 1, changedAt: 1, ordinal: 1, dormant: 1,
  ...Object.fromEntries(GROUP_FIELDS.always.map(field => [`data.${field}`, 1])),
  ...Object.fromEntries(GROUP_FIELDS.whenRunning.map(field => [`data.${field}`, { $cond: [running, `$data.${field}`, '$$REMOVE'] }])),
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
  // Finished work comes without its machine or result: placeholders keep the shape, and nothing reads them.
  const work = raw.assignment?.status ? raw.assignment as Partial<NonNullable<GroupData['assignment']>> : null
  const assignment = work && { id: '', execution: { machineId: '', harnessId: '', machineOwnerId: '' }, result: null, ...work }
  const data = { title: '', ...raw, brief: '', checks: [], assignment,
    ...(raw.task?.owns ? { task: { goal: '', changes: '', constraints: '', owns: raw.task.owns } } : {}) } as GroupData
  return { kind: 'group', key: row.key as string, version: row.version as number, changedAt: ms(row.changedAt), ordinal: row.ordinal as number, data,
    ...(row.dormant ? { dormant: true as const } : {}) }
}

/**
 * A worker with no stored decision and no running work is judged from its finished conversations (model.ts
 * awaitingWorkers): a lost task leaves none stored (liveness.ts). The 'working' selection then also needs every active
 * conversation such a worker is in, works in or leads, as a whole first load sees them (review of #1745).
 */
async function undecidedWork(agents: Part<Agent>[], groups: Part<GroupData>[], lightGroups: (match: Record<string, unknown>) => Promise<Part<GroupData>[]>) {
  const busy = new Set(groups.flatMap(g => [...g.data!.leadId ? [g.data!.leadId] : [], ...activeWork(g.data!) ? [g.data!.assignment!.agentId, ...g.data!.agentIds] : []]))
  const undecided = agents.filter(a => !a.data!.workDecision && !busy.has(a.key)).map(a => a.key)
  if (!undecided.length) return []
  return lightGroups({ dormant: false, key: { $nin: groups.map(g => g.key) },
    $or: [{ 'data.assignment.agentId': { $in: undecided } }, { 'data.leadId': { $in: undecided } }, { agentIds: { $in: undecided } }] })
}

const toPart = <T>(kind: PartKind, row: PartRow): Part<T> => ({ kind, key: row.key, version: row.version, changedAt: row.changedAt.getTime(),
  ordinal: row.ordinal, data: row.data as T })

/**
 * The live parts of one Swarm with conversations light. Conversations: every active one (`groups: 'active'`, as
 * `loadActive`), or only the Lead conversations and those with running work (`'working'`: what visibility and derived
 * values read once every finished worker's decision is stored); plus those named by id and those the named agents are in,
 * dormant ones too, and the active ones of the named projects. Starts: unfinished, or every live start with `includeRecentStarts`.
 */
export async function loadLight(tx: Transaction, tabId: string,
  opts: { groupIds?: string[]; agentIds?: string[]; projectIds?: string[]; includeRecentStarts?: boolean; groups?: 'active' | 'working' } = {}): Promise<SwarmParts> {
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
  const named = [...which, ...opts.groupIds?.length ? [{ key: { $in: opts.groupIds } }] : [], ...opts.agentIds?.length ? [{ agentIds: { $in: opts.agentIds } }] : [],
    ...opts.projectIds?.length ? [{ projectId: { $in: opts.projectIds }, dormant: false }] : [],
    // The Swarm's first project also holds conversations stored with no project (model.ts groupProject).
    ...opts.projectIds?.includes('lead') ? [{ projectId: null, dormant: false }] : []]
  const lightGroups = async (match: Record<string, unknown>) => (await tx.swarmGroup.aggregateRaw({ pipeline: [{ $match: { tabId, deleted: false, ...match } },
    { $project: LIGHT_GROUP }] }) as unknown as Array<Record<string, unknown>>).map(lightGroup)
  const [members, agents, machines, progress, groups] = await Promise.all([
    ...(['member', 'agent', 'machine'] as const).map(kind => delegate(tx, kind).findMany({ where: live }).then(rows => rows.map(row => toPart(kind, row)))),
    delegate(tx, 'progress').findMany({ where: live }).then(rows => rows.map(row => toPart('progress', row))),
    lightGroups({ $or: named }),
  ])
  if (opts.groups === 'working') groups.push(...await undecidedWork(agents as Part<unknown>[] as Part<Agent>[], groups as Part<GroupData>[], lightGroups))
  return { tabId, head: toPart<HeadData>('head', head as unknown as PartRow), members, agents, groups, machines, starts, progress,
    sequenceBase: head.sequenceBase, visibilityEpoch: head.visibilityEpoch, groupCounter: head.groupCounter } as SwarmParts
}
