import type { AgentStart, SuperTabState } from '../model.js'
import { knownKind, nextConversationNumber } from '../model.js'
import type { ContributedMachine, MachineCleanup } from '../machines.js'
import type { HeadData, MachineData, Part, PartKind, SwarmParts } from './types.js'

// The kinds this release knows are listed once (model.ts knownKind).
export { knownKind }
/** Optional lists of `SuperTab.state` an empty one of which differs from an absent one (`[]` after the last machine left). */
const LISTS = ['parkedConversations', 'starts', 'machines', 'harnessReservations', 'releasedHarnesses', 'closingSessions', 'removedSessions', 'machineCleanups'] as const
const STATE_ONLY = ['people', 'agents', 'conversations', 'parkedConversations', 'starts', 'machines', 'harnessReservations',
  'releasedHarnesses', 'closingSessions', 'removedSessions', 'machineCleanups', 'otherProjectsWork', 'pmAccounts', 'groupCounter', 'sequenceBase'] as const

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
  for (const { machineId, ...closing } of state.closingSessions ?? []) of(machineId).closingSessions.push(closing)
  for (const { machineId, ...cleanup } of state.machineCleanups ?? []) of(machineId).cleanups.push(cleanup)
  for (const { machineId, ...removed } of state.removedSessions ?? []) (of(machineId).removedSessions ??= []).push(removed)
  return machines
}

/** One Swarm's state as parts, every part at `version` and `changedAt = now`. */
export function split(state: SuperTabState, opts: { tabId: string; version: number; now: number; visibilityEpoch?: number;
  messageBase?: number }): SwarmParts {
  const { version, now } = opts
  const head = Object.fromEntries(Object.entries(state).filter(([key]) => !(STATE_ONLY as readonly string[]).includes(key))) as HeadData
  const present = LISTS.filter(list => state[list] !== undefined)
  if (present.length) head.presentLists = present
  // A conversation of a kind this release does not know is kept exactly as a later release wrote it.
  const groups = [...state.conversations, ...state.parkedConversations ?? []].map((group, i) => part('group', group.id, !knownKind(group) ? group : {
    ...group, messageSeq: group.messageSeq ?? opts.messageBase ?? version,
    lastActivityAt: group.lastActivityAt ?? new Date(now).toISOString(),
  }, i, version, now))
  for (const entry of groups) if (entry.data?.dormant) entry.dormant = true
  return {
    tabId: opts.tabId,
    head: part('head', 'head', head, 0, version, now),
    members: state.people.map((person, i) => part('member', person.id, person, i, version, now)),
    agents: state.agents.map((agent, i) => part('agent', agent.id, agent, i, version, now)),
    groups,
    machines: [...machineParts(state).values()].map((machine, i) => part('machine', machine.machineId, machine, i, version, now)),
    starts: (state.starts ?? []).map((start, i) => part('start', start.id, start, i, version, now)),
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
  const flat = <T>(each: (machine: MachineData) => T[]) => machines.flatMap(each)
  const state: SuperTabState = {
    ...copy(parts.head.data!),
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
  const removed = flat(m => (m.removedSessions ?? []).map(r => ({ machineId: m.machineId, ...r })))
  const list = <K extends typeof LISTS[number]>(key: K, items: NonNullable<SuperTabState[K]>) => {
    if (items.length || present.has(key)) state[key] = copy(items)
  }
  list('parkedConversations', parked)
  list('starts', starts)
  list('machines', contributed)
  list('harnessReservations', reservations)
  list('releasedHarnesses', released)
  list('closingSessions', closing)
  list('removedSessions', removed)
  list('machineCleanups', cleanups)
  return state
}
