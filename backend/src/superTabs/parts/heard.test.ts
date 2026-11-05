import { describe, expect, it } from 'vitest'
import type { Conversation, MessageDraft, SuperTabState } from '../model.js'
import { numberMessages } from './commit.js'

// Task #3022 (Ken, 11-05): the built-in wake checks what people taught the coordinator only when a person wrote to it since
// the last wake. The Swarm counts that from who wrote where, never by reading the words.
describe('when a person last wrote to a project\'s coordinator', () => {
  const person: MessageDraft['author'] = { kind: 'person', id: 'owner', name: 'owner', membershipGeneration: 'g' }
  const agent: MessageDraft['author'] = { kind: 'agent', id: 'eng', name: 'Engineer', membershipGeneration: 'g' }
  const draft = (id: string, conversationId: string, author: MessageDraft['author'], extra: Partial<MessageDraft> = {}): MessageDraft =>
    ({ id, conversationId, author, text: id, replyTo: null, recipients: [], ...extra })
  const group = (id: string, leadId: string | null): Conversation => ({ id, projectId: 'p1', title: id, leadId, agentIds: ['pm', 'eng'], archived: false,
    brief: '', checks: [], assignment: null, lastMessageSequence: 0 })
  const swarm = (): SuperTabState => ({ version: 1, id: 'tab', name: 'Swarm', ownerId: 'owner', environment: 'prod', paused: false, invitations: [],
    people: [], agents: [], conversations: [group('chat', 'pm'), group('task', 'pm')],
    projects: [{ id: 'p1', name: 'lamp', ownerId: 'owner', leadConversationId: 'chat', visibility: 'public', members: [], updateMinutes: 5 }] } as unknown as SuperTabState)
  const chat = (state: SuperTabState) => state.conversations.find(c => c.id === 'chat')!

  it('moves with a person\'s message in the project chat, a thread reply included', () => {
    const state = swarm()
    numberMessages(state, [draft('p1', 'chat', person)], 10)
    expect(chat(state).heardAt).toBe(10)
    numberMessages(state, [draft('t1', 'chat', person, { thread: 'p1' })], 20)
    expect(chat(state).heardAt).toBe(20)
  })

  it('moves with a person\'s message naming the coordinator in another chat of its project', () => {
    const state = swarm()
    numberMessages(state, [draft('p1', 'task', person, { recipients: ['pm'] })], 30)
    expect(chat(state).heardAt).toBe(30)
    expect(state.conversations.find(c => c.id === 'task')!.heardAt).toBeUndefined()
  })

  it('does not move with an agent\'s message, a system row, an agent-only notice, or a person\'s message to another agent', () => {
    const state = swarm()
    numberMessages(state, [
      draft('a1', 'chat', agent),
      draft('s1', 'chat', person, { source: { kind: 'system' } }),
      draft('n1', 'chat', agent, { source: { kind: 'agent-only' }, recipients: ['pm'] }),
      draft('p1', 'task', person, { recipients: ['eng'] }),
      draft('p2', 'task', person),
    ], 40)
    expect(chat(state).heardAt).toBeUndefined()
  })
})
