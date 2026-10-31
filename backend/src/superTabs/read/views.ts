/**
 * What one reader may see of a Swarm's parts (design 4.1): today's `visibleState` rules applied to the reassembled parts,
 * plus the private-conversation check, each record sent in its part's envelope. Time-based and cross-part values go only
 * in `derived`, so a part never changes without a new version (Lead's ruling).
 */
import { suspendedEngines } from '../engineHealth.js'
import { leadChoices } from '../leadStart.js'
import { isBuddyChat, isBuddyReader } from '../buddies.js'
import { agentForBuddy, agentWithoutMachine, groupWithoutMachines, machineHiddenFrom, seenMachineIds, visibleState, withSeenRequirement, type Actor, type Agent, type Conversation, type SuperTabState } from '../model.js'
import { slotCounter, machineTeamWork, teamAccountSwarm, type ContributedMachine } from '../machines.js'
import * as store from '../parts/index.js'
import type { Part, SwarmParts } from '../parts/index.js'
import { canReadGroup } from '../projects.js'
import { coordinatorNameOf, roleNameOf } from '../instructions.js'
import { withAvatarView } from '../profile.js'
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
  /** Machines whose account row is a Harness Team account (store read helper). */
  teamMachines: string[]
  /** Machines also contributed to a Swarm of another Workspace (store.ts otherWorkspaceMachines). */
  otherWorkspaceMachines?: string[]
  /** No Harness GitHub App on this server, so Team accounts take no work (store.ts teamAccountsIdle). */
  teamAccountsIdle?: boolean
  /** Each contributed machine's CLI version as its daemon last connected (store.ts machineFacts). */
  machineVersions?: Record<string, string>
  /** A person's open mentions, counted by the store. */
  mentionsWaiting?: number
  /** Which ones they are, as a digest (mentions.ts). */
  mentionsDigest?: string
  /** A person's open decisions (decisions.ts). */
  decisionsWaiting?: number
  /** Which ones they are, as a digest (decisions.ts). */
  decisionsDigest?: string
  /** Which of their Activity rows are unread, as a digest (activity.ts). */
  activityDigest?: string
}

const HEAD_FIELDS = ['version', 'id', 'name', 'project', 'projects', 'leadsConversationId', 'ownerId', 'environment',
  'routingPolicy', 'rules', 'paused', 'invitations', 'localModels', 'workspaceId', 'workspaceVisibility', 'buddies'] as const

export const envelope = <T>(part: Pick<Part, 'key' | 'version' | 'changedAt'>, data: T): LivePart<T> =>
  ({ key: part.key, version: part.version, changedAt: part.changedAt, data })

/** A group as readers get it: its message counter, a dormant flag only when dormant, never the store's bookkeeping or the
 *  leaderboard's (the leaderboard read sums it). */
export function groupView(group: Conversation, seenMachines: ReadonlySet<string>): GroupView {
  const { messageSeq, reportSeq: _report, lastActivityAt: _activity, ledger: _ledger, proposals: _proposals, dormant, audience, ...rest } = withSeenRequirement(group, seenMachines)
  // A Buddy chat names its owner instead of an audience: an app from before Buddies takes a private chat of the reader
  // alone for their Chat with PM, and would send what they write for the PM to their Buddy instead (buddies.ts).
  const readers = isBuddyChat(group) ? { buddyOwnerId: audience!.people[0]!.id } : audience ? { audience } : {}
  return { ...rest, messageSeq: messageSeq ?? 0, ...(dormant ? { dormant: true as const } : {}), ...readers }
}

/** A conversation's whole data as the reader may see it: a task's requirement lists only the machines they see. */
export function visibleGroupView(group: Conversation, _visibleAgents: ReadonlySet<string>, seenMachines: ReadonlySet<string>): GroupView {
  return groupView(group, seenMachines)
}

/** The machines a reader's view shows them: listed, or running an agent they see (model.ts seenMachineIds). */
export const seenIn = (parts: ReaderView['parts']): Set<string> =>
  new Set([...parts.machines.map(m => m.key), ...parts.agents.map(a => a.data.machineId)])

