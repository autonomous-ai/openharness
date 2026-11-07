import { describe, expect, it } from 'vitest'
import { openSwarmBuddyChat, swarmBuddyChatId } from './buddies.js'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { BUDDY_DECISION, BUDDY_SEND, SEND_OPTIONS } from './decisions.js'
import { createSuperTab, SuperTabError, type Actor, type Agent } from './model.js'

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
