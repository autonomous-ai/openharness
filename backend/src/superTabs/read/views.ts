/**
 * What one reader may see of a Swarm's parts (design 4.1): today's `visibleState` rules applied to the reassembled parts,
 * plus the private-conversation check, each record sent in its part's envelope. Time-based and cross-part values go only
 * in `derived`, so a part never changes without a new version (Lead's ruling).
 */
import { machineSuspensionReason, suspendedEngines } from '../engineHealth.js'
import { heldView } from '../heldReason.js'
import { seenMachineIds, visibleState, withSeenRequirement, type Actor, type Agent, type Conversation, type SuperTabState } from '../model.js'
import { availableSlots, slotCounter, type ContributedMachine } from '../machines.js'
import * as store from '../parts/index.js'
import type { Part, SwarmParts } from '../parts/index.js'
import { canReadGroup, canReadProject, projectsOf } from '../projects.js'
import { roleNameOf } from '../roleNames.js'
import { agentChatId, agentKind, inMyAgents, ledProjects } from '../agentKind.js'
import { personView, withAvatarView } from '../profile.js'
import { swarmUsernames } from '../usernames.js'
import type { AgentView, Derived, GroupView, HeadView, LivePart, MachineView, MemberView, ProgressView, StartView } from './contract.js'

export interface ReaderParts {
  head: LivePart<HeadView>
  members: LivePart<MemberView>[]
  agents: LivePart<AgentView>[]
  groups: LivePart<GroupView>[]
  machines: LivePart<MachineView>[]
  starts: LivePart<StartView>[]
  progress: LivePart<ProgressView>[]
}
export interface ReaderView {
  /** The reassembled stored state the view was made from, for the read checks of changed parts. */
  state: SuperTabState
  parts: ReaderParts
  derived: Derived
}
export interface ReadExtras {
  /** Each contributed machine's CLI version as its daemon last connected (store.ts machineVersions). */
  machineVersions?: Record<string, string>
}

const HEAD_FIELDS = ['version', 'id', 'name', 'project', 'projects', 'leadsConversationId', 'ownerId', 'environment',
  'paused', 'invitations', 'localModels', 'removedMachines', 'autoJoin'] as const

export const envelope = <T>(part: Pick<Part, 'key' | 'version' | 'changedAt'>, data: T): LivePart<T> =>
  ({ key: part.key, version: part.version, changedAt: part.changedAt, data })

/** A group as readers get it: its message counter, a dormant flag only when dormant, never the store's bookkeeping or the
 *  leaderboard's (the leaderboard read sums it), except when it shipped. */
export function groupView(group: Conversation, seenMachines: ReadonlySet<string>): GroupView {
  const { messageSeq, reportSeq: _report, lastActivityAt: _activity, ledger, talkedAt: _talkedAt, dormant, audience, ...rest } = withSeenRequirement(group, seenMachines)
  const readers = audience ? { audience } : {}
  const shippedAt = ledger?.shippedAt
  const held = heldView(group)
  const view: GroupView = { ...rest, messageSeq: messageSeq ?? 0, ...(dormant ? { dormant: true as const } : {}), ...(shippedAt === undefined ? {} : { shippedAt }),
    ...(held ? { held } : {}), ...readers }
  return view
}

/** A conversation's whole data as the reader may see it: a task's requirement lists only the machines they see. */
export function visibleGroupView(group: Conversation, _visibleAgents: ReadonlySet<string>, seenMachines: ReadonlySet<string>): GroupView {
  return groupView(group, seenMachines)
}

/** The machines a reader's view shows them: listed, or running an agent they see (model.ts seenMachineIds). */
export const seenIn = (parts: ReaderView['parts']): Set<string> =>
  new Set([...parts.machines.map(m => m.key), ...parts.agents.map(a => a.data.machineId)])

export function agentView(agent: Agent): AgentView {
  // A main project goes in the derived row, to its project's readers only: a private one's id says the project exists. A
  // Member's mark names it too (members.ts; security review 2 of #3575), and is its host's alone (read/hostRows.ts sends the
  // agent as stored).
  const { downNamed: _named, downSince: _since, limitedUntil: _limit, roleId: _role, mainProjectId: _main, member: _member, ...rest } = agent
  return withAvatarView(rest) as AgentView
}

