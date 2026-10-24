import { z } from 'zod'
import { activeWork, fail, person, type Actor, type Agent, type AgentStart, type AgentStartRequest, type SuperTabState } from './model.js'
import { agentProjectId, groupProject, ledProject, projectsOf } from './projects.js'
import { conversation } from './model.js'

/** An explicit grant for this tab and project. It never creates a MachineShare. */
export interface ContributedMachine {
  machineId: string
  name: string
  contributorId: string
  membershipGeneration: string
  generation: string
  cwd: string
  scope?: 'swarm'
  engines: string[]
  maxAgents: number
  paused: boolean
  observation?: MachineObservation & { receivedAt: number }
  /** Set by machine.remove: the machine stays listed, paused, while its host deletes the Swarm's folders there, until the
   *  host says it cleaned up (machine.cleaned) or REMOVAL_FALLBACK_MS passes (expireRemovals). */
  removal?: { id: string; state: 'cleaning'; requestedAt: string }
}
/** A removed machine whose host never acknowledged in time: its records are gone, its host still cleans up on its next poll. */
export interface MachineCleanup { machineId: string; removalId: string; machineOwnerId: string }
export const REMOVAL_FALLBACK_MS = 24 * 3_600_000
/** Older contributions may name engines that Swarm no longer starts. Their fresh
 * observation lists the supported engines that are actually installed. */
export function contributedEngines(pool: ContributedMachine, observation: MachineObservation | undefined = pool.observation): string[] {
  const supported = (engine: string) => engine === 'claude' || engine === 'codex'
  return pool.engines.some(engine => !supported(engine))
    ? (observation?.quotas ?? []).map(quota => quota.engine).filter(supported)
    : pool.engines.filter(supported)
}
const measure = z.number().finite().nonnegative().nullable()
const percent = z.number().min(0).max(100).nullable()
const resource = z.object({
  cpuPercent: percent, memoryTotalBytes: measure, memoryUsedBytes: measure,
  diskFreeBytes: measure, diskTotalBytes: measure,
  projectDiskFreeBytes: measure, projectDiskTotalBytes: measure.optional(),
  deviceType: z.string().max(120).nullable(), chip: z.string().max(120).nullable(), os: z.string().max(120).nullable(),
  gpuPercent: percent,
}).strict()
const quota = z.object({ engine: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/), known: z.boolean(),
  windows: z.array(z.object({ name: z.string().max(80), usedPercent: z.number().min(0).max(100),
    resetsAt: z.union([z.string().max(80), z.number().finite(), z.null()]) }).strict()).max(10),
}).strict()
export const machineObservationSchema = z.object({ generation: z.string().max(160), resources: resource,
  tools: z.record(z.string().max(80), z.boolean()).refine(v => Object.keys(v).length <= 20),
  toolProbeErrors: z.record(z.string().max(80), z.string().max(200)).refine(v => Object.keys(v).length <= 20).optional(),
  quotas: z.array(quota).max(32), runningHarnessIds: z.array(z.string().max(160)).max(1000),
  stoppedHarnessIds: z.array(z.string().max(160)).max(1000),
  stoppedReservations: z.array(z.object({ harnessId: z.string().min(1).max(160), generation: z.string().min(1).max(160) }).strict()).max(1000).optional(),
  /** The Local models add-on (docs/plans/2026-10-23-swarm-local-models.md); absent from hosts before it. On the Swarm's
   *  grid: what this machine serves there (`local` an engine of its own, `api` a saved API it shares), usable by agents on
   *  any machine. On any other grid: a model its owner may use there (`shared`, shared with them), usable only by agents
   *  on this machine, since only its sign-in reaches that grid. */
  localModels: z.array(z.object({ grid: z.string().min(1).max(160), model: z.string().min(1).max(200),
    name: z.string().max(200).optional(), contextWindow: z.number().int().positive().nullable().optional(),
    kind: z.enum(['local', 'api', 'shared']).optional() }).strict()).max(64).optional(),
  /** Models this machine serves on the Swarm's grid that Builders are not offered, too small or too slow to drive a coding
   *  agent (cli/src/lib/codingModel.ts), with why: so the route can tell a Lead asked for one why it is not offered. */
  refusedModels: z.array(z.object({ grid: z.string().min(1).max(160), model: z.string().min(1).max(200),
    name: z.string().max(200).optional(), why: z.string().min(1).max(300) }).strict()).max(16).optional(),
}).strict()
export type MachineObservation = z.infer<typeof machineObservationSchema>

/** A machine reports every 15 seconds (cli/src/superTabs/machines.ts); three missed beats is offline. */
export const MACHINE_FRESH_MS = 45_000

/** Since when an agent has been down: the stored time a reading first showed its session gone or the host confirmed its
 * stop, or its machine's last reading once that is stale. Nothing is written while a machine is silent, so that case is
 * read from the reading itself. Undefined while it is up. */
