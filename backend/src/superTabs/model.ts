import { createHash } from 'node:crypto'
import type { RouteDecisionEffect } from './routeRecord.js'
import { agentDisplayName, assignAgentDisplayNames } from './agentNames.js'
import { downSince, expireRemovals } from './machines.js'
import { agentProjectId, agentSetRole, canReadAgent, canReadGroup, canReadProject, groupProject, ledProject, placeRules, projectsOf, sharedWithLeads, skillSetOf, type ProjectVisibility, type SwarmProject } from './projects.js'

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
  /** The project's custom role it runs, chosen at start or assignment (projects.ts agentSetRole). */
  roleId?: string | null
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
  /** Written by the two-hour down wake-up that lost work replaced (liveness.ts); older states may still carry it, never shown. */
  downNamed?: string
  /** Its last task was lost (liveness.ts): routing leaves it out, even once that task is cancelled or reassigned, until it
   *  finishes a new task, a person assigns it work by hand, or its terminal is replaced (commands.ts). */
  lostTask?: { conversationId: string; assignmentId: string; reason: string; at: number }
  /** A usage limit seen on its terminal; routing skips the agent until then. Shown as null once passed (terminal.ts). */
  limitedUntil?: string | null
  /** Terminal alert episodes in progress, so each one posts a single row (terminal.ts). */
  alerting?: Array<'prompt' | 'limit' | 'model'>
  /** Set once its session is a Lead or in a private conversation, and kept until the session leaves: nobody but its
   *  machine's person watches it (projects.ts canWatchAgent). */
  confidential?: true
}
export type AgentRole = 'builder' | 'reviewer'
export const agentRole = (agent: Pick<Agent, 'role'>): AgentRole => agent.role ?? 'builder'
export interface AgentStartRequest {
  conversationId: string
  role?: AgentRole
  roleId?: string
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
  /** When its host was asked to launch it; a start not running 3 minutes later fails (liveness.ts). */
  dispatchedAt?: number
  error: string | null
}
/** `needs_human`: the agent needs a person's decision (its result is the question). `blocked`: it cannot go on (its result
 * says why). Both stay active work; the machine running the agent alerts its Harness Pro (cli/src/superTabs/attention.ts).
 * `lost`: its agent died, stalled or hit a limit (liveness.ts); no longer active, so the Lead assigns it again or cancels it. */
export type WorkStatus = 'planned' | 'working' | 'needs_human' | 'blocked' | 'review' | 'done' | 'stopped' | 'cancelled' | 'reconciling' | 'lost'
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
  /** Its agent owns it until then; progress renews it (liveness.ts). Absent on assignments from before leases. */
  leaseUntil?: number
  /** Its agent's last progress the lease saw, for the Lead's wake-up when it is lost. */
  progressAt?: number
  /** Why and when it was lost (status `lost`). */
  lost?: { reason: string; at: number }
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
  /** The Swarm-wide Leads conversation (syncLeads); absent on every project conversation. */
  kind?: 'leads'
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
  /** Linked GitHub pull requests, including links older than the latest message page. Absent in older snapshots. */
  pullRequestUrls?: string[]
  /** The last sequence given to a message here. Each conversation numbers its own messages (store by parts). */
  messageSeq?: number
  /** The sequence of its last message that counts toward its project's reports (projectUpdates.ts). */
  reportSeq?: number
  /** Out of first loads and changes: work done or cancelled and quiet for a day, or archived by hand. A message wakes it. */
  dormant?: boolean
  /** When its last message was written (ISO). */
  lastActivityAt?: string
  /** A private conversation: only these people and the project's Lead read it (projects.ts canReadGroup). */
  audience?: import('./parts/types.js').Audience
  /** The last attempt here that was lost: its agent's status and checks for it are refused, even after reassignment. */
  lostAttempt?: { id: string; agentId: string }
}

