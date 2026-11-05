import { describe, expect, it } from 'vitest'
import { applyCommand, type Command } from './commands.js'
import { createSuperTab, type Actor, type Author, type SuperTabState } from './model.js'
import type { ThreadReply } from './pageReads.js'
import { MAX_PROPOSALS, openProposals, proposalChat, SEED_SETTLE_MS, type ProposalReads, type ProposalRoot } from './proposals.js'

// The Tasks view's Proposals (#2569): a project's Buddy proposals its PM has not answered, by #2867's rule (threads.ts askOf).
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }

/** A Swarm whose project chat has its PM, and peer, a member. */
function swarm() {
  let state = createSuperTab('swarm', 'Pilot', { id: 'owner', email: owner.email }, 'test')
  state.people.push({ id: 'peer', email: peer.email, role: 'collaborator', generation: 'first' })
  let next = 0
  const run = (command: Command, actor: Actor = owner) => {
    state = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1000,
      contribution: { machineOwnerId: 'host', contributorId: 'owner' } }).state
  }
  run({ type: 'project.cadence', projectId: 'lead', minutes: 5 })
  run({ type: 'agent.add', conversationId: 'lead', harnessId: 'pm', machineId: 'machine', name: 'pm', configuration, lead: true })
  const chat = () => state.conversations.find(c => c.id === 'lead')!
  return { run, chat, get state(): SuperTabState { return state }, pm: chat().leadId! }
}

const person = (id: string): Author => ({ kind: 'person', id, name: id, membershipGeneration: 'first' })
const agent = (id: string): Author => ({ kind: 'agent', id, name: id, membershipGeneration: 'first' })
/** A proposal's root as buddy.propose posts it, at sequence [at]. */
const root = (id: string, at: number, title = `Proposal ${id}`): ProposalRoot => ({ id, sequence: at, text: `Let's build: ${title}`, createdAt: new Date(at),
  source: { kind: 'buddy-proposal', personId: 'peer', buddyId: 'buddy', ownerMessageId: `ask-${id}` } })
/** A thread's rows as pageThreads gives them: its root, then each reply. */
const rows = (of: ProposalRoot, ...replies: Array<{ author: Author; ask?: ThreadReply['ask'] }>): ThreadReply[] => [
  { thread: of.id, id: of.id, author: person('peer'), mentions: [], sequence: of.sequence, createdAt: of.createdAt, agentOnly: false, routing: false, kind: 'buddy-proposal' },
  ...replies.map((reply, i) => ({ thread: of.id, id: `${of.id}-r${i}`, author: reply.author, mentions: [], sequence: of.sequence + i + 1,
    createdAt: new Date(of.createdAt.getTime() + i + 1), agentOnly: false, routing: false, ...reply.ask ? { kind: 'system', ask: reply.ask } : {} })),
]

const NOW = 10_000_000
/** The chat as the database reads it: roots newest first before a sequence, and the threads of the roots named; and its open set
 *  (SuperTabOpenProposal): the roots in it, and its seed mark's time. `calls` are the chat scan's; `counts`, every read's. */
function chatReads(roots: ProposalRoot[], threads: ThreadReply[], options: { seededAt?: number; open?: ProposalRoot[]; closed?: string[] } = {}) {
  const calls: Array<{ before: number | undefined; take: number }> = []
  const counts = { scan: 0, seededAt: 0, listed: 0, rootsById: 0, threads: 0, seed: 0, forget: 0, closed: 0 }
  const set = new Map((options.open ?? []).map(r => [r.id, r.sequence]))
  const forgotten: string[] = []
  let mark = options.seededAt ?? null
  const reads: ProposalReads = {
    seededAt: async () => { counts.seededAt++; return mark },
    seed: async open => { counts.seed++; for (const r of open) set.set(r.id, r.sequence); mark ??= NOW },
    listed: async (before, take) => { counts.listed++; return [...set].map(([id, sequence]) => ({ id, sequence }))
      .filter(r => before === undefined || r.sequence < before).sort((a, b) => b.sequence - a.sequence).slice(0, take) },
    rootsById: async ids => { counts.rootsById++; return roots.filter(r => ids.includes(r.id)) },
    roots: async (before, take) => {
      counts.scan++
      calls.push({ before, take })
      return roots.filter(r => before === undefined || r.sequence < before).sort((a, b) => b.sequence - a.sequence).slice(0, take)
    },
    threads: async ids => { counts.threads++; return threads.filter(row => ids.includes(row.thread)) },
    forget: async ids => { counts.forget++; for (const id of ids) { set.delete(id); forgotten.push(id) } },
    closed: async ids => { counts.closed++; return new Set(ids.filter(id => options.closed?.includes(id))) },
  }
  return { reads, calls, counts, set, forgotten }
}

