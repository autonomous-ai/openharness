/**
 * Reads of a Swarm's parts through the per-process cache (cache.ts, Stability Roadmap 2.2): each read gives what the
 * loader it replaces gives (parts/load.ts loadActive, parts/light.ts loadLight, loadChanged, lastChangedAt), built from
 * what the cache holds at the read's stamps. Without stamps (Redis down, the cache off) each piece is read from Mongo.
 * Everything here is the stored state, the same for every reader: permissions are applied after (read/views.ts).
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { stableId, type AgentStart } from './model.js'
import { CacheView } from './cache.js'
import { accessRule, baseRule, dormantAgentRule, dormantProjectRule, dormantRule, FEED_MAIN_KINDS, feedRule, finishedStartsRule, groupRule, lightDormantAgentRule, machineFeedRule,
  machinesRule } from './cachePatch.js'
import * as store from './parts/index.js'
import type { GroupData, Part, PartKind, SwarmParts, SwarmDelta } from './parts/index.js'
import { retryTransient } from './retry.js'
import { lightKeys, lightSelect, projectLightGroup, type LightOptions as SelectOptions } from './parts/lightSelect.js'
import { retryStaleIndex } from './parts/indexed.js'

type Db = Pick<PrismaClient, '$transaction'> & Prisma.TransactionClient
type LightOptions = NonNullable<Parameters<typeof store.loadLight>[2]>

/** What a read names beyond a Swarm's active parts, as loadActive takes it. */
export interface ReadNamed { groupIds?: string[]; agentIds?: string[]; projectIds?: string[]; startIds?: string[]; startAgentIds?: string[]
  allGroups?: boolean; includeRecentStarts?: boolean }

/** A view with no stamps: every read goes to Mongo, nothing is kept. */
export const DIRECT = new CacheView(null, null)

/** A miss loads the feed from this long before its reader's cursor, so readers polling a few seconds apart share it. */
const FEED_SLACK_MS = 15_000
/** ... and from at least this long before the read, so a phone (5 s), a background window (15 s) or a CLI reading a minute
 *  or two after the poller that loaded it reads the held feed too, not every changed part itself (#2783). */
export const FEED_REACH_MS = 120_000

/** A Swarm's live machine parts, held at both stamps: a machine's reading moves only the machine stamp. */
export const readMachines = (db: Prisma.TransactionClient, view: CacheView, tabId: string) =>
  view.get(tabId, 'machines', 'all', () => store.loadMachines(db, tabId), machinesRule)

/** The active parts, then the machines: one read of the base in a transaction, so its parts are one snapshot. A transaction
 *  that meets a lock it cannot get in 5 ms (an index build, a release) is tried again as a write's would be (retry.ts). */
const base = (db: Db, view: CacheView, tabId: string) => Promise.all([
  view.get(tabId, 'parts', 'main', () => retryTransient(() => retryStaleIndex(() => db.$transaction(tx => store.loadReadBase(tx, tabId)))), baseRule),
  readMachines(db, view, tabId),
])

/** The head, members and agents of a Swarm (parts/load.ts loadAccess), held at its main stamp and patched from those kinds
 *  alone (cachePatch.ts accessRule): what a one-group read checks its reader against (read/service.ts oneGroup, task #2875). */
export const readAccess = (db: Db, view: CacheView, tabId: string): Promise<SwarmParts> =>
  view.get(tabId, 'access', 'main', () => retryTransient(() => retryStaleIndex(() => db.$transaction(tx => store.loadAccess(tx, tabId)))), accessRule)

