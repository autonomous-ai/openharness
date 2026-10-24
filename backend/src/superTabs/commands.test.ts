import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, PAIR_CHAIN_LIMIT, type Command, type CommandContext } from './commands.js'
import { hostLocalGrid, machineSlots, removalPreview, swarmGridRow } from './machines.js'
import { activeWork, agentRole, createSuperTab, visibleState, type Actor, type AgentConfiguration } from './model.js'
import type { RouteDecision } from './routeRecord.js'
import { agentTarget, broken } from './rules.js'
import { DEFAULT_ROUTING_POLICY, effectivePolicy } from './routingPolicy.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const config: AgentConfiguration = { engine: 'codex', model: 'test-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: 1000, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invite = (role: 'viewer' | 'collaborator' = 'collaborator') => {
    const invited = run({ type: 'invite.create', email: peer.email, role, conversationId: 'lead' })
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  }
  const add = (harnessId: string, contributorId = 'owner', group = 'lead', lead = false) => {
    const result = run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId,
      name: harnessId, configuration: config, lead }, contributorId === 'owner' ? owner : peer,
    { contribution: { machineOwnerId: 'host-owner', contributorId } })
    return result.result.agentId as string
  }
  const group = () => run({ type: 'conversation.create', title: 'Offline editing', brief: 'Save edits while offline.',
    checks: [{ description: 'Reconnect preserves the edits.', independent: true }] }).result.conversationId as string
  return { run, invite, add, group, get state() { return state } }
}

describe('five-part tasks', () => {
  const task = { goal: 'Save edits', changes: 'Persist the draft', constraints: 'No dependencies', owns: ['backend/src/superTabs'] }
  const brief = 'Goal:\nSave edits\n\nChanges:\nPersist the draft\n\nConstraints:\nNo dependencies\n\nOwns:\n- backend/src/superTabs'
  const checks = [{ description: 'Reconnect preserves edits', independent: false }]

  it('creates and defines a structured task with a trimmed compatibility brief', () => {
    const f = fixture()
    const create = commandSchema.parse({ type: 'conversation.create', title: 'Drafts', task: { ...task, goal: ' Save edits ', owns: [' backend/src/superTabs '] }, checks })
    const group = f.run(create).result.conversationId as string
    expect(f.state.conversations[1]).toMatchObject({ task, brief })
    const define = commandSchema.parse({ type: 'work.define', conversationId: group, brief: 'ignored', task, checks })
    expect(f.run(define).messages[0]!.text).toBe(brief)
    expect(f.state.conversations[1]).toMatchObject({ task, brief })
  })

  it('delivers all five parts from the stored rendered brief', () => {
    const f = fixture(), group = f.group(), worker = f.add('worker', 'owner', group)
    f.run(commandSchema.parse({ type: 'work.define', conversationId: group, task, checks }))
    const delivery = f.run({ type: 'work.assign', conversationId: group, agentId: worker }).messages[0]!
    expect(delivery.text).toBe(`${brief}\n\nAcceptance checks:\n- Reconnect preserves edits`)
    expect(delivery.recipients).toEqual([worker])
  })

  it('keeps legacy briefs working and clears a previous structured task', () => {
    const f = fixture(), group = f.group()
    f.run(commandSchema.parse({ type: 'work.define', conversationId: group, task, checks }))
    f.run({ type: 'work.define', conversationId: group, brief: 'Legacy update', checks })
    expect(f.state.conversations[1]).not.toHaveProperty('task')
    expect(f.state.conversations[1]!.brief).toBe('Legacy update')
    expect(commandSchema.safeParse({ type: 'work.define', conversationId: group, checks }).success).toBe(false)
    expect(commandSchema.safeParse({ type: 'conversation.create', title: 'Drafts', checks }).success).toBe(false)
  })

  it('bounds task strings and requires every part', () => {
    for (const type of ['conversation.create', 'work.define']) {
      const base = type === 'conversation.create' ? { type, title: 'Drafts' } : { type, conversationId: 'group' }
      for (const invalid of [null, {}, { ...task, goal: ' ' }, { ...task, changes: '' }, { ...task, constraints: '' },
        { ...task, goal: 'x'.repeat(8001) }, { ...task, changes: 'x'.repeat(8001) }, { ...task, constraints: 'x'.repeat(8001) },
        { ...task, owns: [] }, { ...task, owns: [' '] }, { ...task, owns: Array(41).fill('path') }, { ...task, owns: ['x'.repeat(4097)] },
        { ...task, extra: 'unexpected' }]) {
        expect(commandSchema.safeParse({ ...base, brief: 'legacy', task: invalid, checks }).success).toBe(false)
      }
      expect(commandSchema.safeParse({ ...base, task: { ...task, owns: Array(40).fill('path') }, checks }).success).toBe(true)
      expect(commandSchema.safeParse({ ...base, task: { ...task, owns: Array(40).fill('x'.repeat(4096)) }, checks }).success).toBe(false)
    }
  })
})

describe('person removal notices', () => {
  it('tells each remaining Lead who removed an agent and its open task', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group(), worker = f.add('worker', 'owner', group)
    f.run({ type: 'conversation.agent', conversationId: 'lead', agentId: worker, present: true, lead: false })
    f.run({ type: 'work.assign', conversationId: group, agentId: worker })
    const name = f.state.agents.find(a => a.id === worker)!.displayName!
    const effects = f.run({ type: 'agent.remove', agentId: worker })
    expect(effects.messages).toHaveLength(2)
    expect(new Set(effects.messages.map(m => m.id)).size).toBe(2)
    const notice = effects.messages.find(m => m.conversationId === group)!
    expect(notice).toMatchObject({ author: { kind: 'person', id: 'owner' }, recipients: [lead] })
    expect(notice.text).toContain('owner removed')
    expect(notice.text).toContain(name)
    expect(notice.text).toContain('Offline editing')
    expect(effects.messages.find(m => m.conversationId === 'lead')!.recipients).toEqual([lead])
    expect(f.state.conversations.find(c => c.id === group)!.assignment!.status).toBe('reconciling')
  })

  it('finds a held assignment even when the worker is missing from the group roster', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group(), worker = f.add('worker', 'owner', group)
    f.run({ type: 'work.assign', conversationId: group, agentId: worker })
    f.state.conversations[1]!.agentIds = [lead]
    expect(f.run({ type: 'agent.remove', agentId: worker }).messages).toEqual([
      expect.objectContaining({ conversationId: group, recipients: [lead], text: expect.stringContaining('Offline editing') }),
    ])
  })

  it('posts a notice without claiming inactive work stopped or delivering to the removed group lead', () => {
    const f = fixture(), group = f.group(), worker = f.add('worker', 'owner', group, true)
    const effects = f.run({ type: 'agent.remove', agentId: worker })
    expect(effects.messages).toEqual([expect.objectContaining({ conversationId: group, recipients: [] })])
    expect(effects.messages[0]!.text).not.toContain('task')
  })

  it('posts nothing for an agent with no conversations', () => {
    const f = fixture(), worker = f.add('worker')
    f.state.conversations[0]!.agentIds = []
    expect(f.run({ type: 'agent.remove', agentId: worker }).messages).toEqual([])
  })
})

describe('Super Tab collaboration policy', () => {
  it('records host-observed runtime changes without rewriting an assignment\'s starting configuration', () => {
    const f = fixture(), group = f.group(), worker = f.add('worker', 'owner', group)
    f.run({ type: 'work.assign', conversationId: group, agentId: worker })
    const before = f.state.agents[0]!.configurationVersion!
    const observed = { ...config, model: 'another-model', effort: 'max', contextWindow: null }
    const command: Command = { type: 'agent.configuration', previousVersion: before, configuration: observed }
    expect(() => f.run(command)).toThrow('Only the execution host')
    const actor: Actor = { kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' }
    const changed = f.run(command, actor)
    expect(changed.messages).toEqual([])
    expect(f.state.agents[0]!.configuration).toEqual(observed)
    expect(f.state.conversations[1]!.assignment!.configuration).toEqual(config)
    expect(() => f.run(command, actor)).toThrow('current agent configuration')
    const version = f.state.agents[0]!.configurationVersion!
    f.run({ ...command, previousVersion: version }, actor)
    expect(f.state.agents[0]!.configurationVersion).toBe(version)
    f.run({ ...command, configuration: config, previousVersion: version }, actor)
    expect(f.state.agents[0]!.configurationVersion).not.toBe(before)
  })

  it('counts a fresh contribution despite a stopped proof from its previous removal', () => {
    const f = fixture(), worker = f.add('worker')
    f.state.machines = [{ machineId: 'host', name: 'Host', contributorId: 'owner', membershipGeneration: f.state.people[0]!.generation,
      generation: 'pool', cwd: '/work', engines: ['codex'], maxAgents: 1, paused: false,
      observation: { generation: 'pool', receivedAt: 1000, resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null,
        diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null, deviceType: null, chip: null, os: null, gpuPercent: null },
        tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: ['worker'] } }]
    f.run({ type: 'agent.remove', agentId: worker })
    f.state.releasedHarnesses = [{ machineId: 'host', harnessId: 'worker' }]
    f.add('worker')
    expect(machineSlots(f.state, f.state.machines![0]!)).toBe(1)
    // A delayed machine observation from the stopped runtime arrives after re-contribution.
    f.state.machines![0]!.observation!.stoppedHarnessIds = ['worker']
    expect(machineSlots(f.state, f.state.machines![0]!)).toBe(1)
    f.state.machines![0]!.observation!.stoppedHarnessIds = []
    f.state.machines![0]!.observation!.runningHarnessIds = ['worker']
    f.run({ type: 'agent.remove', agentId: worker })
    expect(machineSlots(f.state, f.state.machines![0]!)).toBe(1)
    f.add('worker')
    f.state.machines![0]!.observation!.stoppedHarnessIds = ['worker']
    expect(machineSlots(f.state, f.state.machines![0]!)).toBe(1)
  })

  it('a person withdrawing a stuck stop keeps its native slot until the host reports stopping', () => {
    const f = fixture(), worker = f.add('worker')
    f.state.agents[0]!.workDecision = 'awaiting'
    f.run({ type: 'agent.release', agentId: worker, decision: 'stop' })
    const pool = { machineId: 'host', name: 'Host', contributorId: 'owner', membershipGeneration: f.state.people[0]!.generation,
      generation: 'pool', cwd: '/work', engines: ['codex'], maxAgents: 1, paused: false }
    f.state.machines = [pool]
    f.run({ type: 'agent.remove', agentId: worker })
    expect(f.state.releasedHarnesses ?? []).toEqual([])
    expect(machineSlots(f.state, pool)).toBe(1)
    // An old/offline host has not sent any observation; no physical stop is implied by Remove.
  })

  it('fences observations from an earlier contribution of the same native harness', () => {
    const f = fixture(), worker = f.add('worker')
    const before = f.state.agents[0]!.configurationVersion!
    f.run({ type: 'agent.remove', agentId: worker })
    expect(f.add('worker')).toBe(worker)
    expect(f.state.agents[0]!.configurationVersion).not.toBe(before)
    expect(() => f.run({ type: 'agent.configuration', previousVersion: before, configuration: { ...config, model: 'old observation' } },
      { kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' })).toThrow('current agent configuration')
  })

  it('records the native launch request without dispatching it a second time', () => {
    const f = fixture()
    const result = f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'lead',
      name: 'Lead', configuration: config, lead: true, initialMessage: 'Discuss the architecture.' }, owner,
    { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } })
    expect(result.messages).toEqual([expect.objectContaining({ text: 'Discuss the architecture.', recipients: [], author: expect.objectContaining({ kind: 'person', id: 'owner' }) })])
    expect(f.state.conversations[0]!.leadId).toBe(result.result.agentId)
  })
  it('keeps adding an agent separate from creating conversations and assigning work', () => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true)
    const group = f.group()
    const worker = f.add('worker', 'owner', group)
    expect(f.state.conversations.map(c => c.title)).toEqual(['Lead', 'Offline editing', 'Leads'])
    expect(f.state.conversations[1]).toMatchObject({ leadId: lead, agentIds: [lead, worker], assignment: null })
    f.run({ type: 'conversation.agent', conversationId: 'lead', agentId: worker, present: true, lead: false })
    expect(f.state.agents).toHaveLength(2)
    expect(f.state.conversations).toHaveLength(3) // Lead, the group and Leads
  })

  it('routes a human reply to its author, and does not create agent chatter loops', () => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true)
    const worker = f.add('worker')
    const posted = f.run({ type: 'message.send', conversationId: 'lead', text: 'Which behavior?', replyTo: null, recipientIds: [] },
      { kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' }).messages[0]!
    expect(posted.recipients).toEqual([])
    const reply = f.run({ type: 'message.send', conversationId: 'lead', text: 'Keep the local copy.', replyTo: posted.id, recipientIds: [] }, owner,
      { reply: { id: posted.id, conversationId: 'lead', author: posted.author } })
    expect(reply.messages[0]!.recipients).toEqual([worker])
    const fresh = f.run({ type: 'message.send', conversationId: 'lead', text: 'Continue.', replyTo: null, recipientIds: [] })
    expect(fresh.messages[0]!.recipients).toEqual([lead])
    expect(() => f.run({ type: 'message.send', conversationId: 'lead', text: 'Cross-group reply', replyTo: posted.id, recipientIds: [] }, owner,
      { reply: { id: posted.id, conversationId: 'elsewhere', author: posted.author } })).toThrow('Reply to a message in this conversation')
  })

  it('delivers an assigned worker\'s own post to its Lead, and nobody else\'s', () => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true)
    const group = f.group(), worker = f.add('worker', 'owner', group), other = f.add('other', 'owner', group)
    const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
    const post = (actor: Actor, recipientIds: string[] = []) => f.run({ type: 'message.send', conversationId: group, text: 'PR is green.',
      replyTo: null, recipientIds }, actor).messages[0]!.recipients
    expect(post(as(worker))).toEqual([])
    f.run({ type: 'work.assign', conversationId: group, agentId: worker })
    expect(post(as(worker))).toEqual([lead])
    expect(post(as(worker), [other])).toEqual([other])
    expect(post(as(other))).toEqual([])
    expect(post(as(lead))).toEqual([worker])
    f.run({ type: 'work.status', conversationId: group, assignmentId: f.state.conversations[1]!.assignment!.id, status: 'blocked', result: 'Stuck.' }, as(worker))
    expect(post(as(worker))).toEqual([lead])
  })

  describe('a Lead\'s message to the assigned worker (#1549)', () => {
    const setup = () => {
      const f = fixture()
      const lead = f.add('lead', 'owner', 'lead', true)
      const group = f.group(), worker = f.add('worker', 'owner', group), other = f.add('other', 'owner', group)
      const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
      const history: { author: { kind: 'agent' | 'person'; id: string }; recipients: string[]; id: string }[] = []
      const post = (agentId: string, recipientIds: string[] = [], replyTo: string | null = null) => {
        const reply = history.find(m => m.id === replyTo)
        const sent = f.run({ type: 'message.send', conversationId: group, text: 'Update.', replyTo, recipientIds }, as(agentId), {
          recent: history.slice().reverse().slice(0, PAIR_CHAIN_LIMIT).map(m => ({ author: m.author as never, recipients: m.recipients })),
          ...(reply ? { reply: { id: reply.id, conversationId: group, author: reply.author as never } } : {}),
        }).messages[0]!
        history.push({ author: { kind: 'agent', id: agentId }, recipients: sent.recipients, id: sent.id })
        return sent
      }
      // A Lead routes before it assigns (#1555); a person assigns directly.
      const assign = (assigner: 'lead' | 'person') => {
        const sent = (assigner === 'lead'
          ? f.run({ type: 'work.assign', conversationId: group, agentId: worker, ...via }, as(lead), decisionIn(group))
          : f.run({ type: 'work.assign', conversationId: group, agentId: worker }, owner)).messages[0]!
        history.push({ author: { kind: assigner === 'lead' ? 'agent' : 'person', id: assigner === 'lead' ? lead : 'owner' }, recipients: sent.recipients, id: sent.id })
        return sent
      }
      return { f, lead, group, worker, other, as, post, assign, history }
    }

    it('reaches the assigned worker for a plain post, only while the work is active', () => {
      const { f, lead, group, worker, post } = setup()
      expect(post(lead).recipients).toEqual([])
      f.run({ type: 'work.assign', conversationId: group, agentId: worker })
      expect(post(lead).recipients).toEqual([worker])
      f.run({ type: 'work.cancel', conversationId: group, assignmentId: f.state.conversations[1]!.assignment!.id, reason: 'Duplicate of another task' })
      expect(post(lead).recipients).toEqual([])
    })

    it('reaches the assigned worker for a reply to the worker\'s message', () => {
      const { f, lead, group, worker, post } = setup()
      f.run({ type: 'work.assign', conversationId: group, agentId: worker })
      const report = post(worker)
      expect(report.recipients).toEqual([lead])
      expect(post(lead, [], report.id).recipients).toEqual([worker])
    })

    it('lets explicit recipients win and leaves other members, replies to others and person routing alone', () => {
      const { f, lead, group, worker, other, as, post, history } = setup()
      f.run({ type: 'work.assign', conversationId: group, agentId: worker })
      expect(post(lead, [other]).recipients).toEqual([other])
      const aside = post(other)
      expect(aside.recipients).toEqual([])
      expect(post(lead, [], aside.id).recipients).toEqual([])
      const personMessage = f.run({ type: 'message.send', conversationId: group, text: 'Status?', replyTo: null, recipientIds: [] }).messages[0]!
      history.push({ author: { kind: 'person', id: 'owner' }, recipients: personMessage.recipients, id: personMessage.id })
      expect(personMessage.recipients).toEqual([lead])
      const reply = f.run({ type: 'message.send', conversationId: group, text: 'Ask the worker', replyTo: personMessage.id, recipientIds: [] }, as(lead), {
        reply: { id: personMessage.id, conversationId: group, author: personMessage.author },
      }).messages[0]!
      expect(reply.recipients).toEqual([])
    })

    it('delivers the Lead\'s approval of the worker\'s plan after the Lead\'s own brief (#1549)', () => {
      for (const assigner of ['lead', 'person'] as const) {
        const { lead, worker, post, assign } = setup()
        expect(assign(assigner).recipients).toEqual([worker])
        const plan = post(worker)
        expect(plan.recipients).toEqual([lead])
        expect(post(lead).recipients).toEqual([worker])
        expect(post(worker, [], plan.id).recipients).toEqual([lead])
        expect(post(lead, [], plan.id).recipients).toEqual([worker])
      }
    })

    it('stops an unattended Lead and worker loop, and a person message or explicit recipients start a new one', () => {
      const { f, lead, group, worker, post, assign, history } = setup()
      assign('lead')
      const hops: string[][] = []
      let speaker = worker
      // Each agent answers every message it receives, the worst case for a loop.
      for (let turn = 0; turn < 50; turn++) {
        const sent = post(speaker)
        hops.push(sent.recipients)
        const next = sent.recipients[0]
        if (!next) break
        speaker = next
      }
      expect(hops.slice(0, -1).every(recipients => recipients.length === 1)).toBe(true)
      expect(hops.at(-1)).toEqual([])
      expect(hops).toHaveLength(PAIR_CHAIN_LIMIT)
      expect(post(lead, [worker]).recipients).toEqual([worker])
      const person = f.run({ type: 'message.send', conversationId: group, text: 'Carry on.', replyTo: null, recipientIds: [worker] }).messages[0]!
      history.push({ author: { kind: 'person', id: 'owner' }, recipients: person.recipients, id: person.id })
      expect(post(lead).recipients).toEqual([worker])
    })
  })

  it('lets a viewer read and leave, but not send, assign, attach or invite', () => {
    const f = fixture()
    f.invite('viewer')
    const commands: Command[] = [
      { type: 'message.send', conversationId: 'lead', text: 'Run this', replyTo: null, recipientIds: [] },
      { type: 'work.assign', conversationId: 'lead', agentId: 'worker' },
      { type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'worker', name: 'Worker', configuration: config, lead: false },
      { type: 'invite.create', email: 'next@example.com', role: 'collaborator', conversationId: 'lead' },
    ]
    for (const command of commands) expect(() => f.run(command, peer)).toThrow('read-only')
    expect(visibleState(f.state, peer).people).toHaveLength(2)
    f.run({ type: 'member.remove', userId: 'peer' }, peer)
    expect(() => visibleState(f.state, peer)).toThrow('no longer have access')
  })

  it('requires the addressed account to accept an unexpired invitation and keeps other invitations private', () => {
    const f = fixture()
    const invited = f.run({ type: 'invite.create', email: 'PEER@example.com', role: 'collaborator', conversationId: 'lead' })
    const command: Command = { type: 'invite.accept', inviteId: invited.result.inviteId as string }
    expect(() => f.run(command, { kind: 'person', userId: 'stranger', email: 'else@example.com' })).toThrow('unavailable')
    expect(() => f.run(command, peer, { now: 1000 + 7 * 86400000 })).toThrow('expired')
    f.run(command, peer)
    f.run({ type: 'invite.create', email: 'next@example.com', role: 'viewer', conversationId: 'lead' })
    expect(visibleState(f.state, owner).invitations).toHaveLength(1)
    expect(visibleState(f.state, peer).invitations).toHaveLength(0)
    const snapshot = visibleState(f.state, owner)
    snapshot.people.splice(0)
    expect(f.state.people).toHaveLength(2)
  })

  it('withdraws a departing contributor and preserves execution identity until the host confirms a stop', () => {
    const f = fixture()
    f.invite()
    const group = f.group()
    const worker = f.add('worker', 'peer', group)
    const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: worker }).result.assignmentId as string
    const removed = f.run({ type: 'member.remove', userId: 'peer' })
    expect(removed.cancelledAgents).toEqual([worker])
    expect(f.state.conversations[1]!.assignment).toMatchObject({ status: 'reconciling', execution: { machineId: 'host', harnessId: 'worker', machineOwnerId: 'host-owner' } })
    f.invite()
    expect(f.state.agents).toHaveLength(0)
    const stop: Command = { type: 'work.status', conversationId: group, assignmentId, status: 'stopped', result: 'Host receipt' }
    expect(() => f.run(stop)).toThrow('confirm the stop')
    f.run(stop, owner, { confirmedStopped: true })
    expect(f.state.conversations[1]!.assignment!.status).toBe('stopped')
  })

  it('keeps ownership exclusive and requires independent evidence before closing an attempt', () => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true)
    const group = f.group()
    const worker = f.add('worker', 'owner', group)
    const second = f.group()
    const assigned = f.run({ type: 'work.assign', conversationId: group, agentId: worker })
    const assignmentId = assigned.result.assignmentId as string
    expect(assigned.messages[0]!.recipients).toEqual([worker])
    expect(() => f.run({ type: 'work.assign', conversationId: second, agentId: worker })).toThrow('active assignment')
    expect(() => f.run({ type: 'conversation.agent', conversationId: group, agentId: worker, present: true, lead: true })).toThrow('replacing its lead')
    const done: Command = { type: 'work.status', conversationId: group, assignmentId, status: 'done', result: 'Revision fixture-1' }
    expect(() => f.run(done)).toThrow('evidence')
    const check: Command = { type: 'work.check', conversationId: group, assignmentId,
      checkId: f.state.conversations[1]!.checks[0]!.id, passed: true, evidence: 'Reconnect test passed on revision fixture-1.' }
    expect(() => f.run(check, { kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' })).toThrow('Another agent')
    f.run(check, { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' })
    const completion = f.run(done, { kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' })
    expect(completion.messages[0]).toMatchObject({ conversationId: group, text: 'Done\n\nRevision fixture-1', recipients: [lead] })
    expect(() => f.run(check)).toThrow('new attempt')
    expect(() => f.run({ ...done, status: 'working' })).toThrow('new attempt')
    const retry = f.run({ type: 'work.assign', conversationId: group, agentId: worker })
    expect(retry.previousAttempts[0]!.assignment).toMatchObject({ id: assignmentId, status: 'done', configuration: config })
    expect(f.state.conversations[1]!.checks[0]!.evidence).toBeNull()
  })

  it('tells the Lead when the assignee is stuck and keeps the work active', () => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true)
    const group = f.group()
    const worker = f.add('worker', 'owner', group)
    const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: worker }).result.assignmentId as string
    const as: Actor = { kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' }
    const stuck = f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'blocked', result: 'The staging database refuses my key.' }, as)
    expect(stuck.messages[0]).toMatchObject({ conversationId: group, text: 'Stuck\n\nThe staging database refuses my key.', recipients: [lead] })
    expect(f.state.conversations[1]!.assignment!.status).toBe('blocked')
    expect(activeWork(f.state.conversations[1]!)).toBe(true)
    expect(() => f.run({ type: 'work.assign', conversationId: f.group(), agentId: worker })).toThrow('active assignment')
    const decision = f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'needs_human', result: 'Ship to everyone, or behind a flag?' }, as)
    expect(decision.messages[0]).toMatchObject({ text: 'Needs a human\n\nShip to everyone, or behind a flag?', recipients: [lead] })
    f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'working', result: null }, as)
    expect(f.state.conversations[1]!.assignment!.status).toBe('working')
  })

  it('allows discussion while paused and refuses new work, without mutating rejected state', () => {
    const f = fixture()
    f.run({ type: 'tab.pause', paused: true })
    const before = JSON.stringify(f.state)
    expect(() => f.group()).toThrow('paused')
    expect(JSON.stringify(f.state)).toBe(before)
    expect(f.run({ type: 'message.send', conversationId: 'lead', text: 'Let’s reconsider.', replyTo: null, recipientIds: [] }).messages).toHaveLength(1)
  })

  it('lets a person create an empty group and define its acceptance criteria before delegation', () => {
    const f = fixture()
    const id = f.run({ type: 'conversation.create', title: 'Sketch', brief: '', checks: [] }).result.conversationId as string
    const worker = f.add('worker', 'owner', id)
    expect(() => f.run({ type: 'work.assign', conversationId: id, agentId: worker })).toThrow('acceptance checks')
    f.run({ type: 'work.define', conversationId: id, brief: 'Document the flow.', checks: [{ description: 'A person reviews the document.', independent: true }] })
    f.run({ type: 'work.assign', conversationId: id, agentId: worker })
    expect(() => f.run({ type: 'conversation.archive', conversationId: id, archived: true })).toThrow('active assignment')
  })

  it('rejects spoofed grant fields and execution identities', () => {
    expect(commandSchema.safeParse({ type: 'tab.pause', paused: false, machineOwnerId: 'someone' }).success).toBe(false)
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true)
    expect(() => f.run({ type: 'tab.pause', paused: false }, { kind: 'agent', agentId: lead, machineOwnerId: 'stranger' })).toThrow('execution host')
    expect(() => f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'extra', name: 'Extra', configuration: config, lead: false })).toThrow('explicitly shared')
  })
})

