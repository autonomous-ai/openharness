import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type SuperTabState } from './model.js'
import { projectOf } from './projects.js'
import { canChat, legacyAsks, steers, switched } from './boardRights.js'
import { openTasks } from './dispatch.js'
import { owedLines } from './inbox.js'
import { holdOf } from './pulse.js'

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

describe('a project\'s Board settings', () => {
  it('are set and cleared by the project owner or the Swarm owner, and read by every reader of the project', () => {
    const f = boardFixture()
    expect(switched(f.project())).toBe(false)
    f.run({ type: 'project.boardMode', projectId: f.app.projectId, on: true })
    f.run({ type: 'project.canChat', projectId: f.app.projectId, personId: 'c', granted: true }, swarmOwner)
    f.run({ type: 'project.decider', projectId: f.app.projectId, personId: 'd' })
    expect(f.project()).toMatchObject({ boardMode: true, canChat: ['c'], decider: 'd' })
    expect(switched(f.project())).toBe(true)
    const seen = visibleState(f.state, member).projects!.find(p => p.id === f.app.projectId)!
    expect(seen).toMatchObject({ boardMode: true, canChat: ['c'], decider: 'd' })

    f.run({ type: 'project.canChat', projectId: f.app.projectId, personId: 'c', granted: false })
    f.run({ type: 'project.decider', projectId: f.app.projectId, personId: null }, swarmOwner)
    f.run({ type: 'project.boardMode', projectId: f.app.projectId, on: false }, swarmOwner)
    const project = f.project()
    expect(project.boardMode).toBeUndefined()
    expect(project.canChat).toBeUndefined()
    expect(project.decider).toBeUndefined()
  })

  it('refuse a member, the PM and any other agent', () => {
    const f = boardFixture()
    const commands: Command[] = [
      { type: 'project.boardMode', projectId: f.app.projectId, on: true },
      { type: 'project.canChat', projectId: f.app.projectId, personId: 'd', granted: true },
      { type: 'project.decider', projectId: f.app.projectId, personId: 'd' },
    ]
    for (const command of commands) {
      for (const actor of [member, granted, f.asAgent(f.pm), f.asAgent(f.worker)]) {
        expect(() => f.run(command, actor), `${command.type} by ${JSON.stringify(actor)}`).toThrow(expect.objectContaining({ status: 403 }))
      }
    }
    expect(f.project().boardMode).toBeUndefined()
  })

  it('grant and name only people who read the project', () => {
    const f = boardFixture()
    expect(() => f.run({ type: 'project.canChat', projectId: f.app.projectId, personId: 'stranger', granted: true }))
      .toThrow(expect.objectContaining({ code: 'PERSON_UNKNOWN' }))
    expect(() => f.run({ type: 'project.decider', projectId: f.app.projectId, personId: 'stranger' }))
      .toThrow(expect.objectContaining({ code: 'PERSON_UNKNOWN' }))
  })

  it('give Can chat to the owners and the granted, and steering to the owners and the decider', () => {
    const f = boardFixture()
    f.run({ type: 'project.canChat', projectId: f.app.projectId, personId: 'c', granted: true })
    f.run({ type: 'project.decider', projectId: f.app.projectId, personId: 'd' })
    const project = f.project()
    expect(['owner', 'p', 'c', 'd'].map(id => canChat(f.state, project, id))).toEqual([true, true, true, false])
    expect(['owner', 'p', 'c', 'd'].map(id => steers(f.state, project, id))).toEqual([true, true, false, true])
    // A person who left the Swarm keeps nothing.
    f.state.people.splice(f.state.people.findIndex(person => person.id === 'c'), 1)
    expect(canChat(f.state, project, 'c')).toBe(false)
  })
})