/** The parts loadActive gives for `named`, as one Swarm read (design section 3.1). */
export async function readParts(db: Db, view: CacheView, tabId: string, named: ReadNamed = {}): Promise<SwarmParts> {
  const [active, machines] = await base(db, view, tabId)
  const held = new Set(active.groups.map(g => g.key))
  const extra: Part<GroupData>[] = []
  const add = (groups: Part<GroupData>[]) => { for (const g of groups) if (!held.has(g.key)) { held.add(g.key); extra.push(g) } }
  if (named.allGroups) add(await view.get(tabId, 'dormant', 'main', () => store.loadGroups(db, tabId, 'dormancy', { dormant: true }), dormantRule))
  else {
    // Each named agent's and project's dormant groups by their own index, not every dormant group filtered: 1,544 of them
    // (8.9 MB) on prod's busiest Swarm, where one worker's are ~126 (2026-11-02).
    const selections = await Promise.all([
      ...[...new Set(named.agentIds ?? [])].map(id => view.get(tabId, `dormant:agent:${id}`, 'main',
        () => store.loadGroups(db, tabId, 'agents', { agentIds: { $in: [id] }, dormant: true }), dormantAgentRule(id))),
      // A group stored with no project belongs to the default one (projects.ts groupProject); a null match is a missing field too.
      ...[...new Set(named.projectIds ?? [])].map(id => view.get(tabId, `dormant:project:${id}`, 'main',
        () => store.loadGroups(db, tabId, 'project', { projectId: { $in: id === 'lead' ? ['lead', null] : [id] }, dormant: true }), dormantProjectRule(id))),
    ])
    for (const groups of selections) add(groups)
  }
  for (const id of named.groupIds ?? []) {
    if (!held.has(id)) add(await view.get(tabId, `group:${id}`, 'main', () => store.loadGroups(db, tabId, 'key', { key: id }), groupRule(id)))
  }
  const finished = needsFinished(active.starts, named)
    ? await view.get(tabId, 'finished-starts', 'main', () => store.loadFinishedStarts(db, tabId), finishedStartsRule) : []
  return { ...active, machines, groups: extra.length ? [...active.groups, ...extra] : active.groups, starts: namedStarts(active.starts, finished, named) }
}

/** Whether a read needs the finished starts: a first load shows them all, and a read may name one by id or by its agent. */
const needsFinished = (hot: Part<AgentStart>[], named: ReadNamed) => !!named.includeRecentStarts || !!named.startAgentIds?.length
  || (named.startIds ?? []).some(id => !hot.some(s => s.key === id))

/** Each held list of finished starts by the agent they started, worked out once per list: an agent is a sha256 (stableId),
 *  and hashing every finished start on each read was ~40% of a messages read's CPU (prod's busiest Swarm, 2026-10-30). */
const startsByAgent = new WeakMap<readonly Part<AgentStart>[], Map<string, Part<AgentStart>[]>>()
function byAgent(finished: readonly Part<AgentStart>[]): Map<string, Part<AgentStart>[]> {
  let index = startsByAgent.get(finished)
  if (!index) {
    index = new Map()
    for (const start of finished) {
      if (!start.data!.harnessId) continue
      const agent = stableId(start.data!.request.machineId, start.data!.harnessId)
      index.set(agent, [...index.get(agent) ?? [], start])
    }
    startsByAgent.set(finished, index)
  }
  return index
}

/** The starts loadActive gives for `named`: every unfinished one (`hot`), and the finished ones named by id or by the agent
 *  they started, or all of them with `includeRecentStarts`. */
export function namedStarts(hot: Part<AgentStart>[], finished: Part<AgentStart>[], named: ReadNamed): Part<AgentStart>[] {
  const picked = named.includeRecentStarts ? finished : [...new Map(pickFinished(finished, named).map(s => [s.key, s])).values()]
  if (!picked.length) return hot
  // The two lists are patched at their own moments, so a start that just finished can be in both: it comes once, as its
  // newer version (final review, Important 6).
  const merged = new Map(hot.map(s => [s.key, s]))
  for (const start of picked) {
    const held = merged.get(start.key)
    if (!held || start.version > held.version) merged.set(start.key, start)
  }
  return [...merged.values()]
}

const pickFinished = (finished: Part<AgentStart>[], named: ReadNamed): Part<AgentStart>[] => {
  const ids = new Set(named.startIds ?? [])
  const index = named.startAgentIds?.length ? byAgent(finished) : null
  return [...finished.filter(s => ids.has(s.key)), ...(named.startAgentIds ?? []).flatMap(agent => index!.get(agent) ?? [])]
}

