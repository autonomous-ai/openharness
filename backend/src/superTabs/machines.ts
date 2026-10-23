import { z } from 'zod'
import { fail, person, type Agent, type AgentStart, type AgentStartRequest, type SuperTabState } from './model.js'
import { groupProject } from './projects.js'
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
}
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

export function admitMachineStart(state: SuperTabState, request: AgentStartRequest, now: number, start?: AgentStart) {
  const pool = machineContribution(state, request.machineId)
  if (!pool) return null
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
  const settings = (['codexHome', 'gridModel', 'gridName'] as const).filter(key => request[key])
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