it('starts only in the chosen conversation, captures authority, and never assigns on join', () => {
  const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
  const actor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
  const contribution = { machineOwnerId: 'target-owner', contributorId: 'owner', hostGrant: 'grant-1' }
  const request = { conversationId: group, machineId: 'host', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
    requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }
  const startId = f.run({ type: 'agent.start', request, ...via }, actor, { contribution, ...decisionIn(group) }).result.startId as string
  expect(f.state.starts![0]).toMatchObject({ request, hostGrant: 'grant-1', dispatched: false })
  expect(f.state.agents).toHaveLength(1)
  expect(f.state.conversations).toHaveLength(3) // Lead, the group and Leads
  expect(() => f.run({ type: 'agent.startDispatch', startId }, actor, { contribution: { ...contribution, hostGrant: 'new-grant' } })).toThrow('revoked')
  f.run({ type: 'agent.startDispatch', startId }, actor, { contribution })
  expect(() => f.run({ type: 'agent.startDispatch', startId }, actor, { contribution })).toThrow('already requested')
  const worker = f.run({ type: 'agent.started', startId, harnessId: 'native-worker', configuration: { ...config, engine: 'claude' } }, actor, { contribution }).result.agentId
  expect(f.state.agents).toHaveLength(2)
  expect(f.state.conversations[1]).toMatchObject({ agentIds: [lead, worker], assignment: null })
  expect(f.state.conversations[0]!.agentIds).toEqual([lead])
  f.run({ type: 'tab.pause', paused: true })
  expect(() => f.run({ type: 'agent.start', request, ...via }, actor, { contribution, ...decisionIn(group) })).toThrow('paused')
})

it.each(['opencode', 'kilo'])('refuses to dispatch a stored legacy %s start before native launch', engine => {
  const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
  const actor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
  const contribution = { machineOwnerId: 'target-owner', contributorId: 'owner', hostGrant: 'grant-1' }
  const request = { conversationId: group, machineId: 'host', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
    requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }
  const startId = f.run({ type: 'agent.start', request, ...via }, actor, { contribution, ...decisionIn(group) }).result.startId as string
  f.state.starts![0]!.request.engine = engine // Simulate a start stored before the engine restriction.
  expect(() => f.run({ type: 'agent.startDispatch', startId }, actor, { contribution })).toThrow('Claude Code or Codex')
  expect(f.state.starts![0]!.dispatched).toBe(false)
})

describe('agent.start on the Swarm\'s listed machines', () => {
  const request = (group: string, machineId: string) => ({ conversationId: group, machineId, engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
    requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } })
  const grant = { machineOwnerId: 'target-owner', contributorId: 'owner' }

  it('refuses an agent\'s start on a machine nobody listed, and records nothing', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
    const actor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    expect(() => f.run({ type: 'agent.start', request: request(group, 'account-vm'), ...via }, actor, { contribution: grant, ...decisionIn(group) }))
      .toThrow(expect.objectContaining({ code: 'MACHINE_NOT_LISTED', status: 403, message: 'Add this machine to the Swarm first.' }))
    expect(f.state.starts ?? []).toEqual([])
  })

  // A new Lead may be only Claude or Codex, but on any machine: adding it is what lists that machine.
  it.each(['claude', 'codex'])('lists the machine a %s Lead is added on, so the Lead may start agents there', engine => {
    const f = fixture()
    const lead = f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'lead-machine', harnessId: 'lead', name: 'Lead',
      configuration: { ...config, engine }, lead: true }, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
    const actor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    const group = f.group()
    f.run({ type: 'agent.start', request: request(group, 'lead-machine'), ...via }, actor, { contribution: grant, ...decisionIn(group) })
    expect(f.state.starts).toHaveLength(1)
  })

  it('lets an agent start on a contributed machine', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
    const actor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    f.state.machines = [{ machineId: 'contributed', name: 'Mini', contributorId: 'owner', membershipGeneration: f.state.people[0]!.generation, generation: 'g1',
      cwd: '/repo', engines: ['claude'], maxAgents: 2, paused: false, observation: { receivedAt: 1000 } } as never]
    f.run({ type: 'agent.start', request: request(group, 'contributed'), ...via }, actor, { contribution: grant, ...decisionIn(group) })
    expect(f.state.starts).toHaveLength(1)
  })

  it('keeps a person\'s start on a machine of their own, before anything is listed', () => {
    const f = fixture(), group = f.group()
    f.run({ type: 'agent.start', request: request(group, 'my-laptop') }, owner, { contribution: grant })
    expect(f.state.starts).toHaveLength(1)
  })
})

describe('tab.routingPolicy', () => {
  it('lets only the owner set or clear the tab override', () => {
    const f = fixture()
    f.run({ type: 'tab.routingPolicy', policy: { quotaReserve: 25 } })
    expect(f.state.routingPolicy).toEqual({ quotaReserve: 25 })
    f.invite('collaborator')
    expect(() => f.run({ type: 'tab.routingPolicy', policy: { notes: 'x' } }, peer)).toThrow('Only the Super Tab owner')
    f.run({ type: 'tab.routingPolicy', policy: null })
    expect(f.state.routingPolicy).toBeUndefined()
  })
  it('refuses an invalid override', () => {
    const f = fixture()
    expect(() => commandSchema.parse({ type: 'tab.routingPolicy', policy: { quotaReserve: 99 } })).toThrow()
    expect(() => f.run({ type: 'tab.routingPolicy', policy: { quotaReserve: 99 } } as never)).toThrow()
  })
})

const candidate = (id: string, patch: Record<string, unknown> = {}) => ({ id, kind: 'new', machineId: 'machine', engine: 'claude',
  model: 'opus', effort: 'high', quality: 3, cost: 3, title: `Title ${id}`, label: `Label ${id}`, ...patch })
const record = (patch: Record<string, unknown> = {}) => ({ assessment: { difficulty: 'high', risk: 'low', why: 'Schema change.' },
  candidates: [candidate('c0'), candidate('c1', { model: 'sonnet', quality: 2, cost: 2 })], excluded: [], floor: 3, notes: false,
  pick: 'c0', via: 'jev', p: 0.82, belowFloor: false, why: 'Highest quality within quota.', ...patch })
/** What an agent passes to start or assign: a routing decision of `conversationId`. Its pick differs from the call, so it carries a reason. */
const via = { routeDecisionId: 'd1', overrideReason: 'Test.' }
const decisionIn = (conversationId = 'lead') => ({ routeDecision: { id: 'd1', conversationId, record: record(), final: null, override: null, assignmentId: null, outcome: null } as unknown as RouteDecision })
/** The base fixture plus a coordinating Lead and a worker, both on one host. */
function routed() {
  const f = fixture()
  const lead = f.add('lead', 'owner', 'lead', true), worker = f.add('worker')
  // An agent runs on 'machine', so the Swarm lists it and a start there is allowed.
  f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'machine', harnessId: 'remote', name: 'Remote', configuration: config, lead: false },
    owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } })
  const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const define = (group: string) => f.run({ type: 'work.define', conversationId: group, brief: 'Build it.', checks: [{ description: 'Tests pass.', independent: false }] })
  /** Records a completed native start for an agent, as the decision's `new` final refers to it. */
  const startedFor = (agentId: string) => {
    const member = f.state.agents.find(a => a.id === agentId)!
    f.state.starts ??= []
    f.state.starts.push({ id: `start-${agentId}`, harnessId: member.harnessId, request: { machineId: member.machineId } } as never)
    return `start-${agentId}`
  }
  return { ...f, get state() { return f.state }, lead, worker, define, startedFor, contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' },
    leadActor: agentActor(lead), workerActor: agentActor(worker) }
}

describe('route.record and route.override', () => {
  it('records a lead decision as a route message with its id', () => {
    const f = routed()
    const effects = f.run({ type: 'route.record', conversationId: 'lead', decision: record() } as Command, f.leadActor, { recentRoutes: 0 })
    expect(effects.result.routeDecisionId).toBeTruthy()
    expect(effects.routeDecisions).toEqual([{ op: 'create', id: effects.result.routeDecisionId, conversationId: 'lead', record: expect.objectContaining({ pick: 'c0' }) }])
    expect(effects.messages[0]).toMatchObject({ text: 'Routed to Title c0 — Jev 82% · "Schema change."',
      source: { kind: 'route', decisionId: effects.result.routeDecisionId, via: 'jev', p: 0.82, belowFloor: false,
        pick: { id: 'c0', title: 'Title c0' }, alternatives: [{ id: 'c1', title: 'Title c1' }] } })
  })
  it('keeps the context Jev was given with the record, bounded, and still takes a record without it', () => {
    const f = routed()
    const run = (decision: unknown) => f.run({ type: 'route.record', conversationId: 'lead', decision } as Command, f.leadActor, { recentRoutes: 0 })
    expect(run(record({ context: { chars: 9000, missing: ['messages', 'activity'] } })).routeDecisions[0]).toMatchObject({ record: { context: { chars: 9000, missing: ['messages', 'activity'] } } })
    expect(run(record()).routeDecisions[0]).toMatchObject({ record: { pick: 'c0' } })
    for (const context of [{ chars: -1, missing: [] }, { chars: 1.5, missing: [] }, { chars: 40_000, missing: [] }, { chars: 10 },
      { chars: 10, missing: Array.from({ length: 11 }, (_, i) => `s${i}`) }, { chars: 10, missing: ['x'.repeat(41)] }, { chars: 10, missing: [''] },
      { chars: 10, missing: [], extra: 1 }]) {
      expect(() => run(record({ context }))).toThrow()
    }
  })
  it('keeps the size and each candidate\'s quota fit, and still takes a record without them', () => {
    const f = routed()
    const run = (decision: unknown) => f.run({ type: 'route.record', conversationId: 'lead', decision } as Command, f.leadActor, { recentRoutes: 0 })
    const fit = { status: 'short', coverage: -0.2, effectiveCost: 1.5, expiring: 0, spend: { '5-hour': 45, weekly: 6 }, account: 'remote-1:codex' }
    const sized = (size: unknown, patch: Record<string, unknown> = {}) => record({ assessment: { difficulty: 'high', risk: 'low', why: 'Schema change.', size },
      candidates: [candidate('c0', { fit: { ...fit, ...patch } }), candidate('c1', { model: 'sonnet', quality: 2, cost: 2, fit: { status: 'unknown', coverage: null, effectiveCost: 2, expiring: 0, spend: {} } })] })
    expect(run(sized('large')).routeDecisions[0]).toMatchObject({ record: { assessment: { size: 'large' }, candidates: [{ fit }, { fit: { status: 'unknown', coverage: null } }] } })
    expect(run(record()).routeDecisions[0]).toMatchObject({ record: { pick: 'c0' } })
    expect(() => run(sized('huge'))).toThrow()
    for (const patch of [{ status: 'maybe' }, { coverage: Infinity }, { effectiveCost: -1 }, { expiring: -1 }, { spend: { daily: 1 } },
      { spend: { weekly: -1 } }, { account: '' }, { extra: 1 }]) {
      expect(() => run(sized('small', patch))).toThrow()
    }
  })
  it('refuses a pick outside the candidates, a non-lead agent and a busy hour', () => {
    const f = routed()
    const route = (decision: unknown, actor: Actor, context: Partial<CommandContext>) =>
      f.run({ type: 'route.record', conversationId: 'lead', decision } as Command, actor, context)
    expect(() => route(record({ pick: 'c5' }), f.leadActor, { recentRoutes: 0 })).toThrow()
    expect(() => route(record(), f.workerActor, { recentRoutes: 0 })).toThrow('coordinating lead')
    expect(() => route(record(), f.leadActor, { recentRoutes: 30 })).toThrow('30 tasks')
  })
  it('lets a writer change an open decision with a reason and tells the lead', () => {
    const f = routed()
    const decision = { id: 'd1', conversationId: 'lead', record: record(), final: null, override: null, assignmentId: null, outcome: null } as unknown as RouteDecision
    const effects = f.run({ type: 'route.override', decisionId: 'd1', candidateId: 'c1', reason: 'Opus quota is needed elsewhere.' }, undefined, { routeDecision: decision })
    expect(effects.routeDecisions).toEqual([{ op: 'override', id: 'd1', override: expect.objectContaining({ by: 'person', candidateId: 'c1', reason: 'Opus quota is needed elsewhere.' }) }])
    expect(effects.messages[0]!.recipients).toEqual([f.lead])
    expect(effects.messages[0]!.text).toContain('chose Title c1 instead of Title c0. Hand this task over to it. Reason: Opus quota is needed elsewhere.')
    expect(effects.messages[0]!.source).toEqual({ kind: 'route-override', decisionId: 'd1', by: 'person' })
  })
  it('refuses an override by an agent, of a closed decision, or of the current choice', () => {
    const f = routed()
    const open = { id: 'd1', conversationId: 'lead', record: record(), final: null, override: null, assignmentId: null, outcome: null } as unknown as RouteDecision
    const command = { type: 'route.override', decisionId: 'd1', candidateId: 'c1', reason: 'Because.' } as const
    expect(() => f.run(command, f.leadActor, { routeDecision: open })).toThrow('A person')
    expect(() => f.run(command, undefined, { routeDecision: { ...open, outcome: 'superseded' } })).toThrow('no longer open')
    expect(() => f.run({ ...command, candidateId: 'c0' }, undefined, { routeDecision: open })).toThrow('already')
  })
})

