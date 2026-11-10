import { describe, expect, it } from 'vitest'
import { applyCommand, type Command } from './commands.js'
import { applyCrewKeep } from './crewKeep.js'
import { config, fixture, machine, NOW, person } from './crewKeep.test-support.js'
import { activeWork, type SuperTabState } from './model.js'
import { storedAssignment } from './storedWork.test-support.js'

const everywhere = { admits: () => true }
const host = { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }
const run = (state: SuperTabState, command: Command, operationId: string, now = NOW, extra: Record<string, unknown> = {}) =>
  applyCommand(state, person, command, { now, operationId, ...extra }).state

/** [f]'s Swarm with a task 'Fix it' its crew member works on. */
function working(f: ReturnType<typeof fixture>) {
  f.state = run(f.state, { type: 'conversation.create', title: 'Fix it', brief: 'Fix the thing', checks: [] } as Command, 'task-1', NOW - 3_600_000)
  const task = f.state.conversations.find(c => c.title === 'Fix it')!
  storedAssignment(f.state, task.id, f.ada.id, NOW - 60_000)
  return task
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
  // Task #4120 (the PM's ruling): only the project owner's own agent may take over Team-written work, as ada is here; another
  // member's agent stays out (teamWritten.test.ts, closedAgents.test.ts).
  it('takes a Team-written task back when the new session is the project owner\'s own agent', () => {
    const f = fixture([machine('mac', { signedIn: false }), machine('mini')])
    f.state = run(f.state, { type: 'conversation.create', title: 'Team task', brief: 'b', checks: [] } as Command, 'tw', NOW - 3_600_000)
    const task = f.state.conversations.find(c => c.title === 'Team task')!
    task.agentIds.push(f.ada.id)
    // Placed by hand, as an older server could have: the take-over keeps it, the owner's own agent.
    applyCrewKeep(f.state, NOW, everywhere)
    const start = f.state.starts!.find(s => s.request.crewMoveOf === f.ada.id)!
    f.state.conversations.find(c => c.id === task.id)!.teamWritten = true
    f.state = run(f.state, { type: 'agent.started', startId: start.id, harnessId: 'ada-2', configuration: config } as Command, 'started-tw', NOW + 5000, host)
    const moved = f.state.agents.find(a => a.harnessId === 'ada-2')!
    expect(f.state.conversations.find(c => c.id === task.id)!.agentIds).toContain(moved.id)
    expect(f.state.conversations.find(c => c.id === 'lead')!.agentIds).toContain(moved.id)
  })
})

describe('a refused move start (security review 2 of #3229)', () => {
  it('records the machine that refused it, so the next pass tries another', () => {
    const f = fixture([machine('mac', { signedIn: false }), machine('mini')])
    applyCrewKeep(f.state, NOW, everywhere)
    const start = f.state.starts!.find(s => s.request.crewMoveOf === f.ada.id)!
    f.state = run(f.state, { type: 'agent.startFailed', startId: start.id, error: 'No token' } as Command, 'failed-2', NOW + 5000, host)
    expect(f.state.agents.find(a => a.id === f.ada.id)!.crewMoveRefused).toEqual({ machineId: 'mini', at: NOW + 5000 })
  })
})

describe('a moved member\'s task reaches the head of the list (review of #3229)', () => {
  it('also when the old session lost it before the new one started: offline, or its host closed it', () => {
    const f = fixture([machine('mac', { signedIn: false }), machine('mini')])
    f.state = run(f.state, { type: 'conversation.create', title: 'Other', brief: 'Other work', checks: [] } as Command, 'other', NOW - 7_200_000)
    const task = working(f)
    const other = f.state.conversations.find(c => c.title === 'Other')!
    applyCrewKeep(f.state, NOW, everywhere)
    // The old host's report shows the session stopped (or its machine went quiet): liveness loses the task first.
    const lost = f.state.conversations.find(c => c.id === task.id)!
    lost.assignment = { ...lost.assignment!, status: 'lost', lost: { reason: 'session stopped', at: NOW + 2000 } }
    const start = f.state.starts!.find(s => s.request.crewMoveOf === f.ada.id)!
    f.state = run(f.state, { type: 'agent.started', startId: start.id, harnessId: 'ada-2', configuration: config } as Command, 'started-lost', NOW + 5000, host)
    const rank = (id: string) => f.state.conversations.find(c => c.id === id)!.queueRank ?? Number.MAX_SAFE_INTEGER
    expect(rank(task.id)).toBeLessThan(rank(other.id))
  })
})

