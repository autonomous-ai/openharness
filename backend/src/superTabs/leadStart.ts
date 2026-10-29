/** A project's Product Manager started by the Swarm on one of its machines (Dee, 10-29, option B), as a Buddy's start is
 *  (buddies.ts): recorded on the machine's contribution and launched by its host. Any machine of the Swarm takes it (Ken,
 *  10-29): on another person's Mac it runs in that Mac's Harness Team account when the account can take it now, else on the
 *  Mac itself, as its owner, whatever the Swarm's switch (machines.ts teamAccountRequired) says for workers. Its person always
 *  names the machine: only they know which one stays on (Ken, 10-29). Desktop's own-machine flow (project.create, a local
 *  start, agent.add) is unchanged. */
import { admitMachineStart, contributedEngines, failTeamWork, machineContribution, projectFolder, projectsOnMachine, teamAccountPool, teamAccountSwarm, teamPoolOf,
  teamWorkRefusal, type ContributedMachine } from './machines.js'
import { actorKey, fail, person, SuperTabError, type AgentStart, type AgentStartRequest, type Conversation, type Person, type SuperTabState } from './model.js'
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

/** The engines a Product Manager runs on, as people read them. */
const LEAD_ENGINES = { claude: 'Claude Code', codex: 'Codex' } as const

/** Admits [project]'s Product Manager as [start] asks, in [pool], or throws why not. Writes nothing. */
function admitLead(state: SuperTabState, project: SwarmProject, pool: ContributedMachine, start: AgentStartRequest, context: LeadContext): void {
  if (!contributedEngines(pool).includes(start.engine)) {
    fail('ENGINE_NOT_OFFERED', `${LEAD_ENGINES[start.engine as keyof typeof LEAD_ENGINES] ?? start.engine} isn’t offered on ${pool.name}.`, 403)
  }
  admitMachineStart(state, start, context.now, undefined, context.teamMachines, context.otherWorkspaceMachines, project)
  // Its Team account will serve only this project (machines.ts productManagerOn), so not one running another's work now.
  if (teamAccountPool(pool) && [...projectsOnMachine(state, pool.machineId)].some(id => id !== project.id)) {
    fail('TEAM_ACCOUNT_BUSY', `The Harness Team account on ${pool.name} runs other projects' agents, so it cannot host this ${LEAD_NAME} now.`, 409)
  }
  if (!pool.observation?.capabilities?.includes(LEAD_CAPABILITY)) {
    fail('HOST_OUTDATED', `Update Harness on ${pool.name} to run a ${LEAD_NAME} there.`, 409)
  }
}

/** Where [project]'s Product Manager with [request]'s engine runs when its person names [machineId], as its start request; or
 *  throws why it cannot run there now. Writes nothing. The machine itself for its own owner; on another person's Mac, its
 *  Harness Team account when that admits this Product Manager with this engine now, else the Mac itself, as its owner,
 *  unless the Mac was added as its person joined. A Team account named itself keeps its rules and is refused with its reason.
 *  The start (placeLead) and New Project's machine list (leadChoices) both read it, so they never disagree. */