describe('route.modelResult', () => {
  const started = (patch: Record<string, unknown> = {}) => ({ id: 'd1', conversationId: 'lead', record: record(),
    final: { kind: 'new', startId: 'start-1', machineId: 'machine', engine: 'claude', model: 'opus', effort: 'high' },
    override: null, assignmentId: null, outcome: null, ...patch }) as unknown as RouteDecision
  const result = { type: 'route.modelResult', decisionId: 'd1', startId: 'start-1', model: 'sonnet', effort: 'auto' } as const

  it('records what the agent actually runs and keeps the routed model as requested, without a message', () => {
    const f = routed()
    const effects = f.run(result, f.leadActor, { routeDecision: started() })
    expect(effects.routeDecisions).toEqual([{ op: 'final', id: 'd1', final: { kind: 'new', startId: 'start-1', machineId: 'machine', engine: 'claude',
      model: 'sonnet', effort: 'auto', requested: { model: 'opus', effort: 'high' } } }])
    expect(effects.messages).toEqual([])
  })
  it('keeps the first requested values when it is corrected again', () => {
    const f = routed()
    const final = { kind: 'new', startId: 'start-1', machineId: 'machine', engine: 'claude', model: 'sonnet', effort: 'auto', requested: { model: 'opus', effort: 'high' } }
    const effects = f.run({ ...result, model: 'haiku' }, f.leadActor, { routeDecision: started({ final }) })
    expect(effects.routeDecisions[0]).toMatchObject({ final: { model: 'haiku', requested: { model: 'opus', effort: 'high' } } })
  })
  it('is for the coordinating Lead only', () => {
    const f = routed()
    expect(() => f.run(result, f.workerActor, { routeDecision: started() })).toThrow('coordinating lead')
  })
  it('refuses a closed decision, a member final, no final and another start', () => {
    const f = routed()
    const run = (decision: RouteDecision) => () => f.run(result, f.leadActor, { routeDecision: decision })
    expect(run(started({ outcome: 'done' }))).toThrow('no longer open')
    expect(run(started({ final: { kind: 'member', agentId: f.worker, machineId: 'machine' } }))).toThrow(expect.objectContaining({ code: 'ROUTE_MISMATCH' }))
    expect(run(started({ final: null }))).toThrow(expect.objectContaining({ code: 'ROUTE_MISMATCH' }))
    expect(run(started({ final: { kind: 'new', startId: 'start-2', machineId: 'machine', engine: 'claude', model: 'opus', effort: 'high' } })))
      .toThrow(expect.objectContaining({ code: 'ROUTE_MISMATCH' }))
  })
  it('bounds the model and effort', () => {
    expect(() => commandSchema.parse({ ...result, model: 'm'.repeat(201) })).toThrow()
    expect(() => commandSchema.parse({ ...result, effort: 'e'.repeat(81) })).toThrow()
  })
  it('lets the assignment still match the routed pick after the switch failed', () => {
    const f = routed()
    f.define('lead')
    const final = { kind: 'new', startId: f.startedFor(f.worker), machineId: 'machine', engine: 'claude', model: 'sonnet', effort: 'auto', requested: { model: 'opus', effort: 'high' } }
    const effects = f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker, routeDecisionId: 'd1' }, f.leadActor, { routeDecision: started({ final }) })
    expect(effects.routeDecisions).toEqual([{ op: 'final', id: 'd1', final, assignmentId: effects.result.assignmentId }])
  })
})

describe('decisions linked to work', () => {
  const open = (patch: Record<string, unknown> = {}) => ({ id: 'd1', conversationId: 'lead', record: record(), final: null, override: null, assignmentId: null, outcome: null, ...patch }) as unknown as RouteDecision

  it('links an assignment of the picked member, and needs a reason otherwise', () => {
    const f = routed()
    const member = record({ candidates: [candidate('c0', { kind: 'member', agentId: f.worker }), candidate('c1')], pick: 'c0' })
    f.define('lead')
    const linked = f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker, routeDecisionId: 'd1' }, f.leadActor, { routeDecision: open({ record: member }) })
    expect(linked.routeDecisions).toEqual([{ op: 'final', id: 'd1', final: { kind: 'member', agentId: f.worker, machineId: expect.any(String) }, assignmentId: linked.result.assignmentId }])
  })

  it('gives the policy-order row the Lead’s reason and why the order decided', () => {
    const f = routed()
    const order = (patch: Record<string, unknown>) => f.run({ type: 'route.record', conversationId: 'lead', decision: record({ via: 'order', p: null, ...patch }) } as Command,
      f.leadActor, { recentRoutes: 0 }).messages[0]!
    expect(order({ fallback: 'unavailable', why: 'Jev unavailable (BUSY); first in the policy order.' })).toMatchObject({
      text: 'Routed to Title c0 — by policy order · "Schema change."', source: { why: 'Schema change.', fallback: 'unavailable' } })
    expect(order({ fallback: 'unsure' }).source).toMatchObject({ fallback: 'unsure' })
    expect(order({}).source).not.toHaveProperty('fallback')
    expect(() => order({ fallback: 'sleepy' })).toThrow()
  })

  it('refuses a second link while the first assignment of the decision is still running', () => {
    const f = routed()
    f.define('lead')
    const running = f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker, ...via }, f.leadActor, decisionIn())
    const assignmentId = running.result.assignmentId as string
    const request = { conversationId: 'lead', machineId: 'machine', engine: 'claude', model: 'opus', effort: 'high', name: 'Builder', cwd: '/repo', worktree: false,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    expect(() => f.run({ type: 'agent.start', request, routeDecisionId: 'd1' }, f.leadActor, { routeDecision: open({ assignmentId }), contribution: f.contribution }))
      .toThrow('already has running work')
    // Once that work ended and the worker is kept, the decision may be linked again.
    f.state.conversations.find(c => c.id === 'lead')!.assignment!.status = 'stopped'
    f.run({ type: 'agent.release', agentId: f.worker, decision: 'keep' }, f.leadActor)
    expect(f.run({ type: 'agent.start', request, routeDecisionId: 'd1' }, f.leadActor, { routeDecision: open({ assignmentId }), contribution: f.contribution }).routeDecisions).toHaveLength(1)
  })

  it('needs a reason when a start differs from the pick, and tells the group about it', () => {
    const f = routed()
    const request = { conversationId: 'lead', machineId: 'machine', engine: 'claude', model: 'sonnet', effort: 'high', name: 'Builder', cwd: '/repo', worktree: false,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const start = (extra: Record<string, unknown> = {}) => f.run({ type: 'agent.start', request, routeDecisionId: 'd1', ...extra } as Command, f.leadActor, { routeDecision: open(), contribution: f.contribution })
    expect(() => start()).toThrow(expect.objectContaining({ code: 'OVERRIDE_REASON_REQUIRED' }))
    const effects = start({ overrideReason: 'Sonnet is enough here.' })
    expect(effects.routeDecisions[0]).toMatchObject({ op: 'final', override: { by: 'lead', reason: 'Sonnet is enough here.' } })
    expect(effects.messages[0]).toMatchObject({ text: 'Lead started Builder instead of Title c0. Reason: Sonnet is enough here.',
      source: { kind: 'route-override', decisionId: 'd1', by: 'lead' } })
  })

  it('refuses a mismatch without a reason and records the lead override with one', () => {
    const f = routed()
    f.define('lead')
    expect(() => f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker, routeDecisionId: 'd1' }, f.leadActor, { routeDecision: open() }))
      .toThrow('reason')
    const effects = f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker, routeDecisionId: 'd1', overrideReason: 'This worker already has the context.' }, f.leadActor, { routeDecision: open() })
    expect(effects.routeDecisions[0]).toMatchObject({ op: 'final', override: { by: 'lead', reason: 'This worker already has the context.' } })
    expect(effects.messages.some(m => m.source?.kind === 'route-override')).toBe(true)
    expect(effects.result.messageId).toBe(effects.messages[0]!.id)
  })

  it('refuses a decision from another group', () => {
    const f = routed()
    f.define('lead')
    expect(() => f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker, routeDecisionId: 'd1', overrideReason: 'x' }, f.leadActor,
      { routeDecision: open({ conversationId: 'other' }) })).toThrow('another group')
  })

  it('links a start that matches the picked new agent, model and effort', () => {
    const f = routed()
    const request = { conversationId: 'lead', machineId: 'machine', engine: 'claude', model: 'opus', effort: 'high', name: 'Builder', cwd: '/repo', worktree: false,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const effects = f.run({ type: 'agent.start', request, routeDecisionId: 'd1' }, f.leadActor, { routeDecision: open(), contribution: f.contribution })
    expect(effects.routeDecisions).toEqual([{ op: 'final', id: 'd1', final: { kind: 'new', startId: effects.result.startId, machineId: 'machine', engine: 'claude', model: 'opus', effort: 'high' } }])
    expect(f.state.starts![0]!.request).toMatchObject({ model: 'opus', effort: 'high' })
  })

  it('links the assignment of an agent started from the decision and keeps the started model and effort', () => {
    const f = routed()
    f.define('lead')
    const final = { kind: 'new', startId: f.startedFor(f.worker), machineId: 'machine', engine: 'claude', model: 'opus', effort: 'high' }
    const effects = f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker, routeDecisionId: 'd1' }, f.leadActor, { routeDecision: open({ final }) })
    expect(effects.routeDecisions).toEqual([{ op: 'final', id: 'd1', final, assignmentId: effects.result.assignmentId }])
    expect(effects.routeDecisions[0]).not.toHaveProperty('override')
  })

  it('needs a Lead reason when a person overrode the pick after the start', () => {
    const f = routed()
    f.define('lead')
    const final = { kind: 'new', startId: f.startedFor(f.worker), machineId: 'machine', engine: 'claude', model: 'opus', effort: 'high' }
    const overridden = open({ final, override: { by: 'person', actorKey: 'person:owner', candidateId: 'c1', reason: 'Use Sonnet.' } })
    const assign = { type: 'work.assign', conversationId: 'lead', agentId: f.worker, routeDecisionId: 'd1' } as const
    expect(() => f.run(assign, f.leadActor, { routeDecision: overridden })).toThrow('reason')
    const effects = f.run({ ...assign, overrideReason: 'The opus agent is already warm.' }, f.leadActor, { routeDecision: overridden })
    expect(effects.routeDecisions[0]).toMatchObject({ op: 'final', final, override: { by: 'lead', reason: 'The opus agent is already warm.' } })
  })
})

describe('agents route before they start or assign', () => {
  const request = { conversationId: 'lead', machineId: 'machine', engine: 'claude', model: 'opus', effort: 'high', name: 'Builder', cwd: '/repo', worktree: false,
    requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
  const refused = expect.objectContaining({ code: 'ROUTE_REQUIRED', status: 400, message: expect.stringContaining('Route this task first') })

  it('refuses a Lead\'s start and assignment without a routing decision, and records nothing', () => {
    const f = routed()
    f.define('lead')
    expect(() => f.run({ type: 'agent.start', request }, f.leadActor, { contribution: f.contribution })).toThrow(refused)
    expect(() => f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker }, f.leadActor)).toThrow(refused)
    expect(f.state.starts ?? []).toEqual([])
    expect(f.state.conversations.find(c => c.id === 'lead')!.assignment ?? null).toBeNull()
  })

  it('lets a person start and assign by hand, without routing', () => {
    const f = routed()
    f.define('lead')
    expect(f.run({ type: 'agent.start', request }, owner, { contribution: f.contribution }).result.startId).toBeTruthy()
    expect(f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker }, owner).result.assignmentId).toBeTruthy()
  })
})

it('assigns stable workgroup numbers through old snapshots, rename, archive and new groups', () => {
  const f = fixture(), first = f.group(), second = f.group()
  // The Lead and Leads conversations have no number.
  expect(f.state.conversations.map(c => c.number)).toEqual([undefined, 1, 2, undefined])
  delete f.state.conversations[1]!.number
  delete f.state.conversations[2]!.number
  expect(visibleState(f.state, owner).conversations.map(c => c.number)).toEqual([undefined, 1, 2, undefined])
  expect(f.state.conversations[1]!.number).toBeUndefined()
  f.run({ type: 'conversation.rename', conversationId: first, title: 'Renamed' })
  f.run({ type: 'conversation.archive', conversationId: second, archived: true })
  const third = f.group()
  expect(f.state.conversations.map(c => [c.id, c.number])).toEqual([['lead', undefined], [first, 1], [second, 2], [third, 3], [f.state.leadsConversationId, undefined]])
})
it('records the lead project once and accepts only Claude Code and Codex contributions', () => {
  const f = fixture(), project = { cwd: '/repo', repositoryUrl: 'https://github.com/example/project' }
  f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'lead', name: 'Lead', configuration: config, lead: true, project }, owner,
    { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
  expect(f.state.project).toEqual({ machineId: 'host', ...project })
  expect(() => f.run({ type: 'tab.project', machineId: 'host', project })).toThrow('already has a project')
  const command = commandSchema.parse({ type: 'machine.contribute', machineId: 'host', name: 'Workstation', cwd: '/repo', engines: ['claude', 'codex'], maxAgents: 4 })
  f.run(command, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
  expect(f.state.machines![0]!.engines).toEqual(['claude', 'codex'])
  for (const engine of ['opencode', 'kilo']) {
    expect(commandSchema.safeParse({ ...command, engines: ['claude', engine] }).success).toBe(false)
  }
})
it('accepts POSIX, Windows drive and UNC folders and refuses relative, drive-relative and control-character ones', () => {
  const contribute = (cwd: string) => commandSchema.safeParse({ type: 'machine.contribute', machineId: 'host', name: 'PC', cwd, engines: ['claude'], maxAgents: 1 })
  for (const cwd of ['/repo', 'C:\\Users\\dev\\data', 'c:/Users/dev/data', 'D:\\', '\\\\server\\share\\x']) expect(contribute(cwd).success, cwd).toBe(true)
  for (const cwd of ['repo', './repo', 'C:repo', 'C:', '\\repo', '\\\\server', '\\\\\\x', 'C:\\a\nb', '/a\u0000b']) expect(contribute(cwd).success, cwd).toBe(false)
  const refused = contribute('relative')
  expect(!refused.success && refused.error.issues[0]!.message).toBe('Use a full folder path, such as /home/me/work or C:\\Users\\me\\work.')
})
it('restricts recording a legacy project to the owner or controlling lead', () => {
  const f = fixture(); f.invite()
  const command: Command = { type: 'tab.project', machineId: 'host', project: { cwd: '/repo', repositoryUrl: null } }
  expect(() => f.run(command, peer)).toThrow()
  f.run(command)
  expect(f.state.project).toMatchObject({ machineId: 'host', cwd: '/repo' })
})
it('rejects embedded credentials in shared project metadata', () => {
  expect(commandSchema.safeParse({ type: 'tab.project', machineId: 'host', project: { cwd: '/repo', repositoryUrl: 'https://token@github.com/example/project' } }).success).toBe(false)
  expect(commandSchema.safeParse({ type: 'project.repository', projectId: 'lead', repositoryUrl: 'https://token@github.com/example/project' }).success).toBe(false)
  expect(commandSchema.safeParse({ type: 'project.repository', projectId: 'lead', repositoryUrl: 'github.com/example/project' }).success).toBe(false)
  expect(commandSchema.safeParse({ type: 'project.repository', projectId: 'lead', repositoryUrl: null }).success).toBe(false)
})

describe('message attachments', () => {
  const file = { id: 'file-1', name: 'screen.png', mime: 'image/png', size: 12, url: 'https://cdn.example.test/super-tabs/tab/abc/screen.png' }
  const send = (attachmentIds?: string[], text = ''): Command => ({ type: 'message.send', conversationId: 'lead', text, replyTo: null, recipientIds: [], ...(attachmentIds ? { attachmentIds } : {}) })
  it('records verified files on the message and allows empty text with one', () => {
    const f = fixture()
    const sent = f.run(send(['file-1', 'file-1']), owner, { attachments: [file] })
    expect(sent.messages).toEqual([expect.objectContaining({ text: '', attachments: [file] })])
    expect(f.run(send(undefined, 'Plain text.')).messages[0]).not.toHaveProperty('attachments')
  })
  it('refuses empty text without files and a file the store did not verify', () => {
    const f = fixture()
    expect(() => f.run(send())).toThrow('Write a message or attach a file.')
    expect(() => f.run(send(['file-1']))).toThrow('Upload this file again')
    expect(() => commandSchema.parse(send(Array.from({ length: 11 }, (_, i) => `file-${i}`)))).toThrow()
  })
  it('resends a message with its files', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true)
    const resent = f.run({ type: 'delivery.resolve', deliveryId: 'd', resolution: 'resend' }, owner,
      { delivery: { id: 'd', conversationId: 'lead', agentId: lead, messageId: 'm', text: '', attachments: [file] } })
    expect(resent.messages[0]).toMatchObject({ recipients: [lead], attachments: [file] })
  })
})

 describe('finished worker decisions', () => {
  function finished() {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
    const worker = f.add('worker', 'owner', group), other = f.add('other', 'owner', group)
    const leadActor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    const workerActor: Actor = { kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' }
    const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: worker }).result.assignmentId as string
    f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'stopped', result: null }, owner, { confirmedStopped: true })
    return { f, group, worker, other, leadActor, workerActor }
  }
  it('requires a decision after completion, preserves it across a new brief, and clears it on reuse', () => {
    const { f, group, worker, other, leadActor } = finished()
    expect(visibleState(f.state, owner).agents.find(a => a.id === worker)).toHaveProperty('workDecision', 'awaiting')
    f.run({ type: 'work.define', conversationId: group, brief: 'Next task', checks: [{ description: 'Done', independent: false }] })
    expect(() => f.run({ type: 'work.assign', conversationId: group, agentId: other, ...via }, leadActor, decisionIn(group))).toThrow('reuse, keep or stop')
    f.run({ type: 'work.assign', conversationId: group, agentId: worker, ...via }, leadActor, decisionIn(group))
    expect(f.state.agents.find(a => a.id === worker)).not.toHaveProperty('workDecision')
    expect(() => f.run({ type: 'agent.release', agentId: worker, decision: 'stop' } as Command, leadActor)).toThrow('active work')
  })
  it('permits the Lead or owner to keep or stop, refuses workers, and fences reuse after stop', () => {
    const { f, group, worker, other, leadActor, workerActor } = finished()
    const release = { type: 'agent.release', agentId: worker, decision: 'keep' } as Command
    expect(() => f.run(release, workerActor)).toThrow('Lead')
    f.run(release, leadActor)
    expect(f.state.agents.find(a => a.id === worker)).toHaveProperty('workDecision', 'keep')
    f.run({ ...release, decision: 'stop' } as Command)
    expect(() => f.run({ type: 'work.assign', conversationId: group, agentId: worker, ...via }, leadActor, decisionIn(group))).toThrow('stopping')
    expect(() => f.run(release, leadActor)).toThrow('stopping')
    f.run({ type: 'work.assign', conversationId: group, agentId: other, ...via }, leadActor, decisionIn(group))
  })
  it('allows only the execution host of a requested stop to acknowledge removal', () => {
    const { f, worker, other, leadActor, workerActor } = finished()
    expect(() => f.run({ type: 'agent.remove', agentId: worker }, workerActor)).toThrow()
    f.run({ type: 'agent.release', agentId: worker, decision: 'stop' } as Command, leadActor)
    expect(() => f.run({ type: 'agent.remove', agentId: worker }, { ...workerActor, agentId: other })).toThrow()
    const releaseId = f.state.agents.find(a => a.id === worker)!.releaseId!
    const removed = f.run({ type: 'agent.remove', agentId: worker, releaseId }, workerActor)
    expect(removed.messages).toEqual([])
    expect(removed.cancelledAgents).toContain(worker)
    expect(f.state.agents.some(a => a.id === worker)).toBe(false)
    // Its host closed the session before confirming; nothing is left for it to close.
    expect(f.state.closingSessions).toBeUndefined()
  })
 })

