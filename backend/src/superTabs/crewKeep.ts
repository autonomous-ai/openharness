/**
 * The crew keeper (task #3398): what the Swarm does for its crew members on its own, decided from the state alone so it can
 * be tested with fake machines. A crew member idle an hour sleeps; one whose machine fails moves to the best fallback in the
 * route's order (project instructions, Order and quota); folders of long-asleep members, and of asleep members on a machine
 * short of disk, are dropped. The numbers are in crewRules.ts. Applying the actions is liveness.ts's (sweepLiveness).
 */
import { activeWork, type Agent, type CrewTrouble, type SuperTabState } from './model.js'
import { isBuddy } from './buddies.js'
import type { ContributedMachine } from './machines.js'
import { teamAccountPool } from './projects.js'
import { quotaOf, resetMs } from './reviewSeats.js'
import { groupsOf, idleSince } from './tidy.js'
import { DISK_FLOOR_BYTES, FOLDER_ASLEEP_MS, MOVE_LOW_DISK_BYTES, MOVE_OFFLINE_MS, MOVE_QUOTA_OUT_MS, SLEEP_IDLE_MS } from './crewRules.js'

export type CrewAction =
  | { kind: 'sleep'; agentId: string }
  | { kind: 'move'; agentId: string; toMachineId: string; reason: CrewTrouble }
  | { kind: 'stuck'; agentId: string; reason: CrewTrouble }
  | { kind: 'dropFolder'; agentId: string; why: 'asleep-7d' | 'low-disk' }

/** What the keeper asks of the rest of the Swarm: whether [machineId] would admit a start of [agent]'s kind now (machines.ts
 *  admitMachineStart, with the store's Team-account facts). */
export interface CrewDeps { admits(machineId: string, agent: Agent): boolean }

/** Whether [agent] is crew (#3397's `crew` record), read without its type until that change lands. */
export const isCrewMember = (agent: Agent): boolean => !!(agent as Agent & { crew?: { role?: unknown } }).crew

/** [machineId]'s contribution while it stands: a withdrawn one (its person left or became a viewer) reads as none, never a
 *  refusal, so a sweep never stops on it. */
function standingPool(state: SuperTabState, machineId: string): ContributedMachine | undefined {
  const pool = state.machines?.find(m => m.machineId === machineId)
  const contributor = pool && state.people.find(p => p.id === pool.contributorId)
  return pool && contributor && contributor.role !== 'viewer' && contributor.generation === pool.membershipGeneration ? pool : undefined
}

const isLead = (state: SuperTabState, agent: Agent) => state.conversations.some(c => c.leadId === agent.id)
const hasWork = (state: SuperTabState, agent: Agent) => state.conversations.some(c => c.assignment?.agentId === agent.id && activeWork(c))
const freeDisk = (pool: ContributedMachine) => {
  const resources = pool.observation?.resources
  return resources?.projectDiskFreeBytes ?? resources?.diskFreeBytes
}

/** Why [pool] can't keep a crew member of [engine] at [now], or null. Unknown readings never count as trouble. */
export function crewTrouble(state: SuperTabState, pool: ContributedMachine | null | undefined, engine: string, now: number): CrewTrouble | null {
  const reading = pool?.observation
  if (!pool || !reading || now - reading.receivedAt > MOVE_OFFLINE_MS) return 'offline'
  if (reading.readiness?.engines?.find(e => e.engine === engine)?.signedIn === false) return 'signed-out'
  const quota = quotaOf(state, pool, engine, now)
  if (quota?.known && quota.windows.some(w => {
    if (!(w.usedPercent >= 100)) return false
    const back = resetMs(w.resetsAt)
    return back === null || back - now > MOVE_QUOTA_OUT_MS
  })) return 'quota'
  const disk = freeDisk(pool)
  if (typeof disk === 'number' && disk < MOVE_LOW_DISK_BYTES) return 'disk'
  return null
}

/** The fallback machines for [agent], best first, in the route's order: the same account kind as the machine it leaves, then
 *  the account whose weekly quota resets soonest, then the most left, then the fewest agents working, then by name. Only
 *  machines with no trouble that admit its start. */
export function fallbacks(state: SuperTabState, agent: Agent, now: number, deps: CrewDeps): ContributedMachine[] {
  const from = standingPool(state, agent.machineId)
  const engine = agent.configuration.engine
  const weekly = (pool: ContributedMachine) => quotaOf(state, pool, engine, now)?.windows.find(w => w.name === 'weekly')
  const working = (pool: ContributedMachine) => state.agents.filter(a => a.machineId === pool.machineId && hasWork(state, a)).length
  const key = (pool: ContributedMachine): Array<number | string> => {
    const w = weekly(pool)
    return [teamAccountPool(pool) === teamAccountPool(from) ? 0 : 1, (w && resetMs(w.resetsAt)) ?? Number.MAX_SAFE_INTEGER,
      w ? w.usedPercent : 100, working(pool), pool.name]
  }
  return (state.machines ?? [])
    .filter(pool => pool.machineId !== agent.machineId && !pool.buddyOnly && standingPool(state, pool.machineId) && !crewTrouble(state, pool, engine, now) && deps.admits(pool.machineId, agent))
    .map(pool => ({ pool, key: key(pool) }))
    .sort((a, b) => { for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i]! < b.key[i]! ? -1 : 1; return 0 })
    .map(entry => entry.pool)
}

/** What the keeper does now for the Swarm's crew: one action per member at most, and one low-disk drop per machine. */
export function crewKeep(state: SuperTabState, now: number, deps: CrewDeps): CrewAction[] {
  const actions: CrewAction[] = []
  const members = state.agents.filter(a => isCrewMember(a) && !isBuddy(a) && !isLead(state, a) && !a.movedTo)
  for (const agent of members) {
    const trouble = crewTrouble(state, standingPool(state, agent.machineId), agent.configuration.engine, now)
    if (trouble) {
      const to = fallbacks(state, agent, now, deps)[0]
      if (to) actions.push({ kind: 'move', agentId: agent.id, toMachineId: to.machineId, reason: trouble })
      else if (agent.crewStuck !== trouble) actions.push({ kind: 'stuck', agentId: agent.id, reason: trouble })
      continue
    }
    if (agent.asleep) {
      if (!agent.asleep.folderDropped && now - agent.asleep.since >= FOLDER_ASLEEP_MS) actions.push({ kind: 'dropFolder', agentId: agent.id, why: 'asleep-7d' })
      continue
    }
    if (hasWork(state, agent)) continue
    const since = idleSince(agent, groupsOf(state, agent))
    if (since !== undefined && now - since >= SLEEP_IDLE_MS) actions.push({ kind: 'sleep', agentId: agent.id })
  }
  // A machine short of disk gives back the folder of its member asleep longest first, one a pass, until a reading shows room.
  for (const pool of state.machines ?? []) {
    const disk = freeDisk(pool)
    if (typeof disk !== 'number' || disk >= DISK_FLOOR_BYTES) continue
    const asleep = members.filter(a => a.machineId === pool.machineId && a.asleep && !a.asleep.folderDropped
      && !actions.some(x => x.kind === 'dropFolder' && x.agentId === a.id))
      .sort((a, b) => a.asleep!.since - b.asleep!.since)[0]
    if (asleep) actions.push({ kind: 'dropFolder', agentId: asleep.id, why: 'low-disk' })
  }
  return actions
}
