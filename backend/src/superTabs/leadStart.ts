/** A project's Product Manager started by the Swarm on one of its machines (Dee, 10-29, option B), as a Buddy's start is
 *  (buddies.ts): recorded on the machine's contribution and launched by its host. Any machine of the Swarm takes it (Ken,
 *  10-29): on another person's Mac it runs in that Mac's Harness Team account when the account can take it now, else on the
 *  Mac itself, as its owner, whatever the Swarm's switch (machines.ts teamAccountRequired) says for workers. Its person always
 *  names the machine: only they know which one stays on (Ken, 10-29). Desktop's own-machine flow (project.create, a local
 *  start, agent.add) is unchanged. */
import { admitMachineStart, failTeamWork, machineContribution, projectFolder, projectsOnMachine, teamAccountPool, teamAccountSwarm, teamPoolOf, teamWorkRefusal,
  type ContributedMachine } from './machines.js'
import { actorKey, fail, person, type AgentStart, type AgentStartRequest, type Conversation, type Person, type SuperTabState } from './model.js'
import { projectsOf, type SwarmProject } from './projects.js'
import { failureNotice, publicReason } from './startFailure.js'

/** What a host reports it can launch: a Product Manager. A host from before it is never given one. */
export const LEAD_CAPABILITY = 'leadStart'
export const LEAD_NAME = 'Product Manager'
export const LEAD_REQUIREMENTS: AgentStartRequest['requirements'] = { memoryBytes: 2 * 1024 ** 3, diskBytes: 1024 ** 3, maxCpuPercent: 85,
  tools: ['git'], devices: [], quotaRequired: false }

/** Where the project's Product Manager is: starting on the machine its person named, started, or failed with the reason. */
export interface LeadPlacement {
  status: 'starting' | 'started' | 'failed'
  machineId: string
  machineName: string
  startId?: string
  reason?: string
}
/** `repositoryUrl`: the address its folder is cloned from, recorded for a project that has none yet. */
export interface LeadRequest { engine: string; model?: string; effort?: string; branchRef?: string; repositoryUrl?: string }

export interface LeadContext {
  now: number
  teamMachines?: readonly string[]
  otherWorkspaceMachines?: readonly string[]
  teamAccountsIdle?: boolean
}

/** The contribution [project]'s Product Manager runs in when placed on [machineId]: the machine itself for its own owner;
 *  on another person's Mac, its Harness Team account when that takes it now, else the Mac itself, as its owner. A Team
 *  account named itself keeps its rules and is refused with its reason. */
function leadPool(state: SuperTabState, project: SwarmProject, machineId: string, context: LeadContext): ContributedMachine {
  const named = machineContribution(state, machineId) ?? fail('MACHINE_NOT_LISTED', 'Add this machine to the Swarm first.', 403)
  if (named.contributorId === project.ownerId) return named
  const teamMachines = context.teamMachines ?? []
  // With no GitHub App, or outside the Swarms Team accounts are tried in, a Team account takes no work (machines.ts
  // teamMachineFor).
  const teamsWork = !context.teamAccountsIdle && teamAccountSwarm(state)
  const refusal = (pool: ContributedMachine) => teamWorkRefusal(pool, context.now, teamMachines.includes(pool.machineId), true,
    (context.otherWorkspaceMachines ?? []).includes(pool.machineId))
  if (teamAccountPool(named)) {
    if (!teamsWork) fail('TEAM_ACCOUNT_REQUIRED', `Harness Team accounts take no work in this Swarm yet, so ${named.name} runs only its owner's projects.`, 403)
    const why = refusal(named)
    if (why) failTeamWork(why)
    return named
  }
  const team = teamsWork ? teamPoolOf(state, named, teamMachines) : undefined
  return team && !refusal(team) && takesLead(state, project, team) ? team : named
}

/** Whether a Team account can host [project]'s Product Manager now: not paused, its host starts one, and it runs no other
 *  project's work (it will serve only this project, machines.ts productManagerOn). */
const takesLead = (state: SuperTabState, project: SwarmProject, pool: ContributedMachine): boolean => !pool.paused
  && !!pool.observation?.capabilities?.includes(LEAD_CAPABILITY) && ![...projectsOnMachine(state, pool.machineId)].some(id => id !== project.id)

