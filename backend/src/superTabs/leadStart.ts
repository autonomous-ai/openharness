/** A project's Product Manager started by the Swarm on one of its machines (Dee, 10-29, option B), as a Buddy's start is
 *  (buddies.ts): recorded on the machine's contribution and launched by its host. On another person's Mac it runs only in
 *  that Mac's Harness Team account, never as the Mac's owner, whatever the Swarm's switch (machines.ts teamAccountRequired)
 *  says for workers: a Product Manager reads people's private chats. With no machine named, it waits for the first free
 *  one. Desktop's own-machine flow (project.create, a local start, agent.add) is unchanged. */
import { admitMachineStart, failTeamWork, machineContribution, machineSlots, projectFolder, projectsOnMachine, teamAccountPool, teamAccountSwarm, teamPoolOf, teamWorkRefusal,
  type ContributedMachine } from './machines.js'
import { actorKey, fail, person, stableId, SuperTabError, type AgentStart, type AgentStartRequest, type Conversation, type Person, type SuperTabState } from './model.js'
import { mutableProjects, projectsOf, type SwarmProject } from './projects.js'

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
  const { reason: _reason, ...placement } = project.lead!
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

export const WAITING_TEXT = `Waiting for a machine to start the ${LEAD_NAME}.`

/** lead.start: [project]'s Product Manager on [machineId], refused with the reason when it cannot run there now; or, with
 *  none named, on the first free machine, else waiting for one (placeWaitingLeads). A request already waiting is replaced. */
export function requestLead(state: SuperTabState, project: SwarmProject, by: Person, machineId: string | null, request: LeadRequest,
  operationId: string, context: LeadContext): { startId: string; machineId: string } | { waiting: true } {
  project.lead = { status: 'waiting', requestedAt: context.now, requestedBy: { personId: by.id, generation: by.generation }, request, chosen: machineId }
  const start = machineId ? placeLead(state, project, by, machineId, request, operationId, context) : placeOnFree(state, project, by, operationId, context)
  return start ? { startId: start.id, machineId: start.request.machineId } : { waiting: true }
}

/** The machines a waiting Product Manager is tried on, in order: the project owner's own, then the most free agent slots, and
 *  last those a start from the queue already failed on. A Mac's Harness Team account is reached through its Mac. */
function candidates(state: SuperTabState, project: SwarmProject): string[] {
  const skipped = project.lead?.skipped ?? []
  const rank = (m: ContributedMachine) => [skipped.includes(m.machineId) ? 1 : 0, m.contributorId === project.ownerId ? 0 : 1, machineSlots(state, m) - m.maxAgents] as const
  return (state.machines ?? []).filter(m => !m.hostMachineId).map(m => ({ m, r: rank(m) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2]).map(({ m }) => m.machineId)
}

function placeOnFree(state: SuperTabState, project: SwarmProject, by: Person, startId: string, context: LeadContext): AgentStart | null {
  for (const machineId of candidates(state, project)) {
    try { return placeLead(state, project, by, machineId, project.lead!.request, startId, context) } catch (error) {
      // Each refusal comes before anything is written (placeLead), so the next machine sees the state unchanged.
      if (!(error instanceof SuperTabError)) throw error
    }
  }
  return null
}

/** On a machine's reading: each project whose Product Manager waits starts on the first free machine. The ids of those
 *  placed. Nothing is read or written for a Swarm with none waiting. */
export function placeWaitingLeads(state: SuperTabState, context: LeadContext): string[] {
  const waiting = projectsOf(state).filter(p => p.lead?.status === 'waiting')
  if (!waiting.length || state.paused) return []
  const placed: string[] = []
  for (const { id } of waiting) {
    const project = mutableProjects(state).find(p => p.id === id)!, lead = project.lead!
    const by = state.people.find(p => p.id === lead.requestedBy.personId && p.generation === lead.requestedBy.generation)
    if (!by) {
      Object.assign(lead, { status: 'failed', reason: 'The person who asked for it left the Swarm.' })
      continue
    }
    if (placeOnFree(state, project, by, stableId('lead-start', project.id, String(lead.requestedAt), String(context.now)), context)) placed.push(project.id)
  }
  return placed
}
