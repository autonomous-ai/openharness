import type { Prisma } from '@prisma/client'
import { delegate, extracted, partId, type PartRow } from './write.js'
import type { GroupData, HeadData, MachineData, Part, PartKind, SwarmParts } from './types.js'
import { PART_KINDS } from './types.js'
import { noteChange } from '../cache.js'
import { stableId, type AgentStart } from '../model.js'
import { ms } from './light.js'
import { groupsBy, readBy, type GroupIndex, type NamedCollection } from './indexed.js'

type Transaction = Prisma.TransactionClient
type Where = Record<string, unknown>
/** Live groups as one read per index (parts/indexed.ts): Prisma's filters, and one $or over several indexes, are planned. */
type GroupReads = Array<readonly [GroupIndex, Where]>

const toPart = <T>(kind: PartKind, row: PartRow): Part<T> => ({ kind, key: row.key, version: row.version, changedAt: row.changedAt.getTime(),
  ordinal: row.ordinal, data: row.data as T, ...(row.deleted ? { deleted: true as const } : {}), ...(row.dormant ? { dormant: true as const } : {}) })

/** A group part as `aggregateRaw` returns it, as the PartRow Prisma would. */
const rawGroupRow = (row: Record<string, unknown>): PartRow => ({ ...row, changedAt: new Date(ms(row.changedAt)) }) as unknown as PartRow
/** Any part as `aggregateRaw` returns it: a Float ordinal can come wrapped, and a part stored before `deleted` lacks it. */
const rawPartRow = (row: Record<string, unknown>): PartRow => ({ ...rawGroupRow(row), version: Number(row.version), deleted: !!row.deleted,
  ordinal: typeof row.ordinal === 'number' ? row.ordinal : Number((row.ordinal as { $numberDouble?: string; $numberInt?: string }).$numberDouble
    ?? (row.ordinal as { $numberInt?: string }).$numberInt) }) as PartRow

/** The live groups these reads find, each once. */
async function liveGroups(tx: Transaction, tabId: string, reads: GroupReads): Promise<PartRow[]> {
  const found = await Promise.all(reads.map(([index, match]) => groupsBy(tx, index, [{ $match: { tabId, deleted: false, ...match } as Prisma.InputJsonValue }])))
  return [...new Map(found.flat().map(row => [row.key as string, rawGroupRow(row)])).values()]
}

/** `null` for a kind leaves it out: none are loaded. Groups go by `where` (every part, tombstones too) or as named reads. */
async function assemble(tx: Transaction, tabId: string, where: Record<Exclude<PartKind, 'head' | 'group'>, Where | null> & { group: Where | GroupReads }): Promise<SwarmParts> {
  const head = await tx.swarmHead.findUnique({ where: { id: partId(tabId, 'head') } })
  if (!head) throw Object.assign(new Error(`Swarm ${tabId} has no parts`), { code: 'PARTS_MISSING' })
  const group = where.group
  const [members, agents, groups, machines, starts, progress] = await Promise.all((['member', 'agent', 'group', 'machine', 'start', 'progress'] as const)
    .map(kind => kind === 'group' && Array.isArray(group) ? liveGroups(tx, tabId, group).then(rows => rows.map(row => toPart(kind, row)))
      : where[kind] === null ? Promise.resolve([])
      : delegate(tx, kind).findMany({ where: { tabId, ...where[kind] as Where } }).then(rows => rows.map(row => toPart(kind, row)))))
  return { tabId, head: toPart<HeadData>('head', head as unknown as PartRow), members, agents, groups, machines, starts, progress,
    sequenceBase: head.sequenceBase, visibilityEpoch: head.visibilityEpoch, groupCounter: head.groupCounter } as SwarmParts
}

/**
 * The parts a command or read works on (design section 3.1): every live part except dormant groups and finished starts,
 * plus the groups named by id, the groups the named agents are in and the named projects' groups (dormant ones too),
 * and the finished starts named by id or by the agent they started.
 */
