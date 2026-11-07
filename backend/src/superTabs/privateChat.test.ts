import { describe, expect, it } from 'vitest'
import { openSwarmBuddyChat, swarmBuddyChatId } from './buddies.js'
import { applyCommand, type Command } from './commands.js'
import { createSuperTab, SuperTabError, type Actor, type Agent, type Author, type MessageDraft } from './model.js'
import { checkPrivateChat, SWARM_AUTHOR } from './privateChat.js'

// Task #4547 (anh Dee, 11-07 18:28): only a person and their own agent post in their private chat with that agent. River and
// Theo showed up in his: a Lead's private lines and proposal notices were written there as the Lead.

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let next = 0
  const run = (command: Command, actor: Actor = owner) => {
    const effects = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1_000_000,
      contribution: { machineOwnerId: 'owner', contributorId: actor.kind === 'person' ? actor.userId : 'owner' } })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  const pm = run({ type: 'agent.add', conversationId: 'lead', harnessId: 'pm', machineId: 'machine', name: 'River', lead: true, configuration }).result.agentId as string
  const buddyOf = (personId: string) => {
    const member = state.people.find(p => p.id === personId)!
    const buddy = { id: `${personId}-buddy`, machineId: 'machine', harnessId: `${personId}-buddy-harness`, machineOwnerId: personId, contributorId: personId,
      membershipGeneration: member.generation, name: `${personId} Buddy`, configuration, buddyOf: { personId, generation: member.generation }, buddyScope: 'swarm' } as Agent
    state.agents.push(buddy)
    openSwarmBuddyChat(state, member).agentIds.push(buddy.id)
    return { id: buddy.id, chat: swarmBuddyChatId(member), generation: member.generation }
  }
  const peerBuddy = buddyOf('peer'), ownerBuddy = buddyOf('owner')
  return { run, pm, peerBuddy, ownerBuddy, get state() { return state } }
}

const as = (kind: Author['kind'], id: string): Author => ({ kind, id, name: id, membershipGeneration: 'g' })
const row = (conversationId: string, author: Author): MessageDraft => ({ id: `m-${author.id}`, conversationId, author, text: 'Hi', replyTo: null, recipients: [] })
const code = (act: () => unknown) => {
  try { act() } catch (error) { return (error as SuperTabError).code }
  return 'passed'
}

describe('a person’s private chat with their own agent', () => {
  it('takes rows from the person and their own Buddy', () => {
    const f = fixture()
    expect(code(() => checkPrivateChat(f.state, [row(f.peerBuddy.chat, as('person', 'peer')), row(f.peerBuddy.chat, as('agent', f.peerBuddy.id))]))).toBe('passed')
  })

  it('refuses a Lead, another person and another person’s Buddy', () => {
    const f = fixture()
    for (const author of [as('agent', f.pm), as('person', 'owner'), as('agent', f.ownerBuddy.id)]) {
      expect(code(() => checkPrivateChat(f.state, [row(f.peerBuddy.chat, author)])), author.id).toBe('PRIVATE_CHAT')
    }
  })

  it('leaves every other conversation alone', () => {
    const f = fixture()
    expect(code(() => checkPrivateChat(f.state, [row('lead', as('agent', f.pm))]))).toBe('passed')
  })

  it('refuses a Lead’s private line, and says where to go instead', () => {
    const f = fixture()
    let message = ''
    try { f.run({ type: 'person.tell', personId: 'peer', text: 'Your rule changed.' }, { kind: 'agent', agentId: f.pm, machineOwnerId: 'owner' }) }
    catch (error) { message = (error as Error).message; expect((error as SuperTabError).code).toBe('PRIVATE_CHAT') }
    expect(message).toContain('decision.ask')
    expect(message).toContain('project chat')
  })
})

describe('the Swarm’s own lines in a person’s private chat', () => {
  const line = (conversationId: string, author: Author): MessageDraft => ({ ...row(conversationId, author), source: { kind: 'others-work-notice' } })

  it('are written as the person’s own Buddy', () => {
    const f = fixture()
    expect(checkPrivateChat(f.state, [line(f.peerBuddy.chat, as('agent', f.pm))])[0]!.author).toMatchObject({ kind: 'agent', id: f.peerBuddy.id })
  })

  it('are written as Harness when the person has no Buddy there, so a contributor still hears their machine is used', () => {
    const f = fixture()
    const chat = f.state.conversations.find(c => c.id === f.peerBuddy.chat)!
    chat.agentIds = []
    expect(checkPrivateChat(f.state, [line(chat.id, as('agent', f.pm))])[0]!.author).toEqual(SWARM_AUTHOR)
    // And again at the store's write.
    expect(checkPrivateChat(f.state, checkPrivateChat(f.state, [line(chat.id, as('agent', f.pm))]))[0]!.author).toEqual(SWARM_AUTHOR)
  })

  it('are never a Lead’s or person’s words: a row of another kind as Harness is refused', () => {
    const f = fixture()
    expect(code(() => checkPrivateChat(f.state, [row(f.peerBuddy.chat, SWARM_AUTHOR)]))).toBe('PRIVATE_CHAT')
  })
})

describe('a line from a Buddy removed in the same command', () => {
  it('keeps its own Buddy as its author: a thread session signs its own end', () => {
    const f = fixture()
    const before = structuredClone(f.state)
    const after = { ...f.state, agents: f.state.agents.filter(a => a.id !== f.peerBuddy.id) }
    const ended: MessageDraft = { ...row(f.peerBuddy.chat, as('agent', f.peerBuddy.id)), source: { kind: 'buddy-session-ended' } }
    expect(checkPrivateChat(after, [ended], before)[0]!.author.id).toBe(f.peerBuddy.id)
  })
})
