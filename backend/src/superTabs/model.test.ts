import { describe, expect, it } from 'vitest'
import { awaitingWorkers, createSuperTab, visibleState, workerIndex, type Agent, type SuperTabState } from './model.js'

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value) }
  return value
}

describe('the removed Leads conversation', () => {
  it('is left out of a read over frozen stored records, which keep it unchanged', () => {
    const base = createSuperTab('tab1', 'Pilot', { id: 'u1', email: 'owner@example.com' }, 'prod')
    expect(base.conversations.some(c => c.kind === 'leads')).toBe(false)
    base.leadsConversationId = 'old-leads'
    base.conversations.push({ id: 'old-leads', kind: 'leads', title: 'Leads', leadId: null, agentIds: ['a1'], archived: false, brief: '',
      checks: [], assignment: null, lastMessageSequence: 3 })
    const stored = deepFreeze(structuredClone(base))
    // A read's state is a new object over frozen stored records (parts/shape.ts reassemble with `share`).
    const state: SuperTabState = { ...stored, conversations: [...stored.conversations] }
    const view = visibleState(state, { kind: 'person', userId: 'u1', email: 'owner@example.com' })
    expect(view.conversations.map(c => c.id)).toEqual(['lead'])
    expect(view).not.toHaveProperty('leadsConversationId')
    expect(stored.conversations.find(c => c.kind === 'leads')).toMatchObject({ agentIds: ['a1'], lastMessageSequence: 3 })
  })
})

describe('awaitingWorkers (spec 2026-11-02, Part 5)', () => {
  /** 50 workers, each with a finished and an active task, and a Lead: every agent's answer reads every conversation. */
  function swarm(): SuperTabState {
    const state = createSuperTab('tab1', 'Pilot', { id: 'u1', email: 'owner@example.com' }, 'prod')
    const configuration = { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null } as unknown as Agent['configuration']
    state.agents = Array.from({ length: 50 }, (_, i): Agent => ({ id: `a${i}`, machineId: 'm', harnessId: `h${i}`, machineOwnerId: 'u1',
      contributorId: 'u1', membershipGeneration: 'g', name: `a${i}`, configuration }))
    state.conversations[0]!.leadId = 'a0'
    for (let i = 0; i < 100; i++) {
      state.conversations.push({ id: `c${i}`, title: '', leadId: null, agentIds: [], archived: false, brief: '', checks: [], lastMessageSequence: 0,
        assignment: { id: `w${i}`, agentId: `a${i % 50}`, status: i < 50 ? 'done' : i % 2 ? 'working' : 'cancelled', result: null, configuration,
          execution: { machineId: 'm', harnessId: 'h', machineOwnerId: 'u1' } } })
    }
    return state
  }
  /** Counts scans of the conversations: a for-of, some, find or filter alike reads the first one once. */
  function counted(state: SuperTabState): { scans: number } {
    const count = { scans: 0 }
    state.conversations = new Proxy(state.conversations, { get(target, key, receiver) {
      if (key === '0') count.scans++
      return Reflect.get(target, key, receiver)
    } })
    return count
  }

  it('scans the conversations a constant number of times, and none with an index built for a loop over projects', () => {
    const state = swarm()
    const expected = state.agents.filter((_, i) => i > 0 && i % 2 === 0).map(a => a.id)
    const alone = counted(state)
    expect(awaitingWorkers(state, 'lead').map(a => a.id)).toEqual(expected)
    expect(alone.scans).toBeLessThanOrEqual(3)
    const index = workerIndex(state), shared = counted(state)
    expect(awaitingWorkers(state, 'lead', index).map(a => a.id)).toEqual(expected)
    expect(shared.scans).toBe(0)
  })
})
