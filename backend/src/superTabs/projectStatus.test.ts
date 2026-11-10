import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'
import { projectOf } from './projects.js'
import { numberMessages } from './parts/commit.js'
import { storedAssignment } from './storedWork.test-support.js'

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
    expect(projectOf(f.state, 'lead').status).toEqual({ text: 'Offline editing: PR #12 waiting on CI', at: new Date(f.now).toISOString(), by: f.lead, own: true })
    f.tick(MINUTE)
    expect(f.run(report('Offline editing: merged'), f.leadActor).messages).toEqual([])
    expect(projectOf(f.state, 'lead').status).toEqual({ text: 'Offline editing: merged', at: new Date(f.now).toISOString(), by: f.lead, own: true })
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

  // Swarm v4 (2026-11-10): a task is the project's GitHub issue, so the server writes no task's line on the card. A task stored
  // before v4, still working, shows nothing there: the card is the coordinator's own lines alone, as last reported.
  it('is the coordinator\'s own lines alone: a task stored before v4 adds none', () => {
    const f = fixture(), group = f.group(), dev = f.add('dev', group)
    storedAssignment(f.state, group, dev, f.now)
    f.run(report('Freeze starts Friday.'), f.leadActor)
    expect(visibleState(f.state, owner).projects?.find(p => p.id === 'lead')?.status?.text).toBe('Freeze starts Friday.')
    expect(f.state.conversations.find(c => c.id === group)).not.toHaveProperty('statusLine')
  })
})

describe('no card wake-up for the coordinator (#3593)', () => {
  // The server writes the card (statusCard.ts), so a work group's change marks nothing for the coordinator to read.
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
