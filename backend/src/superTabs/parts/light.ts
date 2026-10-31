/**
 * Read-only loading for the read API (group 3b). The parts a change read or a host form needs, selected as `loadActive`
 * selects them, but conversations with only the fields those reads use: never a brief, a task (beyond its owned paths),
 * checks, or a finished work's result. Group 6's benchmark (b4b28aec8): an idle Desktop change read sent 2.8 KB and loaded
 * 1.17 MB, a whole reassembled Swarm, every 3 s per window. What these loads return is for reading checks, derived values
 * and host rows; it is never sent to a client as a conversation.
 */
import type { Prisma } from '@prisma/client'
import { activeWork, agentRole, type Agent, type AgentStart } from '../model.js'
import type { GroupData, HeadData, Part, PartKind, SwarmParts } from './types.js'
import { delegate, partId, type PartRow } from './write.js'
import { groupsBy, type GroupIndex } from './indexed.js'

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
  unread: ['number', 'brief', 'reviewOf', 'reviewStamp', 'checks', 'lastMessageSequence', 'lastMainSequence', 'pullRequestUrls', 'cards', 'messageSeq', 'reportSeq', 'lastActivityAt', 'lostAttempt', 'requesterId', 'ledger', 'reactionSeq', 'proposals', 'buddyName', 'buddySessions', 'buddyDownTold', 'liveness', 'leadAction', 'stepUp',
    'assignment.configuration', 'assignment.recordingProgress', 'assignment.leaseUntil', 'assignment.progressAt', 'assignment.askedOf', 'assignment.reviewFoundAt',
    'assignment.handoffs', 'assignment.verdicts'],
} as const
const LIGHT_GROUP = {
  _id: 0, key: 1, version: 1, changedAt: 1, ordinal: 1, dormant: 1,
  ...Object.fromEntries(GROUP_FIELDS.always.map(field => [`data.${field}`, 1])),
  ...Object.fromEntries(GROUP_FIELDS.whenRunning.map(field => [`data.${field}`, { $cond: [running, `$data.${field}`, '$$REMOVE'] }])),
}

