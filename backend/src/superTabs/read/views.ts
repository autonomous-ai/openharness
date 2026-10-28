/**
 * What one reader may see of a Swarm's parts (design 4.1): today's `visibleState` rules applied to the reassembled parts,
 * plus the private-conversation check, each record sent in its part's envelope. Time-based and cross-part values go only
 * in `derived`, so a part never changes without a new version (Lead's ruling).
 */
import { isLeads, seenMachineIds, visibleState, withSeenRequirement, type Actor, type Agent, type Conversation, type SuperTabState } from '../model.js'
import { machineSlots, teamAccountRequired, teamWorkRefusal, type ContributedMachine } from '../machines.js'
import * as store from '../parts/index.js'
import type { Part, SwarmParts } from '../parts/index.js'
import { canReadGroup } from '../projects.js'
import { withAvatarView } from '../profile.js'
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
  /** A person's open mentions, counted by the store. */
  mentionsWaiting?: number
  /** A person's open decisions (decisions.ts). */
  decisionsWaiting?: number
  /** Which ones they are, as a digest (decisions.ts). */
  decisionsDigest?: string
}

const HEAD_FIELDS = ['version', 'id', 'name', 'project', 'projects', 'leadsConversationId', 'ownerId', 'environment',
  'routingPolicy', 'rules', 'paused', 'invitations', 'localModels'] as const

export const envelope = <T>(part: Pick<Part, 'key' | 'version' | 'changedAt'>, data: T): LivePart<T> =>
  ({ key: part.key, version: part.version, changedAt: part.changedAt, data })

/** A group as readers get it: its message counter, a dormant flag only when dormant, never the store's bookkeeping or the
 *  leaderboard's (the leaderboard read sums it). */
export function groupView(group: Conversation, seenMachines: ReadonlySet<string>): GroupView {
  const { messageSeq, reportSeq: _report, lastActivityAt: _activity, ledger: _ledger, dormant, audience, ...rest } = withSeenRequirement(group, seenMachines)
  return { ...rest, messageSeq: messageSeq ?? 0, ...(dormant ? { dormant: true as const } : {}), ...(audience ? { audience } : {}) }
}

/** A conversation's whole data as the reader may see it: the Leads conversation lists only the agents the reader can see, and a
 *  task's requirement only the machines they see. */
export function visibleGroupView(group: Conversation, visibleAgents: ReadonlySet<string>, seenMachines: ReadonlySet<string>): GroupView {
  return groupView(isLeads(group) ? { ...group, agentIds: group.agentIds.filter(id => visibleAgents.has(id)) } : group, seenMachines)
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
  if (head.projects) head.projects = head.projects.map(({ progress: _progress, ...project }) => project)
  head.invitations = visible.invitations.filter(i => readable.has(i.conversationId))
  const projects = new Set((visible.projects ?? []).map(p => p.id)), seen = seenMachineIds(visible)
  return {
    state,
    parts: {
      head: envelope(parts.head, head),
      members: parts.members.filter(m => !m.deleted).map(m => envelope(m, withAvatarView(m.data!) as MemberView)),
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
  const machine = (pool: ContributedMachine) => {
    const stored = state.machines!.find(m => m.machineId === pool.machineId)!
    const refusal = teamWorkRefusal(stored, now, extras.teamMachines.includes(pool.machineId), teamAccountRequired(state))
    return [pool.machineId, { availableSlots: Math.max(0, pool.maxAgents - machineSlots(state, stored)),
      teamWork: refusal ? { allowed: false as const, ...refusal } : { allowed: true as const } }] as const
  }
  return {
    agents: Object.fromEntries(visible.agents.map(seen => [seen.id, { downSince: seen.downSince ?? null, limitedUntil: seen.limitedUntil ?? null,
      workDecision: seen.workDecision === 'awaiting' && state.agents.find(a => a.id === seen.id)!.workDecision !== 'awaiting' ? 'awaiting' as const : null,
      roleId: seen.roleId ?? null }])),
    machines: Object.fromEntries((visible.machines ?? []).map(machine)),
    ...(visible.otherProjectsWork ? { otherProjectsWork: visible.otherProjectsWork } : {}),
    ...(actor.kind === 'person' && extras.mentionsWaiting !== undefined ? { mentionsWaiting: extras.mentionsWaiting } : {}),
    ...(actor.kind === 'person' && extras.decisionsWaiting !== undefined ? { decisionsWaiting: extras.decisionsWaiting } : {}),
    ...(actor.kind === 'person' && extras.decisionsDigest !== undefined ? { decisionsDigest: extras.decisionsDigest } : {}),
  }
}
