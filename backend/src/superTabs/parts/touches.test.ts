import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from '../commands.js'
import { createSuperTab, type Actor } from '../model.js'
import { touchesFor } from './touches.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const config = { engine: 'codex', model: 'm', effort: 'high', contextWindow: null, engineVersion: null }

/** A Swarm with a Lead and two workers, each with its own assigned group. */
function swarm() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let n = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const before = state
    const effects = applyCommand(state, actor, command, { now: 1000, operationId: `op-${++n}`, ...context })
    state = effects.state
    return { effects, before, touches: touchesFor(command, actor, before, effects, context) }
  }
  const contribution = { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }
  const add = (harnessId: string, conversationId: string, lead = false) => run({ type: 'agent.add', conversationId, machineId: 'host', harnessId,
    name: harnessId, configuration: config, lead }, owner, contribution).effects.result.agentId as string
  const lead = add('lead', 'lead', true)
  const group = (title: string) => {
    const id = run({ type: 'conversation.create', title, brief: 'Do it', checks: [{ description: 'Done', independent: false }] }).effects.result.conversationId as string
    const worker = add(`${title}-worker`, id)
    const assignmentId = run({ type: 'work.assign', conversationId: id, agentId: worker }).effects.result.assignmentId as string
    return { id, worker, assignmentId }
  }
  const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  return { run, lead, group, agentActor, get state() { return state } }
}
const has = (touches: Array<{ kind: string; key: string }>, kind: string, key: string) => touches.some(t => t.kind === kind && t.key === key)

describe('the parts a command touches (design section 1.2, column T)', () => {
  it('touches the actor\'s own part on every command', () => {
    const f = swarm(), a = f.group('A')
    expect(has(f.run({ type: 'message.send', conversationId: a.id, text: 'Hi', replyTo: null, recipientIds: [] }).touches, 'member', 'owner')).toBe(true)
    expect(has(f.run({ type: 'message.send', conversationId: a.id, text: 'Hi', replyTo: null, recipientIds: [] }, f.agentActor(a.worker)).touches, 'agent', a.worker)).toBe(true)
  })

  it('makes a Lead\'s change to an agent\'s avatar meet on the Lead conversation its check reads', () => {
    const f = swarm(), a = f.group('A')
    const { touches } = f.run({ type: 'agent.avatar', agentId: a.worker, avatar: { kind: 'preset', key: 'owl' } }, f.agentActor(f.lead))
    expect(has(touches, 'group', 'lead')).toBe(true)
    expect(has(touches, 'agent', a.worker)).toBe(true)
  })

  it('leaves a post\'s recipients alone, so workers posting to their Lead in different groups never meet on the Lead', () => {
    const f = swarm(), a = f.group('A')
    const { effects, touches } = f.run({ type: 'message.send', conversationId: a.id, text: 'Report', replyTo: null, recipientIds: [] }, f.agentActor(a.worker))
    expect(effects.messages[0]!.recipients).toEqual([f.lead])
    expect(has(touches, 'agent', f.lead)).toBe(false)
  })

  it('makes finishing work and the Lead\'s next start or assignment meet on the project\'s progress part', () => {
    const f = swarm(), a = f.group('A')
    f.run({ type: 'work.check', conversationId: a.id, assignmentId: a.assignmentId, checkId: f.state.conversations.find(c => c.id === a.id)!.checks[0]!.id,
      passed: true, evidence: 'Shown' }, f.agentActor(f.lead))
    const done = f.run({ type: 'work.status', conversationId: a.id, assignmentId: a.assignmentId, status: 'done', result: 'Shipped' }, f.agentActor(a.worker))
    expect(has(done.touches, 'progress', 'lead')).toBe(true)
    const cancelled = f.group('B')
    expect(has(f.run({ type: 'work.cancel', conversationId: cancelled.id, assignmentId: cancelled.assignmentId, reason: 'Not needed' }).touches, 'progress', 'lead')).toBe(true)
    const next = f.run({ type: 'conversation.create', title: 'C', brief: 'More', checks: [{ description: 'Done', independent: false }] }).effects.result.conversationId as string
    expect(has(f.run({ type: 'work.assign', conversationId: next, agentId: a.worker }).touches, 'progress', 'lead')).toBe(true)
  })

  it('makes naming a requester meet that person\'s removal on their member part', () => {
    const f = swarm()
    const invited = f.run({ type: 'invite.create', email: 'peer@example.com', role: 'collaborator', conversationId: 'lead' }).effects.result.inviteId as string
    f.run({ type: 'invite.accept', inviteId: invited }, { kind: 'person', userId: 'peer', email: 'peer@example.com' })
    const opened = f.run({ type: 'conversation.create', title: 'R', brief: 'Do it', checks: [{ description: 'Done', independent: false }], requesterId: 'peer' },
      f.agentActor(f.lead))
    expect(has(opened.touches, 'member', 'peer')).toBe(true)
    const id = opened.effects.result.conversationId as string
    const named = f.run({ type: 'conversation.requester', conversationId: id, personId: 'peer' }, f.agentActor(f.lead))
    expect(has(named.touches, 'member', 'peer')).toBe(true)
    expect(has(named.touches, 'group', 'lead')).toBe(true)
  })

  it('makes an answer to waiting work meet a change to whom it waits on', () => {
    const f = swarm(), a = f.group('A')
    f.run({ type: 'conversation.requester', conversationId: a.id, personId: 'owner' })
    f.run({ type: 'work.status', conversationId: a.id, assignmentId: a.assignmentId, status: 'needs_human', result: 'Flag?' }, f.agentActor(a.worker))
    const answer = f.run({ type: 'message.send', conversationId: a.id, text: 'Flag.', replyTo: null, recipientIds: [] }, f.agentActor(f.lead))
    expect(has(answer.touches, 'member', 'owner')).toBe(true)
  })

  it('makes two starts on one machine meet on its slot ledger and on the head', () => {
    const f = swarm()
    const request = { conversationId: 'lead', machineId: 'host', engine: 'codex', name: 'New', cwd: '/w', worktree: false,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const { touches } = f.run({ type: 'agent.start', request }, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } })
    expect(has(touches, 'machine', 'host')).toBe(true)
    expect(has(touches, 'head', 'head')).toBe(true)
  })
})
