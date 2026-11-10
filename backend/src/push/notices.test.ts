import { describe, expect, it } from 'vitest'
import { chatNotices } from './notices.js'
import { swarm, peer } from '../superTabs/read/fixture.test-support.js'
import { stableId, type MessageDraft } from '../superTabs/model.js'
import { giveAgentsChats } from '../superTabs/agentChats.js'

function scene() {
  const s = swarm()
  s.join(peer)
  const project = s.run({ type: 'project.create', name: 'Web launch', visibility: 'public', brief: '' }).projectId as string
  const web = s.group('Web', project)
  const worker = s.add('worker-harness', web)
  return { state: s.state, web, worker }
}
const draft = (over: Partial<MessageDraft> & Pick<MessageDraft, 'id' | 'conversationId' | 'author'>): MessageDraft =>
  ({ text: 'never in a notice', replyTo: null, recipients: [], ...over })

// Swarm v4 (anh Dee, 2026-11-10): an agent reaches its person in their 1:1 chat, so its words there ring that person's phone.
describe('chatNotices: an agent\'s words in its 1:1 chat', () => {
  const chatScene = () => {
    const { state, web, worker } = scene()
    giveAgentsChats(state, 0)
    const agent = state.agents.find(a => a.id === worker)!
    const chat = state.conversations.find(c => c.id === agent.chatId)!
    const personId = chat.audience!.people[0]!.id
    Object.assign(agent, { contributorId: personId, machineOwnerId: personId })
    // The write found the chat at main row 5 (a thread reply since is row 6); its own posts are 7 and 8.
    const before = structuredClone(state)
    before.conversations.find(c => c.id === chat.id)!.lastMainSequence = 5
    chat.lastMainSequence = 8
    return { state, before, web, worker, chat: chat.id, personId, asWorker: { kind: 'agent' as const, id: worker, name: agent.name, membershipGeneration: 'g' } }
  }
  const post = (over: Partial<MessageDraft> & Pick<MessageDraft, 'id' | 'conversationId' | 'author'>) => draft({ post: true, ...over })

  it('rings its person once a write, keyed and slotted as the phone\'s own notice of the chat, naming the agent, linking its newest words', () => {
    const { state, before, worker, chat, personId, asWorker } = chatScene()
    // Two posts in this write: the chat held main row 5 before it, as the write found it, which its person's read mark is weighed
    // against (push/unread.ts), never a row counted back from after it.
    const notices = chatNotices('tab', state, [post({ id: 'w1', conversationId: chat, author: asWorker }), post({ id: 'w2', conversationId: chat, author: asWorker })], before)
    expect(notices).toEqual([{ personId, key: `chat:tab:${chat}`, slot: `chat:tab:${chat}`, title: `${state.agents.find(a => a.id === worker)!.name} wrote to you`,
      subtitle: '', body: 'Open Harness to read it.', link: `swarm:tab/${chat}/message/w2`, setting: stableId('tab', chat, personId, 'notify'),
      unreadBefore: { mark: stableId('tab', chat, personId), tabId: 'tab', conversationId: chat, sequence: 5 } }])
    expect(JSON.stringify(notices)).not.toContain('never in a notice')
  })

  it('rings nobody for its person\'s own words, a row the server writes in the agent\'s name, or the agent elsewhere', () => {
    const { state, before, web, chat, personId, asWorker } = chatScene()
    const own = { kind: 'person' as const, id: personId, name: 'me', membershipGeneration: 'g' }
    expect(chatNotices('tab', state, [
      post({ id: 'p1', conversationId: chat, author: own }),
      draft({ id: 's1', conversationId: chat, author: asWorker }),
      post({ id: 'c1', conversationId: web, author: asWorker }),
    ], before)).toEqual([])
  })

  it('rings nobody once its person left the Swarm, or for an agent no longer theirs on their own account', () => {
    const left = chatScene()
    left.state.people = left.state.people.filter(p => p.id !== left.personId)
    expect(chatNotices('tab', left.state, [post({ id: 'w1', conversationId: left.chat, author: left.asWorker })], left.before)).toEqual([])
    const lent = chatScene()
    lent.state.agents.find(a => a.id === lent.worker)!.machineOwnerId = 'someone-else'
    expect(chatNotices('tab', lent.state, [post({ id: 'w1', conversationId: lent.chat, author: lent.asWorker })], lent.before)).toEqual([])
  })
})