export function downSince(state: SuperTabState, target: Agent, now: number): string | undefined {
  const observation = state.machines?.find(m => m.machineId === target.machineId)?.observation
  const offline = observation && now - observation.receivedAt > MACHINE_FRESH_MS ? new Date(observation.receivedAt).toISOString() : undefined
  return [target.downSince, offline].filter(Boolean).sort()[0]
}

/** Before a new reading replaces the last one: a session it lists as running is back; any other agent on the machine
 * keeps the earliest time it was down, including the time its machine went silent. */
export function recordAgentPresence(state: SuperTabState, machineId: string, running: string[], now: number): void {
  for (const target of state.agents.filter(a => a.machineId === machineId)) {
    if (running.includes(target.harnessId)) {
      delete target.downSince
      delete target.downNamed
    } else target.downSince = downSince(state, target, now) ?? new Date(now).toISOString()
  }
}

export function machineContribution(state: SuperTabState, machineId: string) {
  const pool = state.machines?.find(m => m.machineId === machineId)
  if (!pool) return null
  const contributor = person(state, pool.contributorId)
  if (contributor.role === 'viewer' || contributor.generation !== pool.membershipGeneration) {
    fail('CONTRIBUTION_REVOKED', 'This machine contribution was withdrawn.', 403)
  }
  return pool
}

/** A machine is its owner's to remove: whoever contributed it, or, for a machine with only shared agents, whoever
 *  contributed all of them. Not the Swarm owner (spec 2026-10-23-remove-machine.md, decision 1). */
export function ownedMachine(state: SuperTabState, actor: Actor, machineId: string) {
  const pool = state.machines?.find(m => m.machineId === machineId)
  const members = state.agents.filter(a => a.machineId === machineId)
  if (!pool && !members.length) fail('NOT_FOUND', 'This machine is not in the Swarm.', 404)
  const ownerId = pool?.contributorId ?? (members.every(a => a.contributorId === members[0]!.contributorId) ? members[0]!.contributorId : null)
  if (actor.kind !== 'person' || actor.userId !== ownerId) fail('FORBIDDEN', 'Only the machine\'s owner can remove it.', 403)
  return { pool, members }
}

/** What removing the machine would do, for its owner's confirmation. */
export function removalPreview(state: SuperTabState, actor: Actor, machineId: string) {
  const { members } = ownedMachine(state, actor, machineId)
  const led = members.map(a => ledProject(state, a.id)).find(Boolean)
  return {
    blockedBy: led ? { projectId: led.id, projectName: led.name } : null,
    agents: members.map(a => {
      const task = state.conversations.find(c => activeWork(c) && c.assignment!.agentId === a.id)
      return { id: a.id, name: a.displayName ?? a.name, projectName: projectsOf(state).find(p => p.id === agentProjectId(state, a))?.name ?? '',
        ...(task ? { task: task.title } : {}) }
    }),
    // Their code is only on this machine: no other machine can start agents for them until someone shares a repository.
    soleSourceProjects: projectsOf(state).filter(p => p.repository?.machineId === machineId && !p.repository.repositoryUrl).map(p => ({ id: p.id, name: p.name })),
  }
}

/** A removal its host has not acknowledged in a day: the machine's records go, and the cleanup waits for its host. */
export function expireRemovals(state: SuperTabState, now: number): void {
  for (const pool of state.machines?.filter(m => m.removal && now - Date.parse(m.removal.requestedAt) >= REMOVAL_FALLBACK_MS) ?? []) {
    (state.machineCleanups ??= []).push({ machineId: pool.machineId, removalId: pool.removal!.id, machineOwnerId: pool.contributorId })
    state.machines = state.machines!.filter(m => m !== pool)
  }
}

/** Pending intents reserve slots too. Only an explicit host stop frees a launched slot. */
export function machineSlots(state: SuperTabState, pool: ContributedMachine) {
  const reservations = (state.harnessReservations ?? []).filter(r => r.machineId === pool.machineId)
  const live = new Set(reservations.map(r => r.harnessId))
  const released = (state.releasedHarnesses ?? []).filter(r => r.machineId === pool.machineId && !live.has(r.harnessId)).map(r => r.harnessId)
  const observed = pool.observation?.stoppedHarnessIds ?? []
  const stopped = new Set([...observed.filter(id => {
    const reservation = reservations.find(r => r.harnessId === id)
    // Older hosts can prove a first launch stopped, but cannot distinguish a resumed runtime from its predecessor.
    return !reservation || !reservation.renewed || pool.observation?.stoppedReservations?.some(r => r.harnessId === id && r.generation === reservation.generation)
  }), ...released])
  const running = new Set((pool.observation?.runningHarnessIds ?? []).filter(id => !stopped.has(id)))
  for (const a of state.agents) if (a.machineId === pool.machineId && !stopped.has(a.harnessId)) running.add(a.harnessId)
  for (const r of reservations) if (!stopped.has(r.harnessId)) running.add(r.harnessId)
  let pending = 0
  for (const start of state.starts ?? []) {
    if (start.request.machineId !== pool.machineId || start.error) continue
    if (start.harnessId) { if (!stopped.has(start.harnessId)) running.add(start.harnessId) }
    else pending++
  }
  return running.size + pending
}