describe('the head of the list when the move is placed (review of #3229, River)', () => {
  it('an offline machine: liveness lost the task before the move, which puts it at the head at once', () => {
    const f = fixture([machine('mac', { receivedAt: NOW - 6 * 60_000 }), machine('mini')])
    f.state = run(f.state, { type: 'conversation.create', title: 'Other', brief: 'Other work', checks: [] } as Command, 'other-2', NOW - 7_200_000)
    const task = working(f)
    const other = f.state.conversations.find(c => c.title === 'Other')!
    // Lost at 2 minutes offline, before the 5-minute move.
    const lost = f.state.conversations.find(c => c.id === task.id)!
    lost.assignment = { ...lost.assignment!, status: 'lost', lost: { reason: 'machine offline', at: NOW - 4 * 60_000 } }
    f.state.agents.find(a => a.id === f.ada.id)!.lostTask = { conversationId: task.id, assignmentId: lost.assignment.id, reason: 'machine offline', at: NOW - 4 * 60_000 }
    applyCrewKeep(f.state, NOW, everywhere)
    const rank = (id: string) => f.state.conversations.find(c => c.id === id)!.queueRank ?? Number.MAX_SAFE_INTEGER
    expect(rank(task.id)).toBeLessThan(rank(other.id))
  })
})

describe('a take-over marks nothing Team-written (security review of #3229, Curlew3)', () => {
  it('a moved member joins its old conversations without marking them', () => {
    const f = fixture([machine('mac', { signedIn: false }), machine('mini')])
    f.state = run(f.state, { type: 'conversation.create', title: 'Talk', brief: 'A chat it was in', checks: [] } as Command, 'talk', NOW - 3_600_000)
    const talk = f.state.conversations.find(c => c.title === 'Talk')!
    talk.agentIds.push(f.ada.id)
    applyCrewKeep(f.state, NOW, everywhere)
    const start = f.state.starts!.find(s => s.request.crewMoveOf === f.ada.id)!
    f.state = run(f.state, { type: 'agent.started', startId: start.id, harnessId: 'ada-2', configuration: config } as Command, 'started-team', NOW + 5000, host)
    const after = f.state.conversations.find(c => c.id === talk.id)!
    expect(after.agentIds).toContain(f.state.agents.find(a => a.harnessId === 'ada-2')!.id)
    expect(after.teamWritten).toBeFalsy()
  })
})

describe('a member that keeps stopping is moved and its task goes back at once (#3662)', () => {
  it('hands its task on as soon as the move is decided, not after its start runs, and says why', () => {
    const f = fixture()
    const task = working(f)
    f.state.agents.find(a => a.id === f.ada.id)!.stops = [NOW - 50 * 60_000, NOW - 30 * 60_000, NOW - 5 * 60_000]
    const drafts = applyCrewKeep(f.state, NOW, everywhere)
    const ada = f.state.agents.find(a => a.id === f.ada.id)!
    expect(ada.movedTo).toMatchObject({ machineId: 'mini', reason: 'unstable' })
    const now = f.state.conversations.find(c => c.id === task.id)!
    expect(now.assignment).toMatchObject({ status: 'lost', lost: { reason: 'crew-unstable', at: NOW } })
    expect(activeWork(now)).toBe(false)
    expect(drafts.map(d => d.text).join(' ')).toContain('stopped 3 times in the last hour')
  })

  it('moves a member below its quota floor without handing its task on: it is still working', () => {
    const f = fixture([machine('mac', { usedPercent: 90 }), machine('mini')])
    const task = working(f)
    applyCrewKeep(f.state, NOW, everywhere)
    expect(f.state.agents.find(a => a.id === f.ada.id)!.movedTo).toMatchObject({ machineId: 'mini', reason: 'quota-low' })
    expect(f.state.conversations.find(c => c.id === task.id)!.assignment!.status).toBe('working')
  })
})

