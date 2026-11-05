/** Fake machines and a Swarm with one crew member, for the crew keeper's tests (crewKeep.test.ts, crewKeep.apply.test.ts). */
import { applyCommand } from './commands.js'
import { SLEEP_IDLE_MS } from './crewRules.js'
import { createSuperTab, type Actor, type Agent, type SuperTabState } from './model.js'

export const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
export const person: Actor = { kind: 'person', userId: 'owner', email: 'owner@example.test' }
export const NOW = Date.parse('2026-11-05T20:00:00Z')
export const GB = 1024 ** 3
export type Pool = NonNullable<SuperTabState['machines']>[number]

/** A fresh machine reading: online now, signed in, quota half used resetting in [resetIn], [diskFree] bytes free. */
export function machine(machineId: string, options: { receivedAt?: number; signedIn?: boolean; usedPercent?: number; resetIn?: number; known?: boolean;
  diskFree?: number; team?: boolean; hostMachineId?: string } = {}): Pool {
  return {
    machineId, name: machineId, cwd: `/swarms/${machineId}`, engines: ['claude'], maxAgents: 8, contributorId: 'owner', membershipGeneration: 'g',
    generation: `${machineId}-g`, paused: false, scope: 'swarm', ...(options.hostMachineId ? { hostMachineId: options.hostMachineId } : {}),
    observation: {
      receivedAt: options.receivedAt ?? NOW - 5_000, runningHarnessIds: [], stoppedHarnessIds: [],
      resources: { diskFreeBytes: options.diskFree ?? 200 * GB, diskTotalBytes: 500 * GB, memoryUsedBytes: 0, memoryTotalBytes: 64 * GB },
      readiness: { engines: [{ engine: 'claude', installed: true, signedIn: options.signedIn ?? true }] },
      quotas: [{ engine: 'claude', known: options.known ?? true, windows: [{ name: 'weekly', usedPercent: options.usedPercent ?? 50,
        resetsAt: new Date(NOW + (options.resetIn ?? 3 * 86_400_000)).toISOString() }] }],
    },
  } as unknown as Pool
}

/** A Swarm with its PM and one crew member 'Ada' on 'mac', started [startedAgo] ms ago, and machines [pools]. */
export function fixture(pools: Pool[] = [machine('mac'), machine('mini')], startedAgo = 2 * SLEEP_IDLE_MS) {
  let state: SuperTabState = createSuperTab('tab', 'Work', { id: 'owner', email: 'owner@example.test' }, 'prod')
  const add = (harnessId: string, lead: boolean, machineId = 'mac') => {
    state = applyCommand(state, person, { type: 'agent.add', conversationId: 'lead', machineId, harnessId, name: harnessId, lead, configuration: config },
      { now: NOW - startedAgo, operationId: `add-${harnessId}`, contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).state
    return state.agents.find(a => a.harnessId === harnessId)!
  }
  const lead = add('lead', true)
  const ada = add('ada', false)
  ada.startedSession = { creationId: 'c', sessionId: 's', createdAt: new Date(NOW - startedAgo).toISOString() }
  ;(ada as Agent & { crew?: unknown }).crew = { role: 'Engineer', at: NOW - startedAgo, by: 'owner' }
  const generation = state.people.find(p => p.id === 'owner')!.generation
  state.machines = pools.map(pool => ({ ...pool, membershipGeneration: generation }))
  return { state, lead, ada }
}
