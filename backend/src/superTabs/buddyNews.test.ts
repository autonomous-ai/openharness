import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, forRecipients, type Actor, type Conversation, type MessageDraft } from './model.js'
import { buddyChatId } from './buddies.js'
import { SHIP_KIND } from './ship.js'
import { pendingKey, settleReleases } from './releases.js'
import { TASK_LINE_KIND } from './taskLine.js'
import { leaderboard } from './leaderboard/stats.js'
import { weekStart } from './leaderboard/week.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host' })
const proposal = { text: 'Sync edits made offline', goal: 'Sync edits made offline', scope: 'Desktop drafts only', priority: 'high' as const }

/** A public project with its PM, a worker, and peer's Buddy with its chat, as buddy.create and its start leave them. */
function setup() {
  let state = createSuperTab('swarm', 'Team', { id: 'owner', email: owner.email }, 'test')
  state.people.push({ id: 'peer', email: peer.email, role: 'collaborator', generation: 'first' })
  let next = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1000,
      contribution: { machineOwnerId: 'host', contributorId: actor.kind === 'person' ? actor.userId : 'owner' }, ...context })
    state = effects.state
    return effects
  }
  const app = run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
  const add = (conversationId: string, harnessId: string, lead = false) => run({ type: 'agent.add', conversationId, harnessId, machineId: 'machine',
    name: harnessId, configuration, lead }).result.agentId as string
  const pm = add(app.conversationId, 'pm', true)
  state.agents.push({ id: 'buddy', projectId: app.projectId, machineId: 'machine', harnessId: 'buddy-harness', machineOwnerId: 'host',
    contributorId: 'peer', membershipGeneration: 'first', name: 'Buddy', configuration, buddyOf: { personId: 'peer', generation: 'first' } })
  const chat: Conversation = { id: buddyChatId(app.projectId, { id: 'peer', generation: 'first' }), kind: 'buddy', projectId: app.projectId, title: 'Buddy',
    leadId: null, agentIds: ['buddy'], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0,
    audience: { people: [{ id: 'peer', generation: 'first' }] } }
  state.conversations.push(chat)
  /** peer's Buddy sends their proposal; the store reads the ask it names. */
  const proposed = () => run({ type: 'buddy.propose', conversationId: chat.id, ownerMessageId: 'ask', ...proposal }, agentActor('buddy'),
    { proposalAsk: { id: 'ask', conversationId: chat.id, source: false, createdAt: 900, text: proposal.text,
      author: { kind: 'person', id: 'peer', name: 'peer', membershipGeneration: 'first' } } }).messages
  const propose = () => proposed()[0]!
  /** The PM's post in the project chat, replying to [root] or to a reply in [root]'s thread, as the store loads that reply. */
  const pmPost = (text: string, extra: { replyTo?: MessageDraft; root?: MessageDraft; mentions?: string[] } = {}, actor: Actor = agentActor(pm)) => {
    const reply = extra.replyTo && { id: extra.replyTo.id, conversationId: extra.replyTo.conversationId, author: extra.replyTo.author, createdAt: 900,
      thread: (extra.root ?? extra.replyTo).id, threadSource: (extra.root ?? extra.replyTo).source ?? null }
    return run({ type: 'message.send', conversationId: app.conversationId, text, recipientIds: [], replyTo: extra.replyTo?.id ?? null,
      ...(extra.mentions ? { mentions: extra.mentions } : {}) }, actor, reply ? { reply } : {}).messages.at(-1)!
  }
  return { run, add, app, pm, chat: chat.id, proposed, propose, pmPost, get state() { return state } }
}

