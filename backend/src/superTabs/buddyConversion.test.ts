import { describe, expect, it } from 'vitest'
import { giveOwnBuddy } from './ownBuddy.test-support.js'
import { convertBuddies } from './buddyConversion.js'
import { giveAgentsChats } from './agentChats.js'
import { agentChatId, agentKind } from './agentKind.js'
import { buddyChatId, swarmBuddyChatId } from './buddies.js'
import { createSuperTab, visibleState, type Actor, type AgentStart, type Conversation, type SuperTabState } from './model.js'
import { canReadGroup } from './projects.js'

// Swarm v4 (the lead's decision, 2026-11-10): every v3 Buddy becomes an ordinary agent of its person, and its private Buddy chat
// that agent's 1:1 chat with them, read by them alone, as before.
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }

function swarm() {
  const state = createSuperTab('swarm', 'Team', { id: 'owner', email: owner.email }, 'test')
  state.people.push({ id: 'peer', email: peer.email, role: 'collaborator', generation: 'first' })
  // A v4 agent of the owner's, with its 1:1 chat, which the conversion leaves as it is.
  state.agents.push({ id: 'v4', machineId: 'owner-mac', harnessId: 'v4', machineOwnerId: 'owner', contributorId: 'owner', membershipGeneration: state.people[0]!.generation,
    name: 'Ada', configuration, regular: true, chatId: 'v4-chat' })
  state.conversations.push({ id: 'v4-chat', kind: 'agent-chat', title: 'Ada', leadId: null, agentIds: ['v4'], archived: false, brief: '', checks: [],
    assignment: null, lastMessageSequence: 3, audience: { people: [{ id: 'owner', generation: state.people[0]!.generation }] } })
  return state
}
const chatOf = (state: SuperTabState, id: string): Conversation => state.conversations.find(c => c.id === id)!
const agentActor = (agentId: string, machineOwnerId = 'peer'): Actor => ({ kind: 'agent', agentId, machineOwnerId })

