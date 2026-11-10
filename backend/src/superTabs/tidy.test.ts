import { describe, expect, it } from 'vitest'
import type { Agent, Assignment, Conversation, SuperTabState } from './model.js'
import { staleSwitches, SWITCH_UNCLAIMED_MS } from './tidy.js'

const MINUTE = 60_000
const START = Date.parse('2026-10-27T08:00:00.000Z')
const iso = (at: number) => new Date(at).toISOString()
const config = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const done = (patch: Partial<Assignment> = {}): Assignment => ({ id: 'a1', agentId: 'w', status: 'done', result: 'Merged', configuration: config,
  execution: { machineId: 'm', harnessId: 'h', machineOwnerId: 'o' }, progressAt: START, ...patch })
const worker = (patch: Partial<Agent> = {}): Agent => ({ id: 'w', machineId: 'm', harnessId: 'h', machineOwnerId: 'o', contributorId: 'p',
  membershipGeneration: 'g', name: 'Builder', displayName: 'Rowan', configuration: config,
  startedSession: { creationId: 'c1', sessionId: 's1', createdAt: iso(START - 60 * MINUTE) }, ...patch })
const group = (patch: Partial<Conversation> = {}): Conversation => ({ id: 'g1', title: 'Task', leadId: 'L', agentIds: ['L', 'w'], archived: false,
  brief: 'Do it', checks: [], assignment: done(), lastMessageSequence: 3, lastActivityAt: iso(START), ...patch })

/** A Swarm whose coordinator `L` runs on machine `m` with agent `w` (session `h`). */
function swarm(opts: { agents?: Agent[]; groups?: Conversation[] } = {}) {
  return {
    id: 't', ownerId: 'p', paused: false,
    agents: [worker({ id: 'L', harnessId: 'hl', name: 'Lead', displayName: 'River' }), ...opts.agents ?? [worker()]],
    people: [{ id: 'p', email: 'p@example.com', role: 'owner', generation: 'g' }],
    machines: [{ machineId: 'm', name: 'Studio' }],
    conversations: [{ id: 'lead', title: 'Lead', leadId: 'L', agentIds: ['L'], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 },
      ...opts.groups ?? [group()]],
  } as unknown as SuperTabState
}
const target = (state: SuperTabState, id = 'w') => state.agents.find(a => a.id === id)!

describe('staleSwitches', () => {
  const request = (patch = {}) => ({ id: 'op1', engine: 'codex', profileId: 'p', requestedBy: 'p', at: iso(START), ...patch })
  const asked = (switchRequest?: Agent['switchRequest']) => { const state = swarm(); target(state, 'L').switchRequest = switchRequest; return state }
  const line = { conversationId: 'lead', recipients: [], text: "Couldn't switch the PM: its machine did not answer." }

  it('drops a request nobody claimed in 2 minutes, with one line in the project chat', () => {
    const state = asked(request())
    expect(staleSwitches(state, START + SWITCH_UNCLAIMED_MS - 1)).toEqual([])
    expect(target(state, 'L').switchRequest).toBeDefined()
    expect(staleSwitches(state, START + SWITCH_UNCLAIMED_MS)).toMatchObject([line])
    expect(target(state, 'L').switchRequest).toBeUndefined()
    expect(staleSwitches(state, START + 3 * SWITCH_UNCLAIMED_MS)).toEqual([])
  })

  it('keeps a claimed request while its lease lasts and drops it once it lapsed', () => {
    const state = asked(request({ claimedUntil: iso(START + 15 * MINUTE) }))
    expect(staleSwitches(state, START + 10 * MINUTE)).toEqual([])
    expect(target(state, 'L').switchRequest).toBeDefined()
    expect(staleSwitches(state, START + 15 * MINUTE)).toMatchObject([line])
    expect(target(state, 'L').switchRequest).toBeUndefined()
  })
})
