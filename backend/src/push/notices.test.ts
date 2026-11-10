import { describe, expect, it } from 'vitest'
import { phoneNotices, taskSlot } from './notices.js'
import { swarm, owner, peer } from '../superTabs/read/fixture.test-support.js'
import { shownNameOf } from '../superTabs/personNames.js'
import { stableId, type MessageDraft } from '../superTabs/model.js'
import { openSwarmBuddyChat } from '../superTabs/buddies.js'
import { giveAgentsChats } from '../superTabs/agentChats.js'
import { agentDisplayName } from '../superTabs/agentNames.js'

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
const person = (p: typeof peer) => ({ kind: 'person' as const, id: p.userId, name: p.email, membershipGeneration: 'g' })

describe('phoneNotices: what a write tells phones (task #2905)', () => {
  it('words a reply as the phone does, and links the thread at the reply', () => {
    const { state, web } = scene()
    const reply = draft({ id: 'r1', conversationId: web, author: person(peer), thread: 'root1' })
    const notices = phoneNotices('tab', state, { replies: [{ id: 'row1', personId: owner.userId, conversationId: web, messageId: 'r1', threadId: 'root1',
      actorKind: 'person', actorId: peer.userId, rings: true }], tags: [] }, [reply])
    expect(notices).toEqual([{ personId: owner.userId, key: 'reply:tab:row1', title: `${shownNameOf(state, peer.userId)} replied in a thread`,
      subtitle: 'Web launch', body: 'Open Harness to read it.', link: `swarm:tab/${web}/message/r1/thread/root1`,
      slot: `thread:tab:${web}:root1` }])
  })

  it('words a tag as the phone does, and links the message, in its thread only when it is only there', () => {
    const { state, web } = scene()
    const inChat = draft({ id: 'm1', conversationId: web, author: person(peer), mentions: [owner.userId] })
    const inThread = draft({ id: 'm2', conversationId: web, author: person(peer), mentions: [owner.userId], thread: 'root2' })
    const alsoInChat = draft({ id: 'm3', conversationId: web, author: person(peer), mentions: [owner.userId], thread: 'root2', alsoInChat: true })
    const tag = (id: string, messageId: string) => ({ id, personId: owner.userId, conversationId: web, messageId })
    const notices = phoneNotices('tab', state, { replies: [], tags: [tag('t1', 'm1'), tag('t2', 'm2'), tag('t3', 'm3')] }, [inChat, inThread, alsoInChat])
    // A tag is a notice of its own: it shows in the slot of its key, as the app's notice for it does.
    expect(notices.every(n => n.slot === n.key && !n.quiet)).toBe(true)
    // Its person's setting for the chat, by which a tag in a chat they muted rings no phone (push/muted.ts).
    expect(notices.map(n => n.setting)).toEqual(Array(3).fill(stableId('tab', web, owner.userId, 'notify')))
    expect(notices.map(n => [n.key, n.title, n.subtitle, n.link])).toEqual([
      ['mention:t1', `${shownNameOf(state, peer.userId)} tagged you`, 'Web launch', `swarm:tab/${web}/message/m1`],
      ['mention:t2', `${shownNameOf(state, peer.userId)} tagged you`, 'Web launch', `swarm:tab/${web}/message/m2/thread/root2`],
      ['mention:t3', `${shownNameOf(state, peer.userId)} tagged you`, 'Web launch', `swarm:tab/${web}/message/m3`],
    ])
    expect(notices.every(n => n.body === 'Open Harness to read it.')).toBe(true)
  })

  it('tells of a reply in a person\'s Swarm Buddy chat, which belongs to no project, without failing (security review 2)', () => {
    const { state } = scene()
    const buddy = openSwarmBuddyChat(state, state.people.find(p => p.id === peer.userId)!).id
    const reply = draft({ id: 'r1', conversationId: buddy, author: person(owner), thread: 'root1' })
    const notices = phoneNotices('tab', state, { replies: [{ id: 'row1', personId: peer.userId, conversationId: buddy, messageId: 'r1', threadId: 'root1',
      actorKind: 'person', actorId: owner.userId, rings: true }], tags: [] }, [reply])
    expect(notices).toEqual([expect.objectContaining({ personId: peer.userId, subtitle: '', link: `swarm:tab/${buddy}/message/r1/thread/root1` })])
  })

  it('pushes no tag held back for a quiet chat', () => {
    const { state, web } = scene()
    const held = draft({ id: 'm1', conversationId: web, author: person(peer), mentions: [owner.userId], holdMentions: true })
    expect(phoneNotices('tab', state, { replies: [], tags: [{ id: 't1', personId: owner.userId, conversationId: web, messageId: 'm1', holdUntil: new Date() }] }, [held])).toEqual([])
  })

  it('escapes the link\'s parts as the phone reads them', () => {
    const { state, web } = scene()
    const reply = draft({ id: 'r/1', conversationId: web, author: person(peer), thread: 'root 1' })
    const [notice] = phoneNotices('tab:x', state, { replies: [{ id: 'row1', personId: owner.userId, conversationId: web, messageId: 'r/1', threadId: 'root 1',
      actorKind: 'person', actorId: peer.userId, rings: true }], tags: [] }, [reply])
    expect(notice!.link).toBe(`swarm:tab%3Ax/${web}/message/r%2F1/thread/root%201`)
  })

  it('never carries what was written', () => {
    const { state, web } = scene()
    const reply = draft({ id: 'r1', conversationId: web, author: person(peer), thread: 'root1', mentions: [owner.userId] })
    const notices = phoneNotices('tab', state, { replies: [{ id: 'row1', personId: owner.userId, conversationId: web, messageId: 'r1', threadId: 'root1',
      actorKind: 'person', actorId: peer.userId, rings: true }], tags: [{ id: 't1', personId: owner.userId, conversationId: web, messageId: 'r1' }] }, [reply])
    expect(JSON.stringify(notices)).not.toContain('never in a notice')
  })
})

