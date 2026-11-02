import { describe, expect, it } from 'vitest'
import { applyCommand } from './commands.js'
import { closedAgents, DOWN_REMOVE_MS, removeClosedAgents, STOPPED_REMOVE_MS } from './closedAgents.js'
import { MACHINE_FRESH_MS } from './machines.js'
import { createSuperTab, type Actor, type Agent, type SuperTabState } from './model.js'
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
