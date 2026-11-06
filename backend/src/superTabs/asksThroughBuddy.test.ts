import { describe, expect, it } from 'vitest'
import { openSwarmBuddyChat, swarmBuddyChatId } from './buddies.js'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { crewNeedOf } from './crewNeeds.js'
import { createSuperTab, type Actor, type Agent, type MessageDraft } from './model.js'

// Task #3826 (Phase 2 of the Buddy board spec, "When an agent needs a person"): in a switched project an agent asks the person
// directly, never through the PM: the question reaches their default Buddy and their Needs you list (their open decisions),
// always with a default and a time. A project not switched keeps "people talk only to the PM" (crewNeeds.test.ts).

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const asAgent = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'owner' })
const NOW = 1_000_000
const defaultAt = new Date(NOW + 60 * 60_000).toISOString()
const choices = { options: ['Behind a flag', 'To everyone'], recommended: 0, unblocks: 'The release' }

function fixture(switched: boolean) {
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
  if (switched) run({ type: 'project.boardMode', projectId: app.projectId, on: true })
  const add = (harnessId: string, lead: boolean) => run({ type: 'agent.add', conversationId: app.conversationId, harnessId, machineId: 'machine',
    name: harnessId, lead, configuration }).result.agentId as string
  const pm = add('pm', true)
  const worker = add('worker', false)
  const group = run({ type: 'conversation.create', projectId: app.projectId, title: 'Copy', brief: '', checks: [] }).result.conversationId as string
  run({ type: 'conversation.agent', conversationId: group, agentId: worker, present: true, lead: false })
  const assignmentId = run({ type: 'work.assign', conversationId: group, agentId: worker }).result.assignmentId as string
  // Peer's one Buddy, in their main Buddy chat: their default (buddies.ts defaultBuddy).
  const member = state.people.find(p => p.id === 'peer')!
  const buddy = { id: 'peer-buddy', machineId: 'machine', harnessId: 'peer-buddy-harness', machineOwnerId: 'peer', contributorId: 'peer',
    membershipGeneration: member.generation, name: 'Peer Buddy', configuration, buddyOf: { personId: 'peer', generation: member.generation }, buddyScope: 'swarm' } as Agent
  state.agents.push(buddy)
  openSwarmBuddyChat(state, member).agentIds.push(buddy.id)
  return { run, app, pm, worker, group, assignmentId, buddyChat: swarmBuddyChatId(member), get state() { return state } }
}

const needs = (effects: { messages: MessageDraft[] }) => effects.messages.filter(m => crewNeedOf(m.source))
const statusRow = (effects: { messages: MessageDraft[] }) => effects.messages.find(m => (m.source as { status?: string } | null)?.status === 'needs_human')!

describe('in a switched project, an agent’s ask reaches the person through their Buddy', () => {
  it('opens the person’s decision for a needs_human, writes the question to their default Buddy, and sends nothing to the PM', () => {
    const f = fixture(true)
    const sent = f.run({ type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'needs_human',
      result: 'Ship to everyone, or behind a flag?', ask: { personId: 'peer', ...choices, defaultAt } }, asAgent(f.worker))
    expect(sent.decisions).toEqual([expect.objectContaining({ personId: 'peer', question: 'Ship to everyone, or behind a flag?', defaultAt, recommended: 0 })])
    expect(needs(sent)).toEqual([])
    expect(sent.result.routedToPm).toBeUndefined()
    // The PM sees the task waiting on peer, and is not told the question.
    expect(statusRow(sent).recipients).not.toContain(f.pm)
    expect(f.state.conversations.find(c => c.id === f.group)!.assignment!.askedOf).toBe('peer')
    const line = sent.messages.filter(m => m.conversationId === f.buddyChat)
    expect(line).toEqual([expect.objectContaining({ recipients: ['peer-buddy'], buddyProject: f.app.projectId,
      source: { kind: 'decision-asked', decisionId: sent.decisions![0]!.id, projectId: f.app.projectId } })])
    expect(line[0]!.author).toMatchObject({ kind: 'agent', id: f.worker })
    expect(line[0]!.text).toContain('Ship to everyone, or behind a flag?')
    expect(line[0]!.text).toContain('Behind a flag (recommended)')
    expect(line[0]!.text).toContain(defaultAt)
    expect(sent.messages.filter(m => m.recipients.includes(f.pm))).toEqual([])
  })

  it('opens the person’s decisions for a decision.ask, one Buddy line each, and no crew need', () => {
    const f = fixture(true)
    const questions = [{ question: 'Ship how?', ...choices, defaultAt }, { question: 'Which copy?', options: ['Short', 'Long'], recommended: 1, unblocks: 'Copy', defaultAt }]
    const asked = f.run({ type: 'decision.ask', conversationId: f.group, personId: 'peer', questions }, asAgent(f.worker))
    expect(asked.decisions?.map(d => d.question)).toEqual(['Ship how?', 'Which copy?'])
    expect(asked.result.decisionIds).toHaveLength(2)
    expect(needs(asked)).toEqual([])
    expect(asked.result.routedToPm).toBeUndefined()
    expect(asked.messages.filter(m => m.conversationId === f.buddyChat).map(m => (m.source as { decisionId: string }).decisionId)).toEqual(asked.result.decisionIds)
  })

  it('tells the person that a required agreement never applies a default', () => {
    const f = fixture(true)
    const asked = f.run({ type: 'decision.ask', conversationId: f.group, personId: 'peer',
      questions: [{ question: 'Authorize the release?', ...choices, defaultAt, mustAgree: true }] }, asAgent(f.worker))
    const line = asked.messages.find(m => m.conversationId === f.buddyChat)!
    expect(line.text).toContain('No default applies')
    expect(line.text).toContain(defaultAt)
    expect(line.text).not.toContain('if not answered: Behind a flag')
  })

  it('refuses an ask with no default time, saying what to add', () => {
    const f = fixture(true)
    expect(() => f.run({ type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'needs_human',
      result: 'Ship how?', ask: { personId: 'peer', ...choices } }, asAgent(f.worker))).toThrow(/defaultAt/)
    expect(() => f.run({ type: 'decision.ask', conversationId: f.group, personId: 'peer', questions: [{ question: 'Ship how?', ...choices }] },
      asAgent(f.worker))).toThrow(/defaultAt/)
  })
})

describe('in a project not switched, an agent’s ask still goes to the PM', () => {
  it('opens no decision and writes nothing to the person’s Buddy', () => {
    const f = fixture(false)
    const sent = f.run({ type: 'work.status', conversationId: f.group, assignmentId: f.assignmentId, status: 'needs_human',
      result: 'Ship how?', ask: { personId: 'peer', ...choices, defaultAt } }, asAgent(f.worker))
    expect(sent.decisions ?? []).toEqual([])
    expect(statusRow(sent).recipients).toEqual([f.pm])
    expect(crewNeedOf(statusRow(sent).source)).toMatchObject({ agentId: f.worker, personIds: ['peer'], defaultAt })
    const asked = f.run({ type: 'decision.ask', conversationId: f.group, personId: 'peer', questions: [{ question: 'Ship how?', ...choices }] }, asAgent(f.worker))
    expect(asked.decisions ?? []).toEqual([])
    expect(needs(asked)).toHaveLength(1)
    expect([...sent.messages, ...asked.messages].filter(m => m.conversationId === f.buddyChat)).toEqual([])
  })
})
