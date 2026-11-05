import { describe, expect, it } from 'vitest'
import { applyCommand, type Command } from './commands.js'
import { applyCrewKeep } from './crewKeep.js'
import { config, fixture, machine, NOW, person } from './crewKeep.test-support.js'
import { activeWork, type SuperTabState } from './model.js'

const everywhere = { admits: () => true }
const host = { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }
const run = (state: SuperTabState, command: Command, operationId: string, now = NOW, extra: Record<string, unknown> = {}) =>
  applyCommand(state, person, command, { now, operationId, ...extra }).state

/** [f]'s Swarm with a task 'Fix it' its crew member works on. */
function working(f: ReturnType<typeof fixture>) {
  f.state = run(f.state, { type: 'conversation.create', title: 'Fix it', brief: 'Fix the thing', checks: [] } as Command, 'task-1', NOW - 3_600_000)
  const task = f.state.conversations.find(c => c.title === 'Fix it')!
  f.state = run(f.state, { type: 'work.assign', conversationId: task.id, agentId: f.ada.id } as Command, 'assign-1', NOW - 60_000)
  return f.state.conversations.find(c => c.id === task.id)!
}

describe('applying the crew keeper in the Swarm\'s sweep', () => {
  it('puts an idle crew member to sleep, and says nothing', () => {
    const f = fixture()
    expect(applyCrewKeep(f.state, NOW, everywhere)).toEqual([])
    expect(f.state.agents.find(a => a.id === f.ada.id)!.asleep).toEqual({ since: NOW })
  })

  it('moves a member off a failing machine: same name, role and engine, a hand-off note, on the best fallback', () => {
    const f = fixture([machine('mac', { signedIn: false }), machine('mini')])
    f.ada.roleName = 'Engineer'
    const drafts = applyCrewKeep(f.state, NOW, everywhere)
    const ada = f.state.agents.find(a => a.id === f.ada.id)!
    const start = f.state.starts!.find(s => s.request.crewMoveOf === ada.id)!
    expect(ada.movedTo).toEqual({ machineId: 'mini', startId: start.id, reason: 'signed-out', at: NOW })
    expect(start.request).toMatchObject({ machineId: 'mini', name: ada.name, roleName: 'Engineer', engine: 'claude', model: 'opus', effort: 'high',
      cwd: '/swarms/mini/lead', worktree: true })
    expect(start.request.handoffNote).toContain('signed out')
    expect(drafts).toEqual([expect.objectContaining({ conversationId: 'lead', text: expect.stringContaining('moving to mini') })])
    // Moved once: the next pass leaves it to its start.
    expect(applyCrewKeep(f.state, NOW + 1000, everywhere)).toEqual([])
    expect(f.state.starts!.filter(s => s.request.crewMoveOf === ada.id)).toHaveLength(1)
  })

  it('says once when no machine can take a member, and drops a long-asleep folder', () => {
    const f = fixture([machine('mac', { signedIn: false })])
    expect(applyCrewKeep(f.state, NOW, everywhere)).toEqual([expect.objectContaining({ text: expect.stringContaining('no other machine') })])
    expect(applyCrewKeep(f.state, NOW + 1000, everywhere)).toEqual([])
    const asleep = fixture()
    asleep.ada.asleep = { since: NOW - 8 * 86_400_000 }
    applyCrewKeep(asleep.state, NOW, everywhere)
    expect(asleep.state.agents.find(a => a.id === asleep.ada.id)!.asleep).toEqual({ since: NOW - 8 * 86_400_000, folderDropped: true })
  })
})

describe('waking and moving through commands', () => {
  it('new work wakes an asleep crew member in place, and a moving one takes none', () => {
    const f = fixture()
    f.ada.asleep = { since: NOW - 7_200_000 }
    const task = working(f)
    const ada = f.state.agents.find(a => a.id === f.ada.id)!
    expect(ada.asleep).toBeUndefined()
    expect(activeWork(task) && task.assignment!.agentId).toBe(ada.id)
    const moving = fixture()
    moving.ada.movedTo = { machineId: 'mini', startId: 's', reason: 'offline', at: NOW - 1000 }
    expect(() => working(moving)).toThrow(/moving/)
  })

  it('a moved member\'s new session takes over: same name, crew and groups, its task lost to be handed on, the old session closed', () => {
    const f = fixture([machine('mac', { signedIn: false }), machine('mini')])
    const task = working(f)
    const oldId = f.ada.id
    const name = f.state.agents.find(a => a.id === oldId)!.displayName ?? f.ada.name
    applyCrewKeep(f.state, NOW, everywhere)
    const start = f.state.starts!.find(s => s.request.crewMoveOf === oldId)!
    f.state = run(f.state, { type: 'agent.started', startId: start.id, harnessId: 'ada-2', configuration: config } as Command, 'started-1', NOW + 5000, host)
    const moved = f.state.agents.find(a => a.harnessId === 'ada-2')!
    expect(f.state.agents.some(a => a.id === oldId)).toBe(false)
    expect(moved).toMatchObject({ machineId: 'mini', displayName: name, crew: { role: 'Engineer' }, movedFrom: { agentId: oldId, machineId: 'mac', reason: 'signed-out' } })
    const after = f.state.conversations.find(c => c.id === task.id)!
    expect(after.assignment).toMatchObject({ status: 'lost', lost: { reason: 'crew-moved' } })
    expect(f.state.conversations.find(c => c.id === 'lead')!.agentIds).toContain(moved.id)
    // The old session is retired as any removed agent's: its host closes it and drops its folder when clean (closingSessions).
    expect(f.state.closingSessions).toEqual([expect.objectContaining({ machineId: 'mac', harnessId: 'ada', agentId: oldId })])
  })

  it('a move whose start fails lets the keeper try again', () => {
    const f = fixture([machine('mac', { signedIn: false }), machine('mini')])
    applyCrewKeep(f.state, NOW, everywhere)
    const start = f.state.starts!.find(s => s.request.crewMoveOf === f.ada.id)!
    f.state = run(f.state, { type: 'agent.startFailed', startId: start.id, error: 'No room' } as Command, 'failed-1', NOW + 5000, host)
    expect(f.state.agents.find(a => a.id === f.ada.id)!.movedTo).toBeUndefined()
  })
})

describe('a take-over never joins a conversation its new session is barred from (security review of #3229)', () => {
  it('leaves a Team-written task out when the new session runs in the main account', () => {
    const f = fixture([machine('mac', { signedIn: false }), machine('mini')])
    f.state = run(f.state, { type: 'conversation.create', title: 'Team task', brief: 'b', checks: [] } as Command, 'tw', NOW - 3_600_000)
    const task = f.state.conversations.find(c => c.title === 'Team task')!
    task.agentIds.push(f.ada.id)
    // Placed by hand, as an older server could have: the take-over itself must still refuse the join.
    applyCrewKeep(f.state, NOW, everywhere)
    const start = f.state.starts!.find(s => s.request.crewMoveOf === f.ada.id)!
    f.state.conversations.find(c => c.id === task.id)!.teamWritten = true
    f.state = run(f.state, { type: 'agent.started', startId: start.id, harnessId: 'ada-2', configuration: config } as Command, 'started-tw', NOW + 5000, host)
    const moved = f.state.agents.find(a => a.harnessId === 'ada-2')!
    expect(f.state.conversations.find(c => c.id === task.id)!.agentIds).not.toContain(moved.id)
    expect(f.state.conversations.find(c => c.id === 'lead')!.agentIds).toContain(moved.id)
  })
})
