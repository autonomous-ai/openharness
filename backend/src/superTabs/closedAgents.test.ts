import { describe, expect, it } from 'vitest'
import { REMOVED_KEPT, removeClosedAgents, restoreRefusal, restoreSessions } from './closedAgents.js'
import type { Agent, Conversation, RemovedSession, SuperTabState } from './model.js'

const NOW = Date.parse('2026-11-02T08:00:00.000Z')
const agent = (patch: Partial<Agent> = {}): Agent => ({ id: 'a1', machineId: 'mac', harnessId: 'h1', projectId: 'p', machineOwnerId: 'owner', contributorId: 'owner',
  membershipGeneration: 'g1', hostGrant: null, name: 'Agent', configuration: { engine: 'codex', model: 'm', effort: 'high', contextWindow: null, engineVersion: null },
  configurationVersion: 'v1', ...patch }) as Agent
const group = (patch: Partial<Conversation> = {}): Conversation => ({ id: 'g1', title: 'Task', projectId: 'p', leadId: null, agentIds: [], archived: false, ...patch }) as Conversation
const record = (patch: Partial<RemovedSession> = {}): RemovedSession => ({ machineId: 'mac', harnessId: 'h1', agent: agent(), groupIds: ['g1'], leadOf: [], removedAt: NOW - 60_000, ...patch })
function swarm(patch: Partial<SuperTabState> = {}, pool: Record<string, unknown> = {}): SuperTabState {
  return { id: 'tab', environment: 'prod', people: [{ id: 'owner', email: 'o@x', role: 'owner', generation: 'g1' }, { id: 'mate', email: 'm@x', role: 'collaborator', generation: 'g2' }],
    agents: [], conversations: [group()], projects: [{ id: 'p', name: 'P', ownerId: 'owner', leadConversationId: 'lead-p', visibility: 'public', members: [] }, { id: 'other', name: 'O', ownerId: 'owner', leadConversationId: 'lead-o', visibility: 'public', members: [] }],
    machines: [{ machineId: 'mac', contributorId: 'owner', name: 'Mac', generation: 'gen', ...pool }], removedSessions: [record()], ...patch } as unknown as SuperTabState
}
const facts = { elsewhere: new Set<string>(), teamMachines: [] as string[], otherWorkspaceMachines: [] as string[] }

// Security review 1 of #2601: a restore takes the rules a person's add takes (commands.ts agent.add).
describe('what may come back', () => {
  it('comes back on an ordinary machine', () => {
    expect(restoreRefusal(swarm(), record(), 'owner', NOW, facts)).toBeNull()
  })

  it('never onto a Team account that serves another project', () => {
    const team = { hostMachineId: 'host-mac', teamAccountOnly: true }
    const onTeam = record({ agent: agent({ teamAccount: true }) })
    const held = [{ agentId: 'b', machineId: 'mac', harnessId: 'b', machineOwnerId: 'owner', heldFor: 'other', since: NOW }]
    expect(restoreRefusal(swarm({ closingSessions: held } as Partial<SuperTabState>, team), onTeam, 'owner', NOW, { ...facts, teamMachines: ['mac'] })).toBe('team-other-project')
    const mine = [{ agentId: 'b', machineId: 'mac', harnessId: 'b', machineOwnerId: 'owner', heldFor: 'p', since: NOW }]
    expect(restoreRefusal(swarm({ closingSessions: mine } as Partial<SuperTabState>, team), onTeam, 'owner', NOW, { ...facts, teamMachines: ['mac'] })).toBeNull()
  })

  it('never a teammate\'s project on a machine that can no longer take it', () => {
    // The Team account was removed: its owner's own project may come back there, and nobody else's.
    expect(restoreRefusal(swarm({}, { hostMachineId: 'host-mac' }), record(), 'owner', NOW, facts)).toBeNull()
    const theirs = swarm({ projects: [{ id: 'p', name: 'P', ownerId: 'mate', leadConversationId: 'lead-p', visibility: 'public', members: [] }] } as unknown as Partial<SuperTabState>, { hostMachineId: 'host-mac' })
    expect(restoreRefusal(theirs, record(), 'owner', NOW, facts)).toBe('team-work')
  })

  it('leaves out a task marked Team-written while it was away, and keeps the rest', () => {
    const state = swarm({ conversations: [group({ teamWritten: true }), group({ id: 'g2' })], removedSessions: [record({ groupIds: ['g1', 'g2'] })] })
    restoreSessions(state, 'mac', ['h1'], NOW, new Set(['h1']), () => {})
    expect(state.conversations.find(c => c.id === 'g1')!.agentIds).toEqual([])
    expect(state.conversations.find(c => c.id === 'g2')!.agentIds).toEqual(['a1'])
  })
})

describe('what a removal keeps', () => {
  const removal = (target: Agent, patch: Partial<SuperTabState> = {}) => {
    const state = swarm({ agents: [target], conversations: [group({ agentIds: [target.id] })], removedSessions: [], ...patch })
    removeClosedAgents(state, [target], NOW)
    return state
  }

  it('keeps no pending switch or alert of the session it was', () => {
    const kept = removal(agent({ switchRequest: { id: 's' }, switchLanded: { id: 's', requestedBy: 'x' }, alerting: ['prompt'] } as unknown as Partial<Agent>)).removedSessions![0]!.agent
    expect(kept).not.toHaveProperty('switchRequest')
    expect(kept).not.toHaveProperty('switchLanded')
    expect(kept).not.toHaveProperty('alerting')
  })

  it('a later removal that keeps no record takes the older one with it', () => {
    const state = removal(agent({ confidential: true }), { removedSessions: [record()] })
    expect(state.removedSessions ?? []).toEqual([])
  })

  it('keeps at most REMOVED_KEPT for a machine, the oldest going first, and leaves another machine\'s', () => {
    const old = Array.from({ length: REMOVED_KEPT }, (_, i) => record({ harnessId: `h-${i}`, removedAt: NOW - 1000 + i, agent: agent({ id: `x-${i}`, harnessId: `h-${i}` }) }))
    const other = record({ machineId: 'other-mac', harnessId: 'o' })
    const left = removal(agent(), { removedSessions: [...old, other] }).removedSessions!
    expect(left.filter(r => r.machineId === 'mac')).toHaveLength(REMOVED_KEPT)
    expect(left.some(r => r.harnessId === 'h-0')).toBe(false)
    expect(left.some(r => r.harnessId === 'h1')).toBe(true)
    expect(left).toContainEqual(other)
  })
})
