import type { Prisma } from '@prisma/client'
import { delegate, extracted, partId, type PartRow } from './write.js'
import type { GroupData, HeadData, MachineData, Part, PartKind, SwarmParts } from './types.js'
import { PART_KINDS } from './types.js'
import { noteChange } from '../cache.js'

type Transaction = Prisma.TransactionClient
type Where = Record<string, unknown>

const toPart = <T>(kind: PartKind, row: PartRow): Part<T> => ({ kind, key: row.key, version: row.version, changedAt: row.changedAt.getTime(),
  ordinal: row.ordinal, data: row.data as T, ...(row.deleted ? { deleted: true as const } : {}), ...(row.dormant ? { dormant: true as const } : {}) })

/** `null` for a kind leaves it out: none are loaded. */
async function assemble(tx: Transaction, tabId: string, where: Record<Exclude<PartKind, 'head'>, Where | null>): Promise<SwarmParts> {
  const head = await tx.swarmHead.findUnique({ where: { id: partId(tabId, 'head') } })
  if (!head) throw Object.assign(new Error(`Swarm ${tabId} has no parts`), { code: 'PARTS_MISSING' })
  const [members, agents, groups, machines, starts, progress] = await Promise.all((['member', 'agent', 'group', 'machine', 'start', 'progress'] as const)
    .map(kind => where[kind] === null ? Promise.resolve([]) : delegate(tx, kind).findMany({ where: { tabId, ...where[kind] } }).then(rows => rows.map(row => toPart(kind, row)))))
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
  return assemble(tx, tabId, {
    member: live, agent: live, machine: live, progress: live,
    group: opts.allGroups ? live : or({ dormant: false }, !!opts.groupIds?.length && { key: { in: opts.groupIds } },
      !!opts.agentIds?.length && { agentIds: { hasSome: opts.agentIds } }, !!opts.projectIds?.length && { projectId: { in: opts.projectIds } },
      // A group stored with no project belongs to the default one (projects.ts groupProject), as in a Swarm from before projects.
      !!opts.projectIds?.includes('lead') && { projectId: null }, !!opts.projectIds?.includes('lead') && { projectId: { isSet: false } }),
    start: opts.includeRecentStarts ? live : or({ finishedAt: null }, !!opts.startIds?.length && { key: { in: opts.startIds } },
      !!opts.startAgentIds?.length && { agentId: { in: opts.startAgentIds } }),
  })
}

/** What the read cache keeps of a Swarm at its main stamp (cache.ts): `loadActive`'s parts with every live start, and no
 *  machines, which it keeps at their own stamp (`loadMachines`). Dormant groups and their like come by name (`loadGroups`). */
export function loadReadBase(tx: Transaction, tabId: string): Promise<SwarmParts> {
  const live = { deleted: false }
  return assemble(tx, tabId, { member: live, agent: live, group: { ...live, dormant: false }, machine: null, start: live, progress: live })
}

/** A Swarm's live machine parts. */
export async function loadMachines(tx: Transaction, tabId: string): Promise<Part<MachineData>[]> {
  return (await delegate(tx, 'machine').findMany({ where: { tabId, deleted: false } })).map(row => toPart<MachineData>('machine', row))
}

/** A Swarm's live groups that match `where` (by key, or the dormant ones). */
export async function loadGroups(tx: Transaction, tabId: string, where: Where): Promise<Part<GroupData>[]> {
  return (await delegate(tx, 'group').findMany({ where: { tabId, deleted: false, ...where } })).map(row => toPart<GroupData>('group', row))
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

/** Parts of these Swarms whose data changed after `since`, by tab, each kind in turn. Tombstones and dormant groups come
 *  with their last data and `deleted`/`dormant` set, so the reader can check who may see them before sending anything. */
export async function loadChanged(tx: Transaction, tabIds: string[], since: Date, kinds: readonly PartKind[] = PART_KINDS): Promise<Map<string, Part[]>> {
  const changed = new Map<string, Part[]>(tabIds.map(id => [id, []]))
  if (!tabIds.length) return changed
  for (const kind of kinds) {
    for (const row of await delegate(tx, kind).findMany({ where: { tabId: { in: tabIds }, changedAt: { gt: since } } })) {
      changed.get(row.tabId)!.push(toPart(kind, row))
    }
  }
  return changed
}

/** Dormant groups the caller pages through, newest activity first, 50 at a time. */
export async function loadDormant(tx: Transaction, tabId: string,
  page: { projectId?: string; before?: { lastActivityAt: number; key: string } }): Promise<Part<GroupData>[]> {
  const before = page.before && { OR: [{ lastActivityAt: { lt: new Date(page.before.lastActivityAt) } },
    { lastActivityAt: new Date(page.before.lastActivityAt), key: { lt: page.before.key } }] }
  const rows = await tx.swarmGroup.findMany({ where: { tabId, deleted: false, dormant: true, ...(page.projectId ? { projectId: page.projectId } : {}),
    ...before }, orderBy: [{ lastActivityAt: 'desc' }, { key: 'desc' }], take: 50 })
  return rows.map(row => toPart<GroupData>('group', row as unknown as PartRow))
}

/** The newest data change of each Swarm, over all its parts (design section 3.7). A touch does not count. */
export async function lastChangedAt(tx: Transaction, tabIds: string[]): Promise<Map<string, number>> {
  const newest = new Map<string, number>()
  if (!tabIds.length) return newest
  for (const kind of PART_KINDS) {
    for (const row of await delegate(tx, kind).groupBy({ by: ['tabId'], where: { tabId: { in: tabIds } }, _max: { changedAt: true } })) {
      const at = row._max.changedAt?.getTime() ?? 0
      if (at > (newest.get(row.tabId) ?? 0)) newest.set(row.tabId, at)
    }
  }
  return newest
}
