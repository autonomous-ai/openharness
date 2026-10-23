import { createHash } from 'node:crypto'
import type { RouteDecisionEffect } from './routeRecord.js'
import { agentDisplayName, assignAgentDisplayNames } from './agentNames.js'
import { downSince } from './machines.js'
import { canReadAgent, canReadProject, groupProject, placeRules, projectsOf, type ProjectVisibility, type SwarmProject } from './projects.js'

export type Role = 'owner' | 'collaborator' | 'viewer'
export interface Person { id: string; email: string; role: Role; generation: string }
export interface AgentConfiguration {
  engine: string
  model: string | null
  effort: string | null
  contextWindow: number | null
  engineVersion: string | null
}
export interface Agent {
  id: string
  projectId?: string
  machineId: string
  harnessId: string
  machineOwnerId: string
  contributorId: string
  membershipGeneration: string
  hostGrant?: string | null
  name: string
  /** A stable member name; native session and routing names remain in `name`. */
  displayName?: string
  /** Chosen at start and kept for the session. Absent reads as builder (agentRole); the Lead is derived from leadId. */
  role?: AgentRole
  /** A finished worker stays undecided even when its group receives a new brief. */
  workDecision?: 'awaiting' | 'keep' | 'stop'
  releaseId?: string
  /** Captured from the original Swarm launch, never inferred from a later live session with the same id. */
  startedSession?: { creationId: string; sessionId: string; createdAt: string }
  configuration: AgentConfiguration
  /** The last configuration operation fences delayed observations, including re-contribution. */
  configurationVersion?: string
  /** Fences a repeated Change agent report without rolling back later model observations. */
  replacement?: { previousHarnessId: string; harnessId: string }
  /** When a reading first showed its session gone or its host confirmed a stop; cleared when it is back (machines.ts). */
  downSince?: string
  /** The down time already named in the Lead's scheduled wake-up (projectUpdates.ts), so each time down is named once. */
  downNamed?: string
}
export type AgentRole = 'builder' | 'reviewer'
export const agentRole = (agent: Pick<Agent, 'role'>): AgentRole => agent.role ?? 'builder'
export interface AgentStartRequest {
  conversationId: string
  role?: AgentRole
  machineId: string
  engine: string
  model?: string
  effort?: string
  name: string
  cwd: string
  worktree: boolean
  branchRef?: string
  permissionMode?: string
  codexHome?: string
  gridModel?: string
  gridName?: string
  requirements: { memoryBytes: number; diskBytes: number; maxCpuPercent: number; tools: string[]; devices: string[]; quotaRequired: boolean }
}
export interface AgentStart {
  poolGeneration?: string
  poolSettled?: boolean
  routeDecisionId?: string
  id: string
  creationId: string
  actorKey: string
  contributorId: string
  membershipGeneration: string
  machineOwnerId: string
  hostGrant: string | null
  request: AgentStartRequest
  harnessId: string | null
  dispatched: boolean
  error: string | null
}
/** `needs_human`: the agent needs a person's decision (its result is the question). `blocked`: it cannot go on (its result
 * says why). Both stay active work; the machine running the agent alerts its Harness Pro (cli/src/superTabs/attention.ts). */
export type WorkStatus = 'planned' | 'working' | 'needs_human' | 'blocked' | 'review' | 'done' | 'stopped' | 'cancelled' | 'reconciling'
export interface Check {
  id: string
  description: string
  independent: boolean
  evidence: string | null
  passedBy: string | null
}
export interface Assignment {
  id: string
  agentId: string
  status: WorkStatus
  configuration: AgentConfiguration
  execution: { machineId: string; harnessId: string; machineOwnerId: string }
  result: string | null
  /** Explicit progress fences delayed recording gaps; absent on older backends. */
  recordingProgress?: { at: number; revision: number }
}
export interface WorkTask {
  goal: string
  changes: string
  constraints: string
  owns: string[]
}

export function renderWorkTask(task: WorkTask): string {
  return `Goal:\n${task.goal}\n\nChanges:\n${task.changes}\n\nConstraints:\n${task.constraints}\n\nOwns:\n${task.owns.map(area => `- ${area}`).join('\n')}`
}

