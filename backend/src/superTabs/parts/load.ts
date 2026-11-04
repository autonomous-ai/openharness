import type { Prisma } from '@prisma/client'
import { delegate, extracted, partId, type HeadColumns, type PartRow } from './write.js'
import type { GroupData, HeadData, MachineData, Part, PartKind, SwarmParts } from './types.js'
import { PART_KINDS } from './types.js'
import { noteChange } from '../cache.js'
import type { AgentStart } from '../model.js'
import { ms } from './light.js'
import { groupsBy, readBy, type GroupIndex, type NamedCollection } from './indexed.js'
import { HELD, type HeldParts } from './held.js'

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
 * Machine parts and conversations come through `held` (parts/held.ts): whole only those changed since this process last
 * read them (B3, #2597).
 */
export async function loadObserved(tx: Transaction, tabId: string, machineId: string, held: HeldParts = HELD): Promise<SwarmParts> {
  const live = { deleted: false }
  const read = held.read(tabId)
  const [loaded, machineRows] = await Promise.all([
    assemble(tx, tabId, { member: live, agent: live, machine: null, progress: null, start: { ...live, finishedAt: null }, group: [] }),
    read.machines(tx)])
  const machines = machineRows.map(row => toPart<MachineData>('machine', row))
  const { projects } = loaded.head.data!
  // The Lead conversations; the removed Leads conversation is no longer read (model.ts leadsRemoved).
  const leads = projects ? projects.map(p => p.leadConversationId) : ['lead']
  // One read per index (parts/indexed.ts); none of them reads a quiet conversation.
  const groups = (await read.groups(tx, [['running', { executionMachineId: { $ne: null }, dormant: false }],
    ['key', { key: { $in: [...new Set([...leads, ...loaded.starts.map(s => s.data!.request.conversationId)])] }, dormant: false }]])).map(rawGroupRow)
  const working = new Set(groups.flatMap(row => (row.data as GroupData).assignment?.status === 'working' ? [(row.data as GroupData).assignment!.agentId] : []))
  const legacy = loaded.agents.filter(a => !a.data!.projectId).map(a => a.key)
  const lending = loaded.agents.filter(a => a.data!.machineId === machineId && working.has(a.key)).map(a => a.key)
  const more = legacy.length || lending.length ? (await read.groups(tx, [...legacy.length ? [['agents', { agentIds: { $in: legacy }, dormant: false }] as const] : [],
    ...lending.length ? [['agents', { agentIds: { $in: lending }, dormant: false, 'data.audience': { $ne: null } }] as const] : []])).map(rawGroupRow) : []
  read.done()
  const rows = [...new Map([...groups, ...more].map(row => [row.key, row])).values()]
  return { ...loaded, machines, groups: rows.map(row => toPart<GroupData>('group', row)) }
}

/** Machine parts by id (`${tabId}:${machineId}`), with their version, in one read by `_id`: what a reading-only report reads
 *  (DB 2.5, superTabs/machineReports.ts). Raw, so many ids are one plain `$in`. */
export async function loadMachineParts(tx: Transaction, ids: string[]): Promise<Map<string, { version: number; deleted: boolean; data: MachineData }>> {
  if (!ids.length) return new Map()
  const rows = await tx.swarmMachine.aggregateRaw({ pipeline: [{ $match: { _id: { $in: ids } } }, { $project: { version: 1, deleted: 1, data: 1 } }] }) as
    unknown as Array<{ _id: string; version: number; deleted: boolean; data: MachineData }>
  return new Map(rows.map(row => [row._id, { version: Number(row.version), deleted: !!row.deleted, data: row.data }]))
}

/** What the read cache keeps of a Swarm at its main stamp (cache.ts): `loadActive`'s parts with every live start, and no
 *  machines, which it keeps at their own stamp (`loadMachines`). Dormant groups and their like come by name (`loadGroups`). */
export function loadReadBase(tx: Transaction, tabId: string): Promise<SwarmParts> {
  const live = { deleted: false }
  // Unfinished starts only: finished ones were 59% of prod's busiest base (1,118 of 1,120, 2026-11-02) and most reads drop
  // them; the reads that name them read `loadFinishedStarts` (cachedReads.ts readParts).
  return assemble(tx, tabId, { member: live, agent: live, group: [['dormancy', { dormant: false }]], machine: null,
    start: { ...live, finishedAt: null }, progress: live })
}

/** A Swarm's live finished starts (they expire 7 days after finishing, sweeps.ts). A plain match: Prisma's `not: null` on
 *  Mongo is an $expr no index bounds. */
export async function loadFinishedStarts(tx: Transaction, tabId: string): Promise<Part<AgentStart>[]> {
  const rows = await tx.swarmStart.aggregateRaw({ pipeline: [{ $match: { tabId, deleted: false, finishedAt: { $ne: null } } }] }) as unknown as
    Array<Record<string, unknown>>
  return rows.map(row => toPart<AgentStart>('start', rawPartRow(row)))
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
  for (const [kind, rows] of await changedRows(tx, tabIds, since, kinds)) {
    for (const row of rows) changed.get(row.tabId as string)!.push(changedPart(kind, row))
  }
  return changed
}

/** Each kind's rows changed after `since`, read in parallel: a refresh of the read cache waits for one round trip, not seven. */
async function changedRows(tx: Transaction, tabIds: string[], since: Date, kinds: readonly PartKind[], fields: Record<string, number> = CHANGED_FIELDS):
  Promise<Array<[PartKind, Array<Record<string, unknown>>]>> {
  // Plain matches that name each kind's (tabId, changedAt) index (parts/indexed.ts). Prisma sent `tabId: { in }` as an $expr
  // $or, one planned scan per Swarm, and could pick an index that is not bounded by time at all (roadmap Phase 3.5).
  const after = { $gt: { $date: since.toISOString() } }
  const read = (kind: PartKind) => readBy(tx, COLLECTION[kind], 'changes', [{ $match: { tabId: { $in: tabIds }, changedAt: after } }, { $project: fields }])
  return Promise.all(kinds.map(async kind => {
    if (kind !== 'machine') return [kind, await read(kind)] as [PartKind, Array<Record<string, unknown>>]
    // A machine read since the cursor counts as changed too: two bounded reads, not one $or the planner cannot bound.
    const [changes, readings] = await Promise.all([read(kind), readBy(tx, 'SwarmMachine', 'read',
      [{ $match: { tabId: { $in: tabIds }, readAt: after } }, { $project: fields }])])
    return [kind, [...new Map([...changes, ...readings].map(row => [row._id as string, row])).values()]] as [PartKind, Array<Record<string, unknown>>]
  }))
}

const changedPart = (kind: PartKind, row: Record<string, unknown>): Part => {
  const readAt = row.readAt == null ? null : ms(row.readAt), contentAt = row.contentAt == null ? null : ms(row.contentAt)
  return { ...toPart(kind, rawPartRow(row)), ...readAt ? { readAt } : {}, ...contentAt ? { contentAt } : {} }
}

/** What changed in one Swarm after `since`, for the read cache to patch what it holds (cache.ts; spec 2026-11-02 Phase 1):
 *  the parts of `kinds`, and the head's own columns when the head is among them. */
export interface SwarmDelta {
  parts: Part[]
  head: HeadColumns | null
  /** Each changed group's stored host digest (null while it has none), by key: the host signature's entry patches from it
   *  (read/hostInputs.ts). A loader that does not carry it leaves it out, and that entry loads again. */
  hostDigests?: ReadonlyMap<string, string | null>
}

/** Each kind's rows of one Swarm that its last delta read whole, by row id (#2783). */
export type DeltaRows = Map<PartKind, Map<string, Record<string, unknown>>>
/** What a delta reads of each changed row first: enough to tell the row it read whole before from a newer one. Every write of
 *  what a delta reads moves the version (parts/write.ts), and a reading moves `readAt`. */
const STAMP_FIELDS = { key: 1, version: 1, changedAt: 1, readAt: 1, contentAt: 1, deleted: 1 } as const
const rowStamp = (row: Record<string, unknown>) => JSON.stringify([Number(row.version), row.changedAt ?? null, row.readAt ?? null, row.contentAt ?? null, !!row.deleted])

/**
 * The parts of `kinds` changed after `since`. With `held`, the Swarm's rows its last delta read: each changed row is read
 * as its key and version first, and whole only when `held` lacks it at that version, so a delta reads whole only what
 * moved since the one before, not every part of its window again (#2783: a 30 s overlap re-read each conversation that
 * changed in it on every bump). `held` then holds this delta's rows of each kind it read.
 */
export async function loadDelta(tx: Transaction, tabId: string, since: number, kinds: readonly PartKind[], held?: DeltaRows): Promise<SwarmDelta> {
  const parts: Part[] = [], hostDigests = new Map<string, string | null>()
  let head: HeadColumns | null = null
  for (const [kind, rows] of held ? await heldRows(tx, tabId, since, kinds, held) : await changedRows(tx, [tabId], new Date(since), kinds)) {
    for (const row of rows) {
      parts.push(changedPart(kind, row))
      if (kind === 'group') hostDigests.set(row.key as string, typeof row.hostDigest === 'string' ? row.hostDigest : null)
      if (kind === 'head') head = { groupCounter: Number(row.groupCounter), visibilityEpoch: Number(row.visibilityEpoch), sequenceBase: Number(row.sequenceBase) }
    }
  }
  return { parts, head, hostDigests }
}

/** Each kind's changed rows whole: those `held` has at the same version from it, the rest read by id in one read per kind. */
async function heldRows(tx: Transaction, tabId: string, since: number, kinds: readonly PartKind[], held: DeltaRows):
  Promise<Array<[PartKind, Array<Record<string, unknown>>]>> {
  return Promise.all((await changedRows(tx, [tabId], new Date(since), kinds, STAMP_FIELDS)).map(async ([kind, stamps]) => {
    const known = held.get(kind)
    const same = (row: Record<string, unknown>) => { const kept = known?.get(row._id as string); return kept && rowStamp(kept) === rowStamp(row) ? kept : null }
    const missing = stamps.filter(row => !same(row)).map(row => row._id as string)
    const read = new Map((missing.length ? await readBy(tx, COLLECTION[kind], 'id', [{ $match: { _id: { $in: missing }, tabId } }, { $project: CHANGED_FIELDS }]) : [])
      .map(row => [row._id as string, row]))
    const rows = stamps.flatMap(row => { const whole = same(row) ?? read.get(row._id as string); return whole ? [whole] : [] })
    held.set(kind, new Map(rows.map(row => [row._id as string, row])))
    return [kind, rows] as [PartKind, Array<Record<string, unknown>>]
  }))
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
const CHANGED_FIELDS = { tabId: 1, key: 1, version: 1, changedAt: 1, deleted: 1, ordinal: 1, data: 1, dormant: 1, readAt: 1, contentAt: 1,
  // A group's stored host digest (no other kind has one): the host signature's entry patches from it.
  hostDigest: 1,
  // The head's own columns (no other kind has them): a patched base keeps them too.
  groupCounter: 1, visibilityEpoch: 1, sequenceBase: 1 }

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
    // Sorted as the (tabId, changedAt) index is, read backwards, the newest per Swarm is one key (DISTINCT_SCAN): a $max read every key of
    // the Swarm's parts (prod's largest: 1,300 groups, 873 starts, 721 agents, 2026-10-30), on every list.
    const rows = await delegate(tx, kind).aggregateRaw({ pipeline: [{ $match: { tabId: { $in: tabIds } } },
      { $sort: { tabId: -1, changedAt: -1 } }, { $group: { _id: '$tabId', at: { $first: '$changedAt' } } }] }) as Array<{ _id: string; at: unknown }>
    for (const row of rows) {
      const at = row.at ? ms(row.at) : 0
      if (at > (newest.get(row._id) ?? 0)) newest.set(row._id, at)
    }
  }
  return newest
}