describe('phoneNotices: the push rule Tony approved (tasks #3248, #3607; 2026-11-09)', () => {
  const row = (id: string, personId: string, rings: boolean) =>
    ({ id, personId, conversationId: '', messageId: 'r1', threadId: 'root1', actorKind: 'person', actorId: peer.userId, ...rings ? { rings: true as const } : {} })

  it('pushes the reply rows that ring alone: the first person\'s reply in a thread the person started (writeReplyActivity)', () => {
    const { state, web } = scene()
    const reply = draft({ id: 'r1', conversationId: web, author: person(peer), thread: 'root1' })
    const at = (r: ReturnType<typeof row>) => ({ ...r, conversationId: web })
    const notices = phoneNotices('tab', state, { replies: [at(row('a', 'starter-id', true)), at(row('b', 'quoted-id', false)), at(row('c', 'tagged-id', false)),
      at(row('d', 'replier-id', false))], tags: [] }, [reply])
    expect(notices.map(n => n.personId)).toEqual(['starter-id'])
    // The thread's one slot, which the app's own notice for it shares.
    expect(notices.map(n => n.slot)).toEqual([`thread:tab:${web}:root1`])
    expect(notices[0]!.quiet).toBeUndefined()
  })

  it('pushes a decision asked of a person as the app words it, linking its card, and only the first of one ask\'s questions sounds', () => {
    const { state, web, worker } = scene()
    const decision = (id: string, personId: string) => ({ id, personId, conversationId: web, askerAgentId: worker })
    const notices = phoneNotices('tab', state, { replies: [], tags: [], decisions: [decision('d1', owner.userId), decision('d2', owner.userId), decision('d3', peer.userId)] }, [])
    expect(notices).toEqual([
      { personId: owner.userId, key: 'decision:d1', slot: `task:tab:${web}`, title: 'worker-harness asks you', subtitle: 'Web launch', body: 'Open Harness to answer.',
        link: `swarm:tab/${web}/decision/d1` },
      { personId: owner.userId, key: 'decision:d2', slot: `task:tab:${web}`, title: 'worker-harness asks you', subtitle: 'Web launch', body: 'Open Harness to answer.',
        link: `swarm:tab/${web}/decision/d2`, quiet: true },
      { personId: peer.userId, key: 'decision:d3', slot: `task:tab:${web}`, title: 'worker-harness asks you', subtitle: 'Web launch', body: 'Open Harness to answer.',
        link: `swarm:tab/${web}/decision/d3` },
    ])
  })

  it('gives every decision of one task one slot, so a later question replaces the earlier in the notification centre; two tasks keep two', () => {
    const { state, web, worker } = scene()
    const decision = (id: string, conversationId: string) => ({ id, personId: owner.userId, conversationId, askerAgentId: worker })
    const notices = phoneNotices('tab', state, { replies: [], tags: [], decisions: [decision('d1', web), decision('d2', web), decision('d3', 'another-task')] }, [])
    expect(notices.map(n => [n.key, n.slot])).toEqual([['decision:d1', `task:tab:${web}`], ['decision:d2', `task:tab:${web}`], ['decision:d3', 'task:tab:another-task']])
    expect(taskSlot('tab', web)).toBe(`task:tab:${web}`)
  })

  it('names an asker that is gone as the app does', () => {
    const { state, web } = scene()
    expect(phoneNotices('tab', state, { replies: [], tags: [], decisions: [{ id: 'd1', personId: owner.userId, conversationId: web, askerAgentId: 'gone' }] }, [])[0]!.title)
      .toBe('Agent asks you')
  })
})

