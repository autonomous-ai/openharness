import { describe, expect, it } from 'vitest'
import type { Conversation, MessageDraft, SuperTabState } from '../model.js'
import { numberMessages, TALKED_KEEP_MS } from './commit.js'

// Task #3816 (hieule, 11-06): an agent a person is chatting with is never idle. Who talked with whom is counted from who
// wrote and whom it reached, never from the words, on the chat written to (as heard.test.ts counts the coordinator's).
describe('when a person last talked with an agent in a chat', () => {
  const person: MessageDraft['author'] = { kind: 'person', id: 'owner', name: 'owner', membershipGeneration: 'g' }
  const as = (id: string): MessageDraft['author'] => ({ kind: 'agent', id, name: id, membershipGeneration: 'g' })
  const draft = (id: string, author: MessageDraft['author'], extra: Partial<MessageDraft> = {}): MessageDraft =>
    ({ id, conversationId: 'chat', author, text: id, replyTo: null, recipients: [], ...extra })
  const swarm = (): SuperTabState => ({ version: 1, id: 'tab', name: 'Swarm', ownerId: 'owner', environment: 'prod', paused: false,
    invitations: [], people: [], agents: [], conversations: [{ id: 'chat', projectId: 'p1', title: 'Chat', leadId: 'pm',
      agentIds: ['pm', 'eng', 'other'], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 } as Conversation],
    projects: [{ id: 'p1', name: 'lamp', ownerId: 'owner', leadConversationId: 'lead', visibility: 'public', members: [], updateMinutes: 5 }] } as unknown as SuperTabState)
  const chat = (state: SuperTabState) => state.conversations[0]!

  it('marks each agent a person\'s message reaches, then that agent\'s own answers in the same chat', () => {
    const state = swarm()
    numberMessages(state, [draft('p1', person, { recipients: ['eng'] })], 10)
    expect(chat(state).talkedAt).toEqual({ eng: { person: 10 } })
    numberMessages(state, [draft('a1', as('eng'))], 20)
    expect(chat(state).talkedAt).toEqual({ eng: { person: 10, answer: 20 } })
  })

  // Review of #3389: one person's message once made every later post of that agent here count, its posts to other agents too,
  // so two agents talking kept each other from idling for good.
  it('counts one answer per person\'s message, and never a post to an agent', () => {
    const state = swarm()
    numberMessages(state, [draft('p1', person, { recipients: ['eng'] })], 10)
    numberMessages(state, [draft('a1', as('eng'), { recipients: ['other'] })], 20)
    expect(chat(state).talkedAt).toEqual({ eng: { person: 10 } })
    numberMessages(state, [draft('a2', as('eng'))], 30)
    numberMessages(state, [draft('a3', as('eng'))], 40)
    expect(chat(state).talkedAt).toEqual({ eng: { person: 10, answer: 30 } })
    numberMessages(state, [draft('p2', person, { recipients: ['eng'] })], 50)
    numberMessages(state, [draft('a4', as('eng'))], 60)
    expect(chat(state).talkedAt).toEqual({ eng: { person: 50, answer: 60 } })
  })

  it('never brings back an entry older than an hour: it is dropped before the post is read', () => {
    const state = swarm()
    numberMessages(state, [draft('p1', person, { recipients: ['eng'] })], 10)
    numberMessages(state, [draft('a1', as('eng'))], 10 + TALKED_KEEP_MS + 1)
    expect(chat(state).talkedAt).toEqual({})
  })

  it('marks nobody for a person\'s message that reaches no agent, an agent nobody talked with, a system row or a notice', () => {
    const state = swarm()
    numberMessages(state, [
      draft('p1', person),
      draft('a1', as('other')),
      draft('s1', person, { source: { kind: 'system' }, recipients: ['eng'] }),
      draft('n1', as('pm'), { source: { kind: 'agent-only' }, recipients: ['eng'] }),
    ], 30)
    expect(chat(state).talkedAt).toBeUndefined()
  })

  it('keeps only the last hour, so the record stays small', () => {
    const state = swarm()
    numberMessages(state, [draft('p1', person, { recipients: ['eng'] })], 10)
    numberMessages(state, [draft('p2', person, { recipients: ['pm'] })], 10 + TALKED_KEEP_MS + 1)
    expect(chat(state).talkedAt).toEqual({ pm: { person: 10 + TALKED_KEEP_MS + 1 } })
  })
})