it('blocks routing and starts until a finished worker is kept or stopped', () => {
  const f = routed(), group = f.group()
  f.run({ type: 'work.assign', conversationId: group, agentId: f.worker })
  const assignmentId = f.state.conversations.find(c => c.id === group)!.assignment!.id
  f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'stopped', result: null }, owner, { confirmedStopped: true })
  const route = { type: 'route.record', conversationId: group, decision: record() } as Command
  const request = { conversationId: group, machineId: 'machine', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: false,
    requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
  expect(() => f.run(route, f.leadActor)).toThrow('reuse, keep or stop')
  expect(() => f.run({ type: 'agent.start', request, ...via }, f.leadActor, { contribution: f.contribution, ...decisionIn(group) })).toThrow('reuse, keep or stop')
  f.run({ type: 'agent.release', agentId: f.worker, decision: 'keep' }, f.leadActor)
  expect(f.run(route, f.leadActor).routeDecisions).toHaveLength(1)
  expect(f.run({ type: 'agent.start', request, ...via }, f.leadActor, { contribution: f.contribution, ...decisionIn(group) }).result.startId).toBeTruthy()
})

it('requires the exact stop request for host acknowledgement and prevents promotion while stopping', () => {
  const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group(), worker = f.add('worker', 'owner', group)
  const leadActor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
  const workerActor: Actor = { kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' }
  const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: worker }).result.assignmentId as string
  f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'stopped', result: null }, owner, { confirmedStopped: true })
  f.run({ type: 'agent.release', agentId: worker, decision: 'stop' }, leadActor)
  expect(() => f.run({ type: 'agent.remove', agentId: worker, releaseId: 'old-release' } as Command, workerActor)).toThrow('stop request')
  expect(() => f.run({ type: 'conversation.agent', conversationId: group, agentId: worker, present: true, lead: true })).toThrow('stopping')
  expect(() => f.add('worker', 'owner', group, true)).toThrow('stopping')
})

it('allows the contributor to keep a completed worker and refuses another project’s Lead', () => {
  const f = fixture(); f.invite()
  f.add('lead', 'owner', 'lead', true)
  const group = f.group(), worker = f.add('worker', 'peer', group)
  const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: worker }).result.assignmentId as string
  const checkId = f.state.conversations.find(c => c.id === group)!.checks[0]!.id
  f.run({ type: 'work.check', conversationId: group, assignmentId, checkId, passed: true, evidence: 'Verified' })
  f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'done', result: 'Delivered' })
  expect(f.state.agents.find(a => a.id === worker)!.workDecision).toBe('awaiting')
  f.run({ type: 'agent.release', agentId: worker, decision: 'keep' }, peer)
  expect(f.state.agents.find(a => a.id === worker)!.workDecision).toBe('keep')
  const project = f.run({ type: 'project.create', name: 'Other', visibility: 'public', brief: '' }).result
  const otherLead = f.add('other-lead', 'owner', project.conversationId as string, true)
  expect(() => f.run({ type: 'agent.release', agentId: worker, decision: 'stop' }, { kind: 'agent', agentId: otherLead, machineOwnerId: 'host-owner' })).toThrow()
})

describe('cancelling work', () => {
  function active() {
    const f = fixture(); f.invite()
    const lead = f.add('lead', 'owner', 'lead', true), group = f.group(), worker = f.add('worker', 'owner', group)
    const leadActor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    const workerActor: Actor = { kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' }
    const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: worker }).result.assignmentId as string
    const cancel = { type: 'work.cancel', conversationId: group, assignmentId, reason: 'Duplicate of another task' } as Command
    return { f, group, worker, leadActor, workerActor, assignmentId, cancel }
  }
  it('lets the Lead cancel, tells the worker once, and frees the worker to release', () => {
    const { f, group, worker, leadActor, cancel } = active()
    const effects = f.run(cancel, leadActor)
    const assignment = f.state.conversations.find(c => c.id === group)!.assignment!
    expect(assignment).toMatchObject({ status: 'cancelled', result: 'Duplicate of another task' })
    expect(activeWork(f.state.conversations.find(c => c.id === group)!)).toBe(false)
    expect(effects.messages).toHaveLength(1)
    expect(effects.messages[0]).toMatchObject({ recipients: [worker], text: 'The Lead cancelled this task: Duplicate of another task. Stop working on it.' })
    expect(f.run(cancel, leadActor).messages).toHaveLength(0)
    expect(f.state.agents.find(a => a.id === worker)!.workDecision).toBe('awaiting')
    f.run({ type: 'agent.release', agentId: worker, decision: 'keep' }, leadActor)
    expect(f.state.agents.find(a => a.id === worker)!.workDecision).toBe('keep')
  })
  it('lets the tab owner cancel, and never counts a check as passed', () => {
    const { f, group, cancel } = active()
    f.run(cancel)
    expect(f.state.conversations.find(c => c.id === group)!.checks.every(c => !c.passedBy)).toBe(true)
  })
  it('refuses the worker, a collaborator and another project’s Lead', () => {
    const { f, workerActor, cancel } = active()
    const project = f.run({ type: 'project.create', name: 'Other', visibility: 'public', brief: '' }).result
    const otherLead = f.add('other-lead', 'owner', project.conversationId as string, true)
    expect(() => f.run(cancel, workerActor)).toThrow('Lead')
    expect(() => f.run(cancel, peer)).toThrow('Lead')
    expect(() => f.run(cancel, { kind: 'agent', agentId: otherLead, machineOwnerId: 'host-owner' })).toThrow()
  })
  it('names the owner when the owner cancels and drops a trailing full stop from the reason', () => {
    const { f, cancel } = active()
    const text = f.run({ ...cancel, reason: 'Obsolete.' } as Command).messages[0]!.text
    expect(text).toBe('The tab owner cancelled this task: Obsolete. Stop working on it.')
  })
  it('closes a task whose worker was removed, tells nobody, and ignores a retry', () => {
    const { f, group, worker, leadActor, cancel } = active()
    f.run({ type: 'agent.remove', agentId: worker })
    expect(f.state.conversations.find(c => c.id === group)!.assignment!.status).toBe('reconciling')
    const effects = f.run(cancel, leadActor)
    expect(f.state.conversations.find(c => c.id === group)!.assignment).toMatchObject({ status: 'cancelled', result: 'Duplicate of another task' })
    expect(effects.messages).toHaveLength(1)
    expect(effects.messages[0]).toMatchObject({ recipients: [], text: 'The Lead cancelled this task: Duplicate of another task.' })
    expect(f.run(cancel, leadActor).messages).toHaveLength(0)
  })
  it('still refuses a worker or collaborator cancelling a removed worker’s task', () => {
    const { f, worker, workerActor, cancel } = active()
    f.run({ type: 'agent.remove', agentId: worker })
    expect(() => f.run(cancel, workerActor)).toThrow()
    expect(() => f.run(cancel, peer)).toThrow('Lead')
  })
  it('refuses work that already finished', () => {
    const { f, group, leadActor, assignmentId, cancel } = active()
    f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'stopped', result: null }, owner, { confirmedStopped: true })
    expect(() => f.run(cancel, leadActor)).toThrow('already ended')
  })
})

it('allows routing directly to the awaiting worker without first keeping it', () => {
  const f = routed(), group = f.group()
  const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: f.worker }).result.assignmentId as string
  f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'stopped', result: null }, owner, { confirmedStopped: true })
  const decision = record({ candidates: [candidate('c0', { kind: 'member', agentId: f.worker, machineId: 'host' })], pick: 'c0' })
  expect(f.run({ type: 'route.record', conversationId: group, decision } as Command, f.leadActor).routeDecisions).toHaveLength(1)
})

describe('Reviewer role', () => {
  const contribution = { machineOwnerId: 'target-owner', contributorId: 'owner' }
  const request = (group: string, extra: Record<string, unknown> = {}) => ({ conversationId: group, machineId: 'host', engine: 'claude', name: 'Reviewer',
    cwd: '/repo', worktree: true, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }, ...extra })
  function reviewed() {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
    const leadActor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' } as const
    f.run({ type: 'conversation.agent', conversationId: group, agentId: lead, present: true, lead: true })
    const start = { type: 'agent.start', request: request(group, { role: 'reviewer' }) } as Command
    expect(() => f.run(start, leadActor, { contribution })).toThrow('Route this task first')
    const startId = f.run({ ...start, ...via } as Command, leadActor, { contribution, ...decisionIn(group) }).result.startId as string
    f.run({ type: 'agent.startDispatch', startId }, leadActor, { contribution })
    const reviewer = f.run({ type: 'agent.started', startId, harnessId: 'native-reviewer', configuration: { ...config, engine: 'claude' } }, leadActor, { contribution }).result.agentId as string
    const builder = f.add('builder', 'owner', group)
    return { f, lead, leadActor, group, reviewer, builder }
  }

  it('stores the role chosen at start and reads agents without one as Builders', () => {
    const { f, reviewer, builder } = reviewed()
    expect(f.state.agents.find(a => a.id === reviewer)).toHaveProperty('role', 'reviewer')
    expect(f.state.agents.find(a => a.id === builder)).not.toHaveProperty('role')
    expect(agentRole(f.state.agents.find(a => a.id === builder)!)).toBe('builder')
    expect(commandSchema.safeParse({ type: 'agent.start', request: request('g', { role: 'lead' }) }).success).toBe(false)
  })

  it('starts a Reviewer only on Claude Code or Codex', () => {
    const f = fixture(), group = f.group()
    expect(() => f.run({ type: 'agent.start', request: request(group, { role: 'reviewer', engine: 'opencode' }) } as Command, owner, { contribution })).toThrow('Claude Code or Codex')
  })

  it.each(['opencode', 'kilo'])('refuses %s for a Builder before a machine can launch it', engine => {
    const f = fixture(), group = f.group()
    const start = { type: 'agent.start', request: request(group, { engine }) }
    expect(commandSchema.safeParse(start).success).toBe(false)
    expect(() => f.run(start as Command, owner, { contribution })).toThrow('Claude Code or Codex')
  })

  it('does not add an existing OpenCode session as a Swarm member', () => {
    const f = fixture()
    expect(() => f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'open', name: 'Open',
      configuration: { ...config, engine: 'opencode' }, lead: false }, owner,
    { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })).toThrow('Claude Code or Codex')
    expect(f.state.agents).toHaveLength(0)
  })

  it('refuses to assign, route work to or make a Lead of a Reviewer', () => {
    const { f, leadActor, group, reviewer } = reviewed()
    expect(() => f.run({ type: 'work.assign', conversationId: group, agentId: reviewer })).toThrow('Reviewer')
    expect(() => f.run({ type: 'conversation.agent', conversationId: group, agentId: reviewer, present: true, lead: true })).toThrow('Reviewer')
    expect(() => f.run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId: 'native-reviewer', name: 'Reviewer', configuration: config, lead: true },
      owner, { contribution: { machineOwnerId: 'target-owner', contributorId: 'owner' } })).toThrow('cannot lead')
    expect(f.state.conversations.find(c => c.id === group)!.leadId).toBe(leadActor.agentId)
    const pick = record({ candidates: [candidate('c0', { kind: 'member', agentId: reviewer, machineId: 'host' })], pick: 'c0' })
    expect(() => f.run({ type: 'route.record', conversationId: group, decision: pick } as Command, leadActor)).toThrow('only review groups')
  })

  it('assigns a review group only to a Reviewer, which passes the reviewed group\'s independent check', () => {
    const { f, leadActor, group, reviewer, builder } = reviewed()
    const checks = [{ description: 'Verdict on the revision', independent: false }]
    const create = (reviewOf: string) => f.run({ type: 'conversation.create', title: 'Review: Offline editing', brief: 'Review head abc.', reviewOf, checks }, leadActor)
    expect(() => create('lead')).toThrow('one build group')
    const archived = f.group()
    f.run({ type: 'conversation.archive', conversationId: archived, archived: true })
    expect(() => create(archived)).toThrow('Reopen this conversation')
    const review = create(group).result.conversationId as string
    expect(() => create(review)).toThrow('one build group')
    expect(f.state.conversations.find(c => c.id === review)).toHaveProperty('reviewOf', group)
    expect(f.state.conversations.find(c => c.id === group)).not.toHaveProperty('reviewOf')
    const pick = (agentId: string) => record({ candidates: [candidate('c0', { kind: 'member', agentId, machineId: 'host' })], pick: 'c0' })
    expect(() => f.run({ type: 'route.record', conversationId: review, decision: pick(builder) } as Command, leadActor)).toThrow('only to a Reviewer')
    f.run({ type: 'route.record', conversationId: review, decision: pick(reviewer) } as Command, leadActor)
    expect(() => f.run({ type: 'work.assign', conversationId: review, agentId: builder })).toThrow('only to a Reviewer')
    const built = f.run({ type: 'work.assign', conversationId: group, agentId: builder }).result.assignmentId as string
    const assignmentId = f.run({ type: 'work.assign', conversationId: review, agentId: reviewer }).result.assignmentId as string
    const reviewerActor: Actor = { kind: 'agent', agentId: reviewer, machineOwnerId: 'target-owner' }
    const checkId = f.state.conversations.find(c => c.id === group)!.checks[0]!.id
    f.run({ type: 'work.check', conversationId: group, assignmentId: built, checkId, passed: true, evidence: 'Ready: yes — revision abc' }, reviewerActor)
    expect(f.state.conversations.find(c => c.id === group)!.checks[0]!.passedBy).toBe(`agent:${reviewer}`)
    // While its review is active it is busy; when it is done, the Lead decides its fate like a Builder's.
    expect(() => f.run({ type: 'agent.release', agentId: reviewer, decision: 'stop' }, leadActor)).toThrow('active work')
    f.run({ type: 'work.status', conversationId: review, assignmentId, status: 'stopped', result: null }, owner, { confirmedStopped: true })
    f.run({ type: 'work.cancel', conversationId: group, assignmentId: built, reason: 'Obsolete' }, leadActor)
    expect(f.state.agents.find(a => a.id === reviewer)).toHaveProperty('workDecision', 'awaiting')
    f.run({ type: 'agent.release', agentId: reviewer, decision: 'stop' }, leadActor)
  })

  it('tells the Lead and the group\'s Reviewers when work is ready for review', () => {
    const { f, lead, group, reviewer, builder } = reviewed()
    const other = f.group()
    f.run({ type: 'conversation.agent', conversationId: other, agentId: reviewer, present: true, lead: false })
    const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: builder }).result.assignmentId as string
    const builderActor: Actor = { kind: 'agent', agentId: builder, machineOwnerId: 'host-owner' }
    const ready = f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'review', result: 'Head abc123' }, builderActor)
    expect(ready.messages[0]!.recipients).toEqual([lead, reviewer])
    expect(f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'working', result: null }, builderActor).messages[0]!.recipients).toEqual([])
    // A Lead marking the work ready tells only the Reviewers; a Reviewer removed from the group is not told.
    expect(f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'review', result: 'Head def456' }, { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }).messages[0]!.recipients).toEqual([reviewer])
    f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'working', result: null }, builderActor)
    f.run({ type: 'conversation.agent', conversationId: group, agentId: reviewer, present: false, lead: false })
    expect(f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'review', result: 'Head 789' }, builderActor).messages[0]!.recipients).toEqual([lead])
  })

  it('does not wake a Reviewer that is stopping', () => {
    const { f, lead, leadActor, group, reviewer, builder } = reviewed()
    f.run({ type: 'agent.release', agentId: reviewer, decision: 'stop' }, leadActor)
    const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: builder }).result.assignmentId as string
    const ready = f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'review', result: 'Head abc' }, { kind: 'agent', agentId: builder, machineOwnerId: 'host-owner' })
    expect(ready.messages[0]!.recipients).toEqual([lead])
  })

  it('refuses to keep or stop a Reviewer while a group it is in has active work', () => {
    const { f, leadActor, group, reviewer, builder } = reviewed()
    const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: builder }).result.assignmentId as string
    for (const decision of ['keep', 'stop'] as const) {
      expect(() => f.run({ type: 'agent.release', agentId: reviewer, decision }, leadActor)).toThrow('reviewing active work')
    }
    f.run({ type: 'work.cancel', conversationId: group, assignmentId, reason: 'Obsolete' }, leadActor)
    f.run({ type: 'agent.release', agentId: reviewer, decision: 'stop' }, leadActor)
    expect(f.state.agents.find(a => a.id === reviewer)).toHaveProperty('workDecision', 'stop')
  })

  it('lets the Lead keep or stop a Reviewer that never had work, but not such a Builder', () => {
    const { f, leadActor, reviewer, builder } = reviewed()
    f.run({ type: 'agent.release', agentId: reviewer, decision: 'keep' }, leadActor)
    expect(f.state.agents.find(a => a.id === reviewer)).toHaveProperty('workDecision', 'keep')
    f.run({ type: 'agent.release', agentId: reviewer, decision: 'stop' }, leadActor)
    expect(f.state.agents.find(a => a.id === reviewer)).toHaveProperty('workDecision', 'stop')
    expect(() => f.run({ type: 'agent.release', agentId: builder, decision: 'stop' }, leadActor)).toThrow('no finished assignment')
  })

  it('makes the group\'s idle Reviewers await the Lead\'s decision when its work ends, and counts adding one to a group as reuse', () => {
    const { f, leadActor, group, reviewer, builder } = reviewed()
    const other = f.group(), busy = f.group(), otherBuilder = f.add('other-builder', 'owner', busy)
    f.run({ type: 'conversation.agent', conversationId: busy, agentId: leadActor.agentId, present: true, lead: true })
    const decision = (id: string) => f.state.agents.find(a => a.id === id)!.workDecision
    const finish = (g: string, worker: string) => {
      const assignmentId = f.run({ type: 'work.assign', conversationId: g, agentId: worker }).result.assignmentId as string
      return () => f.run({ type: 'work.cancel', conversationId: g, assignmentId, reason: 'Obsolete' }, leadActor)
    }
    // Still reviewing another group's active work: not awaiting yet.
    f.run({ type: 'conversation.agent', conversationId: busy, agentId: reviewer, present: true, lead: false })
    const endBusy = finish(busy, otherBuilder)
    finish(group, builder)()
    expect(decision(reviewer)).toBeUndefined()
    endBusy()
    expect(decision(reviewer)).toBe('awaiting')
    expect(visibleState(f.state, owner).agents.find(a => a.id === reviewer)).toHaveProperty('workDecision', 'awaiting')
    // Start, route and assign elsewhere wait for the decision (the Builders are decided first).
    f.run({ type: 'agent.release', agentId: builder, decision: 'keep' }, leadActor)
    f.run({ type: 'agent.release', agentId: otherBuilder, decision: 'keep' }, leadActor)
    f.run({ type: 'work.define', conversationId: other, brief: 'Next', checks: [{ description: 'Done', independent: false }] })
    expect(() => f.run({ type: 'work.assign', conversationId: other, agentId: builder, ...via }, leadActor, decisionIn(other))).toThrow('reuse, keep or stop')
    // Adding it to that group reuses it.
    f.run({ type: 'conversation.agent', conversationId: other, agentId: reviewer, present: true, lead: false })
    expect(decision(reviewer)).toBeUndefined()
    f.run({ type: 'work.assign', conversationId: other, agentId: builder, ...via }, leadActor, decisionIn(other))
  })

  it('keeps a Reviewer that stays in its group reused for that group\'s next attempt', () => {
    const { f, leadActor, group, reviewer, builder } = reviewed()
    const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: builder }).result.assignmentId as string
    f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'stopped', result: null }, owner, { confirmedStopped: true })
    expect(f.state.agents.find(a => a.id === reviewer)!.workDecision).toBe('awaiting')
    f.run({ type: 'work.define', conversationId: group, brief: 'Again', checks: [{ description: 'Done', independent: false }] })
    f.run({ type: 'work.assign', conversationId: group, agentId: builder, ...via }, leadActor, decisionIn(group))
    expect(f.state.agents.find(a => a.id === reviewer)).not.toHaveProperty('workDecision')
  })
})

