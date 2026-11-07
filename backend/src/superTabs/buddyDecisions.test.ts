import { describe, expect, it } from 'vitest'
import { openSwarmBuddyChat, swarmBuddyChatId } from './buddies.js'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { BUDDY_DECISION, BUDDY_SEND, SEND_OPTIONS } from './decisions.js'
import { createSuperTab, SuperTabError, type Actor, type Agent, type MessageDraft } from './model.js'

// Task #4525 (anh Dee, 11-07): everything waiting on a person shows in their Decisions, their own Buddy's questions
// included. A Buddy asks only its own owner, in its own chat; the server refuses everyone else.

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const asAgent = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'peer' })
/** The project's worker, on the Swarm owner's machine. */
const asWorker = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'owner' })
const NOW = 1_000_000
const question = { question: 'Keep the old flag?', options: ['Keep it', 'Drop it'], recommended: 1, unblocks: 'The cleanup' }

export function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let next = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { operationId: `op${next++}`, now: NOW,
      contribution: { machineOwnerId: 'owner', contributorId: actor.kind === 'person' ? actor.userId : 'owner' }, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  const app = run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
  const pm = run({ type: 'agent.add', conversationId: app.conversationId, harnessId: 'pm', machineId: 'machine', name: 'pm', lead: true, configuration }).result.agentId as string
  const worker = run({ type: 'agent.add', conversationId: app.conversationId, harnessId: 'worker', machineId: 'machine', name: 'worker', lead: false, configuration }).result.agentId as string
  const buddyOf = (personId: string) => {
    const member = state.people.find(p => p.id === personId)!
    const buddy = { id: `${personId}-buddy`, machineId: 'machine', harnessId: `${personId}-buddy-harness`, machineOwnerId: personId, contributorId: personId,
      membershipGeneration: member.generation, name: `${personId} Buddy`, configuration, buddyOf: { personId, generation: member.generation }, buddyScope: 'swarm' } as Agent
    state.agents.push(buddy)
    openSwarmBuddyChat(state, member).agentIds.push(buddy.id)
    return { id: buddy.id, chat: swarmBuddyChatId(member) }
  }
  const peerBuddy = buddyOf('peer'), ownerBuddy = buddyOf('owner')
  return { run, app, pm, worker, peerBuddy, ownerBuddy, get state() { return state } }
}

const refused = (act: () => unknown) => {
  try { act() } catch (error) { return (error as SuperTabError).code }
  throw new Error('expected a refusal')
}

describe('a Buddy asks its owner in Decisions', () => {
  it('opens a decision for its owner from its own chat, marked as a Buddy’s', () => {
    const f = fixture()
    const asked = f.run({ type: 'decision.ask', conversationId: f.peerBuddy.chat, personId: 'peer', questions: [question] }, asAgent(f.peerBuddy.id))
    expect(asked.decisions).toEqual([expect.objectContaining({ personId: 'peer', askerAgentId: f.peerBuddy.id, conversationId: f.peerBuddy.chat,
      question: 'Keep the old flag?', kind: BUDDY_DECISION, projectId: '' })])
    expect(asked.result.decisionIds).toEqual([asked.decisions![0]!.id])
  })

  it('names the project a question is about when it gives one its owner reads', () => {
    const f = fixture()
    const asked = f.run({ type: 'decision.ask', conversationId: f.peerBuddy.chat, personId: 'peer', projectId: f.app.projectId, questions: [question] }, asAgent(f.peerBuddy.id))
    expect(asked.decisions![0]!.projectId).toBe(f.app.projectId)
    expect(refused(() => f.run({ type: 'decision.ask', conversationId: f.peerBuddy.chat, personId: 'peer', projectId: 'nope', questions: [question] }, asAgent(f.peerBuddy.id)))).toBe('NOT_FOUND')
  })

  it('refuses a Buddy asking anyone but its own owner', () => {
    const f = fixture()
    expect(refused(() => f.run({ type: 'decision.ask', conversationId: f.peerBuddy.chat, personId: 'owner', questions: [question] }, asAgent(f.peerBuddy.id)))).toBe('BUDDY_ASKS_OWNER')
  })

  it('refuses a Buddy asking in another person’s Buddy chat', () => {
    const f = fixture()
    expect(refused(() => f.run({ type: 'decision.ask', conversationId: f.ownerBuddy.chat, personId: 'owner', questions: [question] }, asAgent(f.peerBuddy.id)))).toBe('BUDDY_FORBIDDEN')
  })

  it('refuses a project agent asking in a person’s Buddy chat, which it cannot even read', () => {
    const f = fixture()
    expect(refused(() => f.run({ type: 'decision.ask', conversationId: f.peerBuddy.chat, personId: 'peer', questions: [question] }, asWorker(f.worker)))).toBe('NOT_FOUND')
  })

  it('takes a default time, at least 15 minutes ahead', () => {
    const f = fixture()
    const defaultAt = new Date(NOW + 60 * 60_000).toISOString()
    const asked = f.run({ type: 'decision.ask', conversationId: f.peerBuddy.chat, personId: 'peer', questions: [{ ...question, defaultAt }] }, asAgent(f.peerBuddy.id))
    expect(asked.decisions![0]!.defaultAt).toBe(defaultAt)
  })
})