describe('a project\'s open proposals', () => {
  it('lists those its PM has not answered, oldest first: none it replied to in their thread, and none a task marks', async () => {
    const s = swarm(), details = { author: agent('buddy') }
    const [open, answered, onIt, closed, personal, old] = [root('open', 10, 'Sync edits'), root('answered', 20), root('on-it', 30), root('closed', 40),
      root('personal', 50, 'Offline drafts'), root('old', 5, 'Old proposal')]
    const { reads } = chatReads([open, answered, onIt, closed, personal, old], [
      ...rows(open, details),
      ...rows(answered, details, { author: agent(s.pm) }),
      // A task opened from it replies in its thread with its row's tag (taskLine.ts).
      ...rows(onIt, details, { author: person('owner'), ask: 'on-it' }),
      ...rows(closed, details, { author: person('owner'), ask: 'closed' }),
      // A person's reply, the owner's too, is not the PM's answer.
      ...rows(personal, details, { author: person('owner') }),
      // A proposal from before #2867 with no reply at all has no thread summary: nobody answered it.
    ])
    expect(await openProposals(s.state, s.chat(), reads, NOW)).toEqual([
      { messageId: 'old', title: 'Old proposal', personId: 'peer', at: 5 },
      { messageId: 'open', title: 'Sync edits', personId: 'peer', at: 10 },
      { messageId: 'personal', title: 'Offline drafts', personId: 'peer', at: 50 },
    ])
  })

  it('reads a proposal as its owner\'s words in full, and one from before task #2926 without its "Let\'s build: "', async () => {
    const s = swarm()
    const words = 'Jumping a chat back a week (Jump to, Last week) freezes the app and then lags for a minute on Huy\'s Mac, every time'
    // Posted since #2926: the owner's words alone, with no reply under it.
    const owned: ProposalRoot = { ...root('owned', 20), text: words }
    const { reads } = chatReads([root('old', 10, 'Offline drafts'), owned], [...rows(root('old', 10, 'Offline drafts'), { author: agent('buddy') })])
    expect(await openProposals(s.state, s.chat(), reads, NOW)).toEqual([
      { messageId: 'old', title: 'Offline drafts', personId: 'peer', at: 10 },
      { messageId: 'owned', title: words, personId: 'peer', at: 20 },
    ])
  })

  it('keeps the newest 100 open, read in batches, and reads no further once it has them', async () => {
    const s = swarm()
    const roots = Array.from({ length: 250 }, (_, i) => root(`p${i}`, i + 1))
    const { reads, calls } = chatReads(roots, roots.flatMap(r => rows(r, { author: agent('buddy') })))
    const listed = await openProposals(s.state, s.chat(), reads, NOW)
    expect(listed).toHaveLength(MAX_PROPOSALS)
    expect(listed.map(p => p.messageId)).toEqual(roots.slice(-MAX_PROPOSALS).map(r => r.id))
    expect(calls).toEqual([{ before: undefined, take: MAX_PROPOSALS }])
    // Answered ones are read past, a batch at a time.
    const answered = chatReads(roots, roots.flatMap(r => rows(r, { author: agent(r.sequence > 200 ? s.pm : 'buddy') })))
    expect((await openProposals(s.state, s.chat(), answered.reads, NOW)).map(p => p.messageId)).toEqual(roots.slice(100, 200).map(r => r.id))
    expect(answered.calls.map(c => c.before)).toEqual([undefined, 151])
  })

  // Task #2777 (Ken's prod scan 11-04): Desktop reads this every minute, and the scan above walks the whole project chat.
  it('scans the chat once, keeping its open proposals, then answers the same from them alone, however long the chat', async () => {
    const s = swarm()
    const [open, answered, personal] = [root('open', 10, 'Sync edits'), root('answered', 20), root('personal', 50, 'Offline drafts')]
    const threads = [...rows(open, { author: agent('buddy') }), ...rows(answered, { author: agent(s.pm) }), ...rows(personal, { author: person('owner') })]
    const chat = chatReads([open, answered, personal], threads)
    const first = await openProposals(s.state, s.chat(), chat.reads, NOW)
    expect(first.map(p => p.messageId)).toEqual(['open', 'personal'])
    expect([...chat.set.keys()].sort()).toEqual(['open', 'personal'])
    expect(chat.counts.scan).toBe(1)
    const later = NOW + SEED_SETTLE_MS + 1
    expect(await openProposals(s.state, s.chat(), chat.reads, later)).toEqual(first)
    expect(chat.counts.scan).toBe(1)
    // The same reads for a chat of a thousand answered proposals besides.
    const many = Array.from({ length: 1_000 }, (_, i) => root(`old${i}`, 100 + i))
    const short = chatReads([open, personal], threads, { seededAt: NOW, open: [open, personal] })
    const long = chatReads([open, personal, ...many], [...threads, ...many.flatMap(r => rows(r, { author: agent(s.pm) }))], { seededAt: NOW, open: [open, personal] })
    expect(await openProposals(s.state, s.chat(), short.reads, later)).toEqual(first)
    expect(await openProposals(s.state, s.chat(), long.reads, later)).toEqual(first)
    expect(long.counts).toEqual(short.counts)
    expect(long.counts).toMatchObject({ scan: 0, seededAt: 1, listed: 1, rootsById: 1, threads: 1, seed: 0 })
  })

  it('lists a proposal sent since, and forgets one the PM answered, one a task marks, and one whose root is gone', async () => {
    const s = swarm()
    const [fresh, answered, onIt, gone] = [root('fresh', 60, 'New idea'), root('answered', 20), root('on-it', 30), root('gone', 40)]
    const chat = chatReads([fresh, answered, onIt], [...rows(fresh, { author: agent('buddy') }), ...rows(answered, { author: agent('buddy') }, { author: agent(s.pm) }),
      ...rows(onIt, { author: agent('buddy') }, { author: person('owner'), ask: 'on-it' })], { seededAt: NOW - SEED_SETTLE_MS - 1, open: [fresh, answered, onIt, gone] })
    expect(await openProposals(s.state, s.chat(), chat.reads, NOW)).toEqual([{ messageId: 'fresh', title: 'New idea', personId: 'peer', at: 60 }])
    expect(chat.forgotten.sort()).toEqual(['answered', 'gone', 'on-it'])
    expect([...chat.set.keys()]).toEqual(['fresh'])
    expect(chat.counts.scan).toBe(0)
    // Nothing more to forget: no write.
    await openProposals(s.state, s.chat(), chat.reads, NOW)
    expect(chat.counts.forget).toBe(1)
  })

  it('scans the chat again for half an hour after its seed: a server still on the older release writes no row', async () => {
    const s = swarm()
    const late = root('late', 70, 'Sent during the release')
    const chat = chatReads([late], rows(late, { author: agent('buddy') }), { seededAt: NOW - 60_000 })
    expect((await openProposals(s.state, s.chat(), chat.reads, NOW)).map(p => p.messageId)).toEqual(['late'])
    expect(chat.counts.scan).toBe(1)
    expect([...chat.set.keys()]).toEqual(['late'])
  })

  it('keeps the newest 100 from the open set, read a batch at a time', async () => {
    const s = swarm()
    const roots = Array.from({ length: 250 }, (_, i) => root(`p${i}`, i + 1))
    const chat = chatReads(roots, roots.flatMap(r => rows(r, { author: agent('buddy') })), { seededAt: 0, open: roots })
    expect((await openProposals(s.state, s.chat(), chat.reads, NOW)).map(p => p.messageId)).toEqual(roots.slice(-MAX_PROPOSALS).map(r => r.id))
    expect(chat.counts).toMatchObject({ scan: 0, listed: 1, rootsById: 1, threads: 1 })
  })

  // River, 11-04 (task #2926): 43 of 47 listed were long built or answered, before threads or without the task's link.
  it('leaves out a proposal closed with a reason, in the seed\'s scan of the chat too, whatever its thread says', async () => {
    const s = swarm()
    const [open, closed] = [root('open', 10, 'Sync edits'), root('closed', 20, 'Built long ago')]
    const chat = chatReads([open, closed], [...rows(open, { author: agent('buddy') }), ...rows(closed, { author: agent('buddy') })], { closed: ['closed'] })
    expect((await openProposals(s.state, s.chat(), chat.reads, NOW)).map(p => p.messageId)).toEqual(['open'])
    expect([...chat.set.keys()]).toEqual(['open'])
  })

  it('is read only by those who read the project chat', () => {
    const s = swarm()
    expect(proposalChat(s.state, peer, 'lead').id).toBe('lead')
    s.run({ type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: [] })
    expect(() => proposalChat(s.state, peer, 'lead')).toThrow(expect.objectContaining({ code: 'NOT_FOUND', status: 404 }))
    expect(() => proposalChat(s.state, owner, 'no-such-project')).toThrow(expect.objectContaining({ code: 'NOT_FOUND', status: 404 }))
    expect(proposalChat(s.state, owner, 'lead').id).toBe('lead')
  })
})
