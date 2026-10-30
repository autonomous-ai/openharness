import type { AgentStart, Conversation, SuperTabState } from '../model.js'
import { isLeads, knownKind, nextConversationNumber } from '../model.js'
import type { ContributedMachine, MachineCleanup } from '../machines.js'
import type { SwarmProject } from '../projects.js'
import type { HeadData, MachineData, Part, PartKind, ProgressData, SwarmParts } from './types.js'

/** The legacy report progress (`SuperTab.state`), in tab revisions. */
interface LegacyProgress { dirtyRevision: number; summarizedRevision: number; requestedRevision: number; since: number; requestedAt?: number; requestMessageId?: string }

// The kinds this release knows are listed once (model.ts knownKind): a second list here once set Buddy chats aside, so no host or change read saw them.
export { knownKind }
const PART_ONLY_GROUP_FIELDS = ['messageSeq', 'reportSeq', 'dormant', 'lastActivityAt'] as const
/** Optional lists of `SuperTab.state` an empty one of which differs from an absent one (`[]` after the last machine left). */
const LISTS = ['parkedConversations', 'starts', 'machines', 'harnessReservations', 'releasedHarnesses', 'closingSessions', 'machineCleanups'] as const
const STATE_ONLY = ['people', 'agents', 'conversations', 'parkedConversations', 'starts', 'machines', 'harnessReservations',
  'releasedHarnesses', 'closingSessions', 'machineCleanups', 'otherProjectsWork', 'groupCounter', 'sequenceBase'] as const

const isLegacyProgress = (progress: unknown): progress is LegacyProgress =>
  !!progress && typeof progress === 'object' && 'dirtyRevision' in progress

/** The project groups whose posts count toward its reports: not its Lead conversation, not the Leads conversation. */
const reportGroups = (conversations: Conversation[], project: Pick<SwarmProject, 'id' | 'leadConversationId'>) =>
  conversations.filter(c => !isLeads(c) && (c.projectId ?? 'lead') === project.id && c.id !== project.leadConversationId)

function part<T>(kind: PartKind, key: string, data: T, ordinal: number, version: number, now: number): Part<T> {
  return { kind, key, version, changedAt: now, ordinal, data }
}

function machineParts(state: SuperTabState): Map<string, MachineData> {
  const machines = new Map<string, MachineData>()
  const of = (machineId: string) => {
    let entry = machines.get(machineId)
    if (!entry) machines.set(machineId, entry = { machineId, contribution: null, reservations: [], released: [], closingSessions: [], cleanups: [] })
    return entry
  }
  for (const pool of state.machines ?? []) of(pool.machineId).contribution = pool
  for (const { machineId, harnessId, generation, renewed } of state.harnessReservations ?? []) of(machineId).reservations.push({ harnessId, generation, renewed })
  for (const { machineId, harnessId } of state.releasedHarnesses ?? []) of(machineId).released.push(harnessId)
  // With its Team account hold (`heldFor`, `since`, `noticed`): dropped here, the account was free on the next read (review of #2142).
  for (const { machineId, ...closing } of state.closingSessions ?? []) of(machineId).closingSessions.push(closing)
  for (const { machineId, ...cleanup } of state.machineCleanups ?? []) of(machineId).cleanups.push(cleanup)
  return machines
}

/**
 * One Swarm's state as parts, every part at `version` and `changedAt = now`. Accepts the legacy shape too (the
 * migration): legacy report progress becomes a watermark, and each group's report sequence is its last message capped
 * at the project's dirty revision, since a later notice in it was not a report (design section 6.1).
 */
export function split(state: SuperTabState, opts: { tabId: string; version: number; now: number; visibilityEpoch?: number;
  lastActivity?: ReadonlyMap<string, number>; messageBase?: number }): SwarmParts {
  const { version, now } = opts
  const head = Object.fromEntries(Object.entries(state).filter(([key]) => !(STATE_ONLY as readonly string[]).includes(key))) as HeadData
  if (state.projects) head.projects = state.projects.map(({ progress: _progress, ...project }) => project)
  const present = LISTS.filter(list => state[list] !== undefined)
  if (present.length) head.presentLists = present
  const dirty = new Map<string, number>()
  for (const project of state.projects ?? []) {
    if (!isLegacyProgress(project.progress)) continue
    for (const group of reportGroups(state.conversations, project)) dirty.set(group.id, Math.min(group.lastMessageSequence, project.progress.dirtyRevision))
  }
  // A conversation of a kind this release does not know is kept exactly as a later release wrote it.
  const groups = [...state.conversations, ...state.parkedConversations ?? []].map((group, i) => part('group', group.id, !knownKind(group) ? group : {
    ...group, messageSeq: group.messageSeq ?? opts.messageBase ?? version, reportSeq: group.reportSeq ?? dirty.get(group.id) ?? 0,
    lastActivityAt: group.lastActivityAt ?? new Date(opts.lastActivity?.get(group.id) ?? now).toISOString(),
  }, i, version, now))
  for (const entry of groups) if (entry.data?.dormant) entry.dormant = true
  const progress = (state.projects ?? []).flatMap((project, i) => {
    const stored = project.progress as LegacyProgress | ProgressData | undefined
    if (!stored) return []
    const data: ProgressData = isLegacyProgress(stored)
      ? { since: stored.since, summarizedFloor: stored.summarizedRevision, summarized: {}, requestedFloor: stored.requestedRevision, requested: {},
        ...(stored.requestedAt !== undefined ? { requestedAt: stored.requestedAt } : {}),
        ...(stored.requestMessageId !== undefined ? { requestMessageId: stored.requestMessageId } : {}) }
      : stored
    return [part('progress', project.id, data, i, version, now)]
  })
  return {
    tabId: opts.tabId,
    head: part('head', 'head', head, 0, version, now),
    members: state.people.map((person, i) => part('member', person.id, person, i, version, now)),
    agents: state.agents.map((agent, i) => part('agent', agent.id, agent, i, version, now)),
    groups,
    machines: [...machineParts(state).values()].map((machine, i) => part('machine', machine.machineId, machine, i, version, now)),
    starts: (state.starts ?? []).map((start, i) => part('start', start.id, start, i, version, now)),
    progress,
    sequenceBase: state.sequenceBase ?? version,
    visibilityEpoch: opts.visibilityEpoch ?? 1,
    groupCounter: state.groupCounter ?? nextConversationNumber(state) - 1,
  }
}