describe('Board rights after a person leaves', () => {
  // Task #4216: owning a project and being listed in it end with the membership (#3073); Can chat and the decider's seat end too.
  const leaveAndReturn = (f: ReturnType<typeof boardFixture>, person: Actor & { kind: 'person' }) => {
    f.run({ type: 'member.remove', userId: person.userId }, swarmOwner)
    const invited = f.run({ type: 'invite.create', email: person.email, role: 'collaborator', conversationId: f.app.conversationId }, swarmOwner)
    f.run({ type: 'invite.accept', inviteId: invited.inviteId as string }, person)
  }

  it('gives a person who left and was invited back no Can chat and no decider seat', () => {
    const f = boardFixture()
    f.run({ type: 'project.boardMode', projectId: f.app.projectId, on: true })
    f.run({ type: 'project.canChat', projectId: f.app.projectId, personId: 'c', granted: true })
    f.run({ type: 'project.decider', projectId: f.app.projectId, personId: 'd' })
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
    f.run({ type: 'project.canChat', projectId: f.app.projectId, personId: 'c', granted: true })
    f.run({ type: 'project.decider', projectId: f.app.projectId, personId: 'c' })
    // Stored as a Swarm that lost them before the fix shipped: gone from the people, still named in the project.
    f.state.people.splice(f.state.people.findIndex(person => person.id === 'c'), 1)
    const invited = f.run({ type: 'invite.create', email: 'c@example.com', role: 'collaborator', conversationId: f.app.conversationId }, swarmOwner)
    f.run({ type: 'invite.accept', inviteId: invited.inviteId as string }, granted)
    expect(canChat(f.state, f.project(), 'c')).toBe(false)
    expect(steers(f.state, f.project(), 'c')).toBe(false)
  })

  it('keeps the rights of those who stay', () => {
    const f = boardFixture()
    f.run({ type: 'project.canChat', projectId: f.app.projectId, personId: 'c', granted: true })
    f.run({ type: 'project.decider', projectId: f.app.projectId, personId: 'c' })
    leaveAndReturn(f, member as Actor & { kind: 'person' })
    expect(f.project()).toMatchObject({ canChat: ['c'], decider: 'c' })
  })
})

