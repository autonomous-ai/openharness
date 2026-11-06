import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'
import { DEFAULT_DIGEST, digestDue, digestOf } from './digest.js'
import { projectOf } from './projects.js'
import { numberMessages } from './parts/commit.js'

// Quiet project chats (Dee, 2026-10-31): a report sets the coordinator's own lines on the project's status card and posts nothing,
// the server writes the card's lines itself and wakes nobody for them (task #3593), and every project gets the morning digest by default.

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const config: AgentConfiguration = { engine: 'codex', model: 'test-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const MINUTE = 60_000

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0, now = 1_000_000
  /** A command as the store runs it: numbered messages, then the work changes it made (store.ts execute). */
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now, operationId: `op-${++sequence}`, ...context })
    numberMessages(effects.state, effects.messages, now)
    state = effects.state
    return effects
  }
  const add = (harnessId: string, group = 'lead', lead = false) => run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId,
    name: harnessId, configuration: config, lead }, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  // A stored project, as every Swarm made since projects has.
  run({ type: 'project.cadence', projectId: 'lead', minutes: 5 })
  const lead = add('lead-harness', 'lead', true)
  const leadActor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
  const group = () => run({ type: 'conversation.create', title: 'Offline editing', brief: 'Save edits while offline.',
    checks: [{ description: 'Reconnect preserves the edits.', independent: true }] }).result.conversationId as string
  return {
    run, add, group, lead, leadActor,
    get state(): SuperTabState { return state },
    get now() { return now },
    tick(ms: number) { now += ms },
  }
}

const report = (text: string | null, through: Record<string, number> = {}): Command =>
  commandSchema.parse({ type: 'project.report', projectId: 'lead', through, text })

describe('the project status card', () => {
  it('is set by a report, replacing the one before, and posts nothing to the chat', () => {
    const f = fixture()
    const first = f.run(report('Offline editing: PR #12 waiting on CI'), f.leadActor)
    expect(first.messages).toEqual([])
    expect(projectOf(f.state, 'lead').status).toEqual({ text: 'Offline editing: PR #12 waiting on CI', at: new Date(f.now).toISOString(), by: f.lead })
    f.tick(MINUTE)
    expect(f.run(report('Offline editing: merged'), f.leadActor).messages).toEqual([])
    expect(projectOf(f.state, 'lead').status).toEqual({ text: 'Offline editing: merged', at: new Date(f.now).toISOString(), by: f.lead })
    // No text only acknowledges: the card stays.
    expect(f.run(report(null), f.leadActor).messages).toEqual([])
    expect(projectOf(f.state, 'lead').status!.text).toBe('Offline editing: merged')
  })

  it('holds up to 2,000 characters and refuses a longer card', () => {
    expect(() => report('x'.repeat(2_000))).not.toThrow()
    expect(() => report('x'.repeat(2_001))).toThrow(/under 2,000 characters/)
  })

  it('is written only by the coordinator: never another agent of the project, nor a person', () => {
    const f = fixture(), engineer = f.add('engineer')
    const as: Actor = { kind: 'agent', agentId: engineer, machineOwnerId: 'host-owner' }
    expect(() => f.run(report('Mine now'), as)).toThrow(expect.objectContaining({ code: 'COORDINATOR_REQUIRED' }))
    expect(() => f.run(report('Mine now'), owner)).toThrow(expect.objectContaining({ code: 'COORDINATOR_REQUIRED' }))
    expect(projectOf(f.state, 'lead').status).toBeUndefined()
  })

  it('is refused alike to another project\'s coordinator, which writes only its own card', () => {
    const f = fixture()
    const created = f.run({ type: 'project.create', name: 'Firmware', visibility: 'public', brief: 'Build the firmware.' } as Command)
    const other = f.add('other-lead', created.result.conversationId as string, true)
    const as: Actor = { kind: 'agent', agentId: other, machineOwnerId: 'host-owner' }
    expect(() => f.run(report('Firmware took over'), as)).toThrow(expect.objectContaining({ code: 'NOT_FOUND', message: 'This project is unavailable.' }))
    expect(() => f.run(commandSchema.parse({ type: 'project.report', projectId: 'no-such-project', through: {}, text: 'x' }), as))
      .toThrow(expect.objectContaining({ code: 'NOT_FOUND', message: 'This project is unavailable.' }))
    f.run(commandSchema.parse({ type: 'project.report', projectId: created.result.projectId, through: {}, text: 'Firmware: flashing' }), as)
    expect(projectOf(f.state, created.result.projectId as string).status!.text).toBe('Firmware: flashing')
    expect(projectOf(f.state, 'lead').status).toBeUndefined()
  })

  it('is read exactly by those who read the project chat', () => {
    const f = fixture()
    const invited = f.run({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
    f.run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
    f.run(report('Offline editing: building'), f.leadActor)
    const card = (actor: Actor, state = f.state) => visibleState(state, actor).projects?.find(p => p.id === 'lead')?.status
    expect(card(owner)!.text).toBe('Offline editing: building')
    expect(card(peer)!.text).toBe('Offline editing: building')
    // Made private without them, the project and its card leave their reads together.
    f.run({ type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: [] })
    expect(visibleState(f.state, peer).projects?.some(p => p.id === 'lead')).toBe(false)
    expect(JSON.stringify(visibleState(f.state, peer))).not.toContain('Offline editing: building')
    expect(card(owner)!.text).toBe('Offline editing: building')
    // A read whose state lacks the chat shows no card rather than guess.
    const withoutChat = { ...f.state, conversations: f.state.conversations.filter(c => c.id !== 'lead') }
    expect(visibleState(withoutChat, owner).projects?.find(p => p.id === 'lead')).not.toHaveProperty('status')
  })
})

describe('no card wake-up for the coordinator (#3593)', () => {
  // The server writes the card (statusCard.ts), so a work group's change marks nothing for the coordinator to read.
  it('marks no work group for a report, whatever changes in it', () => {
    const f = fixture(), group = f.group()
    const engineer = f.add('engineer', group)
    const as: Actor = { kind: 'agent', agentId: engineer, machineOwnerId: 'host-owner' }
    const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: engineer }).result.assignmentId as string
    f.tick(5 * MINUTE)
    f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'review', result: 'PR #7' }, as)
    f.run({ type: 'conversation.merged', conversationId: group, pullRequestUrl: 'https://github.com/example/app/pull/7' })
    f.tick(15 * MINUTE)
    expect(f.state.conversations.find(c => c.id === group)!.reportSeq).toBeUndefined()
    expect(projectOf(f.state, 'lead').progress).toBeUndefined()
  })

  it('lets an archived group go quiet at once, with no report to wait for', () => {
    const f = fixture(), group = f.group()
    f.run({ type: 'conversation.archive', conversationId: group, archived: true })
    expect(f.state.conversations.find(c => c.id === group)!.dormant).toBe(true)
  })

  it('still takes an older host\'s report with through, and keeps its text as the coordinator\'s own lines', () => {
    const f = fixture(), group = f.group()
    f.run(report('Freeze starts Friday.', { [group]: 1 }), f.leadActor)
    expect(projectOf(f.state, 'lead').status!.text).toBe('Freeze starts Friday.')
    expect(JSON.stringify(visibleState(f.state, owner))).toContain('Freeze starts Friday.')
  })
})