describe('phoneNotices: who rings (task #3607, Tony 2026-11-06)', () => {
  const asAgent = (id: string) => ({ kind: 'agent' as const, id, name: 'worker-harness', membershipGeneration: 'g' })
  // An agent's reply row never rings (writeReplyActivity): only a person's can.
  const row = (web: string, id: string, personId: string, actorKind: 'person' | 'agent', actorId: string) =>
    ({ id, personId, conversationId: web, messageId: 'r1', threadId: 'root1', actorKind, actorId, ...actorKind === 'person' ? { rings: true as const } : {} })

  it('an agent\'s reply rings nobody', () => {
    const { state, web, worker } = scene()
    const reply = draft({ id: 'r1', conversationId: web, author: asAgent(worker), thread: 'root1' })
    expect(phoneNotices('tab', state, { replies: [row(web, 'a', owner.userId, 'agent', worker)], tags: [] }, [reply])).toEqual([])
  })

  it('an agent\'s tag rings nobody, a person\'s tag rings', () => {
    const { state, web, worker } = scene()
    const byAgent = draft({ id: 'm1', conversationId: web, author: asAgent(worker), mentions: [owner.userId] })
    const byPerson = draft({ id: 'm2', conversationId: web, author: person(peer), mentions: [owner.userId] })
    const tag = (id: string, messageId: string) => ({ id, personId: owner.userId, conversationId: web, messageId })
    const notices = phoneNotices('tab', state, { replies: [], tags: [tag('t1', 'm1'), tag('t2', 'm2')] }, [byAgent, byPerson])
    expect(notices.map(n => n.key)).toEqual(['mention:t2'])
  })

  it('an agent\'s words that say approve or decide ring nobody: the type of the event decides, never the text', () => {
    const { state, web, worker } = scene()
    const text = 'Please approve this and decide now: waiting on you'
    const reply = draft({ id: 'r1', conversationId: web, author: asAgent(worker), thread: 'root1', text })
    const tagging = draft({ id: 'm1', conversationId: web, author: asAgent(worker), mentions: [owner.userId], text })
    expect(phoneNotices('tab', state, { replies: [row(web, 'a', owner.userId, 'agent', worker)],
      tags: [{ id: 't1', personId: owner.userId, conversationId: web, messageId: 'm1' }] }, [reply, tagging])).toEqual([])
  })

  it('the server\'s "no reviewer can start" tag is an agent\'s tag: it tells Activity and the badge, no ring', () => {
    // reviewCapacity.ts writes it as the agent that asked for review, with source kind `review-capacity`, tagging the
    // people who can add a machine. Tony's rule has no ring for an agent's tag that is not a decision or an approval.
    const { state, web, worker } = scene()
    const line = draft({ id: 'm1', conversationId: web, author: asAgent(worker), mentions: [owner.userId], source: { kind: 'review-capacity', engine: 'any', cause: 'none' } as never })
    expect(phoneNotices('tab', state, { replies: [], tags: [{ id: 't1', personId: owner.userId, conversationId: web, messageId: 'm1' }] }, [line])).toEqual([])
  })

  it('a decision an agent asks of a person still rings, however the asking agent words it', () => {
    const { state, web, worker } = scene()
    const [notice] = phoneNotices('tab', state, { replies: [], tags: [], decisions: [{ id: 'd1', personId: owner.userId, conversationId: web, askerAgentId: worker }] }, [])
    expect(notice).toEqual(expect.objectContaining({ key: 'decision:d1', title: 'worker-harness asks you' }))
    expect(notice!.quiet).toBeUndefined()
  })
})