describe('Can chat in a switched project', () => {
  const say = (conversationId: string, text = 'Hello') => ({ type: 'message.send', conversationId, text, replyTo: null, recipientIds: [] }) as Command
  const switchedFixture = () => {
    const f = boardFixture()
    f.run({ type: 'project.boardMode', projectId: f.app.projectId, on: true })
    f.run({ type: 'project.canChat', projectId: f.app.projectId, personId: 'c', granted: true })
    return f
  }

  it('lets the owners and the granted write in its chat, and refuses everyone else, whatever the client', () => {
    const f = switchedFixture()
    for (const actor of [projectOwner, swarmOwner, granted]) f.run(say(f.app.conversationId), actor)
    expect(() => f.run(say(f.app.conversationId), member)).toThrow(expect.objectContaining({ code: 'CHAT_NOT_ALLOWED', status: 403 }))
    // An edit writes too: a member's message from before the switch stays as it was.
    f.run({ type: 'project.boardMode', projectId: f.app.projectId, on: false })
    const before = f.run(say(f.app.conversationId, 'Before'), member).messageId as string
    f.run({ type: 'project.boardMode', projectId: f.app.projectId, on: true })
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
  const set = (f: ReturnType<typeof boardFixture>, conversationId: string, priority: 'P0' | 'P1' | 'P2' | 'P3', actor: Actor) =>
    f.run({ type: 'work.priority', conversationId, priority }, actor)
  const switchedFixture = () => {
    const f = boardFixture()
    f.run({ type: 'project.boardMode', projectId: f.app.projectId, on: true })
    f.run({ type: 'project.decider', projectId: f.app.projectId, personId: 'c' })
    return f
  }

  it('lets a member set P1-P3 on their own card, never P0 and never another\'s card', () => {
    const f = switchedFixture()
    const mine = card(f, 'd'), theirs = card(f, 'p')
    set(f, mine, 'P1', member)
    set(f, mine, 'P3', member)
    expect(() => set(f, mine, 'P0', member)).toThrow(expect.objectContaining({ code: 'PRIORITY_FORBIDDEN', status: 403 }))
    expect(() => set(f, theirs, 'P1', member)).toThrow(expect.objectContaining({ code: 'PRIORITY_FORBIDDEN' }))
    // A P0 the owners set stays theirs to lower.
    set(f, mine, 'P0', projectOwner)
    expect(() => set(f, mine, 'P2', member)).toThrow(expect.objectContaining({ code: 'PRIORITY_FORBIDDEN' }))
    expect(() => card(f, 'd', member, 'P0')).toThrow(expect.objectContaining({ code: 'PRIORITY_FORBIDDEN' }))
  })

  // The rule is for people: the PM's rights are today's (coordinatorOrPerson), untouched.
  it('lets the owners and the decider set any priority on any card', () => {
    const f = switchedFixture()
    const theirs = card(f, 'd')
    set(f, theirs, 'P0', projectOwner)
    set(f, theirs, 'P1', swarmOwner)
    set(f, theirs, 'P0', granted)
    card(f, 'd', granted, 'P0')
  })

  it('changes nothing in a project not switched', () => {
    const f = boardFixture()
    const theirs = card(f, 'p')
    set(f, theirs, 'P0', member)
    card(f, 'd', member, 'P0')
  })
})

describe('pause and resume', () => {
  const task = (f: ReturnType<typeof boardFixture>) => f.run({ type: 'conversation.create', projectId: f.app.projectId, title: 'Card', priority: 'P2',
    requesterId: 'd', task: { goal: 'Do it', changes: 'It', constraints: 'None', owns: ['x'] }, checks: [{ description: 'Done', independent: false }] }).conversationId as string
  const group = (f: ReturnType<typeof boardFixture>, id: string) => f.state.conversations.find(c => c.id === id)!
  const lines = (f: ReturnType<typeof boardFixture>, id: string) => f.posted.filter(m => m.conversationId === id).map(m => m.text)

  it('lets those who steer pause a task, with its reason and a line in it, and resume it', () => {
    const f = boardFixture()
    f.run({ type: 'project.decider', projectId: f.app.projectId, personId: 'c' })
    const id = task(f)
    f.run({ type: 'work.pause', conversationId: id, paused: true, reason: 'Wait for the release' }, granted)
    expect(group(f, id).paused).toMatchObject({ by: 'person:c', at: 1000, reason: 'Wait for the release' })
    expect(holdOf(group(f, id), '2026-11-06')).toEqual({ reason: expect.stringMatching(/paused/i) })
    f.run({ type: 'work.pause', conversationId: id, paused: false }, swarmOwner)
    expect(group(f, id).paused).toBeUndefined()
    expect(lines(f, id).join('\n')).toMatch(/paused[\s\S]*Wait for the release[\s\S]*resumed/i)
  })

  // Review of #3310 at c91dc2489 (task #3595): a pause reason was stored and posted as written. A person's text is redacted.
  it('redacts a credential in a pause reason, in the task and its line', () => {
    const f = boardFixture()
    const id = task(f)
    const token = ['ghp', 'Q7mZ2xK9pL4vR8nT1wB6yC3dF5hJ0aE2sG7u'].join('_')
    f.run({ type: 'work.pause', conversationId: id, paused: true, reason: `Rotate ${token} first` })
    expect(group(f, id).paused!.reason).toContain('[credential removed]')
    expect(JSON.stringify(f.state)).not.toContain(token)
    expect(lines(f, id).join('\n')).not.toContain(token)
  })

  it('refuses a member, the PM and any other agent, in every project', () => {
    const f = boardFixture()
    const id = task(f)
    for (const actor of [member, f.asAgent(f.pm), f.asAgent(f.worker)]) {
      expect(() => f.run({ type: 'work.pause', conversationId: id, paused: true }, actor), JSON.stringify(actor))
        .toThrow(expect.objectContaining({ status: 403 }))
    }
    f.run({ type: 'work.pause', conversationId: id, paused: true }, projectOwner)
    expect(() => f.run({ type: 'work.pause', conversationId: id, paused: false }, member)).toThrow(expect.objectContaining({ code: 'PAUSE_FORBIDDEN' }))
  })

  // Readycheck's review: a hand assignment, or a start into the task, went past the pause.
  it('refuses assigning or starting an agent on a paused task, whoever asks', () => {
    const f = boardFixture()
    const id = task(f)
    f.run({ type: 'work.pause', conversationId: id, paused: true }, projectOwner)
    for (const actor of [projectOwner, f.asAgent(f.pm)]) {
      expect(() => f.run({ type: 'work.assign', conversationId: id, agentId: f.worker }, actor), JSON.stringify(actor))
        .toThrow(expect.objectContaining({ code: 'TASK_PAUSED' }))
    }
    expect(() => f.run({ type: 'agent.start', request: { conversationId: id, machineId: 'machine', engine: 'claude', name: 'Helper', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }, routeDecisionId: 'route' }))
      .toThrow(expect.objectContaining({ code: 'TASK_PAUSED' }))
  })

  it('keeps a paused task from being handed out, until it is resumed', () => {
    const f = boardFixture()
    const id = task(f)
    expect(openTasks(f.state, f.app.projectId, 1000).map(g => g.id)).toContain(id)
    f.run({ type: 'work.pause', conversationId: id, paused: true }, projectOwner)
    expect(openTasks(f.state, f.app.projectId, 1000).map(g => g.id)).not.toContain(id)
    f.run({ type: 'work.pause', conversationId: id, paused: false }, projectOwner)
    expect(openTasks(f.state, f.app.projectId, 1000).map(g => g.id)).toContain(id)
  })
})

describe('the PM\'s owed asks in a switched project', () => {
  it('a person\'s message there owes the PM nothing', () => {
    const f = boardFixture()
    f.run({ type: 'project.canChat', projectId: f.app.projectId, personId: 'c', granted: true })
    const ask = () => f.run({ type: 'message.send', conversationId: f.app.conversationId, text: 'Can you look at this?', replyTo: null, recipientIds: [f.pm] }, granted)
    // Not switched: the ask is owed.
    ask()
    expect(owedLines(f.state, f.project(), 1000).join('\n')).toMatch(/Owed asks/)

    f.run({ type: 'project.boardMode', projectId: f.app.projectId, on: true })
    // The ask from before the switch stays until its card exists (legacyAsks); a new one is never owed.
    expect(owedLines(f.state, f.project(), 1000).join('\n')).toMatch(/before this project switched/)
    const before = f.state.conversations.find(c => c.id === f.app.conversationId)!.owed?.length ?? 0
    ask()
    expect(f.state.conversations.find(c => c.id === f.app.conversationId)!.owed?.length ?? 0).toBe(before)
  })
})

describe('switching a project on', () => {
  it('hands over every message still owed to its PM, oldest first, and keeps each until its card exists', () => {
    const f = boardFixture()
    const ask = (text: string, actor: Actor) => f.run({ type: 'message.send', conversationId: f.app.conversationId, text, replyTo: null, recipientIds: [f.pm] }, actor).messageId as string
    const first = ask('First', member), second = ask('Second', granted)
    expect(legacyAsks(f.state, f.project())).toEqual([
      { messageId: first, conversationId: f.app.conversationId, personId: 'd', at: 1000, thread: first },
      { messageId: second, conversationId: f.app.conversationId, personId: 'c', at: 1000, thread: second },
    ])
    f.run({ type: 'project.boardMode', projectId: f.app.projectId, on: true })
    // No card is made here yet (#3817 makes them): the asks stay, so nothing is dropped.
    expect(legacyAsks(f.state, f.project()).map(a => a.messageId)).toEqual([first, second])
    // Readycheck's review: until their cards exist, the PM still sees them, while a message after the switch owes nothing.
    const owed = owedLines(f.state, f.project(), 1000).join('\n')
    expect(owed).toContain(first)
    expect(owed).toContain(second)
    const after = ask('After the switch', projectOwner)
    expect(owedLines(f.state, f.project(), 1000).join('\n')).not.toContain(after)
  })
})
