import { createHash } from 'node:crypto'
import type { RouteDecisionEffect } from './routeRecord.js'

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
  machineId: string
  harnessId: string
  machineOwnerId: string
  contributorId: string
  membershipGeneration: string
  hostGrant?: string | null
  name: string
  configuration: AgentConfiguration
  /** The last configuration operation fences delayed observations, including re-contribution. */
  configurationVersion?: string
}
export interface AgentStartRequest {
  conversationId: string
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
export type WorkStatus = 'planned' | 'working' | 'needs_human' | 'review' | 'done' | 'stopped' | 'reconciling'
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
}
export interface Conversation {
  id: string
  title: string
  leadId: string | null
  agentIds: string[]
  archived: boolean
  brief: string
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
  ownerId: string
  environment: string
  /** Fields this tab overrides from its owner's account routing policy (routingPolicy.ts). */
  routingPolicy?: import('./routingPolicy.js').RoutingOverride
  paused: boolean
  people: Person[]
  agents: Agent[]
  conversations: Conversation[]
  invitations: Invitation[]
  starts?: AgentStart[]
}
export type Actor =
  | { kind: 'person'; userId: string; email: string }
  | { kind: 'agent'; agentId: string; machineOwnerId: string }
export interface Author { kind: 'person' | 'agent'; id: string; name: string; membershipGeneration: string }
export interface MessageDraft {
  id: string
  conversationId: string
  author: Author
  text: string
  replyTo: string | null
  recipients: string[]
  /** Structured row kind for clients; `native` is written by native.ts, `route`/`route-override` by commands. */
  source?: Record<string, unknown>
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
  !['done', 'stopped'].includes(group.assignment.status)

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
export function author(state: SuperTabState, actor: Actor, write = false): Author {
  if (actor.kind === 'person') {
    const member = person(state, actor.userId)
    if (write && member.role === 'viewer') fail('READ_ONLY', 'You have read-only access to this Super Tab.', 403)
    return { kind: 'person', id: member.id, name: member.email, membershipGeneration: member.generation }
  }
  const member = agent(state, actor.agentId)
  if (member.machineOwnerId !== actor.machineOwnerId) fail('FORBIDDEN', 'Only the execution host can speak as this agent.', 403)
  if (write && person(state, member.contributorId).role === 'viewer') fail('READ_ONLY', 'This contribution is read-only.', 403)
  return { kind: 'agent', id: member.id, name: member.name, membershipGeneration: member.membershipGeneration }
}

export function createSuperTab(id: string, name: string, owner: { id: string; email: string }, environment: string): SuperTabState {
  return {
    version: 1, id, name, ownerId: owner.id, environment, paused: false,
    people: [{ ...owner, email: owner.email.trim().toLowerCase(), role: 'owner', generation: id }],
    agents: [], invitations: [],
    conversations: [{ id: 'lead', title: 'Lead', leadId: null, agentIds: [], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 }],
  }
}

/** Pending invitations are management data, not part of the shared conversation. */
export function visibleState(state: SuperTabState, actor: Actor): SuperTabState {
  author(state, actor)
  const visible = structuredClone(state)
  if (actor.kind !== 'person' || actor.userId !== state.ownerId) visible.invitations = []
  return visible
}