describe('convertBuddies', () => {
  it('makes a main Buddy an ordinary agent of its person, its Buddy chat their 1:1 chat, read by them alone', () => {
    const state = swarm()
    const buddy = giveOwnBuddy(state, 'peer')
    Object.assign(buddy, { modelRequest: { id: 'm', gridModel: null, requestedBy: 'peer', at: 'x' }, gridModelName: 'Qwen', gridModelUnservedSince: 5 })
    const id = swarmBuddyChatId(state.people[1]!)
    Object.assign(chatOf(state, id), { title: 'Theo', buddyName: 'Theo', buddyDefault: true, buddyChats: ['gone'], buddyDownTold: true, lastMessageSequence: 7 })
    const v4Before = structuredClone({ agent: state.agents[0], chat: chatOf(state, 'v4-chat') })

    expect(convertBuddies(state)).toEqual([])

    const converted = state.agents.find(a => a.id === buddy.id)!
    expect(converted).toEqual({ id: buddy.id, machineId: 'peer-mac', harnessId: buddy.id, machineOwnerId: 'peer', contributorId: 'peer',
      membershipGeneration: 'first', name: 'Buddy', configuration, regular: true, chatId: id })
    expect(chatOf(state, id)).toEqual({ id, kind: 'agent-chat', number: chatOf(state, id).number, title: 'Theo', leadId: null, agentIds: [buddy.id],
      archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 7, audience: { people: [{ id: 'peer', generation: 'first' }] } })
    expect(agentKind(state, converted)).toBe('regular')
    expect(agentChatId(state, converted)).toBe(id)
    // Its person and their agent read it; nobody else, the Swarm's owner and the owner's agent included.
    expect(canReadGroup(state, peer, chatOf(state, id))).toBe(true)
    expect(canReadGroup(state, agentActor(buddy.id), chatOf(state, id))).toBe(true)
    expect(canReadGroup(state, owner, chatOf(state, id))).toBe(false)
    expect(canReadGroup(state, agentActor('v4', 'owner'), chatOf(state, id))).toBe(false)
    expect(visibleState(state, owner).conversations.map(c => c.id)).not.toContain(id)
    expect(visibleState(state, peer).conversations.map(c => c.id)).toContain(id)
    // v4's own agents and chats are untouched, and the 1:1 chat pass then opens nothing new.
    expect({ agent: state.agents[0], chat: chatOf(state, 'v4-chat') }).toEqual(v4Before)
    const count = state.conversations.length
    giveAgentsChats(state, 1_000)
    expect(state.conversations).toHaveLength(count)
  })

  it('does nothing the second time: a converted agent is no Buddy', () => {
    const state = swarm()
    giveOwnBuddy(state, 'peer')
    convertBuddies(state)
    const once = structuredClone(state)
    expect(convertBuddies(state)).toEqual([])
    expect(state).toEqual(once)
  })

  it('ends thread sessions and older project-chat sessions, and fails Buddy starts still waiting', () => {
    const state = swarm()
    const buddy = giveOwnBuddy(state, 'peer')
    const id = swarmBuddyChatId(state.people[1]!)
    const session = { ...buddy, id: 'session', harnessId: 'session', buddySession: { thread: 't', from: 0 } }
    const narrow = { ...buddy, id: 'narrow', harnessId: 'narrow', buddyScope: undefined, buddyNarrow: true as const, projectId: 'lead' }
    state.agents.push(session, narrow)
    chatOf(state, id).agentIds.push('session')
    chatOf(state, id).buddySessions = [{ thread: 't', startId: 's', agentId: 'session', at: 0 }]
    const start = (startId: string, request: Partial<AgentStart['request']>): AgentStart => ({ id: startId, creationId: startId, actorKey: 'person:peer', contributorId: 'peer',
      membershipGeneration: 'first', machineOwnerId: 'peer', hostGrant: null, harnessId: null, dispatched: false, error: null,
      request: { conversationId: id, machineId: 'peer-mac', engine: 'claude', name: 'x', cwd: '/x', requirements: buddy as never, ...request } as AgentStart['request'] })
    state.starts = [start('buddy-start', { buddyOf: { personId: 'peer', generation: 'first' } }), start('plain', {})]

    const removed = convertBuddies(state)

    expect(removed.map(a => a.id).sort()).toEqual(['narrow', 'session'])
    expect(state.agents.map(a => a.id).sort()).toEqual([buddy.id, 'v4'])
    expect(chatOf(state, id)).toMatchObject({ kind: 'agent-chat', agentIds: [buddy.id] })
    expect(chatOf(state, id).buddySessions).toBeUndefined()
    // Their hosts close them, as for any removed agent.
    expect(state.closingSessions?.map(c => c.agentId).sort()).toEqual(['narrow', 'session'])
    expect(state.starts.map(s => s.error)).toEqual(['Buddies are agents now.', null])
  })

  it('converts an older project Buddy into an agent in no project, its chat out of the project', () => {
    const state = swarm()
    const generation = 'first'
    const chat = buddyChatId('lead', { id: 'peer', generation })
    state.agents.push({ id: 'old', projectId: 'lead', machineId: 'peer-mac', harnessId: 'old', machineOwnerId: 'peer', contributorId: 'peer',
      membershipGeneration: generation, name: 'Old', configuration, buddyOf: { personId: 'peer', generation } })
    state.conversations.push({ id: chat, kind: 'buddy', projectId: 'lead', title: 'Old', leadId: null, agentIds: ['old'], archived: false, brief: '',
      checks: [], assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'peer', generation }] } })

    convertBuddies(state)

    expect(state.agents.find(a => a.id === 'old')).not.toHaveProperty('projectId')
    expect(chatOf(state, chat)).toMatchObject({ kind: 'agent-chat', agentIds: ['old'] })
    expect(chatOf(state, chat)).not.toHaveProperty('projectId')
    expect(canReadGroup(state, peer, chatOf(state, chat))).toBe(true)
    expect(canReadGroup(state, owner, chatOf(state, chat))).toBe(false)
  })

  it('removes a Buddy that would not read its chat as an agent: on another person\'s machine, or of a person who left', () => {
    const state = swarm()
    const buddy = giveOwnBuddy(state, 'peer')
    buddy.machineOwnerId = 'owner'
    const id = swarmBuddyChatId(state.people[1]!)
    const before = structuredClone(chatOf(state, id))

    expect(convertBuddies(state).map(a => a.id)).toEqual([buddy.id])

    // Its chat stays its person's alone, as it was: no agent is in it.
    expect(chatOf(state, id)).toEqual({ ...before, agentIds: [] })
    expect(canReadGroup(state, owner, chatOf(state, id))).toBe(false)

    const left = swarm()
    giveOwnBuddy(left, 'peer')
    left.people = left.people.filter(p => p.id !== 'peer')
    expect(convertBuddies(left).map(a => a.id)).toEqual(['peer-buddy'])
  })
})