describe('the owner\'s rules', () => {
  const asked = { askedIn: { conversationId: 'lead', messageId: 'm1' } }
  const said = (patch: Record<string, unknown> = {}) => ({ askedIn: { author: { kind: 'person', id: 'owner', name: owner.email, membershipGeneration: 'tab' },
    source: false, createdAt: 1000, ...patch } }) as Partial<CommandContext>
  const ownerSaid = said()
  const quoting = (messageId: string) => ({ askedIn: { conversationId: 'lead', messageId } })
  const set = (rule: Record<string, unknown>, text = 'No Haiku.') => ({ type: 'rule.set', rule, text } as Command)
  const startBy = (f: ReturnType<typeof routed>, actor: Actor, patch: Record<string, unknown> = {}) => f.run({ type: 'agent.start', request: { conversationId: 'lead', machineId: 'machine',
    engine: 'claude', model: 'opus', effort: 'high', name: 'Builder', cwd: '/repo', worktree: true,
    requirements: { memoryBytes: 1, diskBytes: 1, maxCpuPercent: 80, tools: [], devices: [], quotaRequired: false }, ...patch }, ...via } as Command, actor, { contribution: f.contribution, ...decisionIn() })

  it('lets the owner set, list and remove rules, and records who asked', () => {
    const f = routed()
    const added = f.run(set({ kind: 'forbidModel', model: 'haiku' }))
    expect(f.state.rules).toEqual([{ id: added.result.ruleId, projectId: 'lead', rule: { kind: 'forbidModel', model: 'haiku' }, text: 'No Haiku.', askedBy: 'owner', askedIn: null,
      addedBy: 'person:owner', createdAt: new Date(1000).toISOString() }])
    expect(added.messages[0]).toMatchObject({ conversationId: 'lead', text: 'Rule added: No Haiku.', source: { kind: 'rule' } })
    // Everyone in the Swarm reads the rules with the tab.
    expect(visibleState(f.state, f.leadActor).rules).toHaveLength(1)
    // A second list of machines replaces the first.
    f.run(set({ kind: 'machines', machineIds: ['m1'] }, 'Only m1.'))
    f.run(set({ kind: 'machines', machineIds: ['m2'] }, 'Only m2.'))
    expect(f.state.rules!.map(r => r.text)).toEqual(['No Haiku.', 'Only m2.'])
    expect(f.run({ type: 'rule.remove', ruleId: added.result.ruleId as string }).messages[0]!.text).toBe('Rule removed: No Haiku.')
    f.run({ type: 'rule.remove', ruleId: f.state.rules![0]!.id })
    expect(f.state).not.toHaveProperty('rules')
    expect(() => f.run({ type: 'rule.remove', ruleId: 'gone' })).toThrow('no such rule')
    for (let i = 0; i < 50; i++) f.run(set({ kind: 'preferIdle' }, `Rule ${i}.`))
    expect(() => f.run(set({ kind: 'preferIdle' }))).toThrow('50 rules')
    expect(() => f.run(set({ kind: 'minEffort', effort: 'huge' }))).toThrow()
  })
  it('lets the Lead change rules only by quoting the owner\'s message, and nobody else', () => {
    const f = routed()
    const added = f.run({ ...set({ kind: 'forbidModel', model: 'haiku' }), ...asked } as Command, f.leadActor, ownerSaid)
    expect(f.state.rules![0]).toMatchObject({ askedBy: 'owner', askedIn: asked.askedIn, addedBy: `agent:${f.lead}` })
    const relay = (messageId: string, context: Partial<CommandContext>) => f.run({ ...set({ kind: 'preferIdle' }), ...quoting(messageId) } as Command, f.leadActor, context)
    expect(() => f.run(set({ kind: 'preferIdle' }), f.leadActor, ownerSaid)).toThrow('quote a chat message the project owner wrote')
    expect(() => relay('m2', {})).toThrow('quote a chat message the project owner wrote')
    for (const author of [{ kind: 'person', id: 'peer' }, { kind: 'agent', id: 'owner' }]) {
      expect(() => relay('m2', said({ author }))).toThrow('quote a chat message the project owner wrote')
    }
    // The owner's own system rows ("Rule added", warnings) and a message older than a day do not count.
    expect(() => relay('m2', said({ source: true }))).toThrow('quote a chat message the project owner wrote')
    expect(() => relay('m2', said({ createdAt: 1000 - 24 * 3_600_000 - 1 }))).toThrow('quote a chat message the project owner wrote')
    // One message may ask for several rules.
    expect(relay('m1', ownerSaid).result.ruleId).toBeTruthy()
    expect(relay('m2', said({ createdAt: 1000 - 24 * 3_600_000 })).result.ruleId).toBeTruthy()
    expect(() => f.run({ ...set({ kind: 'preferIdle' }), ...asked } as Command, f.workerActor, ownerSaid)).toThrow('Only the project owner')
    f.invite()
    expect(() => f.run(set({ kind: 'preferIdle' }), peer)).toThrow('Only the project owner')
    expect(() => f.run({ type: 'rule.remove', ruleId: added.result.ruleId as string }, peer)).toThrow('Only the project owner')
    f.run({ type: 'rule.remove', ruleId: added.result.ruleId as string, ...asked }, f.leadActor, ownerSaid)
    expect(f.state.rules!.map(r => r.text)).toEqual(['No Haiku.', 'No Haiku.'])
  })
  it('refuses an agent\'s start that breaks a hard rule, whatever reason it gives', () => {
    const f = routed()
    expect(startBy(f, f.leadActor).result.startId).toBeTruthy()
    f.run(set({ kind: 'forbidModel', model: 'OPUS' }, 'No Opus.'))
    expect(() => startBy(f, f.leadActor)).toThrow('The owner\'s rule "No Opus." rules out Claude opus. Route again.')
    expect(startBy(f, f.leadActor, { model: 'sonnet' }).result.startId).toBeTruthy()
    f.run(set({ kind: 'minEffort', engine: 'claude', effort: 'high' }, 'High effort.'))
    expect(() => startBy(f, f.leadActor, { model: 'sonnet', effort: 'medium' })).toThrow('rules out Claude at medium effort')
    expect(() => startBy(f, f.leadActor, { model: 'sonnet', effort: undefined })).toThrow('rules out Claude at an unnamed effort')
    expect(startBy(f, f.leadActor, { model: 'sonnet', effort: 'max' }).result.startId).toBeTruthy()
    f.run(set({ kind: 'machines', machineIds: ['elsewhere'] }, 'Only elsewhere.'))
    expect(() => startBy(f, f.leadActor, { model: 'sonnet' })).toThrow('The owner\'s rule "Only elsewhere." rules out this machine (it allows only elsewhere).')
  })
  it('lets a person through with a warning the group sees', () => {
    const f = routed()
    f.run(set({ kind: 'forbidModel', model: 'opus' }, 'No Opus.'))
    const effects = startBy(f, owner)
    expect(effects.result).toMatchObject({ startId: expect.any(String), warnings: ['The owner\'s rule "No Opus." rules out Claude opus.'] })
    expect(effects.messages).toEqual(expect.arrayContaining([expect.objectContaining({ conversationId: 'lead',
      text: 'owner started Builder anyway. The owner\'s rule "No Opus." rules out Claude opus.', source: { kind: 'rule' } })]))
  })
  it('refuses an agent\'s assignment of a worker that breaks a hard rule, with the effort it was launched with', () => {
    const f = routed()
    f.define('lead')
    f.run(set({ kind: 'forbidModel', engine: 'codex', model: 'test' }, 'No test model.'))
    expect(() => f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker, ...via }, f.leadActor, decisionIn())).toThrow('rules out Codex test-model')
    const effects = f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker })
    expect(effects.result.warnings).toEqual(['The owner\'s rule "No test model." rules out Codex test-model.'])
    expect(effects.messages.map(m => m.text)).toContain('owner assigned worker anyway. The owner\'s rule "No test model." rules out Codex test-model.')
    // An agent that reports `auto` is held to the effort its start asked for.
    const worker = f.state.agents.find(a => a.id === f.worker)!
    worker.configuration.effort = 'auto'
    const rule = [{ id: 'r', rule: { kind: 'minEffort', effort: 'high' } as const, text: 'High.', askedBy: 'owner', askedIn: null, addedBy: 'person:owner', createdAt: '' }]
    expect(broken(rule, agentTarget(f.state, worker))).toContain('an unnamed effort')
    f.state.starts = [{ harnessId: worker.harnessId, request: { machineId: worker.machineId, effort: 'xhigh' } } as never]
    expect(broken(rule, agentTarget(f.state, worker))).toBeNull()
  })
  it('refuses a recorded pick that breaks a hard rule, but not a ruled-out candidate that was not picked', () => {
    const f = routed()
    const route = (decision: unknown) => f.run({ type: 'route.record', conversationId: 'lead', decision } as Command, f.leadActor, { recentRoutes: 0 })
    f.run(set({ kind: 'forbidModel', model: 'sonnet' }, 'No Sonnet.'))
    expect(route(record()).result.routeDecisionId).toBeTruthy()
    expect(() => route(record({ pick: 'c1' }))).toThrow('The owner\'s rule "No Sonnet." rules out Claude sonnet.')
    // A member pick is judged by what the member runs now.
    const member = record({ candidates: [candidate('c0', { kind: 'member', agentId: f.worker, machineId: 'host', engine: 'codex', model: 'other' })] })
    f.run(set({ kind: 'forbidModel', model: 'test-model' }, 'No test model.'))
    expect(() => route(member)).toThrow('rules out Codex test-model')
  })
  it('lets a person override to a ruled-out candidate with a warning', () => {
    const f = routed()
    f.run(set({ kind: 'forbidModel', model: 'sonnet' }, 'No Sonnet.'))
    const open = { id: 'd1', conversationId: 'lead', record: record(), final: null, override: null, assignmentId: null, outcome: null } as unknown as RouteDecision
    const effects = f.run({ type: 'route.override', decisionId: 'd1', candidateId: 'c1', reason: 'Because.' }, owner, { routeDecision: open })
    expect(effects.result.warnings).toEqual(['The owner\'s rule "No Sonnet." rules out Claude sonnet.'])
  })
})