export interface Conversation {
  id: string
  projectId?: string
  /** Stable, tab-local workgroup reference. Lead has no number. */
  number?: number
  title: string
  leadId: string | null
  agentIds: string[]
  archived: boolean
  brief: string
  task?: WorkTask
  /** A review group names the group whose work it reviews; only a Reviewer is assigned it, and a Reviewer nothing else. */
  reviewOf?: string
  checks: Check[]
  assignment: Assignment | null
  lastMessageSequence: number
}
export interface Invitation {
  id: string
  email: string
  role: 'collaborator' | 'viewer'
  conversationId: string
  expiresAt: number
}
export interface SuperTabState {
  version: 1
  id: string
  name: string
  project?: { machineId: string; cwd: string; repositoryUrl: string | null }
  projects?: SwarmProject[]
  ownerId: string
  environment: string
  /** Fields this tab overrides from its owner's account routing policy (routingPolicy.ts). */
  routingPolicy?: import('./routingPolicy.js').RoutingOverride
  /** The owner's routing rules (rules.ts); absent until the first is set. */
  rules?: import('./rules.js').SwarmRule[]
  /** Owner-only sharing configuration; visibleState always removes it. */
  sharing?: import('./sharing.js').SwarmSharing
  paused: boolean
  people: Person[]
  agents: Agent[]
  conversations: Conversation[]
  /** Deleting a project never makes its old # references name new work. */
  retiredConversationNumber?: number
  invitations: Invitation[]
  starts?: AgentStart[]
  machines?: import('./machines.js').ContributedMachine[]
  /** Slot claims survive person withdrawal; only host proof for this generation releases them. */
  harnessReservations?: Array<{ machineId: string; harnessId: string; generation: string; renewed: boolean }>
  /** Native stop receipts survive late replaceable machine observations. */
  releasedHarnesses?: Array<{ machineId: string; harnessId: string }>
}
export type Actor =
  | { kind: 'person'; userId: string; email: string }
  | { kind: 'agent'; agentId: string; machineOwnerId: string }
export interface Author { kind: 'person' | 'agent'; id: string; name: string; displayName?: string; membershipGeneration: string }
export interface MessageDraft {
  id: string
  conversationId: string
  author: Author
  text: string
  replyTo: string | null
  recipients: string[]
  /** Structured row kind for clients; `native` is written by native.ts, `route`/`route-override` by commands. */
  source?: Record<string, unknown>
  attachments?: import('./attachments.js').Attachment[]
}
export interface CommandEffects {
  state: SuperTabState
  messages: MessageDraft[]
  cancelledAgents: string[]
  previousAttempts: Array<{ conversationId: string; brief: string; checks: Check[]; assignment: Assignment }>
  routeDecisions: RouteDecisionEffect[]
  result: Record<string, unknown>
}
export class SuperTabError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message)
    this.name = 'SuperTabError'
  }
}
export function fail(code: string, message: string, status = 409): never { throw new SuperTabError(code, message, status) }
export const stableId = (...parts: string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)
export const actorKey = (actor: Actor): string => actor.kind === 'person' ? `person:${actor.userId}` : `agent:${actor.agentId}`
export const activeWork = (group: Conversation): boolean => !!group.assignment &&
  !['done', 'stopped', 'cancelled'].includes(group.assignment.status)

/** Old states derive pending decisions from their closed assignments; new states persist them on the worker. */
export function awaitingWorkers(state: SuperTabState, projectId: string): Agent[] {
  return state.agents.filter(a => {
    if (state.conversations.some(c => c.leadId === a.id) || state.conversations.some(c => activeWork(c) && c.assignment?.agentId === a.id)
      || reviewing(state, a.id)) return false
    const groups = state.conversations.filter(c => c.assignment?.agentId === a.id)
    return (a.projectId ?? groups.map(c => groupProject(state, c).id)[0] ?? 'lead') === projectId &&
      (a.workDecision === 'awaiting' || (!a.workDecision && groups.some(c => !activeWork(c))))
  })
}
export function requireWorkerDecisions(state: SuperTabState, actor: Actor, group: Conversation, reuseId?: string): void {
  if (actor.kind !== 'agent') return
  // A Reviewer that stays in the group being started or assigned is reused for it.
  const waiting = awaitingWorkers(state, groupProject(state, group).id)
    .filter(a => a.id !== reuseId && !(agentRole(a) === 'reviewer' && group.agentIds.includes(a.id)))
  if (waiting.length) fail('WORKER_DECISION_REQUIRED', `Decide what to do with ${waiting.map(a => a.displayName ?? a.name).join(', ')}: reuse, keep or stop. Prefer stop unless more work is coming soon.`)
}
/** A group's work ended: its worker, and each of its Reviewers not reviewing other active work, await the Lead's decision. */
export function finishWorker(state: SuperTabState, workerId: string, group?: Conversation): void {
  const ids = [workerId, ...(group?.agentIds ?? []).filter(id => id !== workerId &&
    state.agents.some(a => a.id === id && agentRole(a) === 'reviewer') && !reviewing(state, id))]
  for (const target of state.agents.filter(a => ids.includes(a.id))) {
    if (!state.conversations.some(c => c.leadId === target.id) && target.workDecision !== 'stop') target.workDecision = 'awaiting'
  }
}
/** A Reviewer is busy while any group it is in has active work. */
export function reviewing(state: SuperTabState, agentId: string): boolean {
  return state.agents.some(a => a.id === agentId && agentRole(a) === 'reviewer') &&
    state.conversations.some(c => activeWork(c) && c.agentIds.includes(agentId))
}

