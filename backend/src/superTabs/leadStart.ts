/** A project's Product Manager started by the Swarm on one of its machines (Dee, 10-29, option B), as a Buddy's start is
 *  (buddies.ts): recorded on the machine's contribution and launched by its host. On another person's Mac it runs only in
 *  that Mac's Harness Team account, never as the Mac's owner, whatever the Swarm's switch (machines.ts teamAccountRequired)
 *  says for workers: a Product Manager reads people's private chats. With no machine named, it waits for the first free
 *  one. Desktop's own-machine flow (project.create, a local start, agent.add) is unchanged. */
import { admitMachineStart, failTeamWork, machineContribution, projectFolder, teamAccountSwarm, teamPoolOf, teamWorkRefusal,
  type ContributedMachine } from './machines.js'
import { actorKey, fail, person, type AgentStart, type AgentStartRequest, type Conversation, type Person, type SuperTabState } from './model.js'
import { projectsOf, type SwarmProject } from './projects.js'

/** What a host reports it can launch: a Product Manager. A host from before it is never given one. */
export const LEAD_CAPABILITY = 'leadStart'
export const LEAD_NAME = 'Product Manager'
export const LEAD_REQUIREMENTS: AgentStartRequest['requirements'] = { memoryBytes: 2 * 1024 ** 3, diskBytes: 1024 ** 3, maxCpuPercent: 85,
  tools: ['git'], devices: [], quotaRequired: false }

/** Where the project's Product Manager is: waiting for a machine, starting on one, started, or failed with the reason. */
export interface LeadPlacement {
  status: 'waiting' | 'starting' | 'started' | 'failed'
  requestedAt: number
  requestedBy: { personId: string; generation: string }
  request: LeadRequest
  /** The machine the person named, or null: the first free one. */
  chosen: string | null
  machineId?: string
  machineName?: string
  startId?: string
  reason?: string
  /** Machines a start from the queue already failed on, tried again only once no other is free. */
  skipped?: string[]
}
/** `repositoryUrl`: the address its folder is cloned from, recorded for a project that has none yet. */
export interface LeadRequest { engine: string; model?: string; effort?: string; branchRef?: string; repositoryUrl?: string }

export interface LeadContext {
  now: number
  teamMachines?: readonly string[]
  otherWorkspaceMachines?: readonly string[]
  teamAccountsIdle?: boolean
}

/** The contribution [project]'s Product Manager runs in when placed on [machineId]: the machine itself for its own owner,
 *  else the Mac's Harness Team account, refused with that account's reason. Never the Mac's owner's account. */
function leadPool(state: SuperTabState, project: SwarmProject, machineId: string, context: LeadContext): ContributedMachine {
  const named = machineContribution(state, machineId) ?? fail('MACHINE_NOT_LISTED', 'Add this machine to the Swarm first.', 403)
  if (named.contributorId === project.ownerId) return named
  const teamMachines = context.teamMachines ?? []
  // With no GitHub App, or outside the Swarms Team accounts are tried in, a Team account takes no work (machines.ts
  // teamMachineFor) and the Mac would run it itself: refused, where a worker would go ahead.
  if (context.teamAccountsIdle || !teamAccountSwarm(state)) {
    fail('TEAM_ACCOUNT_REQUIRED', `Harness Team accounts take no work in this Swarm yet, so ${named.name} runs only its owner's projects.`, 403)
  }
  const pool = named.hostMachineId ? named : teamPoolOf(state, named, teamMachines) ?? named
  const refusal = teamWorkRefusal(pool, context.now, teamMachines.includes(pool.machineId), true,
    (context.otherWorkspaceMachines ?? []).includes(pool.machineId))
  if (refusal) failTeamWork(refusal)
  return pool
}

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
  const { reason: _reason, ...placement } = project.lead ?? { requestedAt: context.now, requestedBy: { personId: by.id, generation: by.generation },
    request, chosen: machineId }
  project.lead = { ...placement, status: 'starting', machineId: pool.machineId, machineName: pool.name, startId }
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

/** Its start failed with [reason]: on the machine its person chose, the project says why and waits for them; placed from
 *  the queue, it waits for another machine. */
export function leadStartFailed(state: SuperTabState, start: AgentStart, reason: string): void {
  const placement = placementOf(state, start)
  if (!placement) return
  delete placement.startId
  if (placement.chosen !== null) Object.assign(placement, { status: 'failed', reason })
  else {
    Object.assign(placement, { status: 'waiting', reason, skipped: [...new Set([...placement.skipped ?? [], start.request.machineId])].slice(-16) })
    delete placement.machineId
    delete placement.machineName
  }
}