/** `state` is the parts already reassembled, when the caller has it (a read reassembles once). */
export function readerView(parts: SwarmParts, actor: Actor, now: number, extras: ReadExtras, state = store.reassemble(parts, { share: true })): ReaderView {
  const visible = visibleState(state, actor, now)
  const groups = visible.conversations.filter(group => canReadGroup(state, actor, group))
  const readable = new Set(groups.map(g => g.id))
  const part = <T>(list: Part<T>[]) => { const keyed = new Map(list.map(p => [p.key, p])); return (key: string) => keyed.get(key)! }
  const agentPart = part(parts.agents), groupPart = part(parts.groups), machinePart = part(parts.machines), startPart = part(parts.starts)
  const head = Object.fromEntries(HEAD_FIELDS.filter(field => visible[field] !== undefined).map(field => [field, visible[field]])) as HeadView
  // The progress is the server's bookkeeping: no reader shows it.
  if (head.projects) head.projects = head.projects.map(({ progress: _progress, ...project }) => project)
  head.invitations = visible.invitations.filter(i => readable.has(i.conversationId))
  const projects = new Set((visible.projects ?? []).map(p => p.id)), seen = seenMachineIds(visible), names = swarmUsernames(state)
  return {
    state,
    parts: {
      head: envelope(parts.head, head),
      // Each person's username as the Swarm shows it, worked out in join order (the reassembled state's), never the order
      // member parts happen to load in.
      members: parts.members.filter(m => !m.deleted).map(m => envelope(m, { ...personView(m.data!), username: names.get(m.key) } as MemberView)),
      agents: visible.agents.map(a => envelope(agentPart(a.id), agentView(state.agents.find(s => s.id === a.id)!))),
      groups: groups.map(g => envelope(groupPart(g.id), groupView(g, seen))),
      machines: (visible.machines ?? []).map(m => envelope(machinePart(m.machineId), m)),
      starts: (visible.starts ?? []).filter(s => readable.has(s.request.conversationId)).map(s => envelope(startPart(s.id), s)),
      progress: parts.progress.filter(p => !p.deleted && projects.has(p.key)).map(p => envelope(p, progressView(p.data!))),
    },
    derived: derive(state, visible, actor, now, extras),
  }
}

export const progressView = (data: NonNullable<SwarmParts['progress'][number]['data']>): ProgressView =>
  ({ ...data, requestedAt: data.requestedAt ?? null })


function derive(state: SuperTabState, visible: SuperTabState, actor: Actor, now: number, extras: ReadExtras): Derived {
  // Every listed machine's slots from one pass over the Swarm's lists (machines.ts slotCounter).
  const slots = slotCounter(state)
  const machine = (pool: ContributedMachine) => {
    const stored = state.machines!.find(m => m.machineId === pool.machineId)!
    const version = extras.machineVersions?.[pool.machineId]
    const suspended = suspendedEngines(stored, now)
    const machineSuspended = machineSuspensionReason(stored, now)
    return [pool.machineId, { availableSlots: availableSlots(state, stored, slots(stored)), ...(version ? { clientVersion: version } : {}),
      ...(Object.keys(suspended).length ? { suspendedEngines: suspended } : {}), ...(machineSuspended ? { machineSuspended } : {}) }] as const
  }
  // Each visible agent's stored row, looked up once rather than once per derived field.
  const storedAgents = new Map(state.agents.map(a => [a.id, a]))
  // Whether the reader reads each project, worked out once for every agent naming it as its main project.
  const projectReads = new Map<string, boolean>()
  const readsProject = (id: string) => {
    let reads = projectReads.get(id)
    if (reads === undefined) {
      const project = projectsOf(state).find(p => p.id === id)
      projectReads.set(id, reads = !!project && canReadProject(state, actor, project))
    }
    return reads
  }
  // A Lead's main project is the one it leads; a Member's, the one its person picked (task #4540).
  const led = ledProjects(state)
  const shownMain = (agent: Agent) => { const main = led.get(agent.id) ?? agent.mainProjectId; return main && readsProject(main) ? main : null }
  return {
    agents: Object.fromEntries(visible.agents.map(seen => {
      const stored = storedAgents.get(seen.id)!
      return [seen.id, { downSince: seen.downSince ?? null, limitedUntil: seen.limitedUntil ?? null,
        workDecision: seen.workDecision === 'awaiting' && stored.workDecision !== 'awaiting' ? 'awaiting' as const : null,
        roleId: seen.roleId ?? null,
        // Derived on every read: who leads a project, and its role set, live outside the agent's own part.
        roleName: roleNameOf(state, stored),
        // What it is and where its person talks to it, for the left pane's "My agents" (agentKind.ts, task #4116).
        kind: agentKind(state, stored), chatId: agentChatId(state, stored, chat => canReadGroup(state, actor, chat)),
        // Whether it is in this reader's My agents, decided here so every client lists the same (task #4192).
        myAgent: inMyAgents(state, actor, stored),
        // Lead or Member, and its main project (agentKind.ts, task #4540).
        role: led.has(stored.id) ? 'lead' as const : 'member' as const, mainProjectId: shownMain(stored) }]
    })),
    machines: Object.fromEntries((visible.machines ?? []).map(machine)),
    ...(visible.otherProjectsWork ? { otherProjectsWork: visible.otherProjectsWork } : {}),
    ...(visible.pmAccounts ? { pmAccounts: visible.pmAccounts } : {}),
    ...(visible.ownerlessProjects ? { ownerlessProjects: visible.ownerlessProjects } : {}),
  }
}
