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

type Db = Pick<PrismaClient, '$transaction'> & Prisma.TransactionClient
type LightOptions = NonNullable<Parameters<typeof store.loadLight>[2]>

/** What a read names beyond a Swarm's active parts, as loadActive takes it. */
export interface ReadNamed { groupIds?: string[]; agentIds?: string[]; projectIds?: string[]; startIds?: string[]; startAgentIds?: string[]
  allGroups?: boolean; includeRecentStarts?: boolean }

/** A view with no stamps: every read goes to Mongo, nothing is kept. */
export const DIRECT = new CacheView(null, null)

/** A changed part comes from the held feed while the read's cursor is this recent (the cursor overlap is 30 s). */
const FEED_WINDOW_MS = 120_000

/** A Swarm's live machine parts, held at both stamps: a machine's reading moves only the machine stamp. */
export const readMachines = (db: Prisma.TransactionClient, view: CacheView, tabId: string) =>
  view.get(tabId, 'machines', 'all', () => store.loadMachines(db, tabId))

/** The active parts, then the machines: one read of the base in a transaction, so its parts are one snapshot. */
const base = (db: Db, view: CacheView, tabId: string) => Promise.all([
  view.get(tabId, 'parts', 'main', () => db.$transaction(tx => store.loadReadBase(tx, tabId))),
  readMachines(db, view, tabId),
])

/** The parts loadActive gives for `named`, as one Swarm read (design section 3.1). */
export async function readParts(db: Db, view: CacheView, tabId: string, named: ReadNamed = {}): Promise<SwarmParts> {
  const [active, machines] = await base(db, view, tabId)
  const held = new Set(active.groups.map(g => g.key))
  const extra: Part<GroupData>[] = []
  const add = (groups: Part<GroupData>[]) => { for (const g of groups) if (!held.has(g.key)) { held.add(g.key); extra.push(g) } }
  if (named.allGroups || named.agentIds?.length || named.projectIds?.length) {
    const dormant = await view.get(tabId, 'dormant', 'main', () => store.loadGroups(db, tabId, { dormant: true }))
    const agents = new Set(named.agentIds ?? []), projects = new Set(named.projectIds ?? [])
    // A group stored with no project belongs to the default one (projects.ts groupProject).
    add(named.allGroups ? dormant : dormant.filter(g => g.data!.agentIds.some(id => agents.has(id)) || projects.has(g.data!.projectId ?? 'lead')))
  }
  for (const id of named.groupIds ?? []) {
    if (!held.has(id)) add(await view.get(tabId, `group:${id}`, 'main', () => store.loadGroups(db, tabId, { key: id })))
  }
  const startIds = new Set(named.startIds ?? []), startAgents = new Set(named.startAgentIds ?? [])
  const agentOf = (start: AgentStart) => start.harnessId ? stableId(start.request.machineId, start.harnessId) : null
  const starts = named.includeRecentStarts ? active.starts : active.starts.filter(s => !startFinished(s.data!) || startIds.has(s.key)
    || startAgents.has(agentOf(s.data!) ?? ''))
  return { ...active, machines, groups: extra.length ? [...active.groups, ...extra] : active.groups, starts }
}

/** The parts loadLight gives for `opts`, held whole by what it selects. */
export async function readLight(db: Db, view: CacheView, tabId: string, opts: Omit<LightOptions, 'machines'>): Promise<SwarmParts> {
  const name = `light:${JSON.stringify([opts.groups ?? 'active', !!opts.includeRecentStarts, ...(['groupIds', 'agentIds', 'projectIds'] as const)
    .map(key => [...opts[key] ?? []].sort())])}`
  const [light, machines] = await Promise.all([
    view.get(tabId, name, 'main', () => db.$transaction(tx => store.loadLight(tx, tabId, { ...opts, machines: false }))),
    readMachines(db, view, tabId),
  ])
  return { ...light, machines }
}

/** The Swarm's newest data change (parts/load.ts lastChangedAt). */
export async function readLastChangedAt(db: Db, view: CacheView, tabId: string): Promise<number | null> {
  return view.get(tabId, 'lastChangedAt', 'all', async () => (await store.lastChangedAt(db, [tabId])).get(tabId) ?? null)
}

/** The Swarm's parts changed after `since` (parts/load.ts loadChanged): from the held feed of the last two minutes, or read. */
export async function readChanged(db: Db, view: CacheView, tabId: string, since: number): Promise<Part[]> {
  const direct = async () => (await store.loadChanged(db, [tabId], new Date(since))).get(tabId) ?? []
  if (!view.available) return direct()
  const feed = await view.get(tabId, 'feed', 'all', async () => {
    const from = Date.now() - FEED_WINDOW_MS
    return { from, parts: (await store.loadChanged(db, [tabId], new Date(from))).get(tabId) ?? [] }
  })
  return since >= feed.from ? feed.parts.filter(p => p.changedAt > since) : direct()
}
