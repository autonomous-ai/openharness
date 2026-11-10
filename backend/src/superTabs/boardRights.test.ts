import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type SuperTabState } from './model.js'
import { projectOf } from './projects.js'
import { canChat, steers } from './boardRights.js'

// Task #3819 (Phase 2 of docs/plans/2026-11-06-buddy-board-final-spec.md, Ken and anh Dee 11-06): a project's owner switches
// it to the Board way of working; in a switched project writing in its chat is a per-project Can chat right, and priority and
// pause follow roles, all on the server. A project not switched behaves exactly as today.
const swarmOwner: Actor = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const projectOwner: Actor = { kind: 'person', userId: 'p', email: 'p@example.com' }
const granted: Actor = { kind: 'person', userId: 'c', email: 'c@example.com' }
const member: Actor = { kind: 'person', userId: 'd', email: 'd@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }

export function boardFixture() {
  let state = createSuperTab('swarm', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
  state.people.push({ id: 'p', email: 'p@example.com', role: 'collaborator', generation: 'p1' },
    { id: 'c', email: 'c@example.com', role: 'collaborator', generation: 'c1' },
    { id: 'd', email: 'd@example.com', role: 'collaborator', generation: 'd1' })
  let next = 0
  const posted: Array<{ conversationId: string; text: string; recipients: readonly string[] }> = []
  const run = (command: Command, actor: Actor = projectOwner, context: Partial<CommandContext> = {}) => {
    const effect = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1000,
      contribution: { machineOwnerId: 'p', contributorId: actor.kind === 'person' ? actor.userId : 'p' }, ...context })
    state = effect.state
    posted.push(...effect.messages)
    return effect.result as Record<string, unknown>
  }
  const app = run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }) as { projectId: string; conversationId: string }
  const add = (harnessId: string, lead: boolean) => run({ type: 'agent.add', conversationId: app.conversationId, harnessId, machineId: 'machine',
    name: harnessId, lead, configuration }).agentId as string
  const pm = add('pm', true), worker = add('worker', false)
  const project = () => projectOf(state, app.projectId)
  const asAgent = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'p' })
  return { run, app, pm, worker, project, asAgent, posted, get state(): SuperTabState { return state } }
}

/** [f]'s project with Board settings stored as an owner set them before Swarm v4 retired the commands (2026-11-10). */
const board = (f: ReturnType<typeof boardFixture>, settings: { boardMode?: true; canChat?: string[]; decider?: string }) =>
  Object.assign(projectOf(f.state, f.app.projectId), settings)

describe('Board rights after a person leaves', () => {
  // Task #4216: owning a project and being listed in it end with the membership (#3073); Can chat and the decider's seat end too.
  const leaveAndReturn = (f: ReturnType<typeof boardFixture>, person: Actor & { kind: 'person' }) => {
    f.run({ type: 'member.remove', userId: person.userId }, swarmOwner)
    const invited = f.run({ type: 'invite.create', email: person.email, role: 'collaborator', conversationId: f.app.conversationId }, swarmOwner)
    f.run({ type: 'invite.accept', inviteId: invited.inviteId as string }, person)
  }

  it('gives a person who left and was invited back no Can chat and no decider seat', () => {
    const f = boardFixture()
    board(f, { boardMode: true })
    board(f, { canChat: ['c'] })
    board(f, { decider: 'd' })
    leaveAndReturn(f, granted as Actor & { kind: 'person' })
    leaveAndReturn(f, member as Actor & { kind: 'person' })
    expect(f.project().canChat).toBeUndefined()
    expect(f.project().decider).toBeUndefined()
    expect(canChat(f.state, f.project(), 'c')).toBe(false)
    expect(steers(f.state, f.project(), 'd')).toBe(false)
    expect(() => f.run({ type: 'message.send', conversationId: f.app.conversationId, text: 'Back', replyTo: null, recipientIds: [] }, granted))
      .toThrow(expect.objectContaining({ code: 'CHAT_NOT_ALLOWED' }))
  })

  it('clears a right kept from before this fix when its person comes back', () => {
    const f = boardFixture()
    board(f, { canChat: ['c'] })
    board(f, { decider: 'c' })
    // Stored as a Swarm that lost them before the fix shipped: gone from the people, still named in the project.
    f.state.people.splice(f.state.people.findIndex(person => person.id === 'c'), 1)
    const invited = f.run({ type: 'invite.create', email: 'c@example.com', role: 'collaborator', conversationId: f.app.conversationId }, swarmOwner)
    f.run({ type: 'invite.accept', inviteId: invited.inviteId as string }, granted)
    expect(canChat(f.state, f.project(), 'c')).toBe(false)
    expect(steers(f.state, f.project(), 'c')).toBe(false)
  })

  it('keeps the rights of those who stay', () => {
    const f = boardFixture()
    board(f, { canChat: ['c'] })
    board(f, { decider: 'c' })
    leaveAndReturn(f, member as Actor & { kind: 'person' })
    expect(f.project()).toMatchObject({ canChat: ['c'], decider: 'c' })
  })
})