// Task #4623 (anh Dee, 11-07): no agent relays news to its owner. Their card shows accepted, working and shipped, and every
// question for them is a Decision, so a Buddy hears no project-chat line, assignment or release for its person.
describe('no agent relays news to its owner', () => {
  const hears = (messages: MessageDraft[]) => messages.filter(m => m.recipients.includes('buddy'))

  it('hears nothing when the PM answers its person’s proposal, in its thread too', () => {
    const f = setup(), sent = f.propose()
    const answer = f.pmPost('Taking it: #12 will build this.', { replyTo: sent })
    expect(hears([answer, f.pmPost('Builder Orion has it.', { replyTo: answer, root: sent })])).toEqual([])
  })

  it('hears nothing when the PM tags its person', () => {
    const f = setup()
    expect(hears([f.pmPost('@peer the build is green.', { mentions: ['peer'] })])).toEqual([])
  })

  it('writes no news line when its person’s requested work is assigned', () => {
    const f = setup()
    const group = f.run({ type: 'conversation.create', projectId: f.app.projectId, title: 'Offline edits', brief: 'Save edits offline.',
      checks: [{ description: 'Tests pass', independent: false }], requesterId: 'peer' } as Command).result.conversationId as string
    const worker = f.add(group, 'worker')
    const assigned = f.run({ type: 'work.assign', conversationId: group, agentId: worker }).messages
    expect(hears(assigned)).toEqual([])
    expect(assigned.filter(m => m.text.startsWith('News for your owner'))).toEqual([])
  })
})