describe('a line waiting for its owner’s OK to send becomes a Send decision', () => {
  const send = { text: 'Drop the old flag from the CLI.', goal: 'No dead flags', scope: 'The CLI flag only', priority: 'normal' as const }

  it('stores the exact words with Send and Not now, for the project it goes to', () => {
    const f = fixture()
    const asked = f.run({ type: 'decision.ask', conversationId: f.peerBuddy.chat, personId: 'peer', questions: [{ send: { ...send, projectId: f.app.projectId } }] }, asAgent(f.peerBuddy.id))
    expect(asked.decisions).toEqual([expect.objectContaining({ kind: BUDDY_SEND, question: send.text, options: SEND_OPTIONS, recommended: 0,
      projectId: f.app.projectId, send: { ...send, projectId: f.app.projectId } })])
  })

  it('needs the project, and never takes a default time', () => {
    const f = fixture()
    expect(refused(() => f.run({ type: 'decision.ask', conversationId: f.peerBuddy.chat, personId: 'peer', questions: [{ send }] }, asAgent(f.peerBuddy.id)))).toBe('BUDDY_PROPOSE_PROJECT')
    expect(() => f.run({ type: 'decision.ask', conversationId: f.peerBuddy.chat, personId: 'peer',
      questions: [{ send: { ...send, projectId: f.app.projectId }, defaultAt: new Date(NOW + 60 * 60_000).toISOString() } as never] }, asAgent(f.peerBuddy.id))).toThrow()
  })

  it('is a Buddy’s alone', () => {
    const f = fixture()
    const group = f.run({ type: 'conversation.create', projectId: f.app.projectId, title: 'Copy', brief: '', checks: [] }).result.conversationId as string
    f.run({ type: 'conversation.agent', conversationId: group, agentId: f.worker, present: true, lead: false })
    expect(refused(() => f.run({ type: 'decision.ask', conversationId: group, personId: 'peer', questions: [{ send: { ...send, projectId: f.app.projectId } }] }, asWorker(f.worker)))).toBe('BUDDY_ONLY')
  })
})

