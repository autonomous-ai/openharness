import type { Prisma } from '@prisma/client'
import { agentOnly, conversation, fail, isLeads, type MessageDraft, type SuperTabState } from '../model.js'
import { split } from './shape.js'
import { guardedWrite, PartConflict, type HeadColumns, type HostColumns, type PartWrite } from './write.js'
import type { GroupData, MachineData, Part, PartKind, SwarmParts } from './types.js'
import { RELEASED_CAP } from './types.js'

type Transaction = Prisma.TransactionClient

/** A part a command relies on without changing it: touched so a concurrent change to it conflicts (design section 1). */
export interface Touch { kind: PartKind; key: string }
/** A part a command wrote, at its new version: the command reply (design section 4.7). */
export interface Written { kind: PartKind; key: string; version: number }

/** MongoDB limits a document to 16 MiB. A part leaves room for its columns and indexes (design section 1.4). */
export const PART_LIMIT_BYTES = 4 * 1024 * 1024

const LISTS = { member: 'members', agent: 'agents', group: 'groups', machine: 'machines', start: 'starts', progress: 'progress' } as const
type ListKind = keyof typeof LISTS

/** JSON with sorted keys, so two equal records compare equal whatever order a command built them in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
}

/**
 * Who sees what changed (design section 4.2): a project's visibility or members, a person removed or rejoined, the set of
 * Leads (the Leads conversation's members), a conversation's audience, or a project removed. Readers reload in full.
 */
export function visibilityChanged(before: SuperTabState, after: SuperTabState): boolean {
  const projects = (state: SuperTabState) => canonical((state.projects ?? []).map(p => [p.id, p.visibility, p.members]))
  const people = (state: SuperTabState) => canonical(state.people.map(p => [p.id, p.generation, p.role]))
  const leads = (state: SuperTabState) => canonical(state.conversations.filter(isLeads).map(c => c.agentIds))
  const audiences = (state: SuperTabState) => new Map(state.conversations.map(c => [c.id, canonical(c.audience ?? null)]))
  if (projects(before) !== projects(after) || people(before) !== people(after) || leads(before) !== leads(after)) return true
  const was = audiences(before)
  return [...audiences(after)].some(([id, audience]) => was.has(id) && was.get(id) !== audience)
}

/** The Swarm's index row (SuperTab): what hosts, invitations and member lists are looked up by (design section 2.3). */
export function indexesOf(state: SuperTabState) {
  return {
    memberIds: state.people.map(p => p.id), invitedEmails: state.invitations.map(i => i.email),
    machineIds: [...new Set([...state.agents.map(a => a.machineId), ...(state.machines ?? []).map(m => m.machineId),
      ...(state.closingSessions ?? []).map(c => c.machineId), ...(state.machineCleanups ?? []).map(c => c.machineId)])],
    cleanupMachineIds: [...new Set([...(state.machines ?? []).flatMap(m => m.removal ? [m.machineId] : []),
      ...(state.machineCleanups ?? []).map(c => c.machineId)])],
  }
}

/**
 * Numbers each message in its conversation (design section 1.1 D4): the conversation's counter moves by one per message, in
 * draft order. A shown message is the conversation's latest and wakes a dormant one; an agent-only notice is numbered but
 * shown to nobody. Returns each message's sequence.
 */
export function numberMessages(state: SuperTabState, messages: MessageDraft[], now: number): Map<string, number> {
  const sequences = new Map<string, number>()
  for (const message of messages) {
    const group = conversation(state, message.conversationId)
    const sequence = (group.messageSeq ?? state.sequenceBase ?? 0) + 1
    group.messageSeq = sequence
    sequences.set(message.id, sequence)
    if (agentOnly(message.source)) continue
    group.lastMessageSequence = sequence
    group.lastActivityAt = new Date(now).toISOString()
    delete group.dormant
    if (message.author.kind === 'person') notePerson(group, message.author.id, now)
  }
  return sequences
}

/** How long a person's post seats them at its conversation's table on the office map (Desktop). */
export const RECENT_PEOPLE_MS = 2 * 60 * 60_000
const RECENT_PEOPLE_CAP = 8