/** Machines of the Swarm serving models on its grid now, by model: only fresh readings count. */
/** What a Swarm's owner's computer keeps on grid for it (docs/plans/2026-10-23-swarm-local-models.md): the grid, and as its
 *  members the people who may act in the Swarm. A viewer is not one, and the owner is the grid's admin already. */
export function swarmGridRow(tabId: string, state: SuperTabState) {
  const local = state.localModels
  if (!local) return null
  return { tabId, grid: local.grid, enabled: local.enabled, ready: local.ready ?? null,
    members: state.people.filter(p => p.role !== 'viewer' && p.id !== state.ownerId).map(p => p.email) }
}

/** The grid a contributed machine reports served models on: only while the add-on is on, so the host asks grid nothing otherwise. */
export const hostLocalGrid = (state: SuperTabState) => state.localModels?.enabled ? { localGrid: state.localModels.grid } : {}

export function servedLocalModels(state: SuperTabState, now: number) {
  const grid = state.localModels?.enabled ? state.localModels.grid : null
  if (!grid) return []
  return (state.machines ?? []).flatMap(m => !m.observation || now - m.observation.receivedAt > MACHINE_FRESH_MS ? []
    : (m.observation.localModels ?? []).filter(l => l.grid === grid).map(l => ({ ...l, machineId: m.machineId })))
}

/** Whether a start names a model it may run on now: one the Swarm's grid serves, from any machine; or one on another grid
 *  that the start's own machine reads it can use (shared with its owner, owner 2026-10-23). Grid models carry no
 *  subscription model or effort. */
export function localModelAllowed(state: SuperTabState, request: AgentStartRequest, now: number): boolean {
  const grid = state.localModels?.enabled ? state.localModels.grid : null
  if (!grid || !request.gridModel || !request.gridName || request.model || request.effort) return false
  if (request.gridName === grid) return servedLocalModels(state, now).some(l => l.model === request.gridModel)
  const pool = (state.machines ?? []).find(m => m.machineId === request.machineId)
  return !!pool?.observation && now - pool.observation.receivedAt <= MACHINE_FRESH_MS
    && (pool.observation.localModels ?? []).some(l => l.grid === request.gridName && l.model === request.gridModel)
}

export function admitMachineStart(state: SuperTabState, request: AgentStartRequest, now: number, start?: AgentStart) {
  const pool = machineContribution(state, request.machineId)
  if (!pool) return null
  if (pool.removal) fail('MACHINE_REMOVED', 'This machine is being removed from the Swarm.')
  if (start && start.poolGeneration !== pool.generation) fail('CONTRIBUTION_REVOKED', 'This machine contribution changed. Reconcile the original start.', 403)
  if (pool.paused) fail('MACHINE_PAUSED', 'New work is paused on this machine.')
  const project = groupProject(state, conversation(state, request.conversationId))
  if (!pool.scope && project.id !== 'lead') fail('PROJECT_CONTRIBUTION', 'Ask its owner to add this machine to the swarm again to support other projects.')
  const cwd = pool.scope === 'swarm'
    ? project.repository?.machineId === pool.machineId ? project.repository.cwd : `${pool.cwd.replace(/\/+$/, '')}/${project.id}`
    : pool.cwd
  // Every refused field is named, with what the machine does accept. Values the caller sent are not echoed: an account
  // setting can be a path or a name of the caller's own.
  const refused: string[] = []
  if (request.cwd !== cwd) refused.push(`cwd (this project uses ${cwd} on it)`)
  const engines = contributedEngines(pool)
  if (!engines.includes(request.engine)) refused.push(`engine (it contributes ${engines.join(', ') || 'no engines'})`)
  // A model served on the Swarm's own grid is the one exception to "default account settings": the owner turned the
  // add-on on, and some machine of the Swarm serves it now.
  const local = localModelAllowed(state, request, now)
  const settings = (['codexHome', 'gridModel', 'gridName'] as const).filter(key => request[key] && !(local && key !== 'codexHome'))
  if (settings.length) refused.push(`${settings.join(', ')} (it runs with its own default account settings, so leave ${settings.length > 1 ? 'them' : 'it'} out)`)
  if (request.permissionMode !== undefined && request.permissionMode !== 'full') {
    refused.push('permissionMode (only full is accepted; leave it out to use the machine’s default)')
  }
  if (refused.length) {
    fail('OUTSIDE_CONTRIBUTION', `${pool.name} accepts only its contributed project folder, engines and default account settings, with full permissions for Swarm agents. Refused: ${refused.join('; ')}.`, 403)
  }
  if (!pool.observation || now - pool.observation.receivedAt > MACHINE_FRESH_MS) {
    fail('MACHINE_OFFLINE', 'Wait for a fresh reading from the contributed machine.')
  }
  if (!start && machineSlots(state, pool) >= pool.maxAgents) fail('MACHINE_FULL', 'This machine has reached its contributed agent limit.')
  return pool
}
