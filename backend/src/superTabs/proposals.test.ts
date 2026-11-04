import { describe, expect, it } from 'vitest'
import { applyCommand, type Command } from './commands.js'
import { createSuperTab, type Actor, type Author, type SuperTabState } from './model.js'
import type { ThreadReply } from './pageReads.js'
import { MAX_PROPOSALS, openProposals, proposalChat, type ProposalReads, type ProposalRoot } from './proposals.js'

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
const agent = (id: string): Author => ({ kind: 'agent', id, name: id })
/** A proposal's root as buddy.propose posts it, at sequence [at]. */
const root = (id: string, at: number, title = `Proposal ${id}`): ProposalRoot => ({ id, sequence: at, text: `Let's build: ${title}`, createdAt: new Date(at),
  source: { kind: 'buddy-proposal', personId: 'peer', buddyId: 'buddy', ownerMessageId: `ask-${id}` } })
/** A thread's rows as pageThreads gives them: its root, then each reply. */
const rows = (of: ProposalRoot, ...replies: Array<{ author: Author; ask?: ThreadReply['ask'] }>): ThreadReply[] => [
  { thread: of.id, id: of.id, author: person('peer'), mentions: [], sequence: of.sequence, createdAt: of.createdAt, agentOnly: false, routing: false, kind: 'buddy-proposal' },
  ...replies.map((reply, i) => ({ thread: of.id, id: `${of.id}-r${i}`, author: reply.author, mentions: [], sequence: of.sequence + i + 1,
    createdAt: new Date(of.createdAt.getTime() + i + 1), agentOnly: false, routing: false, ...reply.ask ? { kind: 'system', ask: reply.ask } : {} })),
]

/** The chat as the database reads it: roots newest first before a sequence, and the threads of the roots named. */
function chatReads(roots: ProposalRoot[], threads: ThreadReply[]) {
  const calls: Array<{ before: number | undefined; take: number }> = []
  const reads: ProposalReads = {
    roots: async (before, take) => {
      calls.push({ before, take })
      return roots.filter(r => before === undefined || r.sequence < before).sort((a, b) => b.sequence - a.sequence).slice(0, take)
    },
    threads: async ids => threads.filter(row => ids.includes(row.thread)),
  }
  return { reads, calls }
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
    expect(await openProposals(s.state, s.chat(), reads)).toEqual([
      { messageId: 'old', title: 'Old proposal', personId: 'peer', at: 5 },
      { messageId: 'open', title: 'Sync edits', personId: 'peer', at: 10 },
      { messageId: 'personal', title: 'Offline drafts', personId: 'peer', at: 50 },
    ])
  })

  it('keeps the newest 100 open, read in batches, and reads no further once it has them', async () => {
    const s = swarm()
    const roots = Array.from({ length: 250 }, (_, i) => root(`p${i}`, i + 1))
    const { reads, calls } = chatReads(roots, roots.flatMap(r => rows(r, { author: agent('buddy') })))
    const listed = await openProposals(s.state, s.chat(), reads)
    expect(listed).toHaveLength(MAX_PROPOSALS)
    expect(listed.map(p => p.messageId)).toEqual(roots.slice(-MAX_PROPOSALS).map(r => r.id))
    expect(calls).toEqual([{ before: undefined, take: MAX_PROPOSALS }])
    // Answered ones are read past, a batch at a time.
    const answered = chatReads(roots, roots.flatMap(r => rows(r, { author: agent(r.sequence > 200 ? s.pm : 'buddy') })))
    expect((await openProposals(s.state, s.chat(), answered.reads)).map(p => p.messageId)).toEqual(roots.slice(100, 200).map(r => r.id))
    expect(answered.calls.map(c => c.before)).toEqual([undefined, 151])
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