describe('work the PM opens from a Buddy\'s proposal without naming anyone (groups #294 and #327, 10-30)', () => {
  /** peer's Buddy proposes; the PM opens a group from it, the store loading the proposal row by its id. */
  function opened(extra: Record<string, unknown> = {}) {
    const f = setup(), sent = f.propose()
    const created = f.run({ type: 'conversation.create', projectId: f.app.projectId, title: 'Offline edits', brief: 'Save edits offline.',
      checks: [{ description: 'Tests pass', independent: false }], proposalMessageId: sent.id, ...extra } as Command, agentActor(f.pm),
      { proposal: { id: sent.id, conversationId: sent.conversationId, author: sent.author, source: sent.source ?? null } })
    const group = created.result.conversationId as string
    return { f, group, created, find: () => f.state.conversations.find(c => c.id === group)! }
  }

  it('is requested by the person the proposal was sent for, who gets the Shipped points and no news through their Buddy', () => {
    const { f, group, created, find } = opened()
    expect(find().requesterId).toBe('peer')
    expect(created.result.requesterUnknown).toBeUndefined()
    const worker = f.add(group, 'worker')
    expect(f.run({ type: 'work.assign', conversationId: group, agentId: worker }).messages.filter(m => m.recipients.includes('buddy'))).toEqual([])
    const assignmentId = find().assignment!.id
    for (const check of find().checks) f.run({ type: 'work.check', conversationId: group, assignmentId, checkId: check.id, passed: true, evidence: 'ok' })
    // Done with its pull request reads ready and is no news yet; its recorded merge ships it (taskLine.ts; PM, review of #2633),
    // and their Buddy hears it inside the task, once.
    const done = f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'done', result: 'Review passed: https://github.com/o/r/pull/7' },
      agentActor(worker))
    expect(done.messages.filter(m => m.thread === find().cards!.line!.messageId)).toEqual([])
    expect(done.messages.filter(m => m.recipients.includes('buddy'))).toEqual([])
    const merged = f.run({ type: 'conversation.merged', conversationId: group, pullRequestUrl: 'https://github.com/o/r/pull/7' }, agentActor(worker))
    expect(merged.messages).toEqual(expect.arrayContaining([expect.objectContaining({ thread: find().cards!.line!.messageId, text: 'Merged: PR #7. Ships in the next release.' })]))
    // A merge is not shipped: the news waits for the release that holds it (task #4217).
    expect(merged.messages.filter(m => m.recipients.includes('buddy'))).toEqual([])
    expect(f.run({ type: 'conversation.merged', conversationId: group, pullRequestUrl: 'https://github.com/o/r/pull/7' }, agentActor(worker))
      .messages.filter(m => m.recipients.includes('buddy'))).toEqual([])
    const board = leaderboard({ state: f.state, groups: f.state.conversations, machines: [], projectId: f.app.projectId, week: weekStart(1000), now: 1000 })
    expect(board.people.find(p => p.personId === 'peer')).toMatchObject({ points: 3, shipped: { count: 1 } })
  })

  // Task #4623: the card says Shipped (task #4547); the Buddy hears nothing.
  it('tells the Buddy nothing when a verified release holds its work', () => {
    const { f, group, find } = opened()
    const worker = f.add(group, 'worker')
    f.run({ type: 'work.assign', conversationId: group, agentId: worker })
    const url = 'https://github.com/o/r/pull/7'
    expect(f.run({ type: 'conversation.merged', conversationId: group, pullRequestUrl: url }, agentActor(worker))
      .messages.filter(m => m.recipients.includes('buddy'))).toEqual([])
    const key = pendingKey({ groupId: group, url })
    const settle = (tag: string, carries: string[], at: number) => {
      const state = structuredClone(f.state)
      const out = settleReleases(state, f.app.projectId, { resolved: [{ groupId: group, url, components: ['backend'], sha: 'merge' }],
        releases: { backend: { tag, sha: tag, at, carries, compared: [key] } } }, at)
      Object.assign(f.state, state)
      return out.messages.filter(m => m.recipients.includes('buddy'))
    }
    expect(settle('v1.0.1_backend', [], 5000)).toEqual([])
    expect(settle('v1.0.2_backend', [key], 6000)).toEqual([])
    expect(find().released).toMatchObject({ at: 6000 })
  })

  it('keeps the requester the PM names, even someone else', () => {
    const { find } = opened({ requesterId: 'owner' })
    expect(find().requesterId).toBe('owner')
  })

  it('is refused naming the requester when the proposal\'s person left the Swarm or no longer reads the project, and opens once the PM names one (task #3389)', () => {
    for (const lose of [(f: ReturnType<typeof setup>) => { f.state.people = f.state.people.filter(p => p.id !== 'peer') },
      (f: ReturnType<typeof setup>) => { f.state.projects!.find(p => p.id === f.app.projectId)!.visibility = 'private' }]) {
      const f = setup(), sent = f.propose()
      lose(f)
      const open = (extra: Record<string, unknown> = {}) => f.run({ type: 'conversation.create', projectId: f.app.projectId, title: 'Offline edits', brief: 'Save edits offline.',
        checks: [{ description: 'Tests pass', independent: false }], proposalMessageId: sent.id, ...extra } as Command, agentActor(f.pm),
        { proposal: { id: sent.id, conversationId: sent.conversationId, author: sent.author, source: sent.source ?? null } })
      expect(() => open()).toThrow(expect.objectContaining({ code: 'TASK_CONTRACT_MISSING', message: expect.stringContaining('requester') }))
      const opened = open({ requesterId: 'owner' }).result.conversationId
      const group = f.state.conversations.find(c => c.id === opened)!
      expect(group.requesterId).toBe('owner')
      expect(group.ledger?.proposal).toEqual({ buddyId: 'buddy', messageId: sent.id })
    }
  })

  // A proposal stored before task #2926 has its Buddy's first reply holding its details, the row its PM was delivered.
  describe('named by its details, the first reply and the row the PM is delivered (Scholes, 11-04)', () => {
    /** A proposal's root and the Buddy's details reply under it, as buddy.propose wrote them before task #2926. */
    const stored = (f: ReturnType<typeof setup>): [MessageDraft, MessageDraft] => {
      const root = f.propose()
      return [root, { id: 'details', conversationId: root.conversationId, author: { kind: 'agent', id: 'buddy', name: 'Buddy', membershipGeneration: 'first' },
        text: 'Goal: Sync edits made offline\nScope: Desktop drafts only\nPriority: high', replyTo: root.id, thread: root.id, recipients: [f.pm] }]
    }
    /** The row the store loads for the named reply, with the row it replies to. */
    const loaded = (reply: MessageDraft, root: MessageDraft) => ({ proposal: { id: reply.id, conversationId: reply.conversationId, author: reply.author,
      source: reply.source ?? null, root: { id: root.id, conversationId: root.conversationId, author: root.author, source: root.source ?? null } } })
    const open = (f: ReturnType<typeof setup>, reply: MessageDraft, root: MessageDraft) => f.run({ type: 'conversation.create', projectId: f.app.projectId,
      title: 'Offline edits', brief: 'Save edits offline.', checks: [{ description: 'Tests pass', independent: false }], proposalMessageId: reply.id } as Command,
    agentActor(f.pm), loaded(reply, root))

    it('links the proposal itself: its person asked, its row is the task\'s only line, its Buddy is credited', () => {
      const f = setup(), [root, details] = stored(f)
      const created = open(f, details, root)
      const group = f.state.conversations.find(c => c.id === created.result.conversationId)!
      expect(group.requesterId).toBe('peer')
      expect(group.ledger?.proposal).toEqual({ buddyId: 'buddy', messageId: root.id })
      expect(group.cards?.line).toMatchObject({ messageId: root.id, conversationId: f.app.conversationId })
      expect(created.messages.filter(m => m.conversationId === f.app.conversationId)).toEqual([])
    })

    it('refuses any other reply in its thread, and the Buddy\'s reply under anything but its own proposal: nothing opens', () => {
      const f = setup(), [root, details] = stored(f)
      const before = f.state.conversations.length
      const wrongs: Array<[MessageDraft, MessageDraft]> = [
        [{ ...details, author: { ...details.author, id: f.pm } }, root],
        [{ ...details, author: { kind: 'person', id: 'peer', name: 'peer', membershipGeneration: 'first' } }, root],
        [{ ...details, source: { kind: 'route' } }, root],
        [details, { ...root, source: { kind: 'route', personId: 'peer', buddyId: 'buddy' } }],
        [details, { ...root, source: { ...root.source, buddyId: 'other-buddy' } }],
        [details, { ...root, conversationId: f.chat }],
      ]
      for (const [reply, under] of wrongs) {
        expect(() => open(f, reply, under), JSON.stringify([reply, under])).toThrow('Name a Buddy\'s proposal posted in this project\'s chat, or leave the proposal out.')
      }
      expect(f.state.conversations.length).toBe(before)
    })
  })

  it('credits nobody from a proposal posted in another project\'s chat, a private chat or by anyone but a Buddy: refused alike, nothing opened', () => {
    const f = setup(), sent = f.propose()
    const web = f.run({ type: 'project.create', name: 'Web', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
    const before = f.state.conversations.length
    const wrongs = [{ ...sent, conversationId: web.conversationId }, { ...sent, conversationId: f.chat },
      { ...sent, author: { kind: 'person' as const, id: 'owner', name: 'owner', membershipGeneration: 'first' } },
      { ...sent, source: { ...sent.source, buddyId: f.pm } },
      { ...sent, author: { ...sent.author, id: f.pm } }, { ...sent, source: { kind: 'route', personId: 'peer' } }]
    for (const wrong of wrongs) {
      expect(() => f.run({ type: 'conversation.create', projectId: f.app.projectId, title: 'Offline', brief: 'Save.',
        checks: [{ description: 'Done', independent: false }], proposalMessageId: wrong.id } as Command, agentActor(f.pm),
        { proposal: { id: wrong.id, conversationId: wrong.conversationId, author: wrong.author, source: wrong.source ?? null } }), JSON.stringify(wrong))
        .toThrow('Name a Buddy\'s proposal posted in this project\'s chat, or leave the proposal out.')
    }
    expect(f.state.conversations.length).toBe(before)
  })
})