function notePerson(group: SuperTabState['conversations'][number], personId: string, now: number): void {
  const kept = Object.entries(group.recentPeople ?? {}).filter(([id, at]) => id !== personId && Date.parse(at) > now - RECENT_PEOPLE_MS)
  group.recentPeople = Object.fromEntries([[personId, new Date(now).toISOString()], ...kept].slice(0, RECENT_PEOPLE_CAP))
}

/** Keeps the newest RELEASED_CAP released harnesses of each machine (spec, Archive). */
export function capReleased(state: SuperTabState): void {
  const released = state.releasedHarnesses
  if (!released) return
  const count = new Map<string, number>()
  for (const entry of released) count.set(entry.machineId, (count.get(entry.machineId) ?? 0) + 1)
  if ([...count.values()].every(n => n <= RELEASED_CAP)) return
  const seen = new Map<string, number>()
  state.releasedHarnesses = released.filter(entry => {
    const index = (seen.get(entry.machineId) ?? 0) + 1
    seen.set(entry.machineId, index)
    return index > count.get(entry.machineId)! - RELEASED_CAP
  })
}

/**
 * Writes what a command changed (design section 3.1): each part whose data differs from what was loaded, each new part,
 * a tombstone for each removed one, a guarded touch for each part in `touches` it did not write, the head when its
 * counters or the visibility epoch move, and the index row when a person, invitation or machine reference was added or
 * removed. Every write is guarded by the version it was read at.
 */
/** A machine part without its machine's own reading, nor the Lent hours each reading credits (leaderboard/lent.ts): what
 *  that machine's host needs to hear about. */
const withoutReading = (data: unknown) => {
  const machine = data as MachineData | undefined
  return machine && { ...machine, contribution: machine.contribution && { ...machine.contribution, observation: undefined, lent: undefined } }
}

/**
 * What a part write tells host reads (read/host.ts, review round 1), from the part's data before and after (undefined for
 * an insert or a removal): a machine's settings or ledger changed, not only its own reading; and which machines' hosts a
 * group's write concerned, by its agents and its work before and after, so an agent leaving its last group wakes its host.
 */
export function hostMarker(kind: PartKind, before: unknown, after: unknown, machineOf: ReadonlyMap<string, string>, stamp: number): { host?: HostColumns } {
  if (kind === 'machine') return canonical(withoutReading(before)) === canonical(withoutReading(after)) ? {} : { host: { hostChangedAt: new Date(stamp) } }
  if (kind !== 'group') return {}
  const machines = ([before, after] as Array<GroupData | undefined>).flatMap(g => g
    ? [...g.agentIds.flatMap(id => machineOf.get(id) ?? []), ...(g.assignment ? [g.assignment.execution.machineId] : [])] : [])
  return { host: { hostMachineIds: [...new Set(machines)] } }
}

/** The agents a group's write let go: in its members or its work before, in neither after. Each is written again, data
 *  unchanged, so its host hears of it whatever later writes to the group leave in that group's marker (review round 2). */
export function departedAgents(before: unknown, after: unknown): string[] {
  const of = (group: GroupData | undefined) => new Set(group ? [...group.agentIds, ...(group.assignment ? [group.assignment.agentId] : [])] : [])
  const kept = of(after as GroupData | undefined)
  return [...of(before as GroupData | undefined)].filter(id => !kept.has(id))
}

