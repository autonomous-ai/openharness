import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'
import type { DecisionTarget } from './decisions.js'

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

  it('refuses a question from anyone but the project\'s Lead, to someone outside the Swarm, or with a recommendation that is not an option', () => {
    const s = swarm()
    const ask = (actor: Actor, personId = 'peer', recommended = 0) =>
      () => s.run({ type: 'decision.ask', conversationId: s.group, personId, questions: [question('Ship how?', recommended)] }, actor)
    expect(ask(asAgent(s.worker))).toThrow('Lead')
    expect(ask(owner)).toThrow('Lead')
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
})

describe('answering a decision', () => {
  const open = (s: ReturnType<typeof swarm>, overrides: Partial<DecisionTarget> = {}): DecisionTarget => ({ id: 'decision-1', personId: 'peer',
    conversationId: s.group, askerAgentId: s.worker, question: 'Ship how?', options: ['Behind a flag', 'To everyone'], answeredAt: null, ...overrides })

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
    const hidden = s.run({ type: 'conversation.create', title: 'Owner only', brief: '', checks: [], audience: { personIds: ['owner'] } }).result.conversationId as string
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

describe('hands-on requests (collaboration protocol)', () => {
  const plugIn = { request: 'Plug in the voice device', steps: ['Plug the device into the Mac Studio', 'Press its button and say "hello"'],
    next: 'I run the voice test on it' }
  const ask = (s: ReturnType<typeof swarm>, actor: Actor, personId = 'peer', conversationId = s.group) =>
    s.run({ type: 'handsOn.ask', conversationId, personId, ...plugIn }, actor)

  it('lets the Lead ask one person for physical steps, with what happens next, and pings nobody in the transcript', () => {
    const s = swarm()
    const asked = ask(s, asAgent(s.lead))
    expect(asked.decisions).toEqual([expect.objectContaining({ kind: 'handsOn', conversationId: s.group, projectId: 'lead', personId: 'peer',
      askerAgentId: s.lead, assignmentId: null, question: plugIn.request, steps: plugIn.steps, unblocks: plugIn.next, options: [], recommended: 0 })])
    expect(asked.messages).toEqual([])
    expect(asked.result.requestId).toBe(asked.decisions![0]!.id)
  })

  it('lets the assigned worker ask on its own task, and nobody else but the Lead', () => {
    const s = swarm()
    expect(ask(s, asAgent(s.worker)).decisions![0]).toMatchObject({ askerAgentId: s.worker, assignmentId: s.assignmentId })
    const other = s.run({ type: 'conversation.create', title: 'Other', brief: 'Other', checks: [] }).result.conversationId as string
    expect(() => ask(s, asAgent(s.worker), 'peer', other)).toThrow('Only the project’s Lead, or the worker on its own task, asks for hands-on help.')
    expect(() => ask(s, owner)).toThrow('Only the project’s Lead, or the worker on its own task, asks for hands-on help.')
    expect(() => ask(s, asAgent(s.lead), 'stranger')).toThrow('person in this Swarm')
    const hidden = s.run({ type: 'conversation.create', title: 'Owner only', brief: '', checks: [], audience: { personIds: ['owner'] } }).result.conversationId as string
    expect(() => ask(s, asAgent(s.lead), 'peer', hidden)).toThrow('peer@example.com cannot read this conversation.')
  })

  it('takes one to ten short steps', () => {
    const s = swarm()
    const parse = (steps: string[]) => commandSchema.safeParse({ type: 'handsOn.ask', conversationId: s.group, personId: 'peer', ...plugIn, steps }).success
    expect(parse([])).toBe(false)
    expect(parse(Array.from({ length: 11 }, (_, i) => `Step ${i}`))).toBe(false)
    expect(parse(['x'.repeat(301)])).toBe(false)
    expect(parse(['Plug it in'])).toBe(true)
  })

  const open = (s: ReturnType<typeof swarm>, overrides: Partial<DecisionTarget> = {}): DecisionTarget => ({ id: 'request-1', kind: 'handsOn', personId: 'peer',
    conversationId: s.group, askerAgentId: s.worker, question: plugIn.request, options: [], answeredAt: null, ...overrides })
  const answer = (s: ReturnType<typeof swarm>, body: Record<string, unknown>, actor: Actor = peer, target: DecisionTarget | null = open(s)) =>
    s.run({ type: 'handsOn.answer', requestId: 'request-1', ...body } as Command, actor, target ? { decision: target } : {})

  it('records done, can’t now with until and a note, or a note, and tells the asker and the Lead with a notice carrying none of it', () => {
    const s = swarm()
    const done = answer(s, { answer: 'done' })
    expect(done.handsOnAnswer).toEqual({ id: 'request-1', answer: 'done', note: null, until: null })
    expect(done.messages).toEqual([expect.objectContaining({ conversationId: s.group, recipients: [s.worker, s.lead],
      source: { kind: 'agent-only', handsOnId: 'request-1' } })])
    expect(done.result.requestId).toBe('request-1')
    const later = answer(s, { answer: 'cant', until: '2026-10-27T14:00:00.000Z', note: 'In a meeting' })
    expect(later.handsOnAnswer).toEqual({ id: 'request-1', answer: 'cant', note: 'In a meeting', until: Date.parse('2026-10-27T14:00:00.000Z') })
    const noted = answer(s, { answer: 'note', note: 'The device is at home today' })
    expect(noted.handsOnAnswer).toMatchObject({ answer: 'note', note: 'The device is at home today' })
    for (const each of [done, later, noted]) {
      for (const text of ['voice device', 'In a meeting', 'at home']) expect(each.messages[0]!.text).not.toContain(text)
    }
  })

  it('takes a note with a note answer, and until only with can’t now', () => {
    const s = swarm()
    expect(() => answer(s, { answer: 'note' })).toThrow('Write the note.')
    expect(() => answer(s, { answer: 'done', until: '2026-10-27T14:00:00.000Z' })).toThrow('Only “can’t now” takes an until.')
  })

  it('takes an answer only from the person asked, once, and never through a decision answer', () => {
    const s = swarm()
    expect(() => answer(s, { answer: 'done' }, owner)).toThrow('unavailable')
    expect(() => answer(s, { answer: 'done' }, peer, null)).toThrow('unavailable')
    expect(() => answer(s, { answer: 'done' }, peer, open(s, { answeredAt: 5 }))).toThrow('already answered')
    // A decision is not a hands-on request, nor the other way round.
    expect(() => answer(s, { answer: 'done' }, peer, open(s, { kind: undefined, options: ['A', 'B'] }))).toThrow('unavailable')
    expect(() => s.run({ type: 'decision.answer', decisionId: 'request-1', choice: 0 }, peer, { decision: open(s) })).toThrow('unavailable')
  })
})