/** A date as `aggregateRaw` returns it: Extended JSON. */
export function ms(value: unknown): number {
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
 * A worker with no stored decision is judged from its finished conversations (model.ts awaitingWorkers): a lost task leaves
 * none stored (liveness.ts). The 'working' selection then also needs every active conversation such a worker is in, works
 * in or leads, as a whole first load sees them (review of #1745). Busy as awaitingWorkers tells it: a Reviewer, the Lead of
 * a conversation, or the worker of active work; a member of someone else's running work is not.
 */
async function undecidedWork(agents: Part<Agent>[], groups: Part<GroupData>[], lightGroups: (index: GroupIndex, match: Record<string, unknown>) => Promise<Part<GroupData>[]>) {
  const busy = new Set(groups.flatMap(g => [...g.data!.leadId ? [g.data!.leadId] : [], ...activeWork(g.data!) ? [g.data!.assignment!.agentId] : []]))
  const undecided = agents.filter(a => !a.data!.workDecision && agentRole(a.data!) !== 'reviewer' && !busy.has(a.key)).map(a => a.key)
  if (!undecided.length) return []
  return lightGroups('dormancy', { dormant: false, key: { $nin: groups.map(g => g.key) },
    $or: [{ 'data.assignment.agentId': { $in: undecided } }, { 'data.leadId': { $in: undecided } }, { agentIds: { $in: undecided } }] })
}

const toPart = <T>(kind: PartKind, row: PartRow): Part<T> => ({ kind, key: row.key, version: row.version, changedAt: row.changedAt.getTime(),
  ordinal: row.ordinal, data: row.data as T })

/** Delivery authority only: no machine reports, starts, progress, or unrelated work. Keep the Lead conversations for
 * ledProject, and the named agents' groups for legacy project identity and native-context privacy checks. These projected
 * groups must never be committed as state; a delivery only touches its authority parts and updates its own row. */
export async function loadDeliveryParts(tx: Transaction, tabId: string, groupIds: string[], agentIds: string[], nativeAgentId?: string): Promise<SwarmParts> {
  const head = await tx.swarmHead.findUnique({ where: { id: partId(tabId, 'head') } })
  if (!head) throw Object.assign(new Error(`Swarm ${tabId} has no parts`), { code: 'PARTS_MISSING' })
  const { projects } = head.data as unknown as HeadData
  // The removed Leads conversation is no longer read (model.ts leadsRemoved).
  const keys = projects ? projects.map(p => p.leadConversationId) : ['lead']
  const [members, agents] = await Promise.all([
    tx.swarmMember.findMany({ where: { tabId, deleted: false } }),
    tx.swarmAgent.findMany({ where: { tabId, deleted: false } }),
  ])
  // Modern agents carry their project. Older agents derive it from their first loaded group. Native privacy checks
  // additionally inspect every group of the terminal's agent, which need not be the delivery's receiver.
  const related = [...agents.filter(a => agentIds.includes(a.key) && !(a.data as unknown as Agent).projectId).map(a => a.key),
    ...nativeAgentId ? [nativeAgentId] : []]
  // One read per index, like loadLight: an $or spanning key and membership indexes would invoke the query planner again.
  const [named, linked] = await Promise.all([
    groupsBy(tx, 'key', [{ $match: { tabId, deleted: false, key: { $in: [...groupIds, ...keys] },
      $or: [{ dormant: false }, { key: { $in: groupIds } }] } }, { $project: LIGHT_GROUP }]),
    related.length ? groupsBy(tx, 'agents', [{ $match: { tabId, deleted: false, dormant: false,
      agentIds: { $in: related } } }, { $project: LIGHT_GROUP }]) : Promise.resolve([]),
  ])
  const groups = [...new Map([...named, ...linked].map(row => [row.key, lightGroup(row)])).values()]
  return { tabId, head: toPart<HeadData>('head', head as unknown as PartRow),
    members: members.map(row => toPart('member', row)), agents: agents.map(row => toPart('agent', row)),
    groups, machines: [], starts: [], progress: [],
    sequenceBase: head.sequenceBase, visibilityEpoch: head.visibilityEpoch, groupCounter: head.groupCounter } as SwarmParts
}

/** A Swarm's live groups that `match` finds through `index`, light as `loadLight` keeps them: for a read that only checks who may
 *  read them (the route-decision list), where a brief or a task is bytes sent for nothing. Never committed as state. */
export async function loadLightGroups(tx: Transaction, tabId: string, index: GroupIndex, match: Record<string, unknown>): Promise<Part<GroupData>[]> {
  return (await groupsBy(tx, index, [{ $match: { tabId, deleted: false, ...match } as Prisma.InputJsonValue }, { $project: LIGHT_GROUP }])).map(lightGroup)
}

/**
 * The live parts of one Swarm with conversations light, and no progress parts: a change poll sends those from the change
 * feed (read/changes.ts), and nothing derived reads them. Conversations: every active one (`groups: 'active'`, as
 * `loadActive`), or only the Lead conversations and those with running work (`'working'`: what visibility and derived
 * values read once every finished worker's decision is stored), with the active ones of agents stored with no project (they
 * take theirs from the first one they are in: projects.ts agentProjectId); plus those named by id and those the named agents
 * are in, dormant ones too, and the active ones of the named projects. Starts: unfinished, or every live start with
 * `includeRecentStarts`.
 */
export async function loadLight(tx: Transaction, tabId: string,
  opts: { groupIds?: string[]; agentIds?: string[]; projectIds?: string[]; includeRecentStarts?: boolean; groups?: 'active' | 'working'
    /** False leaves machines out: the read cache keeps them at their own stamp (cache.ts). */
    machines?: boolean } = {}): Promise<SwarmParts> {
  const head = await tx.swarmHead.findUnique({ where: { id: partId(tabId, 'head') } })
  if (!head) throw Object.assign(new Error(`Swarm ${tabId} has no parts`), { code: 'PARTS_MISSING' })
  const live = { tabId, deleted: false }
  const starts = (await delegate(tx, 'start').findMany({ where: opts.includeRecentStarts ? live : { ...live, finishedAt: null } })).map(row => toPart<AgentStart>('start', row))
  const { projects, invitations } = head.data as unknown as HeadData
  // Besides the Lead conversations and running work, the conversations a start or an invitation names: a reader sees
  // those only alongside their conversation (model.ts visibleState).
  const working = [...projects ? projects.map(p => p.leadConversationId) : ['lead'],
    ...starts.map(s => s.data!.request.conversationId), ...invitations.map(i => i.conversationId)]
  // One read per index, never one $or over several: Mongo plans an $or again whenever its plan cache misses (parts/indexed.ts).
  const keys = [...opts.groups === 'working' ? working : [], ...opts.groupIds ?? []]
  // The Swarm's first project also holds conversations stored with no project (model.ts groupProject).
  const projectIds = [...opts.projectIds ?? [], ...opts.projectIds?.includes('lead') ? [null] : []]
  const named: Array<readonly [GroupIndex, Record<string, unknown>]> = [
    ...opts.groups === 'working' ? [['running', { executionMachineId: { $ne: null } }] as const] : [['dormancy', { dormant: false }] as const],
    ...keys.length ? [['key', { key: { $in: keys } }] as const] : [], ...opts.agentIds?.length ? [['agents', { agentIds: { $in: opts.agentIds } }] as const] : [],
    ...projectIds.length ? [['project', { projectId: { $in: projectIds }, dormant: false }] as const] : []]
  const lightGroups = async (index: GroupIndex, match: Record<string, unknown>) => (await groupsBy(tx, index, [{ $match: { tabId, deleted: false, ...match } },
    { $project: LIGHT_GROUP }])).map(lightGroup)
  const unique = (lists: Part<GroupData>[][]) => [...new Map(lists.flat().map(group => [group.key, group])).values()]
  const [members, agents, machines, groups] = await Promise.all([
    ...(['member', 'agent', 'machine'] as const).map(kind => kind === 'machine' && opts.machines === false ? Promise.resolve([])
      : delegate(tx, kind).findMany({ where: live }).then(rows => rows.map(row => toPart(kind, row)))),
    Promise.all(named.map(([index, match]) => lightGroups(index, match))).then(unique),
  ])
  if (opts.groups === 'working') {
    const workers = agents as Part<unknown>[] as Part<Agent>[]
    const legacy = workers.filter(a => !a.data!.projectId).map(a => a.key)
    const [undecided, ofLegacy] = await Promise.all([undecidedWork(workers, groups as Part<GroupData>[], lightGroups),
      legacy.length ? lightGroups('agents', { agentIds: { $in: legacy }, dormant: false }) : Promise.resolve([])])
    const held = new Set(groups.map(g => g.key))
    groups.push(...unique([undecided, ofLegacy]).filter(g => !held.has(g.key)))
  }
  return { tabId, head: toPart<HeadData>('head', head as unknown as PartRow), members, agents, groups, machines, starts, progress: [],
    sequenceBase: head.sequenceBase, visibilityEpoch: head.visibilityEpoch, groupCounter: head.groupCounter } as SwarmParts
}