export async function commitParts(tx: Transaction, loaded: { parts: SwarmParts; state: SuperTabState; row: { id: string; revision: number } },
  next: SuperTabState, opts: { stamp: number; touches?: Touch[] }): Promise<{ written: Written[]; versions: Map<string, number> }> {
  const { parts } = loaded, { stamp } = opts
  capReleased(next)
  const after = split(next, { tabId: parts.tabId, version: 0, now: stamp, messageBase: parts.sequenceBase })
  const writes: PartWrite[] = []
  const first = parts.sequenceBase + 1
  // An agent removed by this write is still in the loaded state, so its machine is known for the host marker.
  const machineOf = new Map([...loaded.state.agents, ...next.agents].map(a => [a.id, a.machineId]))
  const host = (kind: PartKind, before: unknown, after: unknown) => hostMarker(kind, before, after, machineOf, stamp)
  let referencesChanged = false
  for (const kind of Object.keys(LISTS) as ListKind[]) {
    const before = new Map(parts[LISTS[kind]].filter(p => !p.deleted).map(p => [p.key, p as Part]))
    const now = new Map((after[LISTS[kind]] as Part[]).map(p => [p.key, p]))
    let added = 0
    for (const [key, part] of now) {
      const prior = before.get(key)
      if (!prior) {
        writes.push({ op: 'insert', kind, key, data: part.data, ordinal: stamp + added++ / 1000, first, ...host(kind, undefined, part.data) })
        if (kind !== 'group' && kind !== 'start' && kind !== 'progress') referencesChanged = true
      } else if (canonical(prior.data) !== canonical(part.data)) {
        writes.push({ op: 'update', kind, key, seen: prior.version, data: part.data, ...host(kind, prior.data, part.data) })
      }
    }
    for (const [key, prior] of before) {
      if (now.has(key)) continue
      writes.push({ op: 'remove', kind, key, seen: prior.version, data: prior.data, ...host(kind, prior.data, undefined) })
      if (kind !== 'group' && kind !== 'start' && kind !== 'progress') referencesChanged = true
    }
  }
  const agentsWritten = new Set(writes.filter(w => w.kind === 'agent').map(w => w.key))
  for (const write of writes.filter((w): w is Extract<PartWrite, { op: 'update' }> => w.kind === 'group' && w.op === 'update')) {
    for (const id of departedAgents(parts.groups.find(g => g.key === write.key)!.data, write.data)) {
      const agent = parts.agents.find(a => a.key === id && !a.deleted), data = after.agents.find(a => a.key === id)?.data
      if (!agent || !data || agentsWritten.has(id)) continue
      agentsWritten.add(id)
      writes.push({ op: 'update', kind: 'agent', key: id, seen: agent.version, data })
    }
  }
  const epoch = parts.visibilityEpoch + (visibilityChanged(loaded.state, next) ? 1 : 0)
  const head: HeadColumns = { groupCounter: Math.max(parts.groupCounter, next.groupCounter ?? 0), visibilityEpoch: epoch, sequenceBase: parts.sequenceBase }
  if (canonical(parts.head.data) !== canonical(after.head.data) || head.groupCounter !== parts.groupCounter || epoch !== parts.visibilityEpoch) {
    writes.push({ op: 'update', kind: 'head', key: 'head', seen: parts.head.version, data: after.head.data, head })
  }
  if (canonical(indexesOf(loaded.state)) !== canonical(indexesOf(next))) referencesChanged = true
  for (const write of writes) {
    if ('data' in write && Buffer.byteLength(JSON.stringify(write.data)) > PART_LIMIT_BYTES) {
      fail('PART_TOO_LARGE', 'This Swarm record has reached its size limit.', 413)
    }
  }
  const versions = new Map<string, number>()
  const written: Written[] = []
  for (const write of writes) {
    const version = await guardedWrite(tx, parts.tabId, write, stamp)
    versions.set(`${write.kind}:${write.key}`, version)
    written.push({ kind: write.kind, key: write.key, version })
  }
  const all = [parts.head as Part, ...parts.members, ...parts.agents, ...parts.groups, ...parts.machines, ...parts.starts, ...parts.progress]
  for (const touch of opts.touches ?? []) {
    const key = `${touch.kind}:${touch.key}`
    if (versions.has(key)) continue
    const part = all.find(p => p.kind === touch.kind && p.key === touch.key && !p.deleted)
    if (!part) continue
    versions.set(key, await guardedWrite(tx, parts.tabId, { op: 'touch', kind: touch.kind, key: touch.key, seen: part.version }, stamp))
  }
  if (referencesChanged) {
    // Always written when a reference is added or removed, so two such commands conflict instead of one losing an id.
    const updated = await tx.superTab.updateMany({ where: { id: loaded.row.id, revision: loaded.row.revision },
      data: { revision: loaded.row.revision + 1, ...indexesOf(next) } })
    if (!updated.count) throw new PartConflict('head', 'index')
  }
  return { written, versions }
}
