import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, PAIR_CHAIN_LIMIT, type Command, type CommandContext } from './commands.js'
import { machineSlots } from './machines.js'
import { activeWork, createSuperTab, visibleState, type Actor, type AgentConfiguration } from './model.js'
import type { RouteDecision } from './routeRecord.js'

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

  it('posts a notice without claiming inactive work stopped or delivering to the removed Lead', () => {
    const f = fixture(), worker = f.add('lead', 'owner', 'lead', true)
    const effects = f.run({ type: 'agent.remove', agentId: worker })
    expect(effects.messages).toEqual([expect.objectContaining({ conversationId: 'lead', recipients: [] })])
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
    expect(f.state.conversations.map(c => c.title)).toEqual(['Lead', 'Offline editing'])
    expect(f.state.conversations[1]).toMatchObject({ leadId: lead, agentIds: [lead, worker], assignment: null })
    f.run({ type: 'conversation.agent', conversationId: 'lead', agentId: worker, present: true, lead: false })
    expect(f.state.agents).toHaveLength(2)
    expect(f.state.conversations).toHaveLength(2)
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
      const assign = (assigner: 'lead' | 'person') => {
        const sent = f.run({ type: 'work.assign', conversationId: group, agentId: worker }, assigner === 'lead' ? as(lead) : owner).messages[0]!
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
  expect(f.state.conversations).toHaveLength(2)
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
  expect(f.state.conversations.map(c => c.number)).toEqual([undefined, 1, 2])
  delete f.state.conversations[1]!.number
  delete f.state.conversations[2]!.number
  expect(visibleState(f.state, owner).conversations.map(c => c.number)).toEqual([undefined, 1, 2])
  expect(f.state.conversations[1]!.number).toBeUndefined()
  f.run({ type: 'conversation.rename', conversationId: first, title: 'Renamed' })
  f.run({ type: 'conversation.archive', conversationId: second, archived: true })
  const third = f.group()
  expect(f.state.conversations.map(c => [c.id, c.number])).toEqual([['lead', undefined], [first, 1], [second, 2], [third, 3]])
})
it('records the lead project once and accepts installed engines beyond Claude and Codex', () => {
  const f = fixture(), project = { cwd: '/repo', repositoryUrl: 'https://github.com/example/project' }
  f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'lead', name: 'Lead', configuration: config, lead: true, project }, owner,
    { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
  expect(f.state.project).toEqual({ machineId: 'host', ...project })
  expect(() => f.run({ type: 'tab.project', machineId: 'host', project })).toThrow('already has a project')
  const command = commandSchema.parse({ type: 'machine.contribute', machineId: 'host', name: 'Workstation', cwd: '/repo', engines: ['claude', 'codex', 'pi', 'opencode'], maxAgents: 4 })
  f.run(command, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
  expect(f.state.machines![0]!.engines).toEqual(['claude', 'codex', 'pi', 'opencode'])
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
