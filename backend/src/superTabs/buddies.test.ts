import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type Conversation } from './model.js'
import { canReadGroup, canWatchAgent, isConfidential } from './projects.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }

/** A Swarm of two public projects, each with its Lead, and peer's Buddy in the first, stored as buddy.create and its start
 *  leave them (buddies.ts): a Buddy agent and its owner-only chat. */
function setup() {
  let state = createSuperTab('swarm', 'Team', { id: 'owner', email: owner.email }, 'test')
  state.people.push({ id: 'peer', email: peer.email, role: 'collaborator', generation: 'first' })
  let next = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1000,
      contribution: { machineOwnerId: 'host', contributorId: actor.kind === 'person' ? actor.userId : 'owner' }, ...context })
    state = effects.state
    return effects
  }
  const app = run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
  const web = run({ type: 'project.create', name: 'Web', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
  const lead = (conversationId: string, harnessId: string) => run({ type: 'agent.add', conversationId, harnessId, machineId: 'machine',
    name: harnessId, configuration, lead: true }).result.agentId as string
  const pm = lead(app.conversationId, 'app-pm')
  lead(web.conversationId, 'web-pm')
  const group = run({ type: 'conversation.create', projectId: app.projectId, title: 'Offline', brief: 'Save edits.', checks: [] }).result.conversationId as string
  const pmChat = run({ type: 'conversation.create', projectId: app.projectId, title: 'peer', brief: '', checks: [],
    audience: { personIds: ['peer'] } }, peer).result.conversationId as string
  state.agents.push({ id: 'buddy', projectId: app.projectId, machineId: 'machine', harnessId: 'buddy-harness', machineOwnerId: 'host',
    contributorId: 'peer', membershipGeneration: 'first', name: 'Buddy', configuration, buddyOf: { personId: 'peer', generation: 'first' } })
  const chat: Conversation = { id: 'peer-buddy', kind: 'buddy', projectId: app.projectId, title: 'Buddy', leadId: null, agentIds: ['buddy'],
    archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'peer', generation: 'first' }] } }
  state.conversations.push(chat)
  return { run, app, web, pm, group, pmChat, chat: chat.id, get state() { return state } }
}
const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host' })
const group = (f: ReturnType<typeof setup>, id: string) => f.state.conversations.find(c => c.id === id)!

describe('who reads a Buddy chat', () => {
  it('is its owner and its Buddy: never the PM, the project or Swarm owner, or another person', () => {
    const f = setup(), chat = group(f, f.chat)
    expect(canReadGroup(f.state, peer, chat)).toBe(true)
    expect(canReadGroup(f.state, agentActor('buddy'), chat)).toBe(true)
    expect(canReadGroup(f.state, agentActor(f.pm), chat)).toBe(false)
    expect(canReadGroup(f.state, owner, chat)).toBe(false)
  })

  it('stops being its owner\'s once they rejoin at a new membership', () => {
    const f = setup()
    f.state.people.find(p => p.id === 'peer')!.generation = 'second'
    expect(canReadGroup(f.state, peer, group(f, f.chat))).toBe(false)
  })

  it('is left out of everyone else\'s Swarm read, the PM\'s included', () => {
    const f = setup()
    expect(visibleState(f.state, peer).conversations.map(c => c.id)).toContain(f.chat)
    for (const reader of [owner, agentActor(f.pm)]) expect(visibleState(f.state, reader).conversations.map(c => c.id)).not.toContain(f.chat)
  })
})

describe('what a Buddy reads', () => {
  it('is its project\'s chat and its own chat: no workgroup, no Chat with PM, no other project, no Leads conversation', () => {
    const f = setup(), buddy = agentActor('buddy')
    expect(canReadGroup(f.state, buddy, group(f, f.app.conversationId))).toBe(true)
    expect(canReadGroup(f.state, buddy, group(f, f.group))).toBe(false)
    expect(canReadGroup(f.state, buddy, group(f, f.pmChat))).toBe(false)
    expect(canReadGroup(f.state, buddy, group(f, f.web.conversationId))).toBe(false)
    expect(visibleState(f.state, buddy).conversations.map(c => c.id).sort()).toEqual([f.app.conversationId, f.chat].sort())
  })

  it('is no other person\'s Buddy chat in the same project', () => {
    const f = setup()
    f.state.conversations.push({ ...group(f, f.chat), id: 'owner-buddy', agentIds: ['other-buddy'], audience: { people: [{ id: 'owner', generation: f.state.people[0]!.generation }] } })
    expect(canReadGroup(f.state, agentActor('buddy'), group(f, 'owner-buddy'))).toBe(false)
  })

  it('is a confidential session: only the person whose machine runs it watches its terminal', () => {
    const f = setup(), buddy = f.state.agents.find(a => a.id === 'buddy')!
    f.state.people.push({ id: 'host', email: 'host@example.com', role: 'collaborator', generation: 'first' })
    expect(isConfidential(f.state, buddy)).toBe(true)
    expect(canWatchAgent(f.state, peer, buddy)).toBe(false)
    expect(canWatchAgent(f.state, { kind: 'person', userId: 'host', email: 'host@example.com' }, buddy)).toBe(true)
  })
})

describe('the Swarm\'s Buddies setting', () => {
  it('is off in a new Swarm, and only its owner turns it on', () => {
    const f = setup()
    expect(f.state.buddies).toBeUndefined()
    expect(() => f.run({ type: 'tab.buddies', enabled: true }, peer)).toThrow('Only the Swarm owner')
    expect(() => f.run({ type: 'tab.buddies', enabled: true }, agentActor(f.pm))).toThrow('Only the Swarm owner')
    f.run({ type: 'tab.buddies', enabled: true })
    expect(f.state.buddies).toBe(true)
    expect(visibleState(f.state, peer).buddies).toBe(true)
  })

  it('may be turned on by a Lead passing on the owner\'s own chat message from the last day', () => {
    const f = setup(), askedIn = { conversationId: f.app.conversationId, messageId: 'owner-message' }
    const asked = (author: { kind: 'person' | 'agent'; id: string }, createdAt = 1000) =>
      ({ askedIn: { author: { ...author, name: author.id, membershipGeneration: 'g' }, source: false, createdAt } })
    expect(() => f.run({ type: 'tab.buddies', enabled: true, askedIn }, agentActor(f.pm), asked({ kind: 'person', id: 'peer' }))).toThrow('Only the Swarm owner')
    f.run({ type: 'tab.buddies', enabled: true, askedIn }, agentActor(f.pm), asked({ kind: 'person', id: 'owner' }))
    expect(f.state.buddies).toBe(true)
  })

  it('removes every Buddy when turned off, closing its session, and keeps their chats for their owners', () => {
    const f = setup()
    f.run({ type: 'tab.buddies', enabled: true })
    const off = f.run({ type: 'tab.buddies', enabled: false })
    expect(f.state.buddies).toBeUndefined()
    expect(f.state.agents.map(a => a.id)).not.toContain('buddy')
    expect(off.cancelledAgents).toEqual(['buddy'])
    expect(f.state.closingSessions).toEqual([{ agentId: 'buddy', machineId: 'machine', harnessId: 'buddy-harness', machineOwnerId: 'host' }])
    expect(group(f, f.chat)).toMatchObject({ agentIds: [], archived: false })
    expect(canReadGroup(f.state, peer, group(f, f.chat))).toBe(true)
  })
})
