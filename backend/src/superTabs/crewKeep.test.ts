import { describe, expect, it } from 'vitest'
import { applyCommand } from './commands.js'
import { crewKeep, type CrewDeps } from './crewKeep.js'
import { config, fixture, GB, machine, NOW, person } from './crewKeep.test-support.js'
import { FOLDER_ASLEEP_MS, MOVE_LOW_DISK_BYTES, MOVE_OFFLINE_MS, MOVE_QUOTA_OUT_MS, SLEEP_IDLE_MS, DISK_FLOOR_BYTES } from './crewRules.js'
import type { Agent, SuperTabState } from './model.js'

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

describe('crewKeep: Team-written work stays in Team accounts (security review of #3229)', () => {
  it('a Team-account member moves only to a Team-account machine, and is stuck with none', () => {
    const team = (pool: ReturnType<typeof machine>) => ({ ...pool, hostMachineId: `${pool.machineId}-mac` }) as typeof pool
    const onlyMain = fixture([team(machine('mac', { signedIn: false })), machine('mini')])
    expect(kinds(onlyMain.state)).toEqual([{ kind: 'stuck', agentId: onlyMain.ada.id, reason: 'signed-out' }])
    const withTeam = fixture([team(machine('mac', { signedIn: false })), machine('mini', { resetIn: 86_400_000 }), team(machine('studio'))])
    expect(kinds(withTeam.state)).toEqual([{ kind: 'move', agentId: withTeam.ada.id, toMachineId: 'studio', reason: 'signed-out' }])
  })
  it('a main-account member in a Team-written conversation moves only to a Team-account machine', () => {
    const f = fixture([machine('mac', { signedIn: false }), machine('mini')])
    f.state.conversations.find(c => c.id === 'lead')!.teamWritten = true
    // The project's chat is its coordinator's; a task the member works in is what counts.
    f.state = applyCommand(f.state, person, { type: 'conversation.create', title: 'Team task', brief: 'b', checks: [] } as never, { now: NOW - 7_200_000, operationId: 'tw' }).state
    const task = f.state.conversations.find(c => c.title === 'Team task')!
    task.agentIds.push(f.ada.id)
    task.teamWritten = true
    expect(kinds(f.state)).toEqual([{ kind: 'stuck', agentId: f.ada.id, reason: 'signed-out' }])
  })
})

describe('crewKeep: account kinds and Team sessions (security review 2 of #3229)', () => {
  const team = (pool: ReturnType<typeof machine>) => ({ ...pool, hostMachineId: `${pool.machineId}-mac` }) as typeof pool
  it('a main-account member never moves into a Team account', () => {
    const f = fixture([machine('mac', { signedIn: false }), team(machine('studio'))])
    expect(kinds(f.state)).toEqual([{ kind: 'stuck', agentId: f.ada.id, reason: 'signed-out' }])
  })
  it('a member in a Team account never sleeps: its close there deletes what a wake would resume', () => {
    const f = fixture([team(machine('mac')), machine('mini')])
    expect(kinds(f.state)).toEqual([])
  })
  it('a machine that refused the member\'s move start is not picked again for an hour', () => {
    const f = fixture([machine('mac', { signedIn: false }), machine('mini', { resetIn: 86_400_000 }), machine('late')])
    f.ada.crewMoveRefused = { machineId: 'mini', at: NOW - 30 * 60_000 }
    expect(kinds(f.state)).toEqual([{ kind: 'move', agentId: f.ada.id, toMachineId: 'late', reason: 'signed-out' }])
    f.ada.crewMoveRefused = { machineId: 'mini', at: NOW - 61 * 60_000 }
    expect(kinds(f.state)).toEqual([{ kind: 'move', agentId: f.ada.id, toMachineId: 'mini', reason: 'signed-out' }])
  })
})
