import { describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'
import { checkAsker, listDecisions, waitingInProject, type DecisionTarget } from './decisions.js'
import { buddyChatId } from './buddies.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const config: AgentConfiguration = { engine: 'codex', model: 'test-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const asAgent = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
const question = (text: string, recommended = 0) => ({ question: text, options: ['Behind a flag', 'To everyone'], recommended, unblocks: 'The release' })

/** A Swarm with the peer in it, a Lead, and a worker assigned to one group. */
function swarm() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: 1000, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  const add = (harnessId: string, group: string, lead = false) => run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId,
    name: harnessId, configuration: config, lead }, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  const lead = add('lead', 'lead', true)
  const group = run({ type: 'conversation.create', title: 'Offline editing', brief: 'Save edits while offline.',
    checks: [{ description: 'Reconnect preserves the edits.', independent: true }] }).result.conversationId as string
  const worker = add('worker', group)
  const assignmentId = run({ type: 'work.assign', conversationId: group, agentId: worker }).result.assignmentId as string
  return { run, lead, group, worker, assignmentId, get state() { return state } }
}

describe('asking a person for decisions', () => {
  it('lets the Lead ask one person several questions at once, each with options, a recommendation and what it unblocks', () => {
    const s = swarm()
    const asked = s.run({ type: 'decision.ask', conversationId: s.group, personId: 'peer', questions: [question('Ship how?'), question('Which name?', 1)] }, asAgent(s.lead))
    expect(asked.decisions).toHaveLength(2)
    expect(asked.decisions![0]).toMatchObject({ conversationId: s.group, projectId: 'lead', personId: 'peer', askerAgentId: s.lead, assignmentId: null,
      question: 'Ship how?', options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'The release' })
    expect(asked.decisions![1]).toMatchObject({ question: 'Which name?', recommended: 1 })
    // One batch for the person: one id ties the questions together, and nobody is pinged in the transcript.
    expect(new Set(asked.decisions!.map(d => d.batchId)).size).toBe(1)
    expect(new Set(asked.decisions!.map(d => d.id)).size).toBe(2)
    expect(asked.messages).toEqual([])
    expect(asked.result.decisionIds).toEqual(asked.decisions!.map(d => d.id))
  })

  it('refuses a question from a person, to someone outside the Swarm, or with a recommendation that is not an option', () => {
    const s = swarm()
    const ask = (actor: Actor, personId = 'peer', recommended = 0) =>
      () => s.run({ type: 'decision.ask', conversationId: s.group, personId, questions: [question('Ship how?', recommended)] }, actor)
    expect(ask(owner)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(ask(asAgent(s.lead), 'stranger')).toThrow('person in this Swarm')
    expect(ask(asAgent(s.lead), 'peer', 2)).toThrow('recommend one of its options')
    expect(commandSchema.safeParse({ type: 'decision.ask', conversationId: s.group, personId: 'peer',
      questions: [{ ...question('One option only'), options: ['Yes'] }] }).success).toBe(false)
    expect(commandSchema.safeParse({ type: 'decision.ask', conversationId: s.group, personId: 'peer',
      questions: Array.from({ length: 11 }, (_, i) => question(`Question ${i}`)) }).success).toBe(false)
  })

  it('opens a decision for the named person when a worker needs one on its own task, and still tells the Lead', () => {
    const s = swarm()
    const needs = s.run({ type: 'work.status', conversationId: s.group, assignmentId: s.assignmentId, status: 'needs_human', result: 'Ship to everyone, or behind a flag?',
      ask: { personId: 'peer', options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'Turning the feature on' } }, asAgent(s.worker))
    expect(needs.decisions).toEqual([expect.objectContaining({ personId: 'peer', askerAgentId: s.worker, assignmentId: s.assignmentId,
      question: 'Ship to everyone, or behind a flag?', recommended: 0, unblocks: 'Turning the feature on' })])
    expect(needs.messages[0]).toMatchObject({ text: 'Needs a human\n\nShip to everyone, or behind a flag?\n\nAsked peer@example.com.', recipients: [s.lead] })
    // Without a person and options it reaches the Lead as before, who asks.
    const plain = s.run({ type: 'work.status', conversationId: s.group, assignmentId: s.assignmentId, status: 'needs_human', result: 'Which database?' }, asAgent(s.worker))
    expect(plain.decisions ?? []).toEqual([])
    expect(() => s.run({ type: 'work.status', conversationId: s.group, assignmentId: s.assignmentId, status: 'blocked', result: 'Stuck',
      ask: { personId: 'peer', options: ['A', 'B'], recommended: 0, unblocks: 'X' } }, asAgent(s.worker))).toThrow('needs a human')
  })

  // Who asks a person is workflow (project instructions, phase 4): any agent of the project, in its own project only.
  it('lets any agent of the project ask a person', () => {
    const s = swarm()
    const task = s.state.conversations.find(c => c.id === s.group)!
    expect(checkAsker(s.state, asAgent(s.worker), task)).toBe(s.worker)
    const asked = s.run({ type: 'decision.ask', conversationId: s.group, personId: 'peer', questions: [question('Ship how?')] }, asAgent(s.worker))
    expect(asked.decisions).toEqual([expect.objectContaining({ askerAgentId: s.worker, conversationId: s.group })])
    const other = s.run({ type: 'project.create', name: 'Other', visibility: 'public', brief: '' }).result as { projectId: string }
    const elsewhere = s.run({ type: 'conversation.create', projectId: other.projectId, title: 'Elsewhere', brief: '', checks: [] }).result.conversationId as string
    const leads = s.state.conversations.find(c => c.id === s.state.leadsConversationId)!
    for (const group of [leads, s.state.conversations.find(c => c.id === elsewhere)!]) {
      expect(() => checkAsker(s.state, asAgent(s.worker), group)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    }
    expect(() => checkAsker(s.state, owner, task)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  })
})

describe('answering a decision', () => {
  const open = (s: ReturnType<typeof swarm>, overrides: Partial<DecisionTarget> = {}): DecisionTarget => ({ id: 'decision-1', personId: 'peer',
    conversationId: s.group, projectId: 'lead', askerAgentId: s.worker, question: 'Ship how?', options: ['Behind a flag', 'To everyone'], recommended: 0,
    answeredAt: null, createdAt: 0, assignmentId: null, ...overrides })

  it('records the asked person\'s choice and tells the asking agent and the Lead with a notice only they read, carrying none of it', () => {
    const s = swarm()
    const answered = s.run({ type: 'decision.answer', decisionId: 'decision-1', choice: 1, note: 'We are confident.' }, peer, { decision: open(s) })
    expect(answered.decisionAnswer).toEqual({ id: 'decision-1', choice: 1, note: 'We are confident.' })
    expect(answered.messages).toEqual([expect.objectContaining({ conversationId: s.group, recipients: [s.worker, s.lead],
      source: { kind: 'agent-only', decisionId: 'decision-1' } })])
    for (const text of ['Ship how?', 'To everyone', 'We are confident.']) expect(answered.messages[0]!.text).not.toContain(text)
  })

  it('takes an answer only from the person asked, once, and only for one of its options', () => {
    const s = swarm()
    const answer = (actor: Actor, decision: DecisionTarget | undefined, choice = 0) =>
      () => s.run({ type: 'decision.answer', decisionId: 'decision-1', choice }, actor, decision ? { decision } : {})
    expect(answer(owner, open(s))).toThrow('unavailable')
    expect(answer(peer, undefined)).toThrow('unavailable')
    expect(answer(peer, open(s, { answeredAt: 5 }))).toThrow('already answered')
    expect(answer(peer, open(s), 2)).toThrow('Choose one of its options')
    // A person who can no longer read its conversation cannot answer it, though they stay in the Swarm.
    const hidden = 'owner-buddy'
    s.state.conversations.push({ id: hidden, kind: 'buddy', projectId: 'lead', title: 'Owner\'s Buddy', leadId: null, agentIds: [], archived: false,
      brief: '', checks: [], assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'owner', generation: s.state.people[0]!.generation }] } })
    expect(answer(peer, open(s, { conversationId: hidden }))).toThrow('unavailable')
    expect(answer(peer, open(s, { conversationId: 'gone' }))).toThrow('unavailable')
  })

  it('still records the answer when the asker has left the conversation, telling whoever of them is left', () => {
    const s = swarm()
    const answered = s.run({ type: 'decision.answer', decisionId: 'decision-1', choice: 0 }, peer, { decision: open(s, { askerAgentId: 'gone' }) })
    expect(answered.decisionAnswer).toEqual({ id: 'decision-1', choice: 0, note: null })
    expect(answered.messages[0]!.recipients).toEqual([s.lead])
  })
})

