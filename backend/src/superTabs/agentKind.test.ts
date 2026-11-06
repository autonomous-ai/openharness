import { describe, expect, it } from 'vitest'
import { createSuperTab, type Agent, type Person } from './model.js'
import { agentChatId, agentKind } from './agentKind.js'
import { openSwarmBuddyChat } from './buddies.js'

// Task #4116 (Swarm v3, anh Dee 11-07): the left pane lists "My agents": the person's Buddy first, then their other agents,
// a crown beside a PM, bold for an agent whose chat has news. Each agent says what it is and the chat its person talks to it in.
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }

function setup() {
  const state = createSuperTab('swarm', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
  const peer: Person = { id: 'peer', email: 'peer@example.com', role: 'collaborator', generation: 'second' }
  state.people.push(peer)
  const agent = (id: string, extra: Partial<Agent> = {}): Agent => {
    const made = { id, machineId: 'machine', harnessId: `${id}-harness`, machineOwnerId: 'peer', contributorId: 'peer', membershipGeneration: 'second',
      name: id, configuration, ...extra } as Agent
    state.agents.push(made)
    return made
  }
  return { state, peer, agent }
}

describe('an agent\'s kind and chat', () => {
  it('is a Buddy in its Buddy chat', () => {
    const { state, peer, agent } = setup()
    const buddy = agent('buddy', { buddyOf: { personId: 'peer', generation: 'second' }, buddyScope: 'swarm' })
    const chat = openSwarmBuddyChat(state, peer)
    chat.agentIds.push(buddy.id)
    expect(agentKind(state, buddy)).toBe('buddy')
    expect(agentChatId(state, buddy)).toBe(chat.id)
  })

  it('is a PM in its project\'s Lead chat', () => {
    const { state, agent } = setup()
    const pm = agent('pm')
    const lead = state.conversations.find(c => c.id === 'lead')!
    lead.leadId = pm.id
    lead.agentIds.push(pm.id)
    expect(agentKind(state, pm)).toBe('pm')
    expect(agentChatId(state, pm)).toBe('lead')
  })

  it('is Regular otherwise, with no chat of its own yet', () => {
    const { state, agent } = setup()
    const worker = agent('worker')
    state.conversations.find(c => c.id === 'lead')!.agentIds.push(worker.id)
    expect(agentKind(state, worker)).toBe('regular')
    expect(agentChatId(state, worker)).toBeNull()
  })
})
