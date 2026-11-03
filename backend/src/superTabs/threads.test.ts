import { describe, expect, it } from 'vitest'
import type { Author } from './model.js'
import type { ThreadReply } from './pageReads.js'
import { NOW, outsider, owner, peer, richSwarm } from './read/fixture.test-support.js'
import { threadSummaries } from './threads.js'

const s = richSwarm()
const web = s.state.conversations.find(c => c.id === s.web)!
// A private project's conversation: only its owner reads it.
const secret = s.state.conversations.find(c => c.id === s.secretGroup)!
const person = (id: string): Author => ({ kind: 'person', id, name: id, membershipGeneration: 'gen' })
const agent = (id: string): Author => ({ kind: 'agent', id, name: id, membershipGeneration: 'gen' })
const reply = (thread: string, id: string, sequence: number, author: Author, extra: Partial<ThreadReply> = {}): ThreadReply =>
  ({ thread, id, author, mentions: [], sequence, createdAt: new Date(NOW + sequence), agentOnly: false, routing: false, ...extra })

describe('thread summaries', () => {
  // One row per message, as the inbox read passes them (#2256): a 500-reply thread where every 25th reply is an agent-only
  // note to someone else, the owner and an agent take turns, and a teammate writes once in the middle.
  const rows = [reply('r', 'r', 0, agent('lead')), ...Array.from({ length: 500 }, (_, i) => i % 25 === 24
    ? reply('r', `r-${i}`, 1 + i, agent('ghost'), { agentOnly: true, mentions: [peer.userId] })
    : reply('r', `r-${i}`, 1 + i, i === 300 ? person(peer.userId) : i % 2 ? agent('a1') : person(owner.userId),
      { mentions: i === 5 ? [outsider.userId] : [] }))]

  it('sums up a 500-reply thread from one row per message: hidden replies neither counted nor naming anyone', () => {
    expect(threadSummaries(s.state, web, rows)).toEqual([{ id: 'r', replies: 480, lastSequence: 499, lastAt: new Date(NOW + 499),
      authors: [person(owner.userId), agent('a1'), person(peer.userId)], people: [owner.userId, outsider.userId, peer.userId] }])
  })

  it('names only the people who read the conversation now', () => {
    expect(threadSummaries(s.state, secret, rows)).toEqual([{ id: 'r', replies: 480, lastSequence: 499, lastAt: new Date(NOW + 499),
      authors: [person(owner.userId), agent('a1')], people: [owner.userId] }])
  })

  it('counts a row that stands for several replies as that many', () => {
    expect(threadSummaries(s.state, web, [reply('r', 'r', 0, agent('lead')), reply('r', 'r-0', 1, agent('a1'), { count: 0 }),
      reply('r', 'r-9', 9, agent('a1'), { count: 7 })])).toEqual([{ id: 'r', replies: 7, lastSequence: 9, lastAt: new Date(NOW + 9),
      authors: [agent('a1')], people: [] }])
  })

  it('leaves out a thread whose replies are all hidden, and keeps the others in the order they started', () => {
    expect(threadSummaries(s.state, web, [reply('a', 'a', 0, agent('lead')), reply('b', 'b', 1, agent('lead')),
      reply('a', 'a-1', 2, agent('ghost'), { agentOnly: true }), reply('b', 'b-1', 3, agent('a1'))]).map(t => t.id)).toEqual(['b'])
  })
})