const live = <T>(parts: Part<T>[]): T[] => parts.filter(p => !p.deleted && p.data).sort((a, b) => a.ordinal - b.ordinal).map(p => p.data!)

/**
 * The state commands run on: `SuperTab.state`'s shape, each list in part order, with the part-only group fields kept. A
 * command changes what it reassembled, so each record is a copy; a read (`share`) changes nothing and takes the parts'
 * own records, which the read cache holds frozen (cache.ts).
 */
export function reassemble(parts: SwarmParts, { share = false }: { share?: boolean } = {}): SuperTabState {
  const copy = share ? <T>(value: T): T => value : structuredClone
  const groups = live(parts.groups)
  const machines = live(parts.machines)
  const progress = new Map(parts.progress.filter(p => !p.deleted && p.data).map(p => [p.key, p.data!]))
  const flat = <T>(each: (machine: MachineData) => T[]) => machines.flatMap(each)
  const state: SuperTabState = {
    ...copy(parts.head.data!),
    ...(parts.head.data!.projects ? { projects: parts.head.data!.projects.map(project => ({ ...copy(project),
      ...(progress.has(project.id) ? { progress: copy(progress.get(project.id)!) as unknown as SwarmProject['progress'] } : {}) })) } : {}),
    people: copy(live(parts.members)),
    agents: copy(live(parts.agents)),
    conversations: copy(groups.filter(knownKind)),
    groupCounter: parts.groupCounter,
    sequenceBase: parts.sequenceBase,
  }
  const present = new Set<string>(parts.head.data!.presentLists ?? [])
  delete (state as { presentLists?: unknown }).presentLists
  const parked = groups.filter(group => !knownKind(group))
  const starts: AgentStart[] = live(parts.starts)
  const contributed: ContributedMachine[] = machines.flatMap(m => m.contribution ? [m.contribution] : [])
  const reservations = flat(m => m.reservations.map(r => ({ machineId: m.machineId, ...r })))
  const released = flat(m => m.released.map(harnessId => ({ machineId: m.machineId, harnessId })))
  const closing = flat(m => m.closingSessions.map(c => ({ ...c, machineId: m.machineId })))
  const cleanups: MachineCleanup[] = flat(m => m.cleanups.map(c => ({ machineId: m.machineId, ...c })))
  const list = <K extends typeof LISTS[number]>(key: K, items: NonNullable<SuperTabState[K]>) => {
    if (items.length || present.has(key)) state[key] = copy(items)
  }
  list('parkedConversations', parked)
  list('starts', starts)
  list('machines', contributed)
  list('harnessReservations', reservations)
  list('releasedHarnesses', released)
  list('closingSessions', closing)
  list('machineCleanups', cleanups)
  return state
}

/**
 * The state in `SuperTab.state`'s shape (verification and rollback, design section 6.2): part-only group fields removed,
 * and each project's report watermark turned back into revisions. A project with a group past what was summarized or
 * requested keeps the floor, so the next report request still asks for it.
 */
export function toLegacyState(state: SuperTabState): SuperTabState {
  const legacy = structuredClone(state)
  delete legacy.groupCounter
  delete legacy.sequenceBase
  const strip = (group: Conversation) => { for (const field of PART_ONLY_GROUP_FIELDS) delete group[field] }
  for (const project of legacy.projects ?? []) {
    const stored = project.progress as unknown as ProgressData | undefined
    if (!stored || isLegacyProgress(stored)) continue
    const groups = reportGroups(state.conversations, project)
    const dirtyRevision = Math.max(0, ...groups.map(g => g.reportSeq ?? 0))
    const through = (marks: Record<string, number>, floor: number) => !Object.keys(marks).length ? floor
      : groups.every(g => (g.reportSeq ?? 0) <= (marks[g.id] ?? floor)) ? Math.max(floor, dirtyRevision) : floor
    project.progress = { dirtyRevision, summarizedRevision: through(stored.summarized, stored.summarizedFloor),
      requestedRevision: through(stored.requested, stored.requestedFloor), since: stored.since,
      ...(stored.requestedAt !== undefined ? { requestedAt: stored.requestedAt } : {}),
      ...(stored.requestMessageId !== undefined ? { requestMessageId: stored.requestMessageId } : {}) } as unknown as SwarmProject['progress']
  }
  legacy.conversations.forEach(strip)
  legacy.parkedConversations?.forEach(strip)
  return legacy
}
