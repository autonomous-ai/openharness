import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'
import { noteWorkChanges, projectUpdateRequest, WAKE_GAP_MS } from './projectUpdates.js'
import { DEFAULT_DIGEST, defaultDigest, digestDue } from './digest.js'
import { projectOf } from './projects.js'
import { numberMessages } from './parts/commit.js'

// Quiet project chats (Dee, 2026-10-31): a report sets the project's status card and posts nothing, only a work group's
// state wakes the coordinator, at most once every 15 minutes, and every project gets the morning digest by default.

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const config: AgentConfiguration = { engine: 'codex', model: 'test-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const MINUTE = 60_000

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0, now = 1_000_000
  /** A command as the store runs it: numbered messages, then the work changes it made (store.ts execute). */
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const before = state
    const effects = applyCommand(state, actor, command, { now, operationId: `op-${++sequence}`, ...context })
    numberMessages(effects.state, effects.messages, now)
    noteWorkChanges(before, effects.state, now)
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

describe('the coordinator\'s scheduled wake-up', () => {
  const lead = (f: ReturnType<typeof fixture>) => f.state.agents.find(a => a.id === f.lead)!
  /** The coordinator answers the request it got: everything summarized through what it read. */
  const answer = (f: ReturnType<typeof fixture>, request: NonNullable<ReturnType<typeof projectUpdateRequest>>) => {
    const progress = projectOf(f.state, 'lead').progress!
    progress.requested = { ...progress.requested, ...request.source!.through as Record<string, number> }
    progress.requestedAt = f.now
    f.run(report('Card', request.source!.through as Record<string, number>), f.leadActor)
  }

  it('is never asked for by an ordinary message or a progress note', () => {
    const f = fixture(), group = f.group()
    const engineer = f.add('engineer', group)
    const as: Actor = { kind: 'agent', agentId: engineer, machineOwnerId: 'host-owner' }
    const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: engineer }).result.assignmentId as string
    answer(f, projectUpdateRequest(f.state, lead(f), f.now)!)
    f.tick(WAKE_GAP_MS)
    f.run({ type: 'message.send', conversationId: group, text: 'Halfway there.', replyTo: null, recipientIds: [] }, as)
    f.run({ type: 'message.send', conversationId: group, text: 'How is it going?', replyTo: null, recipientIds: [engineer] }, owner)
    // Still working: a progress note changes no state.
    f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'working', result: 'Tests written' }, as)
    f.tick(WAKE_GAP_MS)
    expect(projectUpdateRequest(f.state, lead(f), f.now)).toBeNull()
    // Ready for review is a change.
    f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'review', result: 'PR #7' }, as)
    expect(projectUpdateRequest(f.state, lead(f), f.now)?.source).toMatchObject({ kind: 'update-request', through: { [group]: expect.any(Number) } })
  })

  it('is asked for by a work group\'s change of state, at most once every 15 minutes', () => {
    const f = fixture()
    // A new group is a change: the first wake-up comes at once.
    const a = f.group()
    const first = projectUpdateRequest(f.state, lead(f), f.now)
    expect(first?.source).toMatchObject({ kind: 'update-request' })
    answer(f, first!)
    // Two changes within 15 minutes wake it once.
    f.tick(MINUTE)
    const b = f.group()
    expect(projectUpdateRequest(f.state, lead(f), f.now)).toBeNull()
    f.tick(5 * MINUTE)
    f.run({ type: 'conversation.merged', conversationId: a, pullRequestUrl: 'https://github.com/example/app/pull/7' })
    expect(projectUpdateRequest(f.state, lead(f), f.now)).toBeNull()
    f.tick(WAKE_GAP_MS - 6 * MINUTE - 1)
    expect(projectUpdateRequest(f.state, lead(f), f.now)).toBeNull()
    f.tick(1)
    const second = projectUpdateRequest(f.state, lead(f), f.now)!
    expect(Object.keys(second.source!.through as object).sort()).toEqual([a, b].sort())
    expect(second.text).toContain('status card')
    answer(f, second)
    f.tick(WAKE_GAP_MS)
    expect(projectUpdateRequest(f.state, lead(f), f.now)).toBeNull()
  })

  it('keeps its 15 minutes whatever cadence an older client set', () => {
    const f = fixture()
    f.run({ type: 'project.cadence', projectId: 'lead', minutes: 1 })
    answer(f, (f.group(), projectUpdateRequest(f.state, lead(f), f.now)!))
    f.tick(MINUTE)
    f.group()
    expect(projectUpdateRequest(f.state, lead(f), f.now)).toBeNull()
    f.tick(WAKE_GAP_MS - MINUTE)
    expect(projectUpdateRequest(f.state, lead(f), f.now)).not.toBeNull()
  })
})

describe('the morning digest by default', () => {
  /** 14:00 on 31 October in Vietnam (UTC+7). */
  const AFTERNOON = Date.UTC(2026, 9, 31, 7, 0)
  const NEXT_EIGHT = Date.UTC(2026, 10, 1, 1, 0)

  it('is 08:00 Vietnam time for a project without one, starting tomorrow when today\'s has passed', () => {
    const f = fixture(), project = projectOf(f.state, 'lead')
    expect(project.digest).toBeUndefined()
    expect(defaultDigest(project, AFTERNOON)).toBe(true)
    expect(project.digest).toEqual({ ...DEFAULT_DIGEST, lastOn: '2026-10-31' })
    expect(DEFAULT_DIGEST).toEqual({ time: '08:00', timeZone: 'Asia/Ho_Chi_Minh' })
    expect(digestDue(project, AFTERNOON + MINUTE)).toBeNull()
    expect(digestDue(project, NEXT_EIGHT)).toBe('2026-11-01')
    // Filled in once: a project with a digest keeps its own.
    expect(defaultDigest(project, NEXT_EIGHT)).toBe(false)
  })

  it('comes the same morning for a project set up before 08:00', () => {
    const f = fixture(), project = projectOf(f.state, 'lead')
    defaultDigest(project, NEXT_EIGHT - 60 * MINUTE)
    expect(digestDue(project, NEXT_EIGHT)).toBe('2026-11-01')
  })

  it('stays off once a person turns it off, and comes back when they set a time', () => {
    const f = fixture()
    f.run({ type: 'project.digest', projectId: 'lead', time: null, timeZone: 'Asia/Ho_Chi_Minh' })
    const project = () => projectOf(f.state, 'lead')
    expect(project().digest).toBeUndefined()
    expect(project().digestOff).toBe(true)
    expect(defaultDigest(project(), AFTERNOON)).toBe(false)
    expect(project().digest).toBeUndefined()
    f.run({ type: 'project.digest', projectId: 'lead', time: '09:00', timeZone: 'Europe/Paris' })
    expect(project().digestOff).toBeUndefined()
    expect(project().digest).toMatchObject({ time: '09:00', timeZone: 'Europe/Paris' })
  })

  it('is on for a new project from its creation', () => {
    const f = fixture()
    const created = f.run({ type: 'project.create', name: 'Firmware', visibility: 'public', brief: 'Build the firmware.' } as Command)
    expect(projectOf(f.state, created.result.projectId as string).digest).toMatchObject(DEFAULT_DIGEST)
  })
})