export function agentView(agent: Agent): AgentView {
  const { downNamed: _named, downSince: _since, limitedUntil: _limit, roleId: _role, ...rest } = agent
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
  // Every project names its coordinator; one from before the field reads as the Product Manager (instructions.ts).
  if (head.projects) head.projects = head.projects.map(({ progress: _progress, ...project }) => ({ ...project, coordinatorName: coordinatorNameOf(project) }))
  head.invitations = visible.invitations.filter(i => readable.has(i.conversationId))
  const projects = new Set((visible.projects ?? []).map(p => p.id)), seen = seenMachineIds(visible), names = swarmUsernames(state)
  const buddy = isBuddyReader(state, actor)
  return {
    state,
    parts: {
      head: envelope(parts.head, head),
      // Each person's username as the Swarm shows it, worked out in join order (the reassembled state's), never the order
      // member parts happen to load in.
      members: parts.members.filter(m => !m.deleted).map(m => envelope(m, { ...withAvatarView(m.data!), username: names.get(m.key) } as MemberView)),
      agents: visible.agents.map(a => {
        const stored = state.agents.find(s => s.id === a.id)!
        const view = agentView(stored)
        return envelope(agentPart(a.id), buddy && actor.kind === 'agent' ? agentForBuddy(view, actor.agentId)
          : machineHiddenFrom(state, actor, stored) ? agentWithoutMachine(view) : view)
      }),
      groups: groups.map(g => envelope(groupPart(g.id), groupView(buddy ? groupWithoutMachines(g) : g, seen))),
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
  // Where New Project's Product Manager would run on each teammate's machine, decided as its start decides (leadStart.ts).
  const leads = actor.kind === 'person' && state.people.find(p => p.id === actor.userId)?.role !== 'viewer'
    ? leadChoices(state, actor.userId, { now, teamMachines: extras.teamMachines, otherWorkspaceMachines: extras.otherWorkspaceMachines ?? [],
      ...(extras.teamAccountsIdle ? { teamAccountsIdle: true } : {}) })
    : {}
  // Every listed machine's slots from one pass over the Swarm's lists (machines.ts slotCounter).
  const slots = slotCounter(state)
  const machine = (pool: ContributedMachine) => {
    const stored = state.machines!.find(m => m.machineId === pool.machineId)!
    const refusal = machineTeamWork(state, stored, now, extras.teamMachines, extras.otherWorkspaceMachines ?? [])
    const version = extras.machineVersions?.[pool.machineId]
    const suspended = suspendedEngines(stored, now)
    return [pool.machineId, { availableSlots: Math.max(0, pool.maxAgents - slots(stored)),
      teamWork: refusal ? { allowed: false as const, ...refusal } : { allowed: true as const }, ...(version ? { clientVersion: version } : {}),
      ...(Object.keys(suspended).length ? { suspendedEngines: suspended } : {}), ...(leads[pool.machineId] ? { lead: leads[pool.machineId] } : {}) }] as const
  }
  return {
    agents: Object.fromEntries(visible.agents.map(seen => [seen.id, { downSince: seen.downSince ?? null, limitedUntil: seen.limitedUntil ?? null,
      workDecision: seen.workDecision === 'awaiting' && state.agents.find(a => a.id === seen.id)!.workDecision !== 'awaiting' ? 'awaiting' as const : null,
      roleId: seen.roleId ?? null,
      // Derived on every read: who leads a project, and its role set, live outside the agent's own part.
      roleName: roleNameOf(state, state.agents.find(a => a.id === seen.id)!) }])),
    machines: Object.fromEntries((visible.machines ?? []).map(machine)),
    ...(visible.otherProjectsWork ? { otherProjectsWork: visible.otherProjectsWork } : {}),
    ...(actor.kind === 'person' && extras.mentionsWaiting !== undefined ? { mentionsWaiting: extras.mentionsWaiting } : {}),
    ...(actor.kind === 'person' && extras.mentionsDigest !== undefined ? { mentionsDigest: extras.mentionsDigest } : {}),
    ...(actor.kind === 'person' && extras.decisionsWaiting !== undefined ? { decisionsWaiting: extras.decisionsWaiting } : {}),
    ...(actor.kind === 'person' && extras.decisionsDigest !== undefined ? { decisionsDigest: extras.decisionsDigest } : {}),
    ...(actor.kind === 'person' && extras.activityDigest !== undefined ? { activityDigest: extras.activityDigest } : {}),
    ...(teamAccountSwarm(state) ? {} : { teamAccounts: false as const }),
    threadSessions: true as const,
    sessionsFromChat: true as const,
  }
}
