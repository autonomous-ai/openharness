import { describe, expect, it } from 'vitest'
import { agentDisplayName, assignAgentDisplayNames, type NamedAgent } from './agentNames.js'
import { applyCommand } from './commands.js'
import { author, createSuperTab, visibleState, type Actor, type Agent } from './model.js'

const owner: Actor = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Actor = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null }
function legacyState() {
  const state = createSuperTab('team', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test', 'public')
  state.people.push({ id: 'peer', email: 'peer@example.com', role: 'collaborator', generation: 'first' })
  state.projects!.push({ ...state.projects![0]!, id: 'private', name: 'Private', visibility: 'private', leadConversationId: 'private-lead' })
  state.conversations.push({ ...state.conversations[0]!, id: 'private-lead', projectId: 'private', agentIds: [] })
  state.agents = Array.from({ length: 40 }, (_, i): Agent => ({
    id: `agent-${i}`, name: i % 2 ? 'Builder' : 'Lead', projectId: i % 2 ? 'private' : 'lead',
    machineId: 'machine', harnessId: `native-${i}`, machineOwnerId: 'host', contributorId: 'owner',
    membershipGeneration: 'team', configuration,
  }))
  return state
}

describe('individual agent names', () => {
  it('gives default roles distinct names while preserving chosen and persisted identities', () => {
    const agents: NamedAgent[] = [
      { id: 'custom', name: 'Multiply' },
      { id: 'existing', name: 'Lead', displayName: 'Atlas' },
      ...Array.from({ length: 80 }, (_, i) => ({ id: `a-${i}`, name: i % 2 ? 'Builder' : 'Lead' })),
      { id: 'clock', name: 'claude-2026-10-21-12-34' },
    ]
    const reversed = structuredClone(agents).reverse()
    assignAgentDisplayNames(agents)
    assignAgentDisplayNames(reversed)
    expect(new Set(agents.map(a => a.displayName)).size).toBe(agents.length)
    expect(agents[0]!.displayName).toBe('Multiply')
    expect(agents[1]!.displayName).toBe('Atlas')
    expect(agents.at(-1)!.displayName).not.toBe(agents.at(-1)!.name)
    expect(Object.fromEntries(agents.map(a => [a.id, a.displayName])))
      .toEqual(Object.fromEntries(reversed.map(a => [a.id, a.displayName])))
    const before = structuredClone(agents)
    agents.splice(2, 1)
    agents.push({ id: 'new', name: 'Lead' })
    assignAgentDisplayNames(agents)
    for (const a of agents.filter(a => a.id !== 'new')) {
      expect(a.displayName).toBe(before.find(b => b.id === a.id)!.displayName)
    }
    expect(agents.map(a => a.name)).toContain('Lead')
  })

  it('resolves legacy identities before filtering private projects without mutating reads', () => {
    const state = legacyState(), original = structuredClone(state)
    const all = visibleState(state, owner), publicOnly = visibleState(state, peer)
    expect(publicOnly.agents).toHaveLength(20)
    for (const a of publicOnly.agents) {
      expect(a.displayName).toBe(all.agents.find(b => b.id === a.id)!.displayName)
      expect(agentDisplayName(state.agents, a.id)).toBe(a.displayName)
    }
    expect(state).toEqual(original)
    expect(agentDisplayName(state.agents, 'removed')).toBeUndefined()
  })

  it('persists the displayed names on an authorized command and keeps routing identities unchanged', () => {
    const state = legacyState(), before = visibleState(state, owner)
    const command = { type: 'tab.rename' as const, name: 'Team renamed' }
    const context = { operationId: 'rename', now: 1000 }
    const result = applyCommand(state, owner, command, context)
    expect(result.state.agents).toEqual(before.agents)
    expect(applyCommand(state, owner, command, context)).toEqual(result)
    expect(state.agents.every(a => a.displayName === undefined)).toBe(true)
    const sender = author(result.state, { kind: 'agent', agentId: 'agent-0', machineOwnerId: 'host' })
    expect(sender).toMatchObject({ id: 'agent-0', name: 'Lead', displayName: before.agents[0]!.displayName })
  })
})