/** The Swarms whose last delta's rows a process keeps (store.loadDelta `held`), most recently read last. Each keeps only its
 *  last delta's rows of each kind: about what changed in its last 30 s (the overlap) and more. */
export const DELTA_ROWS_SWARMS = 256

/** The read cache's delta (cache.ts): one snapshot, as a base load is (final review, Important 5), and tried again on a
 *  transient error as one is. It keeps each Swarm's rows its last delta read, so the next reads whole only what moved since
 *  (#2783). */
export function readDelta(db: Pick<PrismaClient, '$transaction'>): (tabId: string, since: number, kinds: readonly PartKind[]) => Promise<SwarmDelta> {
  const held = new Map<string, store.DeltaRows>()
  return (tabId, since, kinds) => {
    const rows = held.get(tabId) ?? new Map()
    held.delete(tabId)
    held.set(tabId, rows)
    for (const oldest of held.keys()) {
      if (held.size <= DELTA_ROWS_SWARMS) break
      held.delete(oldest)
    }
    return retryTransient(() => db.$transaction(tx => store.loadDelta(tx, tabId, since, kinds, rows)))
  }
}

/** The parts loadLight gives for `opts`, held whole by what it selects. */
export async function readLight(db: Db, view: CacheView, tabId: string, opts: Omit<LightOptions, 'machines'>): Promise<SwarmParts> {
  const name = `light:${JSON.stringify([opts.groups ?? 'active', !!opts.includeRecentStarts, ...(['groupIds', 'agentIds', 'projectIds'] as const)
    .map(key => [...opts[key] ?? []].sort())])}`
  const [light, machines] = await Promise.all([
    // With a cache that patches, built from the entries it holds (deriveLight); otherwise, or for recent finished starts, which
    // the base does not hold, read as before: a base dropped on every bump would cost more than this read.
    view.get(tabId, name, 'main', () => view.patching && !opts.includeRecentStarts ? deriveLight(db, view, tabId, opts)
      : retryTransient(() => retryStaleIndex(() => db.$transaction(tx => store.loadLight(tx, tabId, { ...opts, machines: false }))))),
    readMachines(db, view, tabId),
  ])
  return { ...light, machines }
}

/**
 * `loadLight`'s selection built from entries the cache already holds and patches (spec 2026-11-02 poll cost, Part 1.2): the
 * base's awake conversations, `light-group:{id}` for a named one the base lacks, and, for a machine's host state
 * (`machineId`, read/host.ts hostParts), its agents' dormant conversations from `dormant:agent:{id}` plus its starts'
 * conversations and their projects. Reads Mongo only for entries that miss.
 */
export async function deriveLight(db: Db, view: CacheView, tabId: string, opts: SelectOptions & { machineId?: string }): Promise<Omit<SwarmParts, 'machines'>> {
  const [active] = await base(db, view, tabId)
  const machineId = opts.machineId
  const starts = machineId ? active.starts.filter(s => s.data!.request.machineId === machineId) : active.starts
  const agentIds = machineId ? active.agents.filter(a => (a.data as { machineId?: string }).machineId === machineId).map(a => a.key) : opts.agentIds ?? []
  const groupIds = machineId ? [...new Set(starts.map(s => s.data!.request.conversationId))] : opts.groupIds ?? []
  const awake = active.groups.map(projectLightGroup)
  const held = new Set(awake.map(g => g.key))
  const named = lightKeys(active.head, active.starts, { ...opts, groupIds }).filter(id => !held.has(id))
  // Its agents' quiet conversations light, as the host rows read them: whole, one Lead's were 3.6 MB a read on prod (B4, #2597).
  const [byId, ...dormant] = await Promise.all([readLightGroups(db, view, tabId, named),
    ...agentIds.map(id => view.get(tabId, `light-dormant:agent:${id}`, 'main',
      () => store.loadLightGroups(db, tabId, 'agents', { agentIds: { $in: [id] }, dormant: true }), lightDormantAgentRule(id)))])
  const candidates = new Map(awake.map(g => [g.key, g]))
  for (const g of [...byId, ...dormant.flat()]) if (!candidates.has(g.key)) candidates.set(g.key, g)
  // A machine's host state also lists every conversation of a project it has a start in (read/host.ts hostParts).
  const projectIds = machineId ? [...new Set(groupIds.flatMap(id => { const g = candidates.get(id); return g ? [g.data!.projectId ?? 'lead'] : [] }))]
    : opts.projectIds ?? []
  return lightSelect({ ...active, groups: [...candidates.values()] }, { groups: opts.groups, groupIds, agentIds, projectIds })
}