export function appendPullRequestUrls(group: Conversation, texts: Iterable<string | null | undefined>): void {
  const urls = new Set(group.pullRequestUrls ?? [])
  for (const text of texts) {
    if (!text) continue
    for (const match of text.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/pull\/([1-9][0-9]*)\b/g)) {
      if (Number(match[1]) <= Number.MAX_SAFE_INTEGER) urls.add(match[0])
    }
  }
  group.pullRequestUrls = [...urls]
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
  /** The Leads conversation, outside every project (syncLeads). */
  leadsConversationId?: string
  /** Pairs of tasks ("a:b", sorted ids) whose Leads were told their owned code overlaps, so each pair is told once. */
  overlapAlerts?: string[]
  /** Read-only, for a Lead's own reads (visibleState): the active work of the other projects it may know about. */
  otherProjectsWork?: OtherProjectWork[]
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
  /** Sessions of removed agents their host closes, listed to that host until it says they closed (agent.sessionClosed). */
  closingSessions?: Array<{ agentId: string; machineId: string; harnessId: string; machineOwnerId: string }>
  /** Removed machines whose host still has to clean up (machines.ts expireRemovals), listed only to that host. */
  machineCleanups?: import('./machines.js').MachineCleanup[]
  /** Conversations of a kind a later release added, set aside unchanged by a release that does not know it (parkLaterConversations). */
  parkedConversations?: Conversation[]
  /** The Local models add-on (docs/plans/2026-10-23-swarm-local-models.md): off until the owner turns it on, and only
   * then does anything call grid. The grid is kept when it is turned off, so turning it on again is instant. */
  localModels?: SwarmLocalModels
  /** The highest workgroup number ever given (store by parts); numbers are never given twice. */
  groupCounter?: number
  /** The tab revision when this Swarm was split into parts; every later message sequence is above it. */
  sequenceBase?: number
}
export interface SwarmLocalModels {
  /** The Swarm's own grid, minted on first turn-on and never renamed. */
  grid: string
  enabled: boolean
  /** What the owner's host last reported: the grid created and its members in step, or why not. */
  ready?: boolean
  error?: string
}
export interface OtherProjectWork {
  conversationId: string
  projectName: string
  title: string
  owns: string[]
  status: WorkStatus
  agentName: string
  /** The first pull request link in the assignment's result, when its agent reported one. */
  pr: string | null
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
  /** People a Lead tagged (mentions.ts). */
  mentions?: string[]
}
/** A notice for one agent alone (a skill update): delivered to it like any message, never shown to people or other agents. */
export const AGENT_ONLY = { kind: 'agent-only' }
export const agentOnly = (source: unknown): boolean => (source as { kind?: unknown } | null | undefined)?.kind === AGENT_ONLY.kind
export interface CommandEffects {
  state: SuperTabState
  messages: MessageDraft[]
  cancelledAgents: string[]
  previousAttempts: Array<{ conversationId: string; brief: string; checks: Check[]; assignment: Assignment }>
  routeDecisions: RouteDecisionEffect[]
  result: Record<string, unknown>
  /** A terminal request or its answer, written outside the tab state by the store (terminal.ts). */
  terminal?: import('./terminal.js').TerminalEffect
  /** Decisions asked, and a decision answered, written outside the tab state by the store (decisions.ts). */
  decisions?: import('./decisions.js').DecisionDraft[]
  decisionAnswer?: import('./decisions.js').DecisionAnswer
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
  !['done', 'stopped', 'cancelled', 'lost'].includes(group.assignment.status)

/** Old states derive pending decisions from their closed assignments; new states persist them on the worker. */
export function awaitingWorkers(state: SuperTabState, projectId: string): Agent[] {
  return state.agents.filter(a => {
    if (state.conversations.some(c => c.leadId === a.id) || state.conversations.some(c => activeWork(c) && c.assignment?.agentId === a.id)
      || reviewing(state, a.id)) return false
    // A lost task's agent is not waiting for a decision, even once the task is cancelled: it may be gone, and it must not
    // hold up the next assignment.
    const groups = state.conversations.filter(c => c.assignment?.agentId === a.id && !c.assignment.lost)
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

export const isLeads = (group: Conversation): boolean => group.kind === 'leads'

const KNOWN_KINDS: Record<NonNullable<Conversation['kind']>, true> = { leads: true }
/** During a rolling deploy the previous release reads what the next one wrote. A conversation kind it does not know
 *  belongs to no project it can check, so it waits here unchanged, and the release that knows it puts it back. */
export function parkLaterConversations(state: SuperTabState): void {
  const all = [...state.conversations, ...state.parkedConversations ?? []]
  const known = (c: Conversation) => c.kind == null || Object.hasOwn(KNOWN_KINDS, c.kind)
  state.conversations = all.filter(known)
  const parked = all.filter(c => !known(c))
  if (parked.length) state.parkedConversations = parked
  else delete state.parkedConversations
}

/** Work a Lead of another project should know about: assigned and moving, not finished, stuck or archived. */
export const crossProjectActive = (group: Conversation): boolean => !group.archived && !isLeads(group) && !group.audience
  && ['working', 'review', 'needs_human'].includes(group.assignment?.status ?? '')

/** The active work of the other projects a project's Lead may know about (shared with the read API, design 7.2). */
export function otherProjectsWork(state: SuperTabState, own: SwarmProject): OtherProjectWork[] {
  return state.conversations.filter(crossProjectActive).flatMap(group => {
    const project = groupProject(state, group), assignment = group.assignment!
    if (project.id === own.id || !sharedWithLeads(project)) return []
    const worker = state.agents.find(a => a.id === assignment.agentId)
    return [{ conversationId: group.id, projectName: project.name, title: group.title, owns: group.task?.owns ?? [], status: assignment.status,
      agentName: worker ? worker.displayName ?? worker.name : '', pr: assignment.result?.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/)?.[0] ?? null }]
  })
}

/** The Swarm-wide conversation where Leads agree an order across projects and every person reads along. It belongs to no
 *  project and stays after the project conversations; an older Swarm gets it on its next read or write. Its members are
 *  always the projects' current Leads, so only they receive what is posted there. */
export function syncLeads(state: SuperTabState): void {
  const id = state.leadsConversationId ??= stableId(state.id, 'leads')
  const group = state.conversations.find(c => c.id === id) ?? { id, kind: 'leads', title: 'Leads', leadId: null, agentIds: [],
    archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 }
  state.conversations = [...state.conversations.filter(c => c !== group), group]
  group.agentIds = state.agents.filter(a => ledProject(state, a.id)).map(a => a.id)
}

/** Legacy groups keep their append order, including archived groups. Persisted
 * numbers are never reassigned; the store serializes concurrent additions. */
export function numberConversations(state: SuperTabState): void {
  let next = nextConversationNumber(state)
  const leads = new Set(projectsOf(state).map(p => p.leadConversationId))
  for (const group of state.conversations) {
    if (!leads.has(group.id) && !isLeads(group) && group.number == null) state.groupCounter = group.number = next++
  }
}
/** The store by parts keeps the highest number ever given (`groupCounter`): a dormant group is not loaded, and its
 *  number must not be given again. */
export function nextConversationNumber(state: SuperTabState): number {
  return Math.max(state.groupCounter ?? 0, state.retiredConversationNumber ?? 0, 0,
    ...[...state.conversations, ...state.parkedConversations ?? []].map(c => c.number ?? 0)) + 1
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

/** The Swarm's grid name: `swarm-` and 12 hex of sha256(tab id). Derived so it is reproducible when supported; the
 * stored value is authoritative and never renamed. */
export function swarmGridName(tabId: string): string {
  return `swarm-${createHash('sha256').update(tabId).digest('hex').slice(0, 12)}`
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
  // Its models are on from the start (owner, 2026-10-24): the owner's computer makes the Swarm's grid in the background
  // (CLI `superTabs/swarmGrids.ts`) and reports how it went. Fire and forget: a grid that could not be made leaves the
  // Swarm as it is, and the owner's first share or run in Manage models sets the models up then.
  state.localModels = { grid: swarmGridName(id), enabled: true }
  syncLeads(state)
  return state
}

/** Pending invitations are management data, not part of the shared conversation. */
export function visibleState(state: SuperTabState, actor: Actor, now = Date.now()): SuperTabState {
  author(state, actor)
  const visible = structuredClone(state)
  // A dormant conversation is read on demand, never in a whole-Swarm read (spec, Archive); a command may still load one.
  visible.conversations = visible.conversations.filter(c => !c.dormant)
  syncLeads(visible)
  // People and Leads read the Leads conversation; it is not there for any other agent.
  if (actor.kind === 'agent' && !ledProject(visible, actor.agentId)) {
    visible.conversations = visible.conversations.filter(c => !isLeads(c))
    delete visible.leadsConversationId
  }
  assignAgentDisplayNames(visible.agents)
  const led = actor.kind === 'agent' ? ledProject(visible, actor.agentId) : undefined
  if (led) visible.otherProjectsWork = otherProjectsWork(visible, led)
  for (const target of visible.agents) {
    const since = downSince(state, target, now)
    if (since) target.downSince = since
    delete target.downNamed
    if (target.limitedUntil && Date.parse(target.limitedUntil) <= now) target.limitedUntil = null
  }
  delete visible.sharing
  delete visible.harnessReservations
  delete visible.releasedHarnesses
  delete visible.overlapAlerts
  // Only that machine's host roster lists them (read/hostRows.ts); a removed private agent's session is not every member's.
  delete visible.closingSessions
  // A failing privacy check's detail is its contributor's: an error from the check can name paths on their Mac. Everyone
  // else reads which item failed (machines.ts teamWorkRefusal).
  for (const pool of visible.machines ?? []) {
    const privacy = pool.observation?.privacy
    if (privacy && 'detail' in privacy && !(actor.kind === 'person' && actor.userId === pool.contributorId)) delete (privacy as { detail?: string }).detail
  }
  expireRemovals(visible, now)
  // A read never hands out the cleanup records it just applied (read/hostRows.ts delivers them to the machine's host).
  delete visible.machineCleanups
  delete visible.parkedConversations
  numberConversations(visible)
  delete visible.retiredConversationNumber
  delete visible.groupCounter
  delete visible.sequenceBase
  placeRules(visible)
  if (visible.rules) visible.rules = visible.rules.filter(r => projectsOf(state).some(p => p.id === r.projectId && canReadProject(state, actor, p)))
  if (visible.projects) {
    visible.projects = visible.projects.filter(p => canReadProject(state, actor, p))
    visible.conversations = visible.conversations.filter(c => isLeads(c) || canReadGroup(state, actor, c))
    visible.agents = visible.agents.filter(a => canReadAgent(state, actor, a))
    for (const group of visible.conversations.filter(isLeads)) group.agentIds = group.agentIds.filter(id => visible.agents.some(a => a.id === id))
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
      if (pool.observation.harnessProgress) pool.observation.harnessProgress = Object.fromEntries(Object.entries(pool.observation.harnessProgress).filter(([id]) => harnesses.has(id)))
      if (pool.observation.stoppedReservations) pool.observation.stoppedReservations = pool.observation.stoppedReservations.filter(r => harnesses.has(r.harnessId))
    }
    visible.invitations = visible.invitations.filter(i => visible.conversations.some(c => c.id === i.conversationId))
  }
  for (const project of projectsOf(visible)) for (const target of awaitingWorkers(visible, project.id)) target.workDecision = 'awaiting'
  for (const project of visible.projects ?? []) project.skillSet = skillSetOf(project)
  // On Custom every agent shows the role it runs, null when its kind has none; elsewhere a role id means nothing yet.
  for (const target of visible.agents) {
    const home = projectsOf(state).find(p => p.id === agentProjectId(state, target))
    if (home && skillSetOf(home) === 'custom') target.roleId = agentSetRole(state, home, target)?.id ?? null
    else delete target.roleId
  }
  if (actor.kind !== 'person' || actor.userId !== state.ownerId) visible.invitations = []
  return visible
}