describe('an answer settles a Buddy’s decision in Decisions and in its chat', () => {
  const send = { text: 'Drop the old flag from the CLI.', goal: 'No dead flags', scope: 'The CLI flag only', priority: 'normal' as const }
  type Fixture = ReturnType<typeof fixture>
  /** Peer's Buddy asks [ask] (a question, or one made from the fixture); the decision as the store reads it back for an answer. */
  function asked(ask: Record<string, unknown> | ((f: Fixture) => Record<string, unknown>) = question) {
    const f = fixture()
    const q = typeof ask === 'function' ? ask(f) : ask
    const draft = f.run({ type: 'decision.ask', conversationId: f.peerBuddy.chat, personId: 'peer', questions: [q] } as Command, asAgent(f.peerBuddy.id)).decisions![0]!
    const decision = { ...draft, answeredAt: null, createdAt: NOW, withdrawn: false, mustAgree: false, defaultAt: draft.defaultAt ? Date.parse(draft.defaultAt) : null }
    const generation = f.state.people.find(p => p.id === 'peer')!.generation
    /** Peer's message in their Buddy chat, as the store reads it for the Buddy's settle. */
    const said = (extra: Record<string, unknown> = {}) => ({ ownerAnswer: { id: 'said', conversationId: f.peerBuddy.chat, source: false, createdAt: NOW + 1, newest: true,
      author: { kind: 'person', id: 'peer', name: 'peer', membershipGeneration: generation }, ...extra } })
    const answer = (command: Record<string, unknown>, actor: Actor = peer, context: Record<string, unknown> = {}) =>
      f.run({ type: 'decision.answer', decisionId: decision.id, ...command } as Command, actor, { decision, ...context } as Partial<CommandContext>)
    return { f, decision, answer, said }
  }
  const asSend = (f: Fixture) => ({ send: { ...send, projectId: f.app.projectId } })
  const inChat = (f: Fixture, effects: { messages: MessageDraft[] }) => effects.messages.filter(m => m.conversationId === f.peerBuddy.chat)
  const inProject = (f: Fixture, effects: { messages: MessageDraft[] }) => effects.messages.filter(m => m.conversationId === f.app.conversationId)

  it('the owner’s answer in Decisions tells the Buddy in its chat, and tells no PM', () => {
    const { f, decision, answer } = asked()
    const done = answer({ choice: 0 })
    expect(done.decisionAnswer).toEqual({ id: decision.id, choice: 0, note: null })
    expect(inChat(f, done)).toEqual([expect.objectContaining({ recipients: [f.peerBuddy.id], text: 'Keep it — Keep the old flag?',
      source: { kind: 'decision-answered', decisionId: decision.id } })])
    expect(done.messages.filter(m => m.recipients.includes(f.pm))).toEqual([])
  })

  it('takes the owner’s own words as an answer', () => {
    const { f, answer } = asked()
    expect(inChat(f, answer({ note: 'Keep it a week' }))[0]!.text).toBe('Keep it a week — Keep the old flag?')
  })

  it('is never left to the PM, and applies its own default at its time', () => {
    const defaultAt = new Date(NOW + 60 * 60_000).toISOString()
    const { f, decision, answer } = asked({ ...question, defaultAt })
    expect(refused(() => answer({ delegate: true }))).toBe('INVALID_DECISION')
    const done = answer({ delegate: true }, peer, { defaulted: true, now: NOW + 2 * 60 * 60_000 })
    expect(done.decisionAnswer).toMatchObject({ id: decision.id, choice: 1, delegated: true, defaulted: true })
    expect(inChat(f, done)[0]!.text).toBe('Default applied: Drop it — Keep the old flag?')
  })

  it('Send posts exactly the stored words in the project chat as the owner, and tells the Buddy', () => {
    const { f, decision, answer } = asked(asSend)
    const done = answer({ choice: 0 })
    expect(inProject(f, done)).toEqual([expect.objectContaining({ text: send.text, recipients: [f.pm], author: expect.objectContaining({ kind: 'person', id: 'peer' }),
      source: expect.objectContaining({ kind: 'buddy-proposal', personId: 'peer', buddyId: f.peerBuddy.id, goal: send.goal, scope: send.scope, priority: send.priority }) })])
    expect(inChat(f, done)).toEqual([expect.objectContaining({ recipients: [f.peerBuddy.id] })])
    expect(done.decisionAnswer).toEqual({ id: decision.id, choice: 0, note: null })
  })

  it('Not now posts nothing to the project', () => {
    const { f, decision, answer } = asked(asSend)
    const done = answer({ choice: 1 })
    expect(inProject(f, done)).toEqual([])
    expect(done.decisionAnswer).toEqual({ id: decision.id, choice: 1, note: null })
  })

  it('the Buddy settles it from its owner’s answer in chat, naming their message', () => {
    const { f, decision, answer, said } = asked()
    const done = answer({ choice: 1, ownerMessageId: 'said' }, asAgent(f.peerBuddy.id), said())
    expect(done.decisionAnswer).toEqual({ id: decision.id, choice: 1, note: null })
    // Their words are in the chat already: no second line.
    expect(inChat(f, done)).toEqual([])
  })

  it('refuses the Buddy’s settle without its owner’s message after the question, and never leaves it to the PM', () => {
    const { f, answer, said } = asked()
    const buddy = asAgent(f.peerBuddy.id)
    expect(refused(() => answer({ choice: 1 }, buddy))).toBe('BUDDY_DECISION_UNASKED')
    expect(refused(() => answer({ choice: 1, ownerMessageId: 'said' }, buddy, said({ createdAt: NOW - 1 })))).toBe('BUDDY_DECISION_UNASKED')
    expect(refused(() => answer({ choice: 1, ownerMessageId: 'said' }, buddy, said({ source: true })))).toBe('BUDDY_DECISION_UNASKED')
    expect(refused(() => answer({ choice: 1, ownerMessageId: 'said' }, buddy, said({ author: { kind: 'agent', id: f.peerBuddy.id, name: 'b', membershipGeneration: 'x' } })))).toBe('BUDDY_DECISION_UNASKED')
    expect(refused(() => answer({ choice: 1, ownerMessageId: 'other' }, buddy, said()))).toBe('BUDDY_DECISION_UNASKED')
    expect(refused(() => answer({ delegate: true, ownerMessageId: 'said' }, buddy, said()))).toBe('INVALID_DECISION')
  })

  it('refuses another person’s Buddy, and a person who was not asked', () => {
    const { f, answer, said } = asked()
    expect(refused(() => answer({ choice: 1, ownerMessageId: 'said' }, asAgent(f.ownerBuddy.id), said()))).toBe('NOT_FOUND')
    expect(refused(() => answer({ choice: 1 }, owner))).toBe('NOT_FOUND')
  })

  it('the Buddy sends from its owner’s ok in chat only while that ok is their newest message or under an hour old', () => {
    const { f, answer, said } = asked(asSend)
    const buddy = asAgent(f.peerBuddy.id)
    expect(refused(() => answer({ choice: 0, ownerMessageId: 'said' }, buddy, { ...said({ newest: false }), now: NOW + 2 * 60 * 60_000 }))).toBe('PROPOSAL_STALE')
    const done = answer({ choice: 0, ownerMessageId: 'said' }, buddy, said())
    expect(inProject(f, done).map(m => m.text)).toEqual([send.text])
    // The owner hears it went, whatever the Buddy says.
    expect(inChat(f, done)).toHaveLength(1)
  })
})