describe('the morning digest by default', () => {
  /** 14:00 on 31 October in Vietnam (UTC+7). */
  const AFTERNOON = Date.UTC(2026, 9, 31, 7, 0)
  const NEXT_EIGHT = Date.UTC(2026, 10, 1, 1, 0)

  it('is 08:00 Vietnam time for a project that never set one, first sent in the hour from 08:00', () => {
    const f = fixture(), project = projectOf(f.state, 'lead')
    expect(project.digest).toBeUndefined()
    expect(DEFAULT_DIGEST).toEqual({ time: '08:00', timeZone: 'Asia/Ho_Chi_Minh' })
    expect(digestOf(project)).toEqual(DEFAULT_DIGEST)
    // A release in the afternoon sends nothing at once; the first comes the next morning.
    expect(digestDue(project, AFTERNOON)).toBeNull()
    expect(digestDue(project, NEXT_EIGHT - 1)).toBeNull()
    expect(digestDue(project, NEXT_EIGHT)).toBe('2026-11-01')
    expect(digestDue(project, NEXT_EIGHT + 59 * MINUTE)).toBe('2026-11-01')
    expect(digestDue(project, NEXT_EIGHT + 60 * MINUTE)).toBeNull()
    // Once sent it is stored like any digest, and the next day's comes whenever the coordinator polls after 08:00.
    project.digest = { ...digestOf(project)!, lastOn: '2026-11-01', lastAt: NEXT_EIGHT }
    expect(digestDue(project, NEXT_EIGHT + 24 * 60 * MINUTE + 5 * 60 * MINUTE)).toBe('2026-11-02')
  })

  it('stays off once a person turns it off, and comes back when they set a time', () => {
    const f = fixture()
    f.run({ type: 'project.digest', projectId: 'lead', time: null, timeZone: 'Asia/Ho_Chi_Minh' })
    const project = () => projectOf(f.state, 'lead')
    expect(project().digest).toBeUndefined()
    expect(project().digestOff).toBe(true)
    expect(digestOf(project())).toBeUndefined()
    expect(digestDue(project(), NEXT_EIGHT)).toBeNull()
    f.run({ type: 'project.digest', projectId: 'lead', time: '09:00', timeZone: 'Europe/Paris' })
    expect(project().digestOff).toBeUndefined()
    expect(project().digest).toMatchObject({ time: '09:00', timeZone: 'Europe/Paris' })
  })

  it('is on for a new project from its creation', () => {
    const f = fixture()
    const created = f.run({ type: 'project.create', name: 'Firmware', visibility: 'public', brief: 'Build the firmware.' } as Command)
    const project = projectOf(f.state, created.result.projectId as string)
    expect(digestOf(project)).toEqual(DEFAULT_DIGEST)
    expect(digestDue(project, NEXT_EIGHT)).toBe('2026-11-01')
  })
})
