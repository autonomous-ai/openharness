import { describe, expect, it } from 'vitest'
import { applyCommand } from './commands.js'
import { crewKeep, type CrewDeps } from './crewKeep.js'
import { FOLDER_ASLEEP_MS, MOVE_LOW_DISK_BYTES, MOVE_OFFLINE_MS, MOVE_QUOTA_OUT_MS, SLEEP_IDLE_MS, DISK_FLOOR_BYTES } from './crewRules.js'
import { createSuperTab, type Actor, type Agent, type SuperTabState } from './model.js'

const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const person: Actor = { kind: 'person', userId: 'owner', email: 'owner@example.test' }
const NOW = Date.parse('2026-11-05T20:00:00Z')
const GB = 1024 ** 3
type Pool = NonNullable<SuperTabState['machines']>[number]

/** A fresh machine reading: online now, signed in, quota half used resetting in [resetIn], [diskFree] bytes free. */
function machine(machineId: string, options: { receivedAt?: number; signedIn?: boolean; usedPercent?: number; resetIn?: number; known?: boolean;
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
function fixture(pools: Pool[] = [machine('mac'), machine('mini')], startedAgo = 2 * SLEEP_IDLE_MS) {
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
const everywhere: CrewDeps = { admits: () => true }
const kinds = (state: SuperTabState, deps = everywhere) => crewKeep(state, NOW, deps)

describe('crewKeep: sleep', () => {
  it('sleeps a crew member idle over an hour, not one idle under it, and never one with active work', () => {
    expect(kinds(fixture(undefined, SLEEP_IDLE_MS + 60_000).state)).toEqual([{ kind: 'sleep', agentId: expect.any(String) }])
    expect(kinds(fixture(undefined, SLEEP_IDLE_MS - 60_000).state)).toEqual([])
    const busy = fixture()
    busy.state = applyCommand(busy.state, person, { type: 'conversation.create', title: 'Fix it', brief: 'b', checks: [] } as never,
      { now: NOW - 2 * SLEEP_IDLE_MS, operationId: 'g1' }).state
    const group = busy.state.conversations.find(c => c.title === 'Fix it')!
    group.agentIds.push(busy.ada.id)
    group.assignment = { id: 'a1', agentId: busy.ada.id, status: 'working', assignedAt: NOW - 2 * SLEEP_IDLE_MS } as never
    expect(kinds(busy.state)).toEqual([])
  })

  it('never touches a PM, a member who is not crew, or one already asleep', () => {
    const f = fixture()
    ;(f.lead as Agent & { crew?: unknown }).crew = { role: 'PM', at: 1, by: 'owner' }
    delete (f.ada as Agent & { crew?: unknown }).crew
    expect(kinds(f.state)).toEqual([])
    const asleep = fixture()
    asleep.ada.asleep = { since: NOW - 60_000 }
    expect(kinds(asleep.state)).toEqual([])
  })
})

describe('crewKeep: move when its machine fails', () => {
  const moveOf = (state: SuperTabState, deps = everywhere) => crewKeep(state, NOW, deps).find(a => a.kind === 'move')
  it('moves after the machine is offline over 5 minutes, not before', () => {
    expect(moveOf(fixture([machine('mac', { receivedAt: NOW - MOVE_OFFLINE_MS + 30_000 }), machine('mini')]).state)).toBeUndefined()
    expect(moveOf(fixture([machine('mac', { receivedAt: NOW - MOVE_OFFLINE_MS - 1 }), machine('mini')]).state))
      .toEqual({ kind: 'move', agentId: expect.any(String), toMachineId: 'mini', reason: 'offline' })
  })
  it('moves at once when its engine is signed out', () => {
    expect(moveOf(fixture([machine('mac', { signedIn: false }), machine('mini')]).state)).toMatchObject({ toMachineId: 'mini', reason: 'signed-out' })
  })
  it('moves when out of quota for over an hour; not when it resets within the hour, nor when quota is unknown', () => {
    expect(moveOf(fixture([machine('mac', { usedPercent: 100, resetIn: MOVE_QUOTA_OUT_MS + 60_000 }), machine('mini')]).state))
      .toMatchObject({ toMachineId: 'mini', reason: 'quota' })
    expect(moveOf(fixture([machine('mac', { usedPercent: 100, resetIn: MOVE_QUOTA_OUT_MS - 60_000 }), machine('mini')]).state)).toBeUndefined()
    expect(moveOf(fixture([machine('mac', { usedPercent: 100, known: false }), machine('mini')]).state)).toBeUndefined()
  })
  it('moves when low on disk', () => {
    expect(moveOf(fixture([machine('mac', { diskFree: MOVE_LOW_DISK_BYTES - 1 }), machine('mini')]).state)).toMatchObject({ reason: 'disk' })
    expect(moveOf(fixture([machine('mac', { diskFree: MOVE_LOW_DISK_BYTES + GB }), machine('mini')]).state)).toBeUndefined()
  })
  it('picks the fallback in the route\'s order: same account kind, then the account resetting soonest, then most left, then fewer working', () => {
    const failing = machine('mac', { signedIn: false })
    // Soonest reset first among usable machines of the same kind.
    expect(moveOf(fixture([failing, machine('late', { resetIn: 5 * 86_400_000 }), machine('soon', { resetIn: 86_400_000 })]).state))
      .toMatchObject({ toMachineId: 'soon' })
    // Same reset: most left.
    expect(moveOf(fixture([failing, machine('half', { usedPercent: 50 }), machine('fresh', { usedPercent: 10 })]).state))
      .toMatchObject({ toMachineId: 'fresh' })
    // A machine that is failing itself, or that does not admit the start, is never a fallback.
    expect(moveOf(fixture([failing, machine('down', { receivedAt: NOW - MOVE_OFFLINE_MS - 1 }), machine('ok')]).state)).toMatchObject({ toMachineId: 'ok' })
    expect(moveOf(fixture([failing, machine('refuses'), machine('ok')]).state, { admits: id => id !== 'refuses' })).toMatchObject({ toMachineId: 'ok' })
  })
  it('with no fallback says it once, and moves no member twice', () => {
    const lonely = fixture([machine('mac', { signedIn: false })])
    expect(kinds(lonely.state)).toEqual([{ kind: 'stuck', agentId: lonely.ada.id, reason: 'signed-out' }])
    lonely.ada.crewStuck = 'signed-out'
    expect(kinds(lonely.state)).toEqual([])
    const moving = fixture([machine('mac', { signedIn: false }), machine('mini')])
    moving.ada.movedTo = { machineId: 'mini', startId: 's1', reason: 'signed-out', at: NOW - 1000 }
    expect(kinds(moving.state)).toEqual([])
  })
})

describe('crewKeep: folders', () => {
  it('drops the folder of a member asleep 7 days, once', () => {
    const f = fixture()
    f.ada.asleep = { since: NOW - FOLDER_ASLEEP_MS - 1 }
    expect(kinds(f.state)).toEqual([{ kind: 'dropFolder', agentId: f.ada.id, why: 'asleep-7d' }])
    f.ada.asleep.folderDropped = true
    expect(kinds(f.state)).toEqual([])
    f.ada.asleep = { since: NOW - FOLDER_ASLEEP_MS + 60_000 }
    expect(kinds(f.state)).toEqual([])
  })
  it('below 10 GB free, drops the folder of the member asleep longest on that machine first, one a pass', () => {
    const f = fixture([machine('mac', { diskFree: DISK_FLOOR_BYTES - GB }), machine('mini')])
    f.ada.asleep = { since: NOW - 3_600_000 }
    f.state = applyCommand(f.state, person, { type: 'agent.add', conversationId: 'lead', machineId: 'mac', harnessId: 'bo', name: 'bo', lead: false, configuration: config },
      { now: NOW - 2 * SLEEP_IDLE_MS, operationId: 'add-bo', contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).state
    const bo = f.state.agents.find(a => a.harnessId === 'bo')!
    ;(bo as Agent & { crew?: unknown }).crew = { role: 'Engineer', at: 1, by: 'owner' }
    bo.asleep = { since: NOW - 2 * 3_600_000 }
    expect(kinds(f.state)).toEqual([{ kind: 'dropFolder', agentId: bo.id, why: 'low-disk' }])
    bo.asleep.folderDropped = true
    expect(kinds(f.state)).toEqual([{ kind: 'dropFolder', agentId: f.ada.id, why: 'low-disk' }])
  })
})
