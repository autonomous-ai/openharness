import { describe, expect, it } from 'vitest'
import { createSuperTab, type MessageDraft } from '../model.js'
import { numberMessages } from './commit.js'

// Task #2427 (Huy, 11-03): a task row in the sidebar is bold only for what is for a person, so each conversation records its
// newest main message from a person, beside lastMainSequence.
describe('a conversation\'s newest message from a person', () => {
  const person: MessageDraft['author'] = { kind: 'person', id: 'owner', name: 'owner', membershipGeneration: 'g' }
  const agent: MessageDraft['author'] = { kind: 'agent', id: 'builder', name: 'Builder', membershipGeneration: 'g' }
  const draft = (id: string, author: MessageDraft['author'], extra: Partial<MessageDraft> = {}): MessageDraft =>
    ({ id, conversationId: 'lead', author, text: id, replyTo: null, recipients: [], ...extra })

  it('moves with a person\'s main message, and not with an agent\'s, a system row, a thread-only reply or an agent-only notice', () => {
    const state = createSuperTab('tab', 'Pilot', { id: 'owner', email: 'owner@example.com' }, 'prod')
    const lead = () => state.conversations.find(c => c.id === 'lead')!
    numberMessages(state, [draft('p1', person)], 1)
    const first = lead().lastMainSequence!
    expect(lead().lastPersonSequence).toBe(first)
    numberMessages(state, [
      draft('a1', agent),
      draft('s1', person, { source: { kind: 'system' } }),
      draft('t1', person, { thread: 'p1' }),
      draft('n1', agent, { source: { kind: 'agent-only' }, recipients: ['builder'] }),
    ], 2)
    expect(lead().lastMainSequence).toBeGreaterThan(first)
    expect(lead().lastPersonSequence).toBe(first)
    // A reply also sent to the chat is in its main stream.
    numberMessages(state, [draft('t2', person, { thread: 'p1', alsoInChat: true })], 3)
    expect(lead().lastPersonSequence).toBe(lead().lastMainSequence)
  })
})