describe('leaving a decision to the PM', () => {
  const open = (s: ReturnType<typeof swarm>, overrides: Partial<DecisionTarget> = {}): DecisionTarget => ({ id: 'decision-1', personId: 'peer',
    conversationId: s.group, projectId: 'lead', askerAgentId: s.worker, question: 'Ship how?', options: ['Behind a flag', 'To everyone'], recommended: 1,
    answeredAt: null, createdAt: 0, assignmentId: null, ...overrides })
  /** The peer's own Buddy chat in the project, as adding a Buddy opens it (buddies.ts). */
  const buddyChat = (s: ReturnType<typeof swarm>) => {
    const generation = s.state.people.find(p => p.id === 'peer')!.generation
    const id = buddyChatId('lead', { id: 'peer', generation })
    s.state.conversations.push({ id, kind: 'buddy', projectId: 'lead', title: 'peer\'s Buddy', leadId: null, agentIds: [], archived: false,
      brief: '', checks: [], assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'peer', generation }] } })
    return id
  }
  const delegate = (s: ReturnType<typeof swarm>, actor: Actor, decision: DecisionTarget | undefined) =>
    s.run({ type: 'decision.answer', decisionId: 'decision-1', delegate: true }, actor, decision ? { decision } : {})

  it('answers with the recommended option for the person asked, recorded as delegated, and the PM says so in their Buddy chat', () => {
    const s = swarm()
    const chat = buddyChat(s)
    const answered = delegate(s, peer, open(s))
    expect(answered.decisionAnswer).toEqual({ id: 'decision-1', choice: 1, note: null, delegated: true })
    const [notice, swarmLine, line] = answered.messages
    // The asker and the Lead are told the PM decided, with none of the answer, as for any answer.
    expect(notice).toMatchObject({ conversationId: s.group, recipients: [s.worker, s.lead], source: { kind: 'agent-only', decisionId: 'decision-1' } })
    expect(notice!.text).toContain('left to the Product Manager')
    for (const text of ['Ship how?', 'To everyone']) expect(notice!.text).not.toContain(text)
    // One line from the PM in the person's one Buddy chat, marked with its project, and the same in their older chat there for
    // older apps (Dee, 10-31): only they read either, and it goes to nobody.
    const swarmChat = s.state.conversations.find(c => c.kind === 'swarm-buddy')!
    expect(swarmLine).toMatchObject({ conversationId: swarmChat.id, recipients: [], text: 'PM decided: To everyone — Ship how?',
      author: { kind: 'agent', id: s.lead }, source: { kind: 'decision-delegated', decisionId: 'decision-1', projectId: 'lead' } })
    expect(line).toMatchObject({ conversationId: chat, recipients: [], text: 'PM decided: To everyone — Ship how?',
      author: { kind: 'agent', id: s.lead }, source: { kind: 'decision-delegated', decisionId: 'decision-1' } })
    expect(new Set([notice!.id, swarmLine!.id, line!.id]).size).toBe(3)
    expect(answered.messages).toHaveLength(3)
  })

  it('opens the person\'s Buddy chat for the line when they have none, and opens an archived one again: the line never drops', () => {
    const s = swarm()
    const answered = delegate(s, peer, open(s))
    expect(answered.decisionAnswer).toMatchObject({ choice: 1, delegated: true })
    const chat = s.state.conversations.find(c => c.kind === 'buddy')!, swarmChat = s.state.conversations.find(c => c.kind === 'swarm-buddy')!
    expect(chat).toMatchObject({ projectId: 'lead', agentIds: [], audience: { people: [{ id: 'peer' }] } })
    expect(swarmChat).toMatchObject({ agentIds: [], audience: { people: [{ id: 'peer' }] } })
    expect(swarmChat.projectId).toBeUndefined()
    expect(answered.messages.map(m => m.conversationId)).toEqual([s.group, swarmChat.id, chat.id])
    chat.archived = true
    swarmChat.archived = true
    expect(delegate(s, peer, open(s)).messages.map(m => m.conversationId)).toEqual([s.group, swarmChat.id, chat.id])
    expect(s.state.conversations.find(c => c.id === chat.id)!.archived).toBe(false)
    expect(s.state.conversations.find(c => c.id === swarmChat.id)!.archived).toBe(false)
  })

  it('lets only the person asked delegate, once, and only a decision with a recommended option', () => {
    const s = swarm()
    expect(() => delegate(s, owner, open(s))).toThrow('unavailable')
    expect(() => delegate(s, peer, undefined)).toThrow('unavailable')
    expect(() => delegate(s, peer, open(s, { answeredAt: 5 }))).toThrow('already answered')
    expect(() => delegate(s, peer, open(s, { recommended: 2 }))).toThrow('no recommended option')
  })

  it('takes either a choice or a delegation, not both or neither', () => {
    const s = swarm()
    expect(() => s.run({ type: 'decision.answer', decisionId: 'decision-1', choice: 0, delegate: true }, peer, { decision: open(s) })).toThrow('or leave it to the PM')
    expect(() => s.run({ type: 'decision.answer', decisionId: 'decision-1' }, peer, { decision: open(s) })).toThrow('or leave it to the PM')
    expect(commandSchema.safeParse({ type: 'decision.answer', decisionId: 'decision-1', delegate: false }).success).toBe(false)
  })
})

