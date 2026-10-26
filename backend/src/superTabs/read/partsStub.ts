/** Stand-in for group 2's `parts/index.ts` until it lands (Lead's ruling): the pure functions follow design 6.1.2, 6.2 and
 *  4.8 so the read views and the migration can be tested now; storage calls throw. Deleted when group 2 merges. */
import { activeWork, isLeads, type Actor, type Conversation, type SuperTabState } from '../model.js'
import { canReadProject, groupProject, ledProject, projectsOf } from '../projects.js'
import type { GroupData, MachineData, Part, PartKind, PartsModule, ProgressData, SwarmParts } from './partsPort.js'

const DORMANT_AFTER_MS = 24 * 3_600_000
const KNOWN_KINDS = new Set([undefined, 'leads'])
const missing = (name: string) => () => { throw new Error(`parts.${name} arrives with group 2's storage`) }
const live = <T>(list: Part<T>[]) => list.filter(p => !p.deleted).sort((a, b) => a.ordinal - b.ordinal)
const nonEmpty = <K extends string, T>(key: K, list: T[]) => (list.length ? { [key]: list } : {}) as Partial<Record<K, T[]>>

function split(state: SuperTabState, { version, now, lastActivity }: { version: number; now: number; lastActivity: Map<string, number> }): SwarmParts {
  const part = <T>(kind: PartKind, key: string, ordinal: number, data: T): Part<T> => ({ kind, key, version, changedAt: now, ordinal, data })
  const { people, agents, conversations, parkedConversations, starts, machines, harnessReservations, releasedHarnesses,
    closingSessions, machineCleanups, otherProjectsWork: _derived, projects, ...head } = state
  const leadGroups = new Set(projectsOf(state).map(p => p.leadConversationId))
  const group = (c: Conversation, ordinal: number): Part<GroupData> => {
    // A group with no message yet counts as active now; the archive sweep takes it a day later if it stays idle.
    const activity = lastActivity.get(c.id) ?? now
    const lead = isLeads(c) || leadGroups.has(c.id)
    const dirty = !lead && KNOWN_KINDS.has(c.kind) ? projectsOf(state).find(p => p.id === (c.projectId ?? 'lead'))?.progress?.dirtyRevision : undefined
    const finished = !!c.assignment && !activeWork(c) && c.assignment.status !== 'stopped'
    return part('group', c.id, ordinal, { ...c, messageSeq: version, reportSeq: dirty === undefined ? 0 : Math.min(c.lastMessageSequence, dirty),
      dormant: c.archived || (!lead && finished && now - activity > DORMANT_AFTER_MS), lastActivityAt: new Date(activity).toISOString() })
  }
  const ledger = new Map<string, MachineData>()
  const machine = (machineId: string) => ledger.get(machineId) ?? ledger.set(machineId,
    { machineId, contribution: null, reservations: [], released: [], closingSessions: [], cleanups: [] }).get(machineId)!
  for (const pool of machines ?? []) machine(pool.machineId).contribution = pool
  for (const { machineId, ...r } of harnessReservations ?? []) machine(machineId).reservations.push(r)
  for (const { machineId, harnessId } of releasedHarnesses ?? []) machine(machineId).released.push(harnessId)
  for (const { machineId, ...c } of closingSessions ?? []) machine(machineId).closingSessions.push(c)
  for (const { machineId, ...c } of machineCleanups ?? []) machine(machineId).cleanups.push(c)
  return {
    head: part('head', 'head', 0, { ...head, ...(projects ? { projects: projects.map(({ progress: _p, ...p }) => p) } : {}) }),
    members: people.map((p, i) => part('member', p.id, i, p)),
    agents: agents.map((a, i) => part('agent', a.id, i, a)),
    groups: [...conversations, ...parkedConversations ?? []].map(group),
    machines: [...ledger.values()].map((m, i) => part('machine', m.machineId, i, m)),
    starts: (starts ?? []).map((s, i) => part('start', s.id, i, s)),
    progress: (projects ?? []).flatMap((p, i) => p.progress ? [part<ProgressData>('progress', p.id, i, { since: p.progress.since,
      summarizedFloor: p.progress.summarizedRevision, summarized: {}, requestedFloor: p.progress.requestedRevision, requested: {},
      ...(p.progress.requestedAt !== undefined ? { requestedAt: p.progress.requestedAt } : {}),
      ...(p.progress.requestMessageId !== undefined ? { requestMessageId: p.progress.requestMessageId } : {}) })] : []),
    sequenceBase: version, epoch: 1,
  }
}

