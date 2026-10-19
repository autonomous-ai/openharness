import { z } from 'zod'
import { fail, person, type AgentStart, type AgentStartRequest, type SuperTabState } from './model.js'

/** An explicit grant for this tab and project. It never creates a MachineShare. */
export interface ContributedMachine {
  machineId: string
  name: string
  contributorId: string
  membershipGeneration: string
  generation: string
  cwd: string
  engines: string[]
  maxAgents: number
  paused: boolean
  observation?: MachineObservation & { receivedAt: number }
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
const quota = z.object({ engine: z.enum(['claude', 'codex']), known: z.boolean(),
  windows: z.array(z.object({ name: z.string().max(80), usedPercent: z.number().min(0).max(100),
    resetsAt: z.union([z.string().max(80), z.number().finite(), z.null()]) }).strict()).max(10),
}).strict()
export const machineObservationSchema = z.object({ generation: z.string().max(160), resources: resource,
  tools: z.record(z.string().max(80), z.boolean()).refine(v => Object.keys(v).length <= 20),
  quotas: z.array(quota).max(2), runningHarnessIds: z.array(z.string().max(160)).max(1000),
  stoppedHarnessIds: z.array(z.string().max(160)).max(1000),
}).strict()
export type MachineObservation = z.infer<typeof machineObservationSchema>

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
  const stopped = new Set(pool.observation?.stoppedHarnessIds ?? [])
  const running = new Set(pool.observation?.runningHarnessIds ?? [])
  for (const a of state.agents) if (a.machineId === pool.machineId && !stopped.has(a.harnessId)) running.add(a.harnessId)
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
  if (request.cwd !== pool.cwd || !pool.engines.includes(request.engine)
    || request.codexHome || request.gridModel || request.gridName || request.permissionMode) {
    fail('OUTSIDE_CONTRIBUTION', 'Use the contributed project, engine and default account settings.', 403)
  }
  if (!pool.observation || now - pool.observation.receivedAt > 45_000) {
    fail('MACHINE_OFFLINE', 'Wait for a fresh reading from the contributed machine.')
  }
  if (!start && machineSlots(state, pool) >= pool.maxAgents) fail('MACHINE_FULL', 'This machine has reached its contributed agent limit.')
  return pool
}