/** Records the start of [project]'s Product Manager on [machineId] for [by], and marks the project starting. Refuses, and
 *  changes nothing, when that machine cannot take it now. */
export function placeLead(state: SuperTabState, project: SwarmProject, by: Person, machineId: string, request: LeadRequest,
  startId: string, context: LeadContext): AgentStart {
  const pool = leadPool(state, project, machineId, context)
  const start: AgentStartRequest = { conversationId: project.leadConversationId, machineId: pool.machineId, engine: request.engine,
    ...(request.model ? { model: request.model } : {}), ...(request.effort ? { effort: request.effort } : {}), name: LEAD_NAME,
    cwd: projectFolder(pool, project), worktree: true, ...(request.branchRef ? { branchRef: request.branchRef } : {}),
    requirements: LEAD_REQUIREMENTS, leadFor: { projectId: project.id, personId: by.id, generation: by.generation } }
  admitMachineStart(state, start, context.now, undefined, context.teamMachines, context.otherWorkspaceMachines)
  // Its Team account will serve only this project (machines.ts productManagerOn), so not one running another's work now.
  if (teamAccountPool(pool) && [...projectsOnMachine(state, pool.machineId)].some(id => id !== project.id)) {
    fail('TEAM_ACCOUNT_BUSY', `The Harness Team account on ${pool.name} runs other projects' agents, so it cannot host this ${LEAD_NAME} now.`, 409)
  }
  if (!pool.observation?.capabilities?.includes(LEAD_CAPABILITY)) {
    fail('HOST_OUTDATED', `Update Harness on ${pool.name} to run a ${LEAD_NAME} there.`, 409)
  }
  state.starts ??= []
  if (state.starts.filter(s => !s.harnessId && !s.error).length >= 32) fail('STARTS_PENDING', 'Reconcile pending agent starts before adding more.')
  const contributor = person(state, pool.contributorId)
  const recorded: AgentStart = { poolGeneration: pool.generation, id: startId, creationId: `super-${startId}`,
    actorKey: actorKey({ kind: 'person', userId: by.id, email: by.email }), contributorId: contributor.id,
    membershipGeneration: contributor.generation, machineOwnerId: pool.contributorId, hostGrant: null, request: start,
    harnessId: null, dispatched: false, error: null, requestedAt: context.now }
  state.starts.push(recorded)
  project.repository ??= { machineId: pool.machineId, cwd: start.cwd, repositoryUrl: request.repositoryUrl ?? null }
  project.lead = { status: 'starting', machineId: pool.machineId, machineName: pool.name, startId }
  return recorded
}

/** A start of [project]'s Product Manager not yet running or failed. */
export const leadStarting = (state: SuperTabState, projectId: string): AgentStart | undefined =>
  state.starts?.find(s => s.request.leadFor?.projectId === projectId && !s.harnessId && !s.error)

const placementOf = (state: SuperTabState, start: AgentStart): LeadPlacement | undefined => {
  const lead = start.request.leadFor && projectsOf(state).find(p => p.id === start.request.leadFor!.projectId)?.lead
  return lead?.startId === start.id ? lead : undefined
}

/** Its agent [agentId] joined the project's Lead conversation [home]: it leads it, unless a Lead was added there by hand
 *  meanwhile, which stays. The line its conversation shows. */
export function leadJoined(state: SuperTabState, start: AgentStart, home: Conversation, agentId: string): string {
  if (!home.leadId || !home.agentIds.includes(home.leadId)) home.leadId = agentId
  const placement = placementOf(state, start)
  if (placement) placement.status = 'started'
  return `${LEAD_NAME} started on ${placement?.machineName ?? state.machines?.find(m => m.machineId === start.request.machineId)?.name ?? 'its machine'}.`
}

/** Its start failed with [reason]: the project says why and waits for its person to name a machine again. The line its
 *  conversation shows; null for a start that is no longer the project's. */
export function leadStartFailed(state: SuperTabState, start: AgentStart, reason: string): string | null {
  const placement = placementOf(state, start)
  if (!placement) return null
  delete placement.startId
  // Every reader of the project reads its placement: the reason a group member may read, never the host's own words, which
  // can name a folder on the machine or a token problem (startFailure.ts). Its asker reads those on the start.
  Object.assign(placement, { status: 'failed', reason: publicReason(reason) })
  return failureNotice(start.request.name, reason)
}
