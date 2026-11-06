import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type SuperTabState } from './model.js'
import { projectOf } from './projects.js'
import { canChat, legacyAsks, steers, switched } from './boardRights.js'
import { openTasks } from './dispatch.js'
import { PM_SCHEDULE_TEXT, pmScheduleText, sweepDue } from './pmSchedule.js'
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

  it('keeps a paused task from being handed out or chased, until it is resumed', () => {
    const f = boardFixture()
    const id = task(f)
    expect(openTasks(f.state, f.app.projectId, 1000).map(g => g.id)).toContain(id)
    expect(sweepDue(f.state, f.app.projectId, 1000)).toBe(true)
    f.run({ type: 'work.pause', conversationId: id, paused: true }, projectOwner)
    expect(openTasks(f.state, f.app.projectId, 1000).map(g => g.id)).not.toContain(id)
    expect(sweepDue(f.state, f.app.projectId, 1000)).toBe(false)
    f.run({ type: 'work.pause', conversationId: id, paused: false }, projectOwner)
    expect(openTasks(f.state, f.app.projectId, 1000).map(g => g.id)).toContain(id)
  })
})

describe('the PM text in a switched project', () => {
  const INBOX_LINE = /Answer each person's message once|Your inbox lists every unanswered message/

  it('drops the inbox lines, and a person\'s message there owes the PM nothing', () => {
    const f = boardFixture()
    f.run({ type: 'project.canChat', projectId: f.app.projectId, personId: 'c', granted: true })
    const ask = () => f.run({ type: 'message.send', conversationId: f.app.conversationId, text: 'Can you look at this?', replyTo: null, recipientIds: [f.pm] }, granted)
    // Not switched: today's text, and the ask is owed.
    expect(pmScheduleText(f.project())).toBe(PM_SCHEDULE_TEXT)
    ask()
    expect(owedLines(f.state, f.project(), 1000).join('\n')).toMatch(/Owed asks/)

    f.run({ type: 'project.boardMode', projectId: f.app.projectId, on: true })
    const text = pmScheduleText(f.project())
    expect(PM_SCHEDULE_TEXT).toMatch(INBOX_LINE)
    expect(text).not.toMatch(INBOX_LINE)
    expect(text).toContain('Keep a standing crew')
    expect(owedLines(f.state, f.project(), 1000).join('\n')).not.toMatch(/Owed asks/)
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
  })
})
