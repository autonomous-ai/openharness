import { describe, expect, it } from 'vitest'
import { applyCommand } from './commands.js'
import { closedAgents, DOWN_REMOVE_MS, REMOVED_KEEP_MS, REMOVED_KEPT, removeClosedAgents, reopened, restoreRefusal, restoreSessions, STOPPED_REMOVE_MS } from './closedAgents.js'
import { MACHINE_FRESH_MS } from './machines.js'
import { createSuperTab, type Actor, type Agent, type Conversation, type RemovedSession, type SuperTabState } from './model.js'
import { projectsOf } from './projects.js'

const config = { engine: 'codex', model: 'm', effort: 'high', contextWindow: null, engineVersion: null }
const person: Actor = { kind: 'person', userId: 'owner', email: 'owner@example.test' }
const NOW = 10_000_000

/** A Swarm with its coordinator and one worker on machine 'mac', whose last reading (fresh) listed `before` running. */
function fixture(before: string[] = ['lead', 'other']) {
  let state: SuperTabState = createSuperTab('tab', 'Work', { id: 'owner', email: 'owner@example.test' }, 'prod')
  const add = (harnessId: string, lead: boolean) => {
    state = applyCommand(state, person, { type: 'agent.add', conversationId: 'lead', machineId: 'mac', harnessId, name: harnessId, lead, configuration: config },
      { now: 1, operationId: `add-${harnessId}`, contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).state
    return state.agents.find(a => a.harnessId === harnessId)!
  }
  const lead = add('lead', true)
  const worker = add('worker', false)
  state.machines = [{ machineId: 'mac', name: 'Mac', cwd: '/r', engines: ['codex'], maxAgents: 4, contributorId: 'owner', membershipGeneration: 'g', generation: 'g1', paused: false,
    observation: { runningHarnessIds: before, stoppedHarnessIds: [], receivedAt: NOW - 5_000 } } as unknown as NonNullable<SuperTabState['machines']>[number]]
  worker.downSince = new Date(NOW - 2 * STOPPED_REMOVE_MS).toISOString()
  const report = (running: string[], stopped: string[] = []) => ({ runningHarnessIds: running, stoppedHarnessIds: stopped, stoppedReservations: [] })
  return { state, lead, worker, report }
}
const ids = (agents: Agent[]) => agents.map(a => a.harnessId)

describe('closedAgents: which agents a report shows closed', () => {
  it('takes an agent listed stopped, down long enough, after a fresh reading that did not list it running', () => {
    const f = fixture()
    expect(ids(closedAgents(f.state, 'mac', f.report(['lead'], ['worker']), NOW))).toEqual(['worker'])
  })
  it('takes nobody on the first report after a silence', () => {
    const f = fixture()
    f.state.machines![0]!.observation!.receivedAt = NOW - MACHINE_FRESH_MS - 1
    expect(closedAgents(f.state, 'mac', f.report(['lead'], ['worker']), NOW)).toEqual([])
  })
  it('waits STOPPED_REMOVE_MS since it went down, so a host mid-restart or a Change agent in progress is not cut off', () => {
    const f = fixture()
    f.worker.downSince = new Date(NOW - STOPPED_REMOVE_MS + 1).toISOString()
    expect(closedAgents(f.state, 'mac', f.report(['lead'], ['worker']), NOW)).toEqual([])
    delete f.worker.downSince
    expect(closedAgents(f.state, 'mac', f.report(['lead'], ['worker']), NOW)).toEqual([])
  })
  it('takes none that the last reading listed running: a session back from a restart starts its wait again', () => {
    const f = fixture(['lead', 'worker'])
    expect(closedAgents(f.state, 'mac', f.report(['lead'], ['worker']), NOW)).toEqual([])
  })
  it('leaves an agent whose stop was asked for to its host, which closes it', () => {
    const f = fixture()
    f.worker.workDecision = 'stop'
    expect(closedAgents(f.state, 'mac', f.report(['lead'], ['worker']), NOW)).toEqual([])
    f.worker.workDecision = 'keep'
    expect(closedAgents(f.state, 'mac', f.report(['lead'], ['worker']), NOW)).toEqual([])
  })
  it('takes an agent not listed at all only after DOWN_REMOVE_MS, and never when the report lists nothing running', () => {
    const f = fixture()
    f.worker.downSince = new Date(NOW - DOWN_REMOVE_MS + 1).toISOString()
    expect(closedAgents(f.state, 'mac', f.report(['lead']), NOW)).toEqual([])
    f.worker.downSince = new Date(NOW - DOWN_REMOVE_MS).toISOString()
    expect(ids(closedAgents(f.state, 'mac', f.report(['lead']), NOW))).toEqual(['worker'])
    // A fault in the host's listing would empty a whole machine: not this way.
    expect(closedAgents(f.state, 'mac', f.report([]), NOW)).toEqual([])
    f.state.machines![0]!.observation!.runningHarnessIds = []
    expect(closedAgents(f.state, 'mac', f.report(['lead']), NOW)).toEqual([])
  })
  it('never takes a coordinator', () => {
    const f = fixture()
    f.lead.downSince = f.worker.downSince
    expect(projectsOf(f.state).some(p => p.leadConversationId === 'lead')).toBe(true)
    expect(ids(closedAgents(f.state, 'mac', f.report([], ['lead', 'worker']), NOW))).toEqual(['worker'])
  })
})

describe('removeClosedAgents: what a removal leaves for the host', () => {
  it('writes the close record a removal by command writes, so the host closes the session and frees its slot', () => {
    const f = fixture()
    expect(ids(removeClosedAgents(f.state, [f.worker], NOW))).toEqual(['worker'])
    expect(f.state.closingSessions).toEqual([{ agentId: f.worker.id, machineId: 'mac', harnessId: 'worker', machineOwnerId: 'owner' }])
    expect(f.state.agents.map(a => a.id)).toEqual([f.lead.id])
    expect(f.state.conversations.every(c => !c.agentIds.includes(f.worker.id))).toBe(true)
  })
  it('frees the slot of its reservation once the host confirms the close', () => {
    const f = fixture()
    f.state.harnessReservations = [{ machineId: 'mac', harnessId: 'worker', generation: 'r1', operationId: 'reserve' } as never]
    removeClosedAgents(f.state, [f.worker], NOW)
    expect(f.state.harnessReservations).toHaveLength(1)
    const closed = applyCommand(f.state, { kind: 'person', userId: 'owner', email: 'owner@example.test' }, { type: 'agent.sessionClosed', agentId: f.worker.id, harnessId: 'worker' } as never, { now: NOW, operationId: 'closed' })
    expect(closed.state.closingSessions).toBeUndefined()
    expect(closed.state.harnessReservations).toEqual([])
    expect(closed.state.releasedHarnesses).toEqual([{ machineId: 'mac', harnessId: 'worker' }])
  })
  it('holds a Team account for the project of a confidential session until its host confirms the data deleted', () => {
    const f = fixture()
    f.worker.confidential = true
    f.worker.teamAccount = true
    removeClosedAgents(f.state, [f.worker], NOW)
    expect(f.state.closingSessions).toEqual([expect.objectContaining({ agentId: f.worker.id, heldFor: expect.any(String), since: NOW })])
  })
  it('keeps an agent that holds a task, active or just lost', () => {
    const f = fixture()
    const group = f.state.conversations.find(c => c.id === 'lead')!
    group.assignment = { id: 'work', agentId: f.worker.id, status: 'lost', configuration: config,
      execution: { machineId: 'mac', machineOwnerId: 'owner', harnessId: 'worker' }, result: null } as never
    expect(removeClosedAgents(f.state, [f.worker], NOW)).toEqual([])
    expect(f.state.closingSessions).toBeUndefined()
  })
})

// A person's choice stands over an older record (security review 1 of #2601).
describe('a person\'s add or remove of the session', () => {
  const recordOf = (target: Agent) => ({ machineId: 'mac', harnessId: target.harnessId, agent: target, groupIds: ['lead'], leadOf: [], removedAt: NOW })

  it('takes its record with it when they add it back', () => {
    const f = fixture()
    // No machine listed, as a person may add a session on any machine of theirs.
    const state = { ...f.state, machines: undefined, agents: f.state.agents.filter(a => a.id !== f.worker.id), removedSessions: [recordOf(f.worker)] }
    const added = applyCommand(state, person, { type: 'agent.add', conversationId: 'lead', machineId: 'mac', harnessId: 'worker', name: 'worker', lead: false, configuration: config },
      { now: NOW, operationId: 'add-again', contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).state
    expect(added.removedSessions ?? []).toEqual([])
  })

  it('takes its record with it when they remove it, so a reopen does not undo that', () => {
    const f = fixture()
    f.worker.workDecision = 'stop'
    const state = { ...f.state, removedSessions: [recordOf(f.worker), { ...recordOf(f.worker), harnessId: 'another' }] }
    const removed = applyCommand(state, person, { type: 'agent.remove', agentId: f.worker.id }, { now: NOW, operationId: 'remove-it' }).state
    expect(removed.agents.map(a => a.id)).not.toContain(f.worker.id)
    expect((removed.removedSessions ?? []).map(r => r.harnessId)).toEqual(['another'])
  })

  it('an expired record is not reopened, so it writes no session record', () => {
    const f = fixture()
    const state = { ...f.state, removedSessions: [{ ...recordOf(f.worker), removedAt: NOW - REMOVED_KEEP_MS }] }
    expect(reopened(state, 'mac', ['worker'], NOW)).toEqual([])
    expect(reopened(state, 'mac', ['worker'], NOW - 1)).toHaveLength(1)
  })
})

// What a removal keeps, and a reopened session coming back from it (task #2131).
const AT = Date.parse('2026-11-02T08:00:00.000Z')
const removedAgent = (patch: Partial<Agent> = {}): Agent => ({ id: 'a1', machineId: 'mac', harnessId: 'h1', projectId: 'p', machineOwnerId: 'owner', contributorId: 'owner',
  membershipGeneration: 'g1', hostGrant: null, name: 'Agent', configuration: { engine: 'codex', model: 'm', effort: 'high', contextWindow: null, engineVersion: null },
  configurationVersion: 'v1', ...patch }) as Agent
const removedGroup = (patch: Partial<Conversation> = {}): Conversation => ({ id: 'g1', title: 'Task', projectId: 'p', leadId: null, agentIds: [], archived: false, ...patch }) as Conversation
const record = (patch: Partial<RemovedSession> = {}): RemovedSession => ({ machineId: 'mac', harnessId: 'h1', agent: removedAgent(), groupIds: ['g1'], leadOf: [], removedAt: AT - 60_000, ...patch })
function restoring(patch: Partial<SuperTabState> = {}, pool: Record<string, unknown> = {}): SuperTabState {
  return { id: 'tab', environment: 'prod', people: [{ id: 'owner', email: 'o@x', role: 'owner', generation: 'g1' }, { id: 'mate', email: 'm@x', role: 'collaborator', generation: 'g2' }],
    agents: [], conversations: [removedGroup()], projects: [{ id: 'p', name: 'P', ownerId: 'owner', leadConversationId: 'lead-p', visibility: 'public', members: [] }, { id: 'other', name: 'O', ownerId: 'owner', leadConversationId: 'lead-o', visibility: 'public', members: [] }],
    machines: [{ machineId: 'mac', contributorId: 'owner', name: 'Mac', generation: 'gen', ...pool }], removedSessions: [record()], ...patch } as unknown as SuperTabState
}
const facts = { elsewhere: new Set<string>(), teamMachines: [] as string[], otherWorkspaceMachines: [] as string[] }

// Security review 1 of #2601: a restore takes the rules a person's add takes (commands.ts agent.add).
describe('what may come back', () => {
  it('comes back on an ordinary machine', () => {
    expect(restoreRefusal(restoring(), record(), 'owner', AT, facts)).toBeNull()
  })

  it('never onto a Team account that serves another project', () => {
    const team = { hostMachineId: 'host-mac', teamAccountOnly: true }
    const onTeam = record({ agent: removedAgent({ teamAccount: true }) })
    const held = [{ agentId: 'b', machineId: 'mac', harnessId: 'b', machineOwnerId: 'owner', heldFor: 'other', since: AT }]
    expect(restoreRefusal(restoring({ closingSessions: held } as Partial<SuperTabState>, team), onTeam, 'owner', AT, { ...facts, teamMachines: ['mac'] })).toBe('team-other-project')
    const mine = [{ agentId: 'b', machineId: 'mac', harnessId: 'b', machineOwnerId: 'owner', heldFor: 'p', since: AT }]
    expect(restoreRefusal(restoring({ closingSessions: mine } as Partial<SuperTabState>, team), onTeam, 'owner', AT, { ...facts, teamMachines: ['mac'] })).toBeNull()
  })

  it('never a teammate\'s project on a machine that can no longer take it', () => {
    // The Team account was removed: its owner's own project may come back there, and nobody else's.
    expect(restoreRefusal(restoring({}, { hostMachineId: 'host-mac' }), record(), 'owner', AT, facts)).toBeNull()
    const theirs = restoring({ projects: [{ id: 'p', name: 'P', ownerId: 'mate', leadConversationId: 'lead-p', visibility: 'public', members: [] }] } as unknown as Partial<SuperTabState>, { hostMachineId: 'host-mac' })
    expect(restoreRefusal(theirs, record(), 'owner', AT, facts)).toBe('team-work')
  })

  it('leaves out a task marked Team-written while it was away, and keeps the rest', () => {
    const state = restoring({ conversations: [removedGroup({ teamWritten: true }), removedGroup({ id: 'g2' })], removedSessions: [record({ groupIds: ['g1', 'g2'] })] })
    restoreSessions(state, 'mac', ['h1'], AT, new Set(['h1']), () => {})
    expect(state.conversations.find(c => c.id === 'g1')!.agentIds).toEqual([])
    expect(state.conversations.find(c => c.id === 'g2')!.agentIds).toEqual(['a1'])
  })
})

describe('what a removal keeps', () => {
  const removal = (target: Agent, patch: Partial<SuperTabState> = {}) => {
    const state = restoring({ agents: [target], conversations: [removedGroup({ agentIds: [target.id] })], removedSessions: [], ...patch })
    removeClosedAgents(state, [target], AT)
    return state
  }

  it('keeps no pending switch or alert of the session it was', () => {
    const kept = removal(removedAgent({ switchRequest: { id: 's' }, switchLanded: { id: 's', requestedBy: 'x' }, alerting: ['prompt'] } as unknown as Partial<Agent>)).removedSessions![0]!.agent
    expect(kept).not.toHaveProperty('switchRequest')
    expect(kept).not.toHaveProperty('switchLanded')
    expect(kept).not.toHaveProperty('alerting')
  })

  it('a later removal that keeps no record takes the older one with it', () => {
    const state = removal(removedAgent({ confidential: true }), { removedSessions: [record()] })
    expect(state.removedSessions ?? []).toEqual([])
  })

  it('keeps at most REMOVED_KEPT for a machine, the oldest going first, and leaves another machine\'s', () => {
    const old = Array.from({ length: REMOVED_KEPT }, (_, i) => record({ harnessId: `h-${i}`, removedAt: AT - 1000 + i, agent: removedAgent({ id: `x-${i}`, harnessId: `h-${i}` }) }))
    const other = record({ machineId: 'other-mac', harnessId: 'o' })
    const left = removal(removedAgent(), { removedSessions: [...old, other] }).removedSessions!
    expect(left.filter(r => r.machineId === 'mac')).toHaveLength(REMOVED_KEPT)
    expect(left.some(r => r.harnessId === 'h-0')).toBe(false)
    expect(left.some(r => r.harnessId === 'h1')).toBe(true)
    expect(left).toContainEqual(other)
  })
})