describe('the owner\'s rules in a Swarm of projects', () => {
  // Backend v1.3.14: once the original 'lead' project is gone, every Lead rule.set failed NOT_FOUND.
  const said = (patch: Record<string, unknown> = {}) => ({ askedIn: { author: { kind: 'person', id: 'owner', name: owner.email, membershipGeneration: 'tab' },
    source: false, createdAt: 1000, ...patch } }) as Partial<CommandContext>
  function projects() {
    const f = fixture(); f.invite()
    const app = f.run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }).result.conversationId as string
    const site = f.run({ type: 'project.create', name: 'Site', visibility: 'public', brief: '' }).result.conversationId as string
    f.run({ type: 'project.delete', projectId: 'lead' })
    const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
    return { ...f, get state() { return f.state }, app, site, lead: agentActor(f.add('app-lead', 'owner', app, true)),
      worker: agentActor(f.add('app-worker', 'owner', app)), siteLead: agentActor(f.add('site-lead', 'owner', site, true)) }
  }
  const machines = (conversationId: string, messageId = 'm1') => ({ type: 'rule.set', rule: { kind: 'machines', machineIds: ['m1'] }, text: 'Only m1.',
    askedIn: { conversationId, messageId } }) as Command

  it('lets a project\'s Lead set a rule by quoting the owner in that project\'s chat, and posts the row there', () => {
    const f = projects()
    const added = f.run(machines(f.app), f.lead, said())
    expect(f.state.rules).toEqual([expect.objectContaining({ rule: { kind: 'machines', machineIds: ['m1'] }, askedIn: { conversationId: f.app, messageId: 'm1' },
      addedBy: `agent:${f.lead.kind === 'agent' && f.lead.agentId}` })])
    expect(added.messages).toEqual([expect.objectContaining({ conversationId: f.app, text: 'Rule added: Only m1.', source: { kind: 'rule' } })])
    const removed = f.run({ type: 'rule.remove', ruleId: added.result.ruleId as string, askedIn: { conversationId: f.app, messageId: 'm2' } }, f.lead, said())
    expect(f.state).not.toHaveProperty('rules')
    expect(removed.messages).toEqual([expect.objectContaining({ conversationId: f.app, text: 'Rule removed: Only m1.', source: { kind: 'rule' } })])
  })
  it('posts the owner\'s own rule rows in the quoted project, or else in a remaining Lead chat', () => {
    const f = projects()
    expect(f.run(machines(f.site)).messages[0]!.conversationId).toBe(f.site)
    expect(f.run({ type: 'rule.set', rule: { kind: 'preferIdle' }, text: 'Idle first.' }).messages[0]!.conversationId).toBe(f.app)
  })
  it('refuses another project\'s Lead, a worker, a collaborator, a system row and an old message', () => {
    const f = projects()
    expect(() => f.run(machines(f.app), f.siteLead, said())).toThrow('unavailable')
    expect(() => f.run(machines(f.app), f.worker, said())).toThrow('Only the project owner')
    expect(() => f.run(machines(f.app), peer, said({ author: { kind: 'person', id: 'peer' } }))).toThrow('Only the project owner')
    expect(() => f.run(machines(f.app), f.lead, said({ source: true }))).toThrow('quote a chat message the project owner wrote')
    expect(() => f.run(machines(f.app), f.lead, said({ createdAt: 1000 - 24 * 3_600_000 - 1 }))).toThrow('quote a chat message the project owner wrote')
    expect(f.state).not.toHaveProperty('rules')
  })
  const projectIdOf = (f: ReturnType<typeof projects>, conversationId: string) => f.state.conversations.find(c => c.id === conversationId)!.projectId!
  const forbid = (projectId: string, model: string) => ({ type: 'rule.set', projectId, rule: { kind: 'forbidModel', model }, text: `No ${model}.` }) as Command

  it('applies a project\'s rules only to that project\'s groups', () => {
    // 2026-10-23: one project's rules (three machines, no Haiku, high effort) refused every other project's Lead.
    const f = projects(), app = projectIdOf(f, f.app)
    f.run(forbid(app, 'sonnet')); f.run(forbid(app, 'test-model'))
    expect(f.state.rules!.map(r => r.projectId)).toEqual([app, app])
    const route = (conversationId: string, actor: Actor) => f.run({ type: 'route.record', conversationId, decision: record({ pick: 'c1' }) } as Command, actor, { recentRoutes: 0 })
    expect(route(f.site, f.siteLead).result.routeDecisionId).toBeTruthy()
    expect(() => route(f.app, f.lead)).toThrow('The owner\'s rule "No sonnet." rules out Claude sonnet.')
    const siteWorker = f.add('site-worker', 'owner', f.site)
    const assign = (conversationId: string, agentId: string) => {
      f.run({ type: 'work.define', conversationId, brief: 'Build it.', checks: [{ description: 'Tests pass.', independent: false }] })
      return f.run({ type: 'work.assign', conversationId, agentId })
    }
    expect(assign(f.site, siteWorker).result.warnings).toBeUndefined()
    expect(assign(f.app, f.worker.kind === 'agent' ? f.worker.agentId : '').result.warnings).toEqual(['The owner\'s rule "No test-model." rules out Codex test-model.'])
  })
  it('keeps one machines list and the rule limit per project', () => {
    const f = projects(), app = projectIdOf(f, f.app), site = projectIdOf(f, f.site)
    const machinesIn = (projectId: string, machineId: string) => f.run({ type: 'rule.set', projectId, rule: { kind: 'machines', machineIds: [machineId] }, text: `Only ${machineId}.` } as Command)
    machinesIn(app, 'm1'); machinesIn(site, 'm2'); machinesIn(app, 'm3')
    expect(f.state.rules!.map(r => [r.projectId, r.text])).toEqual([[site, 'Only m2.'], [app, 'Only m3.']])
    for (let i = 0; i < 49; i++) f.run({ type: 'rule.set', projectId: app, rule: { kind: 'preferIdle' }, text: `Rule ${i}.` } as Command)
    expect(() => f.run(forbid(app, 'haiku'))).toThrow('50 rules')
    expect(f.run(forbid(site, 'haiku')).result.ruleId).toBeTruthy()
  })
  it('moves Swarm-level rules to the project they were asked in, else to the Lead chat\'s project', () => {
    const f = projects(), app = projectIdOf(f, f.app), site = projectIdOf(f, f.site)
    const old = (id: string, askedIn: { conversationId: string; messageId: string } | null) =>
      ({ id, rule: { kind: 'preferIdle' } as const, text: id, askedBy: 'owner', askedIn, addedBy: 'person:owner', createdAt: '' })
    f.state.rules = [old('site', { conversationId: f.site, messageId: 'm1' }), old('direct', null), old('gone', { conversationId: 'deleted', messageId: 'm2' })]
    expect(visibleState(f.state, owner).rules!.map(r => r.projectId)).toEqual([site, app, app])
    f.run({ type: 'project.cadence', projectId: app, minutes: 1 })
    expect(f.state.rules!.map(r => r.projectId)).toEqual([site, app, app])
    f.run({ type: 'project.delete', projectId: site })
    expect(f.state.rules!.map(r => r.id)).toEqual(['direct', 'gone'])
  })
  it('lets the project owner set its rules directly, and refuses the Swarm owner and Leads for another person\'s project', () => {
    const f = projects()
    const mine = f.run({ type: 'project.create', name: 'Peer', visibility: 'private', brief: '' }, peer).result as { projectId: string; conversationId: string }
    const added = f.run(forbid(mine.projectId, 'haiku'), peer)
    expect(added.messages).toEqual([expect.objectContaining({ conversationId: mine.conversationId, text: 'Rule added: No haiku.', source: { kind: 'rule' } })])
    expect(f.state.rules![0]).toMatchObject({ projectId: mine.projectId, askedBy: 'peer', askedIn: null, addedBy: 'person:peer' })
    expect(visibleState(f.state, owner).rules).toEqual([])
    expect(() => f.run(forbid(mine.projectId, 'opus'))).toThrow('unavailable')
    f.run({ type: 'project.sharing', projectId: mine.projectId, visibility: 'public', memberIds: [] }, peer)
    expect(() => f.run(forbid(mine.projectId, 'opus'))).toThrow('Only the project owner')
    expect(() => f.run({ type: 'rule.remove', ruleId: added.result.ruleId as string })).toThrow('Only the project owner')
    expect(() => f.run({ ...forbid(projectIdOf(f, f.app), 'opus'), projectId: undefined, askedIn: { conversationId: f.app, messageId: 'm1' } } as Command,
      f.lead, said({ author: { kind: 'person', id: 'peer' } }))).toThrow('quote a chat message the project owner wrote')
    expect(() => f.run({ ...forbid(projectIdOf(f, f.site), 'opus'), askedIn: { conversationId: f.app, messageId: 'm1' } } as Command, f.lead, said())).toThrow('unavailable')
    f.run({ type: 'rule.remove', ruleId: added.result.ruleId as string }, peer)
    expect(f.state).not.toHaveProperty('rules')
  })
  it('tells each project\'s Lead chat which of its starts were abandoned when the machine joins', () => {
    const f = projects()
    const start = (id: string, conversationId: string, name: string) => ({ id, request: { conversationId, machineId: 'mac', name }, error: null })
    f.state.starts = [start('s1', f.app, 'Builder'), start('s2', f.site, 'Writer'), start('s3', f.app, 'Reviewer')] as never
    const joined = f.run({ type: 'machine.contribute', machineId: 'mac', name: 'Mac', cwd: '/swarm', engines: ['codex'], maxAgents: 2 },
      owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' }, abandonedStartIds: ['s1', 's2', 's3'] })
    expect(joined.messages.map(m => [m.conversationId, m.text])).toEqual([
      [f.app, 'Builder, Reviewer never started and will not start now. Start them again if still needed.'],
      [f.site, 'Writer never started and will not start now. Start it again if still needed.']])
    expect(new Set(joined.messages.map(m => m.id)).size).toBe(2)
  })
})

it('marks every row the system writes in the owner\'s name, so a Lead cannot quote it as the owner asking for a rule', () => {
  const f = fixture(); f.invite()
  const rows: { text: string; source?: unknown }[] = []
  const run = (command: Command, context: Partial<CommandContext> = {}) => { const effects = f.run(command, owner, context); rows.push(...effects.messages); return effects }
  f.add('lead', 'owner', 'lead', true)
  const group = run({ type: 'conversation.create', title: 'Drafts', brief: 'Save drafts.', checks: [{ description: 'Saved.', independent: false }] }).result.conversationId as string
  const worker = f.add('worker', 'owner', group)
  run({ type: 'work.define', conversationId: group, brief: 'Save drafts offline.', checks: [{ description: 'Saved.', independent: false }] })
  const assignmentId = run({ type: 'work.assign', conversationId: group, agentId: worker }).result.assignmentId as string
  run({ type: 'work.status', conversationId: group, assignmentId, status: 'blocked', result: 'Waiting.' })
  run({ type: 'delivery.resolve', deliveryId: 'd1', resolution: 'received' },
    { delivery: { id: 'd1', conversationId: group, agentId: worker, messageId: 'm1', text: 'Earlier.' } })
  run({ type: 'delivery.resolve', deliveryId: 'd2', resolution: 'resend' },
    { delivery: { id: 'd2', conversationId: group, agentId: worker, messageId: 'm2', text: 'Earlier.' } })
  run({ type: 'work.cancel', conversationId: group, assignmentId, reason: 'Obsolete.' })
  run({ type: 'agent.remove', agentId: worker })
  const start = (id: string) => ({ id, actorKey: 'person:owner', contributorId: 'owner', membershipGeneration: f.state.people[0]!.generation,
    request: { conversationId: 'lead', machineId: 'mac', name: 'Builder' }, error: null })
  f.state.starts = [start('s1'), start('s2')] as never
  run({ type: 'agent.startFailed', startId: 's1', error: 'Launch refused.' })
  run({ type: 'machine.contribute', machineId: 'mac', name: 'Mac', cwd: '/swarm', engines: ['codex'], maxAgents: 2 },
    { contribution: { machineOwnerId: 'owner', contributorId: 'owner' }, abandonedStartIds: ['s2'] })
  expect(rows.map(r => r.text)).toEqual(expect.arrayContaining(['Builder never started and will not start now. Start it again if still needed.',
    'Could not start Builder: Launch refused.', 'owner removed worker from the Swarm.']))
  expect(rows.filter(r => !r.source).map(r => r.text)).toEqual([])
})

describe('the owner\'s rules, after review', () => {
  const set = (rule: Record<string, unknown>, text = 'Rule.') => ({ type: 'rule.set', rule, text } as Command)
  const request = (patch: Record<string, unknown> = {}) => ({ conversationId: 'lead', machineId: 'machine', engine: 'claude', model: 'opus', effort: 'high', name: 'Builder',
    cwd: '/repo', worktree: true, requirements: { memoryBytes: 1, diskBytes: 1, maxCpuPercent: 80, tools: [], devices: [], quotaRequired: false }, ...patch })
  it('checks an agent joining or leading a group, and never one leaving it', () => {
    const f = routed(), group = f.group()
    f.run(set({ kind: 'forbidModel', model: 'test-model' }, 'No test model.'))
    expect(() => f.run({ type: 'conversation.agent', conversationId: 'lead', agentId: f.worker, present: true, lead: false }, f.leadActor))
      .toThrow('The owner\'s rule "No test model." rules out Codex test-model. Route again.')
    const byHand = f.run({ type: 'conversation.agent', conversationId: group, agentId: f.worker, present: true, lead: true })
    expect(byHand.result.warnings).toEqual(['The owner\'s rule "No test model." rules out Codex test-model.'])
    expect(byHand.messages[0]).toMatchObject({ text: 'owner added worker anyway. The owner\'s rule "No test model." rules out Codex test-model.' })
    expect(f.run({ type: 'conversation.agent', conversationId: 'lead', agentId: f.worker, present: false, lead: false }, f.leadActor).messages).toEqual([])
  })
  it('does not launch a start recorded before a rule, unless a person chose it', () => {
    const f = routed()
    const startId = f.run({ type: 'agent.start', request: request(), ...via } as Command, f.leadActor, { contribution: f.contribution, ...decisionIn() }).result.startId as string
    f.run(set({ kind: 'minEffort', effort: 'max' }, 'Max effort.'))
    expect(() => f.run({ type: 'agent.startDispatch', startId }, f.leadActor, { contribution: f.contribution }))
      .toThrow('The owner\'s rule "Max effort." rules out Claude at high effort. This start was not launched. Route again.')
    const chosen = decisionIn().routeDecision
    f.run({ type: 'agent.startDispatch', startId }, f.leadActor, { contribution: f.contribution, routeDecision: { ...chosen, override: { by: 'person', actorKey: 'person:owner', candidateId: 'c0', reason: 'r' } } })
    expect(f.state.starts!.find(s => s.id === startId)!.dispatched).toBe(true)
    // A person's own start is launched; the warning was given when it was asked for.
    const own = f.run({ type: 'agent.start', request: request() } as Command, owner, { contribution: f.contribution }).result.startId as string
    expect(f.run({ type: 'agent.startDispatch', startId: own }, owner, { contribution: f.contribution }).messages).toEqual([])
  })
  it('lets the Lead carry out a person\'s override to a ruled-out candidate, and nothing else', () => {
    const f = routed()
    f.run(set({ kind: 'forbidModel', model: 'sonnet' }, 'No Sonnet.'))
    const decision = { ...decisionIn().routeDecision, override: { by: 'person', actorKey: 'person:owner', candidateId: 'c1', reason: 'Opus is busy.' } } as RouteDecision
    const sonnet = request({ model: 'sonnet' })
    const effects = f.run({ type: 'agent.start', request: sonnet, routeDecisionId: 'd1' } as Command, f.leadActor, { contribution: f.contribution, routeDecision: decision })
    expect(effects.result.warnings).toEqual(['The owner\'s rule "No Sonnet." rules out Claude sonnet.'])
    // Without the person's choice the same start is refused, and a reason of the Lead's own does not get past it.
    expect(() => f.run({ type: 'agent.start', request: sonnet, ...via } as Command, f.leadActor, { contribution: f.contribution, ...decisionIn() })).toThrow('Route again')
    // The person chose sonnet; the Lead starting something else that breaks a rule is still refused.
    f.run(set({ kind: 'forbidModel', model: 'opus' }, 'No Opus.'))
    expect(() => f.run({ type: 'agent.start', request: request(), routeDecisionId: 'd1', overrideReason: 'Mine.' } as Command, f.leadActor, { contribution: f.contribution, routeDecision: decision })).toThrow('No Opus.')
    // An assignment that carries out the person's choice of a member goes through too.
    f.define('lead')
    const member = { ...decision, record: record({ candidates: [candidate('c0'), candidate('c1', { kind: 'member', agentId: f.worker, machineId: 'host', engine: 'codex', model: 'test-model' })] }) } as unknown as RouteDecision
    f.run(set({ kind: 'forbidModel', model: 'test' }, 'No test model.'))
    expect(f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker, routeDecisionId: 'd1' }, f.leadActor, { routeDecision: member }).result.warnings).toHaveLength(1)
  })
  it('matches a model as the owner named it: an alias for a full id, and never an unknown default', () => {
    const rule = (model: string) => [{ id: 'r', rule: { kind: 'forbidModel', model } as const, text: 'R.', askedBy: 'owner', askedIn: null, addedBy: 'person:owner', createdAt: '' }]
    const target = (model: string | null) => ({ machineId: 'm', engine: 'claude', model, effort: 'high' })
    expect(broken(rule('claude-haiku-4-5'), target('haiku'))).toContain('R.')
    expect(broken(rule('haiku'), target('claude-haiku-4-5'))).toContain('R.')
    expect(broken(rule('claude-haiku-4-5'), target('sonnet'))).toBeNull()
    expect(broken(rule('claude-haiku-4-5'), target('claude-haiku-3'))).toBeNull()
    for (const model of ['def', 'default']) {
      expect(broken(rule(model), target('default'))).toBeNull()
      expect(broken(rule(model), target(null))).toBeNull()
    }
  })
})