describe('listing a person\'s decisions', () => {
  /** A transaction whose open decisions are [count] rows asked of the peer in the group, newest first. */
  const reading = (s: ReturnType<typeof swarm>, count: number) => {
    const asked: Array<{ take?: number }> = []
    const rows = Array.from({ length: count }, (_, i) => ({ id: `decision-${i}`, batchId: `batch-${i}`, projectId: 'lead', conversationId: s.group,
      assignmentId: null, personId: 'peer', askerAgentId: s.lead, question: `Question ${i}`, options: ['Behind a flag', 'To everyone'], recommended: 0,
      unblocks: 'The release', createdAt: new Date(1000 - i), answeredAt: null, choice: null, note: null, delegated: null }))
    const tx = { superTabDecision: { findMany: async (args: { take?: number }) => { asked.push(args); return rows.slice(0, args.take) } } }
    return { tx: tx as unknown as Prisma.TransactionClient, asked }
  }

  it('says when the newest page leaves open decisions out, so a client never takes it for all of them', async () => {
    const s = swarm()
    const full = reading(s, 201)
    const page = await listDecisions(full.tx, 'tab', s.state, peer, 'open')
    expect(page.decisions).toHaveLength(200)
    expect(page.more).toBe(true)
    const all = await listDecisions(reading(s, 3).tx, 'tab', s.state, peer, 'open')
    expect(all.decisions.map(d => d.id)).toEqual(['decision-0', 'decision-1', 'decision-2'])
    expect(all.more).toBe(false)
  })
})