export function loadActive(tx: Transaction, tabId: string,
  opts: { groupIds?: string[]; agentIds?: string[]; projectIds?: string[]; startIds?: string[]; startAgentIds?: string[]
    /** Also the finished starts not yet expired (finished within 7 days), as a first load shows them (design section 4.3). */
    includeRecentStarts?: boolean
    /** Every live group, dormant ones too: for the rare reads that list across all of them (mentions, route decisions). */
    allGroups?: boolean } = {}): Promise<SwarmParts> {
  const live = { deleted: false }
  const or = (always: Where, ...named: Array<Where | false>) => ({ ...live, OR: [always, ...named.filter((w): w is Where => !!w)] })
  // A group stored with no project belongs to the default one (projects.ts groupProject), as in a Swarm from before projects;
  // a null match is a missing field too.
  const projectIds = [...opts.projectIds ?? [], ...opts.projectIds?.includes('lead') ? [null] : []]
  return assemble(tx, tabId, {
    member: live, agent: live, machine: live, progress: live,
    group: opts.allGroups ? [['live', {}]] : [['dormancy', { dormant: false }], ...opts.groupIds?.length ? [['key', { key: { $in: opts.groupIds } }] as const] : [],
      ...opts.agentIds?.length ? [['agents', { agentIds: { $in: opts.agentIds } }] as const] : [],
      ...projectIds.length ? [['project', { projectId: { $in: projectIds } }] as const] : []],
    start: opts.includeRecentStarts ? live : or({ finishedAt: null }, !!opts.startIds?.length && { key: { in: opts.startIds } },
      !!opts.startAgentIds?.length && { agentId: { in: opts.startAgentIds } }),
  })
}

/**
 * What a machine's report works on (store.ts observeMachine, #876): `loadActive`'s parts with only the conversations its
 * checks read, whole, since it may write them: running work, the Lead conversations, the unfinished starts' conversations,
 * the conversations of agents stored with no project (projects.ts agentProjectId), and the private chats of this machine's
 * working agents (leaderboard/lent.ts accrueLent). A busy Swarm's finished conversations, briefs and checks were ~1.1 MB
 * read every 15 s per machine; the commit compares only what was loaded, so the others stay as they are. No project's report
 * progress either: only commands and native events note reports (projectUpdates.ts), so none is loaded or committed.
 */
export async function loadObserved(tx: Transaction, tabId: string, machineId: string): Promise<SwarmParts> {
  const live = { deleted: false }
  const loaded = await assemble(tx, tabId, { member: live, agent: live, machine: live, progress: null, start: { ...live, finishedAt: null }, group: [] })
  const { projects, leadsConversationId } = loaded.head.data!
  // A head that never stored the Leads conversation's id finds it where model.ts syncLeads would make it.
  const leads = [...projects ? projects.map(p => p.leadConversationId) : ['lead'], leadsConversationId ?? stableId(tabId, 'leads')]
  // One read per index (parts/indexed.ts); none of them reads a quiet conversation.
  const groups = await liveGroups(tx, tabId, [['running', { executionMachineId: { $ne: null }, dormant: false }],
    ['key', { key: { $in: [...new Set([...leads, ...loaded.starts.map(s => s.data!.request.conversationId)])] }, dormant: false }]])
  const working = new Set(groups.flatMap(row => (row.data as GroupData).assignment?.status === 'working' ? [(row.data as GroupData).assignment!.agentId] : []))
  const legacy = loaded.agents.filter(a => !a.data!.projectId).map(a => a.key)
  const lending = loaded.agents.filter(a => a.data!.machineId === machineId && working.has(a.key)).map(a => a.key)
  const more = await liveGroups(tx, tabId, [...legacy.length ? [['agents', { agentIds: { $in: legacy }, dormant: false }] as const] : [],
    ...lending.length ? [['agents', { agentIds: { $in: lending }, dormant: false, 'data.audience': { $ne: null } }] as const] : []])
  const rows = [...new Map([...groups, ...more].map(row => [row.key, row])).values()]
  return { ...loaded, groups: rows.map(row => toPart<GroupData>('group', row)) }
}

