import { describe, expect, it } from 'vitest'
import { phoneNotices } from './notices.js'
import { swarm, owner, peer } from '../superTabs/read/fixture.test-support.js'
import { shownNameOf } from '../superTabs/personNames.js'
import type { MessageDraft } from '../superTabs/model.js'
import { openSwarmBuddyChat } from '../superTabs/buddies.js'

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
      actorKind: 'person', actorId: peer.userId }], tags: [] }, [reply])
    expect(notices).toEqual([{ personId: owner.userId, key: 'reply:tab:row1', title: `${shownNameOf(state, peer.userId)} replied in a thread`,
      subtitle: 'Web launch', body: 'Open Harness to read it.', link: `swarm:tab/${web}/message/r1/thread/root1` }])
  })

  it('words a tag as the phone does, and links the message, in its thread only when it is only there', () => {
    const { state, web, worker } = scene()
    const agent = { kind: 'agent' as const, id: worker, name: 'worker-harness', membershipGeneration: 'g' }
    const inChat = draft({ id: 'm1', conversationId: web, author: agent, mentions: [owner.userId] })
    const inThread = draft({ id: 'm2', conversationId: web, author: person(peer), mentions: [owner.userId], thread: 'root2' })
    const alsoInChat = draft({ id: 'm3', conversationId: web, author: person(peer), mentions: [owner.userId], thread: 'root2', alsoInChat: true })
    const tag = (id: string, messageId: string) => ({ id, personId: owner.userId, conversationId: web, messageId })
    const notices = phoneNotices('tab', state, { replies: [], tags: [tag('t1', 'm1'), tag('t2', 'm2'), tag('t3', 'm3')] }, [inChat, inThread, alsoInChat])
    expect(notices.map(n => [n.key, n.title, n.subtitle, n.link])).toEqual([
      ['mention:t1', 'worker-harness tagged you', 'Web launch', `swarm:tab/${web}/message/m1`],
      ['mention:t2', `${shownNameOf(state, peer.userId)} tagged you`, 'Web launch', `swarm:tab/${web}/message/m2/thread/root2`],
      ['mention:t3', `${shownNameOf(state, peer.userId)} tagged you`, 'Web launch', `swarm:tab/${web}/message/m3`],
    ])
    expect(notices.every(n => n.body === 'Open Harness to read it.')).toBe(true)
  })

  it('tells of a reply in a person\'s Swarm Buddy chat, which belongs to no project, without failing (security review 2)', () => {
    const { state } = scene()
    const buddy = openSwarmBuddyChat(state, state.people.find(p => p.id === peer.userId)!).id
    const agent = { kind: 'agent' as const, id: 'buddy-session', name: 'Buddy', membershipGeneration: 'g' }
    const reply = draft({ id: 'r1', conversationId: buddy, author: agent, thread: 'root1' })
    const notices = phoneNotices('tab', state, { replies: [{ id: 'row1', personId: peer.userId, conversationId: buddy, messageId: 'r1', threadId: 'root1',
      actorKind: 'agent', actorId: 'buddy-session' }], tags: [] }, [reply])
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
      actorKind: 'person', actorId: peer.userId }], tags: [] }, [reply])
    expect(notice!.link).toBe(`swarm:tab%3Ax/${web}/message/r%2F1/thread/root%201`)
  })

  it('never carries what was written', () => {
    const { state, web } = scene()
    const reply = draft({ id: 'r1', conversationId: web, author: person(peer), thread: 'root1', mentions: [owner.userId] })
    const notices = phoneNotices('tab', state, { replies: [{ id: 'row1', personId: owner.userId, conversationId: web, messageId: 'r1', threadId: 'root1',
      actorKind: 'person', actorId: peer.userId }], tags: [{ id: 't1', personId: owner.userId, conversationId: web, messageId: 'r1' }] }, [reply])
    expect(JSON.stringify(notices)).not.toContain('never in a notice')
  })
})