// groupBy on SuperTabDecision once panicked the Prisma engine on Mongo: the digest counts the open decisions it reads instead.
describe('the decisions waiting in a project', () => {
  it('counts each conversation and person\'s open decisions without groupBy, reading only who and where', async () => {
    const asked: unknown[] = []
    const rows = [{ conversationId: 'c1', personId: 'owner' }, { conversationId: 'c2', personId: 'peer' }, { conversationId: 'c1', personId: 'owner' },
      { conversationId: 'c1', personId: 'peer' }, { conversationId: 'c1', personId: 'owner' }]
    const tx = { superTabDecision: {
      groupBy: async () => { throw new Error('groupBy on SuperTabDecision') },
      findMany: async (args: unknown) => { asked.push(args); return rows },
    } } as unknown as Prisma.TransactionClient
    expect(await waitingInProject(tx, 'tab', 'web')).toEqual([{ conversationId: 'c1', personId: 'owner', count: 3 },
      { conversationId: 'c2', personId: 'peer', count: 1 }, { conversationId: 'c1', personId: 'peer', count: 1 }])
    expect(asked).toEqual([{ where: { tabId: 'tab', projectId: 'web', OR: [{ answeredAt: null }, { answeredAt: { isSet: false } }] },
      select: { conversationId: true, personId: true } }])
  })
})