/** What the read cache keeps of a Swarm at its main stamp (cache.ts): `loadActive`'s parts with every live start, and no
 *  machines, which it keeps at their own stamp (`loadMachines`). Dormant groups and their like come by name (`loadGroups`). */
export function loadReadBase(tx: Transaction, tabId: string): Promise<SwarmParts> {
  const live = { deleted: false }
  return assemble(tx, tabId, { member: live, agent: live, group: [['dormancy', { dormant: false }]], machine: null, start: live, progress: live })
}

/** A Swarm's live machine parts. */
export async function loadMachines(tx: Transaction, tabId: string): Promise<Part<MachineData>[]> {
  return (await delegate(tx, 'machine').findMany({ where: { tabId, deleted: false } })).map(row => toPart<MachineData>('machine', row))
}

/** A Swarm's live groups that `match` finds through `index`. */
export async function loadGroups(tx: Transaction, tabId: string, index: GroupIndex, match: Where): Promise<Part<GroupData>[]> {
  return (await liveGroups(tx, tabId, [[index, match]])).map(row => toPart<GroupData>('group', row))
}

/** Every part of one Swarm, tombstones included with their last data (migration verification and rollback). */
export function loadAll(tx: Transaction, tabId: string): Promise<SwarmParts> {
  return assemble(tx, tabId, { member: {}, agent: {}, group: {}, machine: {}, start: {}, progress: {} })
}

/** Inserts a Swarm's parts as they are (the migration, a new Swarm). An existing part fails with P2002. */
export async function insertParts(tx: Transaction, parts: SwarmParts): Promise<void> {
  const { tabId } = parts
  noteChange(tx, tabId, 'main')
  const rows = (kind: PartKind, list: Part[]) => list.map(part => ({ id: partId(tabId, part.key), tabId, key: part.key, version: part.version,
    changedAt: new Date(part.changedAt), deleted: !!part.deleted, ordinal: part.ordinal, data: part.data as Prisma.InputJsonValue,
    ...extracted(kind, part.data, part.changedAt),
    ...(kind === 'head' ? { groupCounter: parts.groupCounter, visibilityEpoch: parts.visibilityEpoch, sequenceBase: parts.sequenceBase } : {}) }))
  for (const [kind, list] of [['head', [parts.head]], ['member', parts.members], ['agent', parts.agents], ['group', parts.groups],
    ['machine', parts.machines], ['start', parts.starts], ['progress', parts.progress]] as Array<[PartKind, Part[]]>) {
    if (list.length) await delegate(tx, kind).createMany({ data: rows(kind, list) })
  }
}

/** Parts of these Swarms whose data changed after `since`, by tab, each kind in turn, machines also by their own reading
 *  (`readAt`). Tombstones and dormant groups come with their last data and `deleted`/`dormant` set, so the reader can
 *  check who may see them before sending anything. */
export async function loadChanged(tx: Transaction, tabIds: string[], since: Date, kinds: readonly PartKind[] = PART_KINDS): Promise<Map<string, Part[]>> {
  const changed = new Map<string, Part[]>(tabIds.map(id => [id, []]))
  if (!tabIds.length) return changed
  // Plain matches that name each kind's (tabId, changedAt) index (parts/indexed.ts). Prisma sent `tabId: { in }` as an $expr
  // $or, one planned scan per Swarm, and could pick an index that is not bounded by time at all (roadmap Phase 3.5).
  const after = { $gt: { $date: since.toISOString() } }
  const read = (kind: PartKind) => readBy(tx, COLLECTION[kind], 'changes', [{ $match: { tabId: { $in: tabIds }, changedAt: after } }, { $project: CHANGED_FIELDS }])
  for (const kind of kinds) {
    // A machine read since the cursor counts as changed too: two bounded reads, not one $or the planner cannot bound.
    const rows = kind === 'machine' ? [...new Map([...await read(kind), ...await readBy(tx, 'SwarmMachine', 'read',
      [{ $match: { tabId: { $in: tabIds }, readAt: after } }, { $project: CHANGED_FIELDS }])].map(row => [row._id as string, row])).values()] : await read(kind)
    for (const row of rows) {
      const readAt = row.readAt == null ? null : ms(row.readAt)
      changed.get(row.tabId as string)!.push({ ...toPart(kind, rawPartRow(row)), ...readAt ? { readAt } : {} })
    }
  }
  return changed
}