/** Light conversations by id (parts/light.ts loadLightGroups), dormant ones too, in the order named: each held at the
 *  Swarm's main stamp, an id no live conversation has held as none. A read's misses are one query, as readLastChangedAts
 *  batches them; without stamps every id is read, still in one query. */
export async function readLightGroups(db: Db, view: CacheView, tabId: string, ids: readonly string[]): Promise<Part<GroupData>[]> {
  const missing: string[] = []
  let batch: Promise<Map<string, Part<GroupData>>> | undefined
  const groups = await Promise.all([...new Set(ids)].map(id => view.get(tabId, `light-group:${id}`, 'main', () => {
    missing.push(id)
    // As readLastChangedAts: every miss of this read joins before the query starts.
    batch ??= Promise.resolve().then(async () => new Map((await retryStaleIndex(() => store.loadLightGroups(db, tabId, 'key', { key: { $in: missing } })))
      .map(group => [group.key, group])))
    return batch.then(found => found.get(id) ?? null)
  })))
  return groups.filter((group): group is Part<GroupData> => group !== null)
}

/** The Swarm's newest data change (parts/load.ts lastChangedAt), held at its main stamp: a machine's reading leaves it. */
export async function readLastChangedAt(db: Db, view: CacheView, tabId: string): Promise<number | null> {
  return view.get(tabId, 'lastChangedAt', 'main', async () => (await store.lastChangedAt(db, [tabId])).get(tabId) ?? null)
}

/** The same per-Swarm entries, with this read's misses collected into one seven-kind query (also without a cache). */
export async function readLastChangedAts(db: Db, view: CacheView, tabIds: string[]): Promise<Map<string, number | null>> {
  const missing: string[] = []
  let batch: Promise<Map<string, number>> | undefined
  return new Map(await Promise.all(tabIds.map(async tabId => [tabId, await view.get(tabId, 'lastChangedAt', 'main', () => {
    missing.push(tabId)
    // get starts miss loaders synchronously. Defer the query one microtask so every miss joins before it starts;
    // hits and entries already loading at this stamp never enter the batch.
    batch ??= Promise.resolve().then(() => store.lastChangedAt(db, missing))
    return batch.then(newest => newest.get(tabId) ?? null)
  })] as const)))
}

/** The Swarm's parts changed after `since` (parts/load.ts loadChanged): from the held feed when it reaches back that far, else
 *  read. The feed is held in two entries by the stamp each depends on (#2783): a machine's reading refreshes only its
 *  machine part, and every other kind stays as held. */
export async function readChanged(db: Db, view: CacheView, tabId: string, since: number): Promise<Part[]> {
  const direct = async () => (await store.loadChanged(db, [tabId], new Date(since))).get(tabId) ?? []
  if (!view.available) return direct()
  const load = (kinds: readonly PartKind[]) => async () => {
    const from = Math.min(since - FEED_SLACK_MS, view.at - FEED_REACH_MS)
    return { from, parts: (await store.loadChanged(db, [tabId], new Date(from), kinds)).get(tabId) ?? [] }
  }
  const [main, machines] = await Promise.all([view.get(tabId, 'feed', 'main', load(FEED_MAIN_KINDS), feedRule),
    view.get(tabId, 'machine-feed', 'all', load(['machine']), machineFeedRule)])
  if (since < main.from || since < machines.from) return direct()
  return [...main.parts, ...machines.parts].filter(p => Math.max(p.changedAt, p.readAt ?? 0) > since)
}