// Swarm v4 (anh Dee, 2026-11-10): an agent reaches its person in their 1:1 chat, so its words there ring that person's phone.
describe('phoneNotices: an agent\'s words in its 1:1 chat', () => {
  const chatScene = () => {
    const { state, web, worker } = scene()
    giveAgentsChats(state, 0)
    const agent = state.agents.find(a => a.id === worker)!
    const chat = agent.chatId!
    const personId = state.conversations.find(c => c.id === chat)!.audience!.people[0]!.id
    return { state, web, worker, chat, personId, asWorker: { kind: 'agent' as const, id: worker, name: agent.name, membershipGeneration: 'g' } }
  }

  it('rings its person once a write, keyed and slotted as the phone\'s own notice of the chat, naming the agent, linking its newest words', () => {
    const { state, worker, chat, personId, asWorker } = chatScene()
    const notices = phoneNotices('tab', state, { replies: [], tags: [] }, [draft({ id: 'w1', conversationId: chat, author: asWorker }),
      draft({ id: 'w2', conversationId: chat, author: asWorker })])
    expect(notices).toEqual([{ personId, key: `chat:tab:${chat}`, slot: `chat:tab:${chat}`, title: `${agentDisplayName(state.agents, worker)} wrote to you`,
      subtitle: '', body: 'Open Harness to read it.', link: `swarm:tab/${chat}/message/w2`, setting: stableId('tab', chat, personId, 'notify') }])
    expect(JSON.stringify(notices)).not.toContain('never in a notice')
  })

  it('rings nobody for its person\'s own words, a row the server writes in the agent\'s name, a notice only agents read, or the agent elsewhere', () => {
    const { state, web, chat, personId, asWorker } = chatScene()
    const own = { kind: 'person' as const, id: personId, name: 'me', membershipGeneration: 'g' }
    expect(phoneNotices('tab', state, { replies: [], tags: [] }, [
      draft({ id: 'p1', conversationId: chat, author: own }),
      draft({ id: 's1', conversationId: chat, author: asWorker, source: { kind: 'system' } as never }),
      draft({ id: 'a1', conversationId: chat, author: asWorker, source: { kind: 'agent-only' } as never }),
      draft({ id: 'c1', conversationId: web, author: asWorker }),
    ])).toEqual([])
  })

  it('rings nobody once its person left the Swarm', () => {
    const { state, chat, personId, asWorker } = chatScene()
    state.people = state.people.filter(p => p.id !== personId)
    expect(phoneNotices('tab', state, { replies: [], tags: [] }, [draft({ id: 'w1', conversationId: chat, author: asWorker })])).toEqual([])
  })
})