describe('Can chat in a switched project', () => {
  const say = (conversationId: string, text = 'Hello') => ({ type: 'message.send', conversationId, text, replyTo: null, recipientIds: [] }) as Command
  const switchedFixture = () => {
    const f = boardFixture()
    board(f, { boardMode: true })
    board(f, { canChat: ['c'] })
    return f
  }

  it('lets the owners and the granted write in its chat, and refuses everyone else, whatever the client', () => {
    const f = switchedFixture()
    for (const actor of [projectOwner, swarmOwner, granted]) f.run(say(f.app.conversationId), actor)
    expect(() => f.run(say(f.app.conversationId), member)).toThrow(expect.objectContaining({ code: 'CHAT_NOT_ALLOWED', status: 403 }))
    // An edit writes too: a member's message from before the switch stays as it was.
    board(f, { boardMode: undefined })
    const before = f.run(say(f.app.conversationId, 'Before'), member).messageId as string
    board(f, { boardMode: true })
    expect(() => f.run({ type: 'message.edit', conversationId: f.app.conversationId, messageId: before, text: 'After' }, member))
      .toThrow(expect.objectContaining({ code: 'CHAT_NOT_ALLOWED' }))
    expect(() => f.run({ type: 'agent.add', conversationId: f.app.conversationId, harnessId: 'h2', machineId: 'machine', name: 'h2', lead: false,
      configuration, initialMessage: 'Start here' }, member)).toThrow(expect.objectContaining({ code: 'CHAT_NOT_ALLOWED' }))
  })

  it('leaves agents, and people in a task\'s own chat, writing as today', () => {
    const f = switchedFixture()
    f.run(say(f.app.conversationId, 'From the PM'), f.asAgent(f.pm))
    const task = f.run({ type: 'conversation.create', projectId: f.app.projectId, title: 'Task', priority: 'P2', requesterId: 'd',
      task: { goal: 'Do it', changes: 'It', constraints: 'None', owns: ['x'] }, checks: [{ description: 'Done', independent: false }] }).conversationId as string
    f.run(say(task, 'In the card chat'), member)
    // A person's own Buddy chat belongs to no project: writing there is never this right's to refuse.
    const buddyChat = f.run({ type: 'buddy.chat' }, member).conversationId as string
    f.run(say(buddyChat, 'To my Buddy'), member)
  })

  it('changes nothing in a project not switched', () => {
    const f = boardFixture()
    f.run(say(f.app.conversationId), member)
  })
})

describe('priority by role in a switched project', () => {
  const card = (f: ReturnType<typeof boardFixture>, requesterId: string, actor: Actor = projectOwner, priority: 'P0' | 'P1' | 'P2' | 'P3' = 'P2') =>
    f.run({ type: 'conversation.create', projectId: f.app.projectId, title: 'Card', priority, requesterId,
      task: { goal: 'Do it', changes: 'It', constraints: 'None', owns: ['x'] }, checks: [{ description: 'Done', independent: false }] }, actor).conversationId as string
  const switchedFixture = () => {
    const f = boardFixture()
    board(f, { boardMode: true })
    board(f, { decider: 'c' })
    return f
  }

  it('lets a member open their own card at P1-P3, never at P0', () => {
    const f = switchedFixture()
    card(f, 'd', member, 'P1')
    card(f, 'd', member, 'P3')
    expect(() => card(f, 'd', member, 'P0')).toThrow(expect.objectContaining({ code: 'PRIORITY_FORBIDDEN', status: 403 }))
  })

  // The rule is for people: the PM's rights are today's (coordinatorOrPerson), untouched.
  it('lets the owners and the decider open a card at any priority', () => {
    const f = switchedFixture()
    card(f, 'd', projectOwner, 'P0')
    card(f, 'd', swarmOwner, 'P0')
    card(f, 'd', granted, 'P0')
  })

  it('changes nothing in a project not switched', () => {
    const f = boardFixture()
    card(f, 'd', member, 'P0')
  })
})

// A pause stored before Swarm v4 (work.pause answers as retired, 2026-11-10) still holds its task.
describe('a paused task', () => {
  const paused = (f: ReturnType<typeof boardFixture>) => {
    const id = f.run({ type: 'conversation.create', projectId: f.app.projectId, title: 'Card', priority: 'P2', requesterId: 'd',
      task: { goal: 'Do it', changes: 'It', constraints: 'None', owns: ['x'] }, checks: [{ description: 'Done', independent: false }] }).conversationId as string
    const group = f.state.conversations.find(c => c.id === id)!
    group.paused = { by: 'person:c', at: 1000, reason: 'Wait for the release' }
    return group
  }


  // Readycheck's review: a start into the task went past the pause.
  it('refuses starting an agent on it, whoever asks', () => {
    const f = boardFixture()
    const group = paused(f)
    expect(() => f.run({ type: 'agent.start', request: { conversationId: group.id, machineId: 'machine', engine: 'claude', name: 'Helper', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }, routeDecisionId: 'route' }))
      .toThrow(expect.objectContaining({ code: 'TASK_PAUSED' }))
  })
})