describe('machine.remove', () => {
  const observationAt = (receivedAt: number) => ({ generation: 'g1', receivedAt,
    resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null,
      projectDiskFreeBytes: null, deviceType: null, chip: null, os: null, gpuPercent: null },
    tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] })
  /** A contributed machine, online unless it is given no reading or an old one (the fixture's now is 1000). */
  const contribute = (f: ReturnType<typeof fixture>, contributorId = 'owner', machineId = 'host', receivedAt: number | null = 1000) => {
    const generation = f.state.people.find(p => p.id === contributorId)!.generation
    f.state.machines = [...(f.state.machines ?? []), { machineId, name: 'Studio', contributorId, membershipGeneration: generation, generation: 'g1',
      cwd: '/repo', engines: ['claude'], maxAgents: 2, paused: false, ...(receivedAt === null ? {} : { observation: observationAt(receivedAt) }) } as never]
  }
  const start = (f: ReturnType<typeof fixture>, group: string, dispatched = false) => {
    f.state.starts = [...(f.state.starts ?? []), { id: `start-${(f.state.starts ?? []).length}`, creationId: 'creation', actorKey: 'agent:lead', contributorId: 'owner',
      membershipGeneration: f.state.people[0]!.generation, machineOwnerId: 'host-owner', hostGrant: null, ...(dispatched ? { dispatched: true } : {}),
      request: { conversationId: group, machineId: 'host', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
        requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } } as never]
  }

  it('takes the machine out with the Swarm\'s agents on it, and tells each group whose task needs a new worker', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group(), worker = f.add('worker', 'owner', group)
    f.state.agents.find(a => a.id === lead)!.machineId = 'elsewhere'
    contribute(f)
    f.run({ type: 'work.assign', conversationId: group, agentId: worker })
    f.state.harnessReservations = [{ machineId: 'host', harnessId: 'old', generation: 'g0', renewed: false }, { machineId: 'elsewhere', harnessId: 'x', generation: 'g0', renewed: false }]
    const named = (id: string) => { const a = f.state.agents.find(x => x.id === id)!; return a.displayName ?? a.name }
    const workerName = named(worker)
    const effects = f.run({ type: 'machine.remove', machineId: 'host' })

    expect(f.state.machines).toEqual([expect.objectContaining({ machineId: 'host', paused: true,
      removal: { id: effects.result.removalId, state: 'cleaning', requestedAt: new Date(1000).toISOString() } })])
    expect(f.state.agents.map(a => a.id)).toEqual([lead])
    expect(effects.result.removedAgents).toEqual([worker])
    expect(f.state.harnessReservations).toEqual([expect.objectContaining({ machineId: 'elsewhere' })])
    expect(f.state.conversations.find(c => c.id === group)!.assignment!.status).toBe('reconciling')
    const notice = effects.messages.find(m => m.conversationId === group)!
    expect(notice).toMatchObject({ author: { kind: 'person', id: 'owner' }, source: { kind: 'system' } })
    expect(notice.text).toBe(`owner removed Studio from the Swarm, and ${workerName} with it. Its task "Offline editing" needs to be assigned again or closed.`)
    expect(notice.recipients).toEqual([lead])
    expect(effects.messages.map(m => m.conversationId)).toEqual([group])
    expect(new Set(effects.messages.map(m => m.id)).size).toBe(effects.messages.length)
  })

  it('removes a machine that only runs agents, so nothing lists it any more', () => {
    const f = fixture(), worker = f.add('worker')
    f.run({ type: 'machine.remove', machineId: 'host' })
    expect(f.state.agents.some(a => a.id === worker)).toBe(false)
    expect(f.state.machines ?? []).toEqual([])
  })

  it('fails the starts still waiting for it, and waits for one already launching', () => {
    const f = fixture(), group = f.group()
    contribute(f)
    start(f, group)
    const effects = f.run({ type: 'machine.remove', machineId: 'host' })
    expect(f.state.starts![0]!.error).toBe('Its machine was removed from the Swarm.')
    expect(effects.messages).toEqual([expect.objectContaining({ conversationId: group, text: 'Builder will not start: its machine was removed from the Swarm.' })])

    const g = fixture(), other = g.group()
    contribute(g)
    start(g, other, true)
    expect(() => g.run({ type: 'machine.remove', machineId: 'host' })).toThrow(expect.objectContaining({ code: 'STARTS_PENDING' }))
    expect(g.state.machines).toHaveLength(1)
  })

  it('is only the machine owner\'s to remove, with every Swarm agent on it; the Swarm owner cannot remove another person\'s machine', () => {
    const f = fixture()
    f.invite()
    contribute(f, 'peer')
    f.add('theirs', 'peer')
    const owners = f.add('owners', 'owner')
    expect(() => f.run({ type: 'machine.remove', machineId: 'host' })).toThrow(expect.objectContaining({ code: 'FORBIDDEN', status: 403,
      message: 'Only the machine\'s owner can remove it.' }))
    f.run({ type: 'machine.remove', machineId: 'host' }, peer)
    expect(f.state.agents.some(a => a.id === owners)).toBe(false)
    expect(f.state.machines!.map(m => m.removal?.state)).toEqual(['cleaning'])

    // A machine nobody contributed, with only shared agents, is theirs whose agents they all are.
    const g = fixture()
    g.invite()
    g.add('mine', 'peer')
    g.add('owners', 'owner')
    expect(() => g.run({ type: 'machine.remove', machineId: 'host' }, peer)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => g.run({ type: 'machine.remove', machineId: 'host' })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  })

  const cleaning = () => {
    const f = fixture(), group = f.group()
    contribute(f)
    const removalId = f.run({ type: 'machine.remove', machineId: 'host' }).result.removalId as string
    return { f, group, removalId }
  }
  const cleaned = (removalId: string): Command => ({ type: 'machine.cleaned', machineId: 'host', removalId })

  it('keeps the machine paused and cleaning: no start, pause, re-adding or second removal until its owner\'s host says it cleaned up', () => {
    const { f, group, removalId } = cleaning()
    const request = { conversationId: group, machineId: 'host', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    expect(() => f.run({ type: 'agent.start', request }, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })).toThrow('being removed')
    expect(() => f.run({ type: 'machine.pause', machineId: 'host', paused: false })).toThrow('being removed')
    expect(() => f.run({ type: 'machine.remove', machineId: 'host' })).toThrow('being removed')
    const add = { type: 'machine.contribute', machineId: 'host', name: 'Studio', cwd: '/repo', engines: ['claude'], maxAgents: 2 } as Command
    expect(() => f.run(add, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })).toThrow('still cleaning up')
    f.invite()
    expect(() => f.run(cleaned(removalId), peer)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => f.run(cleaned('other'))).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    f.run(cleaned(removalId))
    expect(f.state.machines).toEqual([])
    expect(() => f.run(cleaned(removalId))).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    f.run(add, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
    expect(f.state.machines!.map(m => m.removal)).toEqual([undefined])
  })

  it('lets the machine owner\'s host acknowledge after the owner left the Swarm', () => {
    const f = fixture()
    f.invite()
    contribute(f, 'peer')
    const removalId = f.run({ type: 'machine.remove', machineId: 'host' }, peer).result.removalId as string
    f.run({ type: 'member.remove', userId: 'peer' }, peer)
    expect(f.state.machines!.map(m => m.removal?.id)).toEqual([removalId])
    f.run(cleaned(removalId), peer)
    expect(f.state.machines).toEqual([])
  })

  it('drops the machine\'s records after 24 hours without an acknowledgement, and keeps the cleanup for its host', () => {
    const { f, removalId } = cleaning()
    const day = 24 * 3_600_000
    // Its host keeps reporting, so only the day-long fallback can expire it.
    f.state.machines![0]!.observation!.receivedAt = 1000 + day - 1
    f.run({ type: 'tab.rename', name: 'Still cleaning' }, owner, { now: 1000 + day - 1 })
    expect(f.state.machines!.map(m => m.removal?.id)).toEqual([removalId])
    expect(visibleState(f.state, owner, 1000 + day).machines).toEqual([])
    f.run({ type: 'tab.rename', name: 'A day later' }, owner, { now: 1000 + day })
    expect(f.state.machines).toEqual([])
    expect(f.state.machineCleanups).toEqual([{ machineId: 'host', removalId, machineOwnerId: 'owner' }])
    const add = { type: 'machine.contribute', machineId: 'host', name: 'Studio', cwd: '/repo', engines: ['claude'], maxAgents: 2 } as Command
    expect(() => f.run(add, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' }, now: 1000 + day })).toThrow('still cleaning up')
    f.run(cleaned(removalId), owner, { now: 1000 + day })
    expect(f.state.machineCleanups).toBeUndefined()
  })

  it.each([['has no reading', null], ['was last read long ago', 1000 - 45_001]] as const)(
    'drops a machine that is offline (%s) at once, and keeps its cleanup for its host', (_why, receivedAt) => {
      const f = fixture()
      contribute(f, 'owner', 'host', receivedAt)
      // Listed, if offline, until its owner removes it.
      expect(visibleState(f.state, owner).machines).toHaveLength(1)
      const effects = f.run({ type: 'machine.remove', machineId: 'host' })
      const removalId = effects.result.removalId as string
      expect(f.state.machines).toEqual([])
      expect(f.state.machineCleanups).toEqual([{ machineId: 'host', removalId, machineOwnerId: 'owner' }])
      expect(visibleState(f.state, owner).machines).toEqual([])
      // Its host still gets the cleanup on its next connection; its later acknowledgement closes it and changes nothing else.
      f.run(cleaned(removalId))
      expect(f.state.machineCleanups).toBeUndefined()
      expect(f.state.machines).toEqual([])
    })

  it('drops a machine already cleaning once it is offline, on the next read and on the next change', () => {
    const { f, removalId } = cleaning()
    const later = 1000 + 45_001
    // A read that finds it offline leaves it out without writing.
    expect(visibleState(f.state, owner, later).machines).toEqual([])
    expect(visibleState(f.state, owner, later).machineCleanups).toBeUndefined()
    expect(f.state.machines).toEqual([expect.objectContaining({ machineId: 'host' })])
    // The next change applies the same rule and keeps the cleanup for its host.
    f.run({ type: 'tab.rename', name: 'Still cleaning' }, owner, { now: later })
    expect(f.state.machines).toEqual([])
    expect(f.state.machineCleanups).toEqual([{ machineId: 'host', removalId, machineOwnerId: 'owner' }])
    f.run(cleaned(removalId))
    expect(f.state.machineCleanups).toBeUndefined()
  })

  it('keeps a machine that is still online cleaning until its host acknowledges', () => {
    const { f, removalId } = cleaning()
    expect(visibleState(f.state, owner, 1000 + 45_000).machines).toEqual([
      expect.objectContaining({ machineId: 'host', paused: true, removal: { id: removalId, state: 'cleaning', requestedAt: new Date(1000).toISOString() } })])
    expect(f.state.machineCleanups).toBeUndefined()
    f.run({ type: 'tab.rename', name: 'Still online' }, owner, { now: 1000 + 45_000 })
    expect(f.state.machines!.map(m => m.removal?.id)).toEqual([removalId])
    f.run(cleaned(removalId))
    expect(f.state.machines).toEqual([])
  })

  it('takes the machine out of every project\'s machines rule, telling each project\'s chat, and removes a rule left empty', () => {
    const f = fixture()
    contribute(f)
    const docs = f.run({ type: 'project.create', name: 'Docs', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
    const rule = (id: string, projectId: string, machineIds: string[]) => ({ id, projectId, rule: { kind: 'machines' as const, machineIds },
      text: `Only ${machineIds.join(' and ')}.`, askedBy: 'owner', askedIn: null, addedBy: 'person:owner', createdAt: '' })
    f.state.rules = [rule('both', 'lead', ['host', 'other']), rule('only', docs.projectId, ['host']), rule('elsewhere', docs.projectId, ['other']),
      { ...rule('effort', 'lead', ['x']), rule: { kind: 'minEffort', effort: 'high' } }]
    const effects = f.run({ type: 'machine.remove', machineId: 'host' })
    expect(f.state.rules!.map(r => [r.id, r.rule])).toEqual([['both', { kind: 'machines', machineIds: ['other'] }],
      ['elsewhere', { kind: 'machines', machineIds: ['other'] }], ['effort', { kind: 'minEffort', effort: 'high' }]])
    // The owner's words stay as they were; the row says what the rule allows now.
    expect(f.state.rules![0]!.text).toBe('Only host and other.')
    expect(effects.messages).toEqual([
      expect.objectContaining({ conversationId: 'lead', source: { kind: 'rule' },
        text: 'Rule changed: Studio left the Swarm, so "Only host and other." now allows only other.' }),
      expect.objectContaining({ conversationId: docs.conversationId, source: { kind: 'rule' },
        text: 'Rule removed: Only host. Its only machine, Studio, left the Swarm.' })])
  })

  it.each(['leaves', 'is removed'] as const)('puts the machines of a person who %s through the same removal', how => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
    f.state.agents.find(a => a.id === lead)!.machineId = 'elsewhere'
    f.invite()
    contribute(f, 'peer')
    const worker = f.add('worker', 'peer', group), owners = f.add('owners', 'owner')
    f.run({ type: 'work.assign', conversationId: group, agentId: worker })
    f.state.rules = [{ id: 'both', projectId: 'lead', rule: { kind: 'machines', machineIds: ['host', 'elsewhere'] }, text: 'Only these two.',
      askedBy: 'owner', askedIn: null, addedBy: 'person:owner', createdAt: '' }]
    const effects = f.run({ type: 'member.remove', userId: 'peer' }, how === 'leaves' ? peer : owner)
    const pool = f.state.machines!.find(m => m.machineId === 'host')!
    expect([pool.removal?.state, pool.paused]).toEqual(['cleaning', true])
    expect(f.state.agents.map(a => a.id)).toEqual([lead])
    expect(f.state.agents.some(a => a.id === owners)).toBe(false)
    expect(f.state.conversations.find(c => c.id === group)!.assignment!.status).toBe('reconciling')
    expect(f.state.rules!.map(r => r.rule)).toEqual([{ kind: 'machines', machineIds: ['elsewhere'] }])
    expect(effects.messages.map(m => [m.conversationId, m.text])).toEqual(expect.arrayContaining([
      ['lead', 'Rule changed: Studio left the Swarm, so "Only these two." now allows only elsewhere.'],
      [group, expect.stringContaining('Its task "Offline editing" needs to be assigned again or closed.')]]))
    expect(new Set(effects.messages.map(m => m.id)).size).toBe(effects.messages.length)
    f.run({ type: 'machine.cleaned', machineId: 'host', removalId: pool.removal!.id }, peer)
    expect(f.state.machines).toEqual([])
  })

  it('refuses a person\'s leaving while their machine runs a Product Manager, whoever contributed that agent', () => {
    const f = fixture()
    f.invite()
    contribute(f, 'peer')
    f.add('lead', 'owner', 'lead', true)
    expect(() => f.run({ type: 'member.remove', userId: 'peer' }, peer)).toThrow(expect.objectContaining({ code: 'LEAD_PROTECTED' }))
    expect(f.state.machines!.map(m => m.removal)).toEqual([undefined])
  })

  it('previews what removal does for the machine owner only: its agents and their tasks, sole-source projects, and a Product Manager that blocks it', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group(), worker = f.add('worker', 'owner', group)
    contribute(f)
    f.run({ type: 'work.assign', conversationId: group, agentId: worker })
    f.state.project = { machineId: 'host', cwd: '/repo', repositoryUrl: null }
    f.state.projects![0]!.repository = { machineId: 'host', cwd: '/repo', repositoryUrl: null }
    const docs = f.run({ type: 'project.create', name: 'Docs', visibility: 'public', brief: '' }).result.projectId as string
    f.state.projects!.find(p => p.id === docs)!.repository = { machineId: 'host', cwd: '/docs', repositoryUrl: 'https://github.com/example/docs' }
    const named = (id: string) => { const a = f.state.agents.find(x => x.id === id)!; return a.displayName ?? a.name }
    expect(removalPreview(f.state, owner, 'host')).toEqual({ blockedBy: { projectId: 'lead', projectName: 'Pilot' },
      agents: [{ id: lead, name: named(lead), projectName: 'Pilot' }, { id: worker, name: named(worker), projectName: 'Pilot', task: 'Offline editing' }],
      soleSourceProjects: [{ id: 'lead', name: 'Pilot' }] })
    f.state.agents.find(a => a.id === lead)!.machineId = 'elsewhere'
    expect(removalPreview(f.state, owner, 'host').blockedBy).toBeNull()
    f.invite()
    expect(() => removalPreview(f.state, peer, 'host')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => removalPreview(f.state, owner, 'nowhere')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('is a person\'s to do, and only for a machine in the Swarm', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true)
    expect(() => f.run({ type: 'machine.remove', machineId: 'host' }, { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }))
      .toThrow(expect.objectContaining({ code: 'HUMAN_REQUIRED', status: 403 }))
    expect(() => f.run({ type: 'machine.remove', machineId: 'nowhere' })).toThrow(expect.objectContaining({ code: 'NOT_FOUND', status: 404 }))
    expect(commandSchema.safeParse({ type: 'machine.remove', machineId: 'host', extra: true }).success).toBe(false)
  })
})

describe('Lead protection', () => {
  const refused = (project = 'Pilot') => expect.objectContaining({ code: 'LEAD_PROTECTED',
    message: expect.stringMatching(new RegExp(`is the Product Manager of project ${project}\\. Delete the project first\\.$`)) })
  const hostOwner: Actor = { kind: 'person', userId: 'host-owner', email: 'host@example.com' }
  const closing = (agentId: string, harnessId: string) => ({ agentId, machineId: 'host', harnessId, machineOwnerId: 'host-owner' })

  it('refuses removing the Lead as an agent, with its machine, or with the person who contributed it', () => {
    const f = fixture()
    f.invite()
    const lead = f.add('lead', 'peer', 'lead', true)
    expect(() => f.run({ type: 'agent.remove', agentId: lead })).toThrow(refused())
    expect(() => f.run({ type: 'machine.remove', machineId: 'host' }, peer)).toThrow(refused())
    expect(() => f.run({ type: 'member.remove', userId: 'peer' })).toThrow(refused())
    expect(() => f.run({ type: 'member.remove', userId: 'peer' }, peer)).toThrow(refused())
    expect(f.state.agents.map(a => a.id)).toEqual([lead])
    expect(f.state.people.map(p => p.id)).toEqual(['owner', 'peer'])
  })

  it('refuses clearing or replacing the Lead, so it can never be released afterwards', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), other = f.add('other'), group = f.group()
    expect(() => f.run({ type: 'conversation.agent', conversationId: 'lead', agentId: lead, present: false, lead: false })).toThrow(refused())
    expect(() => f.run({ type: 'conversation.agent', conversationId: 'lead', agentId: other, present: true, lead: true })).toThrow(refused())
    expect(() => f.add('other', 'owner', 'lead', true)).toThrow(refused())
    expect(() => f.run({ type: 'agent.release', agentId: lead, decision: 'stop' })).toThrow(refused())
    expect(f.state.conversations[0]!.leadId).toBe(lead)
    // Its other groups and the Lead conversation's other members are not protected.
    f.run({ type: 'conversation.agent', conversationId: group, agentId: lead, present: false, lead: false })
    f.run({ type: 'conversation.agent', conversationId: 'lead', agentId: other, present: false, lead: false })
    expect(f.state.conversations.find(c => c.id === group)!.leadId).toBeNull()
  })

  it('protects the Lead of a Swarm from before projects', () => {
    const f = fixture()
    delete f.state.projects
    const lead = f.add('lead', 'owner', 'lead', true)
    expect(() => f.run({ type: 'agent.remove', agentId: lead })).toThrow(refused())
  })

  it('lets only deleting its project take the Lead, and asks its host to close the session', () => {
    const f = fixture()
    const { projectId, conversationId } = f.run({ type: 'project.create', name: 'Docs', visibility: 'public', brief: 'Docs' }).result as { projectId: string; conversationId: string }
    const lead = f.add('docs-lead', 'owner', conversationId, true)
    expect(() => f.run({ type: 'agent.remove', agentId: lead })).toThrow(refused('Docs'))
    const effects = f.run({ type: 'project.delete', projectId })
    expect(f.state.agents).toEqual([])
    expect(effects.cancelledAgents).toEqual([lead])
    expect(f.state.closingSessions).toEqual([closing(lead, 'docs-lead')])
  })

  it('asks the host to close the session of every agent a person removes, and shows it to nobody else', () => {
    const f = fixture(), worker = f.add('worker')
    f.run({ type: 'agent.remove', agentId: worker })
    expect(f.state.closingSessions).toEqual([closing(worker, 'worker')])
    expect(visibleState(f.state, owner)).not.toHaveProperty('closingSessions')

    const g = fixture(), other = g.add('other')
    g.run({ type: 'machine.remove', machineId: 'host' })
    expect(g.state.closingSessions).toEqual([closing(other, 'other')])

    const h = fixture()
    h.invite()
    const theirs = h.add('theirs', 'peer')
    h.run({ type: 'member.remove', userId: 'peer' }, peer)
    expect(h.state.closingSessions).toEqual([closing(theirs, 'theirs')])
  })

  it('drops a close request and the slot held for its session once the machine owner says it closed', () => {
    const f = fixture(), worker = f.add('worker')
    f.run({ type: 'agent.remove', agentId: worker })
    expect(f.state.harnessReservations).toEqual([expect.objectContaining({ machineId: 'host', harnessId: 'worker' })])
    const closed = { type: 'agent.sessionClosed', agentId: worker, harnessId: 'worker' } as Command
    const nothing = expect.objectContaining({ code: 'NOT_FOUND', status: 404 })
    // Another account learns nothing, not even whether a close is pending.
    expect(() => f.run(closed)).toThrow(nothing)
    expect(() => f.run({ ...closed, harnessId: 'other' } as Command, hostOwner)).toThrow(nothing)
    f.run(closed, hostOwner)
    expect(f.state.closingSessions).toBeUndefined()
    expect(f.state.harnessReservations).toEqual([])
    expect(f.state.releasedHarnesses).toEqual([{ machineId: 'host', harnessId: 'worker' }])
    // Only the store's receipt answers an exact retry; a new confirmation finds nothing to close.
    expect(() => f.run(closed, hostOwner)).toThrow(nothing)
  })

  it('forgets a close request when the same session is added back before its host closed it', () => {
    const f = fixture(), worker = f.add('worker')
    f.run({ type: 'agent.remove', agentId: worker })
    f.add('worker')
    expect(f.state.closingSessions).toBeUndefined()
  })
})