/** The live starts of these agents (an agent is its machine and harness: write.ts extracted), whole, by the (tabId, agentId)
 *  index: a change poll reads the finished starts whose harness a machine record still lists, and no other (read/service.ts).
 *  A plain match: through Prisma, `agentId: { in }` was $expr, which no index bounds. */
export async function loadStartsOfAgents(tx: Transaction, tabId: string, agentIds: string[]): Promise<Part<AgentStart>[]> {
  if (!agentIds.length) return []
  const rows = await tx.swarmStart.aggregateRaw({ pipeline: [{ $match: { tabId, agentId: { $in: agentIds }, deleted: false } }] }) as unknown as
    Array<Record<string, unknown>>
  return rows.map(row => toPart<AgentStart>('start', rawPartRow(row)))
}

const COLLECTION = { head: 'SwarmHead', member: 'SwarmMember', agent: 'SwarmAgent', group: 'SwarmGroup', machine: 'SwarmMachine', start: 'SwarmStart',
  progress: 'SwarmProgress' } as const satisfies Record<PartKind, NamedCollection>
/** What a changed part is made of: its other fields are indexed copies of its data. */
const CHANGED_FIELDS = { tabId: 1, key: 1, version: 1, changedAt: 1, deleted: 1, ordinal: 1, data: 1, dormant: 1, readAt: 1 }

export const DORMANT_PAGE = 50

/** Dormant groups the caller pages through, newest activity first, 50 at a time. A project's go through its index in that
 *  order. A later page is two reads that index bounds: the rest of its cursor's moment by key, then what is older. The
 *  cursor as one `$or` is no bound, and each page read every newer group again (#1964). */
export async function loadDormant(tx: Transaction, tabId: string,
  page: { projectId?: string; before?: { lastActivityAt: number; key: string } }): Promise<Part<GroupData>[]> {
  const index = page.projectId ? 'project' : 'dormancy'
  const read = async (match: Where, limit: number) => limit <= 0 ? [] : groupsBy(tx, index, [
    { $match: { tabId, deleted: false, dormant: true, ...page.projectId ? { projectId: page.projectId } : {}, ...match } as Prisma.InputJsonValue },
    { $sort: { lastActivityAt: -1, key: -1 } }, { $limit: limit }])
  const at = page.before && { $date: new Date(page.before.lastActivityAt).toISOString() }
  const same = page.before ? await read({ lastActivityAt: at, key: { $lt: page.before.key } }, DORMANT_PAGE) : []
  const older = await read(at ? { lastActivityAt: { $lt: at } } : {}, DORMANT_PAGE - same.length)
  return [...same, ...older].map(row => toPart<GroupData>('group', rawGroupRow(row)))
}

/** The newest data change of each Swarm, over all its parts (design section 3.7). A touch does not count.
 *  One `$group` with `$max` per part kind, run by Mongo itself: Prisma's groupBy here can panic its engine on Mongo, which
 *  then fails every later query of the process (as groupBy on SuperTabDecision did, 2026-10-27). */
export async function lastChangedAt(tx: Transaction, tabIds: string[]): Promise<Map<string, number>> {
  const newest = new Map<string, number>()
  if (!tabIds.length) return newest
  for (const kind of PART_KINDS) {
    const rows = await delegate(tx, kind).aggregateRaw({ pipeline: [{ $match: { tabId: { $in: tabIds } } },
      { $group: { _id: '$tabId', at: { $max: '$changedAt' } } }] }) as Array<{ _id: string; at: unknown }>
    for (const row of rows) {
      const at = row.at ? ms(row.at) : 0
      if (at > (newest.get(row._id) ?? 0)) newest.set(row._id, at)
    }
  }
  return newest
}
