/**
 * Reads of a Swarm's parts through the per-process cache (cache.ts, Stability Roadmap 2.2): each read gives what the
 * loader it replaces gives (parts/load.ts loadActive, parts/light.ts loadLight, loadChanged, lastChangedAt), built from
 * what the cache holds at the read's stamps. Without stamps (Redis down, the cache off) each piece is read from Mongo.
 * Everything here is the stored state, the same for every reader: permissions are applied after (read/views.ts).
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { stableId, type AgentStart } from './model.js'
import { CacheView } from './cache.js'
import * as store from './parts/index.js'
import type { GroupData, Part, SwarmParts } from './parts/index.js'
import { startFinished } from './parts/write.js'
import { retryTransient } from './retry.js'
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

/** A Swarm's live machine parts, held at both stamps: a machine's reading moves only the machine stamp. */
export const readMachines = (db: Prisma.TransactionClient, view: CacheView, tabId: string) =>
  view.get(tabId, 'machines', 'all', () => store.loadMachines(db, tabId))

/** The active parts, then the machines: one read of the base in a transaction, so its parts are one snapshot. A transaction
 *  that meets a lock it cannot get in 5 ms (an index build, a release) is tried again as a write's would be (retry.ts). */
const base = (db: Db, view: CacheView, tabId: string) => Promise.all([
  view.get(tabId, 'parts', 'main', () => retryTransient(() => retryStaleIndex(() => db.$transaction(tx => store.loadReadBase(tx, tabId))))),
  readMachines(db, view, tabId),
])

/** The parts loadActive gives for `named`, as one Swarm read (design section 3.1). */
export async function readParts(db: Db, view: CacheView, tabId: string, named: ReadNamed = {}): Promise<SwarmParts> {
  const [active, machines] = await base(db, view, tabId)
  const held = new Set(active.groups.map(g => g.key))
  const extra: Part<GroupData>[] = []
  const add = (groups: Part<GroupData>[]) => { for (const g of groups) if (!held.has(g.key)) { held.add(g.key); extra.push(g) } }
  if (named.allGroups || named.agentIds?.length || named.projectIds?.length) {
    const dormant = await view.get(tabId, 'dormant', 'main', () => store.loadGroups(db, tabId, 'dormancy', { dormant: true }))
    const agents = new Set(named.agentIds ?? []), projects = new Set(named.projectIds ?? [])
    // A group stored with no project belongs to the default one (projects.ts groupProject).
    add(named.allGroups ? dormant : dormant.filter(g => g.data!.agentIds.some(id => agents.has(id)) || projects.has(g.data!.projectId ?? 'lead')))
  }
  for (const id of named.groupIds ?? []) {
    if (!held.has(id)) add(await view.get(tabId, `group:${id}`, 'main', () => store.loadGroups(db, tabId, 'key', { key: id })))
  }
  return { ...active, machines, groups: extra.length ? [...active.groups, ...extra] : active.groups, starts: namedStarts(active.starts, named) }
}

/** The starts loadActive gives for `named`: every unfinished one, and the finished ones named by id or by the agent they
 *  started (or all of them with `includeRecentStarts`). A finished start's agent is a sha256 (stableId), so it is worked
 *  out only when the read names an agent: hashing every finished start was ~40% of a messages read's CPU (local profile of
 *  prod's busiest Swarm, 873 starts, 2026-10-30). */
export function namedStarts(starts: Part<AgentStart>[], named: ReadNamed): Part<AgentStart>[] {
  if (named.includeRecentStarts) return starts
  const startIds = new Set(named.startIds ?? []), startAgents = new Set(named.startAgentIds ?? [])
  const agentOf = (start: AgentStart) => start.harnessId ? stableId(start.request.machineId, start.harnessId) : null
  return starts.filter(s => !startFinished(s.data!) || startIds.has(s.key) || (startAgents.size > 0 && startAgents.has(agentOf(s.data!) ?? '')))
}

/** The parts loadLight gives for `opts`, held whole by what it selects. */
export async function readLight(db: Db, view: CacheView, tabId: string, opts: Omit<LightOptions, 'machines'>): Promise<SwarmParts> {
  const name = `light:${JSON.stringify([opts.groups ?? 'active', !!opts.includeRecentStarts, ...(['groupIds', 'agentIds', 'projectIds'] as const)
    .map(key => [...opts[key] ?? []].sort())])}`
  const [light, machines] = await Promise.all([
    view.get(tabId, name, 'main', () => retryTransient(() => retryStaleIndex(() => db.$transaction(tx => store.loadLight(tx, tabId, { ...opts, machines: false }))))),
    readMachines(db, view, tabId),
  ])
  return { ...light, machines }
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

/** The Swarm's parts changed after `since` (parts/load.ts loadChanged): from the held feed when it reaches back that far, else read. */
export async function readChanged(db: Db, view: CacheView, tabId: string, since: number): Promise<Part[]> {
  const direct = async () => (await store.loadChanged(db, [tabId], new Date(since))).get(tabId) ?? []
  if (!view.available) return direct()
  const feed = await view.get(tabId, 'feed', 'all', async () => {
    const from = since - FEED_SLACK_MS
    return { from, parts: (await store.loadChanged(db, [tabId], new Date(from))).get(tabId) ?? [] }
  })
  return since >= feed.from ? feed.parts.filter(p => Math.max(p.changedAt, p.readAt ?? 0) > since) : direct()
}