export function person(state: SuperTabState, id: string): Person {
  return state.people.find(p => p.id === id) ?? fail('FORBIDDEN', 'You no longer have access to this Super Tab.', 403)
}
export function agent(state: SuperTabState, id: string): Agent {
  const found = state.agents.find(a => a.id === id) ?? fail('AGENT_UNAVAILABLE', 'This agent is no longer in the Super Tab.')
  if (person(state, found.contributorId).generation !== found.membershipGeneration) {
    fail('AGENT_UNAVAILABLE', 'This agent must be shared again before it can participate.')
  }
  return found
}
export function conversation(state: SuperTabState, id: string): Conversation {
  return state.conversations.find(c => c.id === id) ?? fail('NOT_FOUND', 'This conversation is unavailable.', 404)
}

/** Legacy groups keep their append order, including archived groups. Persisted
 * numbers are never reassigned; the store serializes concurrent additions. */
export function numberConversations(state: SuperTabState): void {
  let next = nextConversationNumber(state)
  const leads = new Set(projectsOf(state).map(p => p.leadConversationId))
  for (const group of state.conversations) {
    if (!leads.has(group.id) && group.number == null) group.number = next++
  }
}
export function nextConversationNumber(state: SuperTabState): number {
  return Math.max(state.retiredConversationNumber ?? 0, 0, ...state.conversations.map(c => c.number ?? 0)) + 1
}
export function author(state: SuperTabState, actor: Actor, write = false): Author {
  if (actor.kind === 'person') {
    const member = person(state, actor.userId)
    if (write && member.role === 'viewer') fail('READ_ONLY', 'You have read-only access to this Super Tab.', 403)
    return { kind: 'person', id: member.id, name: member.email, membershipGeneration: member.generation }
  }
  const member = agent(state, actor.agentId)
  if (member.machineOwnerId !== actor.machineOwnerId) fail('FORBIDDEN', 'Only the execution host can speak as this agent.', 403)
  if (write && person(state, member.contributorId).role === 'viewer') fail('READ_ONLY', 'This contribution is read-only.', 403)
  return { kind: 'agent', id: member.id, name: member.name, displayName: agentDisplayName(state.agents, member.id), membershipGeneration: member.membershipGeneration }
}

export function createSuperTab(id: string, name: string, owner: { id: string; email: string }, environment: string, visibility?: ProjectVisibility): SuperTabState {
  const state: SuperTabState = {
    version: 1, id, name, ownerId: owner.id, environment, paused: false,
    people: [{ ...owner, email: owner.email.trim().toLowerCase(), role: 'owner', generation: id }],
    agents: [], invitations: [],
    conversations: [{ id: 'lead', title: 'Lead', leadId: null, agentIds: [], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 }],
  }
  // A new Swarm's first project starts in Default; only a project from before skill modes reads as Harness orchestration.
  state.projects = [{ ...projectsOf(state)[0]!, ...(visibility ? { visibility } : {}), skillMode: 'default' }]
  return state
}

/** Pending invitations are management data, not part of the shared conversation. */
export function visibleState(state: SuperTabState, actor: Actor, now = Date.now()): SuperTabState {
  author(state, actor)
  const visible = structuredClone(state)
  assignAgentDisplayNames(visible.agents)
  for (const target of visible.agents) {
    const since = downSince(state, target, now)
    if (since) target.downSince = since
    delete target.downNamed
  }
  delete visible.sharing
  delete visible.harnessReservations
  delete visible.releasedHarnesses
  numberConversations(visible)
  delete visible.retiredConversationNumber
  placeRules(visible)
  if (visible.rules) visible.rules = visible.rules.filter(r => projectsOf(state).some(p => p.id === r.projectId && canReadProject(state, actor, p)))
  if (visible.projects) {
    visible.projects = visible.projects.filter(p => canReadProject(state, actor, p))
    visible.conversations = visible.conversations.filter(c => canReadProject(state, actor, groupProject(state, c)))
    visible.agents = visible.agents.filter(a => canReadAgent(state, actor, a))
    visible.starts = visible.starts?.filter(s => visible.conversations.some(c => c.id === s.request.conversationId))
    if (!visible.projects.some(p => p.id === 'lead')) {
      delete visible.project
      visible.machines = visible.machines?.filter(m => m.scope === 'swarm')
    }
    const harnesses = new Set([...visible.agents.map(a => a.harnessId), ...(visible.starts ?? []).flatMap(s => s.harnessId ? [s.harnessId] : [])])
    for (const pool of visible.machines ?? []) {
      if (!pool.observation) continue
      pool.observation.runningHarnessIds = pool.observation.runningHarnessIds.filter(id => harnesses.has(id))
      pool.observation.stoppedHarnessIds = pool.observation.stoppedHarnessIds.filter(id => harnesses.has(id))
      if (pool.observation.stoppedReservations) pool.observation.stoppedReservations = pool.observation.stoppedReservations.filter(r => harnesses.has(r.harnessId))
    }
    visible.invitations = visible.invitations.filter(i => visible.conversations.some(c => c.id === i.conversationId))
  }
  for (const project of projectsOf(visible)) for (const target of awaitingWorkers(visible, project.id)) target.workDecision = 'awaiting'
  if (actor.kind !== 'person' || actor.userId !== state.ownerId) visible.invitations = []
  return visible
}