describe('Leads conversation', () => {
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const send = (conversationId: string, text: string, recipientIds: string[] = []): Command =>
    ({ type: 'message.send', conversationId, text, replyTo: null, recipientIds })
  const swarm = () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), worker = f.add('worker')
    const docs = f.run({ type: 'project.create', name: 'Docs', visibility: 'public', brief: 'Docs' }).result as { projectId: string; conversationId: string }
    const docsLead = f.add('docs-lead', 'owner', docs.conversationId, true)
    return { f, lead, worker, docs, docsLead, leads: f.state.leadsConversationId! }
  }

  it('gives every Swarm one, an old one too, outside every project', () => {
    const f = fixture(), id = f.state.leadsConversationId!
    expect(f.state.conversations.find(c => c.id === id)).toMatchObject({ kind: 'leads', title: 'Leads', archived: false, leadId: null })
    expect(f.state.conversations.find(c => c.id === id)).not.toHaveProperty('number')

    const old = fixture()
    delete old.state.leadsConversationId
    old.state.conversations = old.state.conversations.filter(c => c.id !== id)
    expect(visibleState(old.state, owner).leadsConversationId).toBe(id)
    old.run({ type: 'tab.rename', name: 'Renamed' })
    expect(old.state.leadsConversationId).toBe(id)
    expect(old.state.conversations.filter(c => c.kind === 'leads')).toHaveLength(1)
  })

  it('lets people and Leads post, delivers to every other Lead, and keeps it from other agents', () => {
    const { f, lead, worker, docsLead, leads } = swarm()
    expect(f.run(send(leads, 'Who goes first?')).messages[0]!.recipients.sort()).toEqual([lead, docsLead].sort())
    expect(f.run(send(leads, 'Docs waits for Pilot.'), as(docsLead)).messages[0]!.recipients).toEqual([lead])
    // Naming a Lead adds emphasis; every other Lead still hears it.
    expect(f.run(send(leads, 'Pilot, can you go first?', [lead])).messages[0]!.recipients.sort()).toEqual([lead, docsLead].sort())
    expect(() => f.run(send(leads, 'Me too'), as(worker))).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => f.run(send(leads, 'Hi', [worker]))).toThrow()
    expect(visibleState(f.state, as(lead)).conversations.map(c => c.id)).toContain(leads)
    const workerView = visibleState(f.state, as(worker))
    expect(workerView.conversations.map(c => c.id)).not.toContain(leads)
    expect(workerView).not.toHaveProperty('leadsConversationId')

    f.invite('viewer')
    expect(visibleState(f.state, peer).conversations.map(c => c.id)).toContain(leads)
    expect(() => f.run(send(leads, 'Viewer here'), peer)).toThrow(expect.objectContaining({ code: 'READ_ONLY' }))
  })

  it('takes no work, members or archiving, and outlives every project', () => {
    const { f, worker, docs, leads } = swarm()
    const checks = [{ description: 'Done', independent: false }]
    for (const command of [
      { type: 'conversation.archive', conversationId: leads, archived: true },
      { type: 'conversation.rename', conversationId: leads, title: 'Chat' },
      { type: 'work.define', conversationId: leads, brief: 'Work', checks },
      { type: 'conversation.agent', conversationId: leads, agentId: worker, present: true, lead: false },
      { type: 'conversation.create', title: 'Review', reviewOf: leads, brief: 'Review', checks },
    ] as Command[]) expect(() => f.run(command)).toThrow(expect.objectContaining({ code: 'LEADS_CONVERSATION' }))
    f.run({ type: 'project.delete', projectId: docs.projectId })
    expect(f.state.conversations.some(c => c.id === leads)).toBe(true)
  })
})

describe('other projects\' work for Leads', () => {
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const checks = [{ description: 'Done', independent: false }]
  const task = (owns: string[]) => ({ goal: 'Polish', changes: 'The roster', constraints: 'None', owns })
  const swarm = () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true)
    const project = (name: string, visibility: 'public' | 'private') => {
      const created = f.run({ type: 'project.create', name, visibility, brief: name }).result as { projectId: string; conversationId: string }
      return { ...created, lead: f.add(`${name}-lead`, 'owner', created.conversationId, true) }
    }
    /** A task in that project, assigned to a new worker. */
    const work = (projectId: string, title: string, owns: string[]) => {
      const group = f.run({ type: 'conversation.create', projectId, title, task: task(owns), checks }).result.conversationId as string
      const worker = f.add(`${title}-worker`, 'owner', group)
      const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: worker }).result.assignmentId as string
      return { group, worker, assignmentId }
    }
    return { f, lead, project, work }
  }

  it('shows a Lead the active work of every other shared project, and nobody else', () => {
    const { f, lead, project, work } = swarm()
    const docs = project('Docs', 'public'), secret = project('Secret', 'private')
    const roster = work(docs.projectId, 'Roster', ['desktop/lib/super_tabs'])
    f.run({ type: 'work.status', conversationId: roster.group, assignmentId: roster.assignmentId, status: 'review',
      result: 'Ready: https://github.com/example/project/pull/12 head abc.' }, as(roster.worker))
    const finished = work(docs.projectId, 'Finished', ['docs'])
    f.run({ type: 'work.cancel', conversationId: finished.group, assignmentId: finished.assignmentId, reason: 'Not needed.' })
    work(secret.projectId, 'Hidden', ['backend'])
    const own = work('lead', 'Own', ['cli'])
    const workerName = f.state.agents.find(a => a.id === roster.worker)!.displayName

    expect(visibleState(f.state, as(lead)).otherProjectsWork).toEqual([{ conversationId: roster.group, projectName: 'Docs',
      title: 'Roster', owns: ['desktop/lib/super_tabs'], status: 'review', agentName: workerName, pr: 'https://github.com/example/project/pull/12' }])
    expect(visibleState(f.state, as(docs.lead)).otherProjectsWork).toEqual([expect.objectContaining({ conversationId: own.group,
      projectName: 'Pilot', status: 'working', pr: null })])
    expect(visibleState(f.state, as(roster.worker))).not.toHaveProperty('otherProjectsWork')
    expect(visibleState(f.state, owner)).not.toHaveProperty('otherProjectsWork')
  })

  it('tells both Leads once when a task\'s owned code overlaps another project\'s active task', () => {
    const { f, lead, project, work } = swarm()
    const docs = project('Docs', 'public')
    const roster = work(docs.projectId, 'Roster', ['desktop/lib/super_tabs'])
    const alerts = () => f.state.leadsConversationId
    const name = (id: string) => f.state.agents.find(a => a.id === id)!.displayName
    const created = f.run({ type: 'conversation.create', title: 'Agents filter', task: task([' ./desktop/lib/super_tabs/roster.dart ', 'cli']), checks }, as(lead))
    const group = created.result.conversationId as string
    const alert = created.messages.find(m => m.conversationId === alerts())!
    expect(alert).toMatchObject({ author: { id: lead }, recipients: [docs.lead],
      source: { kind: 'overlap', conversationIds: [group, roster.group] } })
    expect(alert.text).toBe(`"Agents filter" (Pilot, ${name(lead)}) and "Roster" (Docs, ${name(docs.lead)}) both change `
      + 'desktop/lib/super_tabs/roster.dart. Agree an order or a split here, then each tell your own project.')
    // The same pair is not alerted again.
    f.run({ type: 'work.define', conversationId: group, task: task(['desktop/lib/super_tabs/roster.dart']), checks }, as(lead))
    const worker = f.add('pilot-worker', 'owner', group)
    expect(f.run({ type: 'work.assign', conversationId: group, agentId: worker }).messages.some(m => m.conversationId === alerts())).toBe(false)
    expect(visibleState(f.state, owner)).not.toHaveProperty('overlapAlerts')
  })

  it('stays silent within one project, for owned code that is not a path, and for private projects', () => {
    const { f, project, work } = swarm()
    const secret = project('Secret', 'private'), docs = project('Docs', 'public')
    work('lead', 'Own', ['desktop/lib'])
    work(secret.projectId, 'Hidden', ['desktop/lib'])
    work(docs.projectId, 'Phrase', ['The Desktop roster'])
    for (const owns of [['desktop/lib/super_tabs'], ['The Desktop roster']]) {
      const effects = f.run({ type: 'conversation.create', title: 'More', task: task(owns), checks })
      expect(effects.messages.filter(m => m.conversationId === f.state.leadsConversationId)).toEqual([])
    }
    expect(f.run({ type: 'conversation.create', projectId: secret.projectId, title: 'Secret too', task: task(['desktop/lib']), checks })
      .messages.filter(m => m.conversationId === f.state.leadsConversationId)).toEqual([])
  })
})

describe('the Local models add-on', () => {
  const served = (f: ReturnType<typeof fixture>, grid: string, model = 'qwen3-30b', receivedAt = 1000) => {
    f.state.machines = [{ machineId: 'host', name: 'Studio', contributorId: 'owner', membershipGeneration: f.state.people[0]!.generation, generation: 'g1',
      cwd: '/repo', scope: 'swarm', engines: ['claude', 'codex'], maxAgents: 4, paused: false,
      observation: { receivedAt, localModels: [{ grid, model, name: 'Qwen3 30B' }] } } as never]
  }
  const start = (gridName: string, patch: Record<string, unknown> = {}) => ({ conversationId: 'lead', machineId: 'host', engine: 'claude', name: 'Local builder',
    cwd: '/repo/lead', worktree: true, gridModel: 'qwen3-30b', gridName, ...patch,
    requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } })
  const grant = { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }

  it('is off until the owner turns it on, mints one grid name, and keeps it when turned off', () => {
    const f = fixture()
    expect(f.state.localModels).toBeUndefined()
    f.invite()
    expect(() => f.run({ type: 'localModels.set', enabled: true }, peer)).toThrow(expect.objectContaining({ code: 'OWNER_REQUIRED' }))
    const on = f.run({ type: 'localModels.set', enabled: true })
    expect(on.result.grid).toMatch(/^swarm-[0-9a-f]{12}$/)
    expect(f.state.localModels).toEqual({ grid: on.result.grid, enabled: true })
    f.run({ type: 'localModels.set', enabled: false })
    f.run({ type: 'localModels.set', enabled: true })
    expect(f.state.localModels).toEqual({ grid: on.result.grid, enabled: true })
  })

  it('gives the owner\'s computer the grid and the people who may act, and a host the grid only while it is on', () => {
    const f = fixture()
    expect(swarmGridRow('tab', f.state)).toBeNull()
    expect(hostLocalGrid(f.state)).toEqual({})
    f.invite()
    const grid = f.run({ type: 'localModels.set', enabled: true }).result.grid as string
    expect(swarmGridRow('tab', f.state)).toEqual({ tabId: 'tab', grid, enabled: true, ready: null, members: [peer.email] })
    expect(hostLocalGrid(f.state)).toEqual({ localGrid: grid })
    f.run({ type: 'localModels.status', grid, ready: true })
    f.run({ type: 'localModels.set', enabled: false })
    expect(swarmGridRow('tab', f.state)).toMatchObject({ enabled: false, ready: true })
    expect(hostLocalGrid(f.state)).toEqual({})
    // A viewer may not act in the Swarm, so is no member of its grid.
    const viewing = fixture()
    viewing.invite('viewer')
    viewing.run({ type: 'localModels.set', enabled: true })
    expect(swarmGridRow('tab', viewing.state)!.members).toEqual([])
  })

  it('takes the owner\'s computer\'s report of its grid, and nothing about another grid', () => {
    const f = fixture()
    const grid = f.run({ type: 'localModels.set', enabled: true }).result.grid as string
    f.run({ type: 'localModels.status', grid, ready: false, error: 'grid: plan limit reached' })
    expect(f.state.localModels).toMatchObject({ ready: false, error: 'grid: plan limit reached' })
    f.run({ type: 'localModels.status', grid, ready: true })
    expect(f.state.localModels).toEqual({ grid, enabled: true, ready: true })
    expect(() => f.run({ type: 'localModels.status', grid: 'swarm-other', ready: true })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('lets a contributed machine run a Builder on a model the Swarm\'s grid serves now, and only then', () => {
    const f = fixture()
    const grid = f.run({ type: 'localModels.set', enabled: true }).result.grid as string
    served(f, grid)
    f.run({ type: 'agent.start', request: start(grid) }, owner, grant)
    expect(f.state.starts).toHaveLength(1)

    const refused = (request: Record<string, unknown>, now = 1000) => () => applyCommand(f.state, owner, { type: 'agent.start', request } as Command,
      { now, operationId: 'op-x', ...grant })
    expect(refused(start('swarm-other'))).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
    expect(refused(start(grid, { gridModel: 'llama-70b' }))).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
    expect(refused(start(grid, { model: 'opus' }))).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
    // A reading too old to trust says nothing is served.
    expect(refused(start(grid), 1000 + 60_000)).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
    f.run({ type: 'localModels.set', enabled: false })
    expect(refused(start(grid))).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
  })

  it('lets a machine run a Builder on a model shared with its owner on another grid, and only that machine', () => {
    const f = fixture()
    const grid = f.run({ type: 'localModels.set', enabled: true }).result.grid as string
    served(f, grid)
    const host = f.state.machines![0]!
    host.observation!.localModels = [{ grid: 'team-grid', model: 'qwen3-30b', kind: 'shared' }]
    // A second machine whose reading does not list it.
    f.state.machines!.push({ ...structuredClone(host), machineId: 'mini', name: 'Mini', observation: { ...structuredClone(host.observation!), localModels: [] } })
    const refused = (request: Record<string, unknown>, now = 1000) => () => applyCommand(f.state, owner, { type: 'agent.start', request } as Command,
      { now, operationId: 'op-x', ...grant })
    expect(refused(start('team-grid', { machineId: 'mini' }))).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
    expect(refused(start('team-grid', { gridModel: 'llama-70b' }))).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
    expect(refused(start('team-grid'), 1000 + 60_000)).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
    f.run({ type: 'agent.start', request: start('team-grid') }, owner, grant)
    expect(f.state.starts).toEqual([expect.objectContaining({ request: expect.objectContaining({ machineId: 'host', gridName: 'team-grid', gridModel: 'qwen3-30b' }) })])
    // Not while the add-on is off.
    f.run({ type: 'localModels.set', enabled: false })
    expect(refused(start('team-grid'))).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
  })

  it('matches a start to a local route candidate by its grid model, and records it on the decision', () => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true)
    const grid = f.run({ type: 'localModels.set', enabled: true }).result.grid as string
    served(f, grid)
    const local = candidate('c0', { machineId: 'host', model: 'default', effort: 'default', quality: 1, cost: 1, gridModel: 'qwen3-30b', gridName: grid })
    const decision = { routeDecision: { id: 'd1', conversationId: 'lead', record: record({ candidates: [local, candidate('c1')], pick: 'c0' }),
      final: null, override: null, assignmentId: null, outcome: null } as unknown as RouteDecision }
    const actor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    const effects = f.run({ type: 'agent.start', request: start(grid), routeDecisionId: 'd1' }, actor, { ...grant, ...decision })
    expect(effects.routeDecisions).toEqual([expect.objectContaining({ op: 'final', final: expect.objectContaining({ gridModel: 'qwen3-30b', gridName: grid }) })])
    expect(effects.messages.some(m => m.source?.kind === 'route-override')).toBe(false)
  })

  it('reads the policy\'s local quality, low by default, from policies saved before the add-on', () => {
    expect(effectivePolicy(null, null).policy.localModels).toEqual({ quality: 1, enabled: true })
    const saved = { ...DEFAULT_ROUTING_POLICY } as Record<string, unknown>
    delete saved.localModels
    expect(effectivePolicy(saved, null).policy.localModels).toEqual({ quality: 1, enabled: true })
    expect(effectivePolicy(saved, { localModels: { quality: 2, enabled: true } }).policy.localModels).toEqual({ quality: 2, enabled: true })
  })
})

describe('Lead mentions', () => {
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const send = (conversationId: string, mentions: string[]): Command => ({ type: 'message.send', conversationId, text: 'Please confirm the copy.',
    replyTo: null, recipientIds: [], mentions })
  const swarm = () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true)
    f.invite()
    const created = f.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: 'Secret' }).result as { projectId: string; conversationId: string }
    return { f, lead, secret: { ...created, lead: f.add('secret-lead', 'owner', created.conversationId, true) } }
  }

  it('lets a project Lead tag readers in its own project and puts them on the message once', () => {
    const { f, lead } = swarm(), group = f.group()
    expect(f.run(send(group, ['peer', 'owner', 'peer']), as(lead)).messages[0]!.mentions).toEqual(['peer', 'owner'])
    expect(f.run(send('lead', []), as(lead)).messages[0]).not.toHaveProperty('mentions')
  })

  it('refuses a person, a non-Lead agent and another project’s Lead', () => {
    const { f, lead, secret } = swarm(), group = f.group(), worker = f.add('worker', 'owner', group)
    expect(() => f.run(send(group, ['peer']))).toThrow('Only a project’s Lead can tag people.')
    expect(() => f.run(send(group, ['peer']), as(worker))).toThrow('Only a project’s Lead can tag people.')
    expect(() => f.run(send(group, ['owner']), as(secret.lead))).toThrow('This project is unavailable.')
    expect(() => f.run(send(f.state.leadsConversationId!, ['owner']), as(lead))).toThrow('A Lead can tag people only in its own project’s conversations.')
  })

  it('refuses a person who cannot read the conversation or is not in the Swarm', () => {
    const { f, secret } = swarm()
    expect(() => f.run(send(secret.conversationId, ['peer']), as(secret.lead))).toThrow('peer@example.com cannot read this conversation.')
    expect(() => f.run(send(secret.conversationId, ['stranger']), as(secret.lead))).toThrow('Tag a person in this Swarm.')
    expect(f.run(send(secret.conversationId, ['owner']), as(secret.lead)).messages[0]!.mentions).toEqual(['owner'])
  })

  it('tags at most five people', () => {
    expect(commandSchema.safeParse(send('lead', ['a', 'b', 'c', 'd', 'e'])).success).toBe(true)
    expect(commandSchema.safeParse(send('lead', ['a', 'b', 'c', 'd', 'e', 'f'])).success).toBe(false)
  })

  it('lets only the tagged person mark a mention done, a viewer included', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true)
    f.invite('viewer')
    const mention = { id: 'mention-1', personId: 'peer', conversationId: 'lead' }
    const done: Command = { type: 'mention.done', mentionId: 'mention-1' }
    expect(f.run(done, peer, { mention }).result).toEqual({ mentionId: 'mention-1' })
    expect(() => f.run(done, owner, { mention })).toThrow('This mention is unavailable.')
    expect(() => f.run(done, peer)).toThrow('This mention is unavailable.')
    expect(() => f.run(done, as(lead), { mention })).toThrow('This mention is unavailable.')
  })
})