export function leadHost(state: SuperTabState, project: SwarmProject, machineId: string, request: LeadRequest, leadFor: AgentStartRequest['leadFor'],
  context: LeadContext): AgentStartRequest {
  // A machine whose owner left the Swarm stays listed while its host cleans up. Its contribution is withdrawn; machineContribution
  // would tell the person starting the Product Manager that they lost access themselves.
  const listed = state.machines?.find(m => m.machineId === machineId)
  if (listed && !state.people.some(p => p.id === listed.contributorId)) fail('CONTRIBUTION_REVOKED', 'This machine contribution was withdrawn.', 403)
  const named = machineContribution(state, machineId) ?? fail('MACHINE_NOT_LISTED', 'Add this machine to the Swarm first.', 403)
  const startIn = (pool: ContributedMachine): AgentStartRequest => ({ conversationId: project.leadConversationId, machineId: pool.machineId,
    engine: request.engine, ...(request.model ? { model: request.model } : {}), ...(request.effort ? { effort: request.effort } : {}), name: LEAD_NAME,
    cwd: projectFolder(pool, project), worktree: true, ...(request.branchRef ? { branchRef: request.branchRef } : {}), requirements: LEAD_REQUIREMENTS, leadFor })
  const teamMachines = context.teamMachines ?? []
  // With no GitHub App, or outside the Swarms Team accounts are tried in, a Team account takes no work (machines.ts
  // teamMachineFor).
  const teamsWork = !context.teamAccountsIdle && teamAccountSwarm(state)
  const refusal = (pool: ContributedMachine) => teamWorkRefusal(pool, context.now, teamMachines.includes(pool.machineId), true,
    (context.otherWorkspaceMachines ?? []).includes(pool.machineId))
  let candidates: ContributedMachine[]
  if (named.contributorId === project.ownerId) candidates = [named]
  else if (teamAccountPool(named)) {
    if (!teamsWork) fail('TEAM_ACCOUNT_REQUIRED', `Harness Team accounts take no work in this Swarm yet, so ${named.name} runs only its owner's projects.`, 403)
    const why = refusal(named)
    if (why) failTeamWork(why)
    candidates = [named]
  } else {
    const team = teamsWork ? teamPoolOf(state, named, teamMachines) : undefined
    // A Mac added as its person joined, not lent, takes teammates' work only in its Team account (machines.ts teamAccountOnly).
    if (named.teamAccountOnly) {
      const pool = team ?? named
      const why = refusal(pool)
      if (why) failTeamWork(why)
      candidates = [pool]
    } else candidates = team && !refusal(team) ? [team, named] : [named]
  }
  // The Team account first, with every check its start has (engine, sign-in, room, other projects' work, its host); refused
  // there for any reason, the Mac itself (security reviews 1 and 2 of #2228). The last one's reason is the answer.
  for (const [i, pool] of candidates.entries()) {
    const start = startIn(pool)
    try {
      admitLead(state, project, pool, start, context)
      return start
    } catch (error) {
      if (!(error instanceof SuperTabError) || i === candidates.length - 1) throw error
    }
  }
  throw new Error('unreachable: a Product Manager has at least one candidate machine')
}

/** Where New Project's Product Manager would run on each teammate's machine, for [personId] as its owner, by engine: the
 *  machine it runs in, or why it cannot run there now. The same answer leadHost gives the start, before the project exists, so
 *  Desktop shows the server's decision rather than working one out (security review 1 of #2228). The person's own machines
 *  are left to Desktop, which starts the Product Manager there itself; a Team account is read through its Mac. Reasons name
 *  no other project. */
export function leadChoices(state: SuperTabState, personId: string, context: LeadContext): Record<string, Record<string, { machineId: string } | { refused: string }>> {
  const by = state.people.find(p => p.id === personId)
  if (!by || state.paused) return {}
  const project = { id: '', name: '', ownerId: personId, leadConversationId: '', visibility: 'private', members: [], updateMinutes: 5,
    skillMode: 'default' } as unknown as SwarmProject
  const leadFor = { projectId: '', personId, generation: by.generation }
  const choices: Record<string, Record<string, { machineId: string } | { refused: string }>> = {}
  for (const machine of state.machines ?? []) {
    if (machine.hostMachineId || machine.removal || machine.contributorId === personId) continue
    choices[machine.machineId] = Object.fromEntries(Object.keys(LEAD_ENGINES).map(engine => {
      try {
        return [engine, { machineId: leadHost(state, project, machine.machineId, { engine }, leadFor, context).machineId }]
      } catch (error) {
        if (!(error instanceof SuperTabError)) throw error
        return [engine, { refused: error.message }]
      }
    }))
  }
  return choices
}

/** Records the start of [project]'s Product Manager on [machineId] for [by], and marks the project starting. Refuses, and
 *  changes nothing, when that machine cannot take it now. */
export function placeLead(state: SuperTabState, project: SwarmProject, by: Person, machineId: string, request: LeadRequest,
  startId: string, context: LeadContext): AgentStart {
  const start = leadHost(state, project, machineId, request, { projectId: project.id, personId: by.id, generation: by.generation }, context)
  const pool = machineContribution(state, start.machineId)!
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
