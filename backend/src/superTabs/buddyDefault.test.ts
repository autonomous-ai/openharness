import { describe, expect, it } from 'vitest'
import { createSuperTab, type Agent, type Person } from './model.js'
import { defaultBuddy, defaultBuddyChat, openSwarmBuddyChat, ownAgentAuthor, swarmBuddyChatId } from './buddies.js'

// Task #3818 (Phase 2 of the Buddy board spec, approved 11-06): a person's lines (a decision, a needs-you, a removed Buddy's
// news) go to their default Buddy, and a proposal's notice to the Buddy that sent it while it is still theirs. Until a person
// may have several, the default is their one Buddy.
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }

function setup() {
  const state = createSuperTab('swarm', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
  const peer: Person = { id: 'peer', email: 'peer@example.com', role: 'collaborator', generation: 'second' }
  state.people.push(peer)
  const buddy = (id: string, extra: Partial<Agent> = {}): Agent => {
    const agent = { id, machineId: 'machine', harnessId: `${id}-harness`, machineOwnerId: 'peer', contributorId: 'peer', membershipGeneration: 'second',
      name: id, configuration, buddyOf: { personId: 'peer', generation: 'second' }, buddyScope: 'swarm', ...extra } as Agent
    state.agents.push(agent)
    return agent
  }
  return { state, peer, buddy }
}

describe('a person\'s default Buddy', () => {
  it('is their Buddy in this Swarm, never a thread session\'s, one of an older membership, or another person\'s', () => {
    const { state, peer, buddy } = setup()
    expect(defaultBuddy(state, peer.id)).toBeUndefined()
    buddy('old', { buddyOf: { personId: 'peer', generation: 'first' } })
    buddy('session', { buddySession: { thread: 't1', from: 0 } } as Partial<Agent>)
    buddy('theirs', { buddyOf: { personId: 'other', generation: 'second' } })
    expect(defaultBuddy(state, peer.id)).toBeUndefined()
    const main = buddy('main')
    openSwarmBuddyChat(state, peer).agentIds.push(main.id)
    expect(defaultBuddy(state, peer.id)?.id).toBe('main')
    expect(defaultBuddy(state, 'nobody')).toBeUndefined()
  })

  it('has a chat to write to, even before the person has a Buddy', () => {
    const { state, peer, buddy } = setup()
    expect(defaultBuddyChat(state, peer).id).toBe(swarmBuddyChatId(peer))
    const main = buddy('main')
    const chat = openSwarmBuddyChat(state, peer)
    chat.agentIds.push(main.id)
    expect(defaultBuddyChat(state, peer)).toBe(chat)
  })
})

describe('who writes a server notice in a person\'s private chat (task #4558)', () => {
  it('is their own default Buddy, never another person\'s, and nobody when they have none', () => {
    const { state, peer, buddy } = setup()
    expect(ownAgentAuthor(state, peer)).toBeUndefined()
    buddy('theirs', { buddyOf: { personId: 'other', generation: 'second' } })
    expect(ownAgentAuthor(state, peer)).toBeUndefined()
    const main = buddy('main')
    openSwarmBuddyChat(state, peer).agentIds.push(main.id)
    expect(ownAgentAuthor(state, peer)).toMatchObject({ kind: 'agent', id: 'main', membershipGeneration: main.membershipGeneration })
  })
})