function reassemble(parts: SwarmParts): SuperTabState {
  const groups = live(parts.groups).map(g => g.data!)
  const conversation = ({ messageSeq: _m, reportSeq: _r, dormant: _d, lastActivityAt: _l, ...c }: GroupData): Conversation => c
  const machines = live(parts.machines).map(m => m.data!)
  const head = parts.head.data!
  const progress = new Map(live(parts.progress).map(p => [p.key, p.data!]))
  const state = { ...head, people: live(parts.members).map(m => m.data!), agents: live(parts.agents).map(a => a.data!),
    conversations: groups.filter(g => KNOWN_KINDS.has(g.kind)).map(conversation) } as SuperTabState
  if (head.projects) {
    const leadGroups = new Set(head.projects.map(p => p.leadConversationId))
    state.projects = head.projects.map(p => {
      const stored = progress.get(p.id)
      if (!stored) return p
      const reports = groups.filter(g => !isLeads(g) && !leadGroups.has(g.id) && (g.projectId ?? 'lead') === p.id).map(g => g.reportSeq)
      return { ...p, progress: { dirtyRevision: Math.max(0, ...reports), summarizedRevision: stored.summarizedFloor, since: stored.since,
        requestedRevision: stored.requestedFloor, ...(stored.requestedAt !== undefined ? { requestedAt: stored.requestedAt } : {}),
        ...(stored.requestMessageId !== undefined ? { requestMessageId: stored.requestMessageId } : {}) } }
    })
  }
  return Object.assign(state,
    nonEmpty('parkedConversations', groups.filter(g => !KNOWN_KINDS.has(g.kind)).map(conversation)),
    nonEmpty('starts', live(parts.starts).map(s => s.data!)),
    nonEmpty('machines', machines.flatMap(m => m.contribution ? [m.contribution] : [])),
    nonEmpty('harnessReservations', machines.flatMap(m => m.reservations.map(r => ({ machineId: m.machineId, ...r })))),
    nonEmpty('releasedHarnesses', machines.flatMap(m => m.released.map(harnessId => ({ machineId: m.machineId, harnessId })))),
    nonEmpty('closingSessions', machines.flatMap(m => m.closingSessions.map(c => ({ ...c, machineId: m.machineId })))),
    nonEmpty('machineCleanups', machines.flatMap(m => m.cleanups.map(c => ({ machineId: m.machineId, ...c })))))
}

/** Owners do not read private conversations (owner's decision, design section 8 Q3a). */
const PRIVATE_VISIBLE_TO_OWNERS = false
function canReadGroup(state: SuperTabState, actor: Actor, group: Conversation): boolean {
  if (isLeads(group)) return actor.kind === 'person' ? state.people.some(p => p.id === actor.userId) : !!ledProject(state, actor.agentId)
  const project = groupProject(state, group)
  if (!canReadProject(state, actor, project)) return false
  const audience = (group as Conversation & Pick<GroupData, 'audience'>).audience
  if (!audience) return true
  if (actor.kind === 'agent') return ledProject(state, actor.agentId)?.id === project.id
  const member = state.people.find(p => p.id === actor.userId)
  return audience.people.some(p => p.id === member?.id && p.generation === member.generation)
    || (PRIVATE_VISIBLE_TO_OWNERS && (actor.userId === project.ownerId || actor.userId === state.ownerId))
}

let last = 0
export const parts: PartsModule = {
  loadActive: missing('loadActive'), loadChanged: missing('loadChanged'), loadDormant: missing('loadDormant'), loadAll: missing('loadAll'),
  insertParts: missing('insertParts'), lastChangedAt: missing('lastChangedAt'), reassemble, split, canReadGroup,
  clock: { next: () => (last = Math.max(Date.now(), last + 1)) },
}
