import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { CREW_NEED_KIND, crewNeedOf } from './crewNeeds.js'
import { agentOnly, createSuperTab, type Actor, type MessageDraft } from './model.js'

// People talk only to the PM (anh Dee, 2026-11-05; task #3404, River's ruling): an agent's tag of a person, its needs_human
// and its person.tell become a crew need for the PM, and the agent is told. The PM tags anyone; any other
// agent tags only the person it is answering. With no PM in the project, everything stays as before.

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const third: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'third', email: 'third@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const asAgent = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'owner' })
const choices = { options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'The release' }

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let next = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1000,
      contribution: { machineOwnerId: 'owner', contributorId: actor.kind === 'person' ? actor.userId : 'owner' }, ...context })
    state = effects.state
    return effects
  }
  for (const who of [peer, third]) {
    const invited = run({ type: 'invite.create', email: who.email, role: 'collaborator', conversationId: 'lead' })
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, who)
  }
  const project = (name: string) => run({ type: 'project.create', name, visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
  const add = (conversationId: string, harnessId: string, lead: boolean) => run({ type: 'agent.add', conversationId, harnessId, machineId: 'machine',
    name: harnessId, lead, configuration }).result.agentId as string
  const app = project('App')
  const pm = add(app.conversationId, 'pm', true)
  const worker = add(app.conversationId, 'worker', false)
  const group = run({ type: 'conversation.create', projectId: app.projectId, title: 'Copy', brief: '', checks: [] }).result.conversationId as string
  run({ type: 'conversation.agent', conversationId: group, agentId: worker, present: true, lead: false })
  /** A post, with the context the store gives a reply or an answer: the message it answers. */
  const post = (actor: Actor, text: string, extra: Partial<Extract<Command, { type: 'message.send' }>> = {}, reply?: MessageDraft, conversationId = group) =>
    run({ type: 'message.send', conversationId, text, replyTo: null, recipientIds: [], ...extra }, actor,
      reply ? { reply: { id: reply.id, conversationId: reply.conversationId, author: reply.author, createdAt: 1000, thread: reply.thread ?? reply.id } } : {})
  return { run, add, project, post, app, pm, worker, group, get state() { return state } }
}

const own = (effects: { messages: MessageDraft[] }, conversationId: string) => effects.messages.find(m => m.conversationId === conversationId && !m.source)!
const needs = (effects: { messages: MessageDraft[] }) => effects.messages.filter(m => crewNeedOf(m.source))

describe('an agent’s tag of a person goes to the PM', () => {
  it('writes no tag for the person, and a crew need reaches the PM alone, saying so to the agent', () => {
    const f = fixture()
    for (const sent of [f.post(asAgent(f.worker), '@peer please confirm the copy'), f.post(asAgent(f.worker), 'Please confirm the copy', { mentions: ['peer'] })]) {
      const message = own(sent, f.group)
      expect(message.mentions ?? []).toEqual([])
      // A tag picked but not said is not written into the text either: the person would read it as a tag.
      expect(message.text).not.toContain('@peer please confirm the copy\n')
      expect(needs(sent)).toHaveLength(1)
      const [need] = needs(sent)
      expect(need).toMatchObject({ conversationId: f.group, recipients: [f.pm], source: { kind: CREW_NEED_KIND } })
      expect(need!.mentions ?? []).toEqual([])
      expect(agentOnly(need!.source, need!.recipients)).toBe(true)
      expect(crewNeedOf(need!.source)).toEqual({ agentId: f.worker, personIds: ['peer'], messageId: message.id, conversationId: f.group })
      expect(need!.text).toContain('peer')
      expect(sent.result.routedToPm).toMatch(/PM/)
    }
  })

  it('keeps the PM’s tags, a person’s tags, and an agent’s tag of the person it answers', () => {
    const f = fixture()
    const byPm = f.post(asAgent(f.pm), '@peer please confirm')
    expect(own(byPm, f.group).mentions).toEqual(['peer'])
    expect(needs(byPm)).toEqual([])
    const byPerson = f.post(owner, '@peer please confirm')
    expect(own(byPerson, f.group).mentions).toEqual(['peer'])
    expect(needs(byPerson)).toEqual([])
    // The worker answers peer's question: peer is tagged; third, whom it did not answer, goes to the PM.
    const question = own(f.post(peer, 'Is the copy final?'), f.group)
    const answer = f.post(asAgent(f.worker), '@peer yes, and @third should check it', { answers: question.id }, question)
    expect(own(answer, f.group).mentions).toEqual(['peer'])
    expect(needs(answer).map(m => crewNeedOf(m.source)!.personIds)).toEqual([['third']])
    const inThread = f.post(asAgent(f.worker), '@peer it is in', { replyTo: question.id }, question)
    expect(inThread.messages.find(m => !m.source)!.mentions).toEqual(['peer'])
    expect(needs(inThread)).toEqual([])
  })

  it('leaves tags as they are in a project with no PM', () => {
    const f = fixture()
    const other = f.project('Other')
    const helper = f.add(other.conversationId, 'helper', false)
    const task = f.run({ type: 'conversation.create', projectId: other.projectId, title: 'Docs', brief: '', checks: [] }).result.conversationId as string
    f.run({ type: 'conversation.agent', conversationId: task, agentId: helper, present: true, lead: false })
    const sent = f.post(asAgent(helper), '@peer please confirm', {}, undefined, task)
    expect(own(sent, task).mentions).toEqual(['peer'])
    expect(needs(sent)).toEqual([])
    expect(sent.result.routedToPm).toBeUndefined()
  })

  it('still brings a person’s reply to the agent it answers', () => {
    const f = fixture()
    const asked = own(f.post(asAgent(f.worker), 'Which copy do we ship?'), f.group)
    const reply = f.post(peer, 'The short one', { replyTo: asked.id }, asked)
    expect(reply.messages.find(m => !m.source)!.recipients).toContain(f.worker)
    const below = f.post(peer, 'The short one', { answers: asked.id }, asked)
    expect(own(below, f.group).recipients).toContain(f.worker)
  })
})

describe('an agent’s needs_human and line to a person go to the PM', () => {
  const assigned = () => {
    const f = fixture()
    const assignmentId = f.run({ type: 'work.assign', conversationId: f.group, agentId: f.worker }).result.assignmentId as string
    return Object.assign(f, { assignmentId })
  }

  it('opens no decision for the person; the status row to the PM carries the crew need', () => {
    const f = assigned()
    const sent = f.run({ type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'needs_human',
      result: 'Ship to everyone, or behind a flag?', ask: { personId: 'peer', ...choices } }, asAgent(f.worker))
    const row = sent.messages.find(m => (m.source as { status?: string } | null)?.status === 'needs_human')!
    expect(row.recipients).toEqual([f.pm])
    expect(row.text).not.toContain('Asked peer')
    expect(crewNeedOf(row.source)).toEqual({ agentId: f.worker, personIds: ['peer'], messageId: row.id, conversationId: f.group,
      question: 'Ship to everyone, or behind a flag?', options: choices.options, recommended: 0 })
    expect(sent.result.routedToPm).toMatch(/PM/)
    // Whom it waits on stays on the task for the board, which notifies nobody.
    expect(f.state.conversations.find(c => c.id === f.group)!.assignment!.askedOf).toBe('peer')
    // Without a person named, the needs_human is the PM's crew need as well.
    const plain = f.run({ type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'needs_human', result: 'Which database?' }, asAgent(f.worker))
    const plainRow = plain.messages.find(m => (m.source as { status?: string } | null)?.status === 'needs_human')!
    expect(crewNeedOf(plainRow.source)).toMatchObject({ agentId: f.worker, personIds: [], question: 'Which database?' })
  })

  // As a decision's were (until Swarm v4, 2026-11-10): the recommended option is one of them, and a default time gives the person
  // 15 minutes. What an older CLI still sends for a decision (unblocks, mustAgree) is taken and kept nowhere.
  it('refuses an ask that recommends no option of its own or defaults within 15 minutes, and keeps nothing of unblocks', () => {
    const f = assigned()
    const status = (ask: Record<string, unknown>) => ({ type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'needs_human',
      result: 'Ship how?', ask: { personId: 'peer', ...ask } })
    expect(commandSchema.safeParse(status({ ...choices, recommended: 2 })).success).toBe(false)
    expect(() => f.run(commandSchema.parse(status({ ...choices, defaultAt: new Date(1000 + 60_000).toISOString() })), asAgent(f.worker))).toThrow('15 minutes')
    const sent = f.run(commandSchema.parse(status({ ...choices, mustAgree: true, defaultAt: new Date(1000 + 3_600_000).toISOString() })), asAgent(f.worker))
    expect(JSON.stringify(sent.messages)).not.toContain('The release')
  })

  // Review of #3223, Important 1: routing is by who sends it, not whose assignment it is.
  it('routes another agent’s needs_human on the task to the PM as well, and keeps the PM’s own', () => {
    const f = assigned()
    const other = f.add(f.app.conversationId, 'other', false)
    f.run({ type: 'conversation.agent', conversationId: f.group, agentId: other, present: true, lead: false })
    const ask = (actor: Actor) => f.run({ type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'needs_human',
      result: 'Ship to everyone, or behind a flag?', ask: { personId: 'peer', ...choices } }, actor)
    const byOther = ask(asAgent(other))
    expect(byOther.messages.map(m => crewNeedOf(m.source)).filter(Boolean)).toEqual([expect.objectContaining({ agentId: other, personIds: ['peer'] })])
    expect(byOther.result.routedToPm).toMatch(/PM/)
    f.run({ type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'working', result: null }, asAgent(f.worker))
    const byPm = ask(asAgent(f.pm))
    expect(byPm.messages.filter(m => crewNeedOf(m.source))).toEqual([])
  })

  it('turns a worker’s line to a person into a crew need in the project chat, and refuses the PM’s private line (task #4558)', () => {
    const f = assigned()
    const byWorker = f.run({ type: 'person.tell', personId: 'peer', text: 'Look at the mockup in #12' }, asAgent(f.worker))
    // Nothing lands in the person's Buddy chats: the crew need is the command's only message.
    expect(byWorker.messages.filter(m => !crewNeedOf(m.source))).toEqual([])
    expect(needs(byWorker).map(m => [m.conversationId, m.recipients, crewNeedOf(m.source)!.personIds])).toEqual([[f.app.conversationId, [f.pm], ['peer']]])
    expect(byWorker.result.routedToPm).toMatch(/PM/)
    expect(() => f.run({ type: 'person.tell', personId: 'peer', text: 'Look at the mockup in #12' }, asAgent(f.pm)))
      .toThrow(expect.objectContaining({ code: 'PRIVATE_CHAT' }))
  })
})
