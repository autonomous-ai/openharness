import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, PAIR_CHAIN_LIMIT, swarmGridName, withoutCredentials, type Command, type CommandContext } from './commands.js'
import { CREDENTIAL_MARKER, type CredentialKind } from './credentials.js'
import { sweepLiveness } from './liveness.js'
import { hostLocalGrid, machineSlots, removalPreview, swarmGridRow } from './machines.js'
import { activeWork, agentOnly, agentRole, createSuperTab, visibleState, type Actor, type AgentConfiguration } from './model.js'
import type { RouteDecision } from './routeRecord.js'
import { startFinished } from './parts/write.js'
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

/** Makes [machineId] [contributorId]'s contributed machine used only for agents (`harness team on`), reporting now, so a
 *  teammate's agent there may take another person's project (machines.ts teamWorkCheck). */
function teamMachine(f: ReturnType<typeof fixture>, contributorId: string, machineId = 'host') {
  const team = { sessionKind: 'team' as const, privacy: { mode: 'dedicated' as const, seenAt: 1000 } }
  const existing = f.state.machines?.find(m => m.machineId === machineId)
  if (existing) return void Object.assign(existing.observation!, team)
  f.state.machines = [...(f.state.machines ?? []), { machineId, name: 'Studio', contributorId, membershipGeneration: f.state.people.find(p => p.id === contributorId)!.generation,
    generation: 'g1', cwd: '/repo', engines: ['claude'], maxAgents: 2, paused: false, observation: { generation: 'g1', receivedAt: 1000, ...team,
      resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null,
        deviceType: null, chip: null, os: null, gpuPercent: null }, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] } }]
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

  it('counts a finished start\'s harness only while its agent or its host says it runs', () => {
    const f = fixture()
    const pool = { machineId: 'host', name: 'Host', contributorId: 'owner', membershipGeneration: f.state.people[0]!.generation,
      generation: 'pool', cwd: '/work', engines: ['codex'], maxAgents: 2, paused: false }
    f.state.machines = [pool]
    // A read keeps finished starts until they expire: one whose harness is long gone takes no slot.
    f.state.starts = [{ poolGeneration: 'pool', id: 'old', creationId: 'super-old', actorKey: 'person:owner', contributorId: 'owner',
      membershipGeneration: f.state.people[0]!.generation, machineOwnerId: 'owner', hostGrant: null, harnessId: 'gone', dispatched: true,
      error: null, poolSettled: true, request: { conversationId: 'lead', machineId: 'host', engine: 'codex', name: 'Builder', cwd: '/work/lead',
        worktree: true, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } }]
    expect(machineSlots(f.state, pool)).toBe(0)
    // Started but not yet settled, it still holds its slot.
    f.state.starts[0]!.poolSettled = false
    expect(machineSlots(f.state, pool)).toBe(1)
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
    // Any agent in a group reaches its Lead (review of #2243).
    expect(posted.recipients).toEqual([lead])
    const reply = f.run({ type: 'message.send', conversationId: 'lead', text: 'Keep the local copy.', replyTo: posted.id, recipientIds: [] }, owner,
      { reply: { id: posted.id, conversationId: 'lead', author: posted.author, createdAt: 0 } })
    expect(reply.messages[0]!.recipients).toEqual([worker])
    const fresh = f.run({ type: 'message.send', conversationId: 'lead', text: 'Continue.', replyTo: null, recipientIds: [] })
    expect(fresh.messages[0]!.recipients).toEqual([lead])
    expect(() => f.run({ type: 'message.send', conversationId: 'lead', text: 'Cross-group reply', replyTo: posted.id, recipientIds: [] }, owner,
      { reply: { id: posted.id, conversationId: 'elsewhere', author: posted.author, createdAt: 0 } })).toThrow('Reply to a message in this conversation')
  })

  it('files a reply under its thread root, never a nested thread, and keeps a reply to a pre-thread message inline', () => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true)
    const root = f.run({ type: 'message.send', conversationId: 'lead', text: 'Should we do threads?', replyTo: null, recipientIds: [] }).messages[0]!
    expect(root.thread).toBeUndefined()
    const first = f.run({ type: 'message.send', conversationId: 'lead', text: 'Yes.', replyTo: root.id, recipientIds: [] },
      { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }, { reply: { id: root.id, conversationId: 'lead', author: root.author, createdAt: 0, thread: root.id } }).messages[0]!
    expect(first).toMatchObject({ replyTo: root.id, thread: root.id })
    expect(first.alsoInChat).toBeUndefined()
    // A reply to a reply joins the root's thread.
    const second = f.run({ type: 'message.send', conversationId: 'lead', text: 'Agreed.', replyTo: first.id, recipientIds: [], alsoSend: true },
      owner, { reply: { id: first.id, conversationId: 'lead', author: first.author, createdAt: 0, thread: root.id } }).messages[0]!
    expect(second).toMatchObject({ replyTo: first.id, thread: root.id, alsoInChat: true })
    // A message written before threads has none: a reply to it stays an inline quote.
    const inline = f.run({ type: 'message.send', conversationId: 'lead', text: 'Old question answered.', replyTo: 'old-message', recipientIds: [], alsoSend: true },
      owner, { reply: { id: 'old-message', conversationId: 'lead', author: root.author, createdAt: 0, thread: null } }).messages[0]!
    expect(inline.replyTo).toBe('old-message')
    expect(inline.thread).toBeUndefined()
    expect(inline.alsoInChat).toBeUndefined()
  })

  it('delivers an assigned worker\'s own post to its Lead, or to the agents it names instead', () => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true)
    const group = f.group(), worker = f.add('worker', 'owner', group), other = f.add('other', 'owner', group)
    const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
    const post = (actor: Actor, recipientIds: string[] = []) => f.run({ type: 'message.send', conversationId: group, text: 'PR is green.',
      replyTo: null, recipientIds }, actor).messages[0]!.recipients
    f.run({ type: 'work.assign', conversationId: group, agentId: worker })
    expect(post(as(worker))).toEqual([lead])
    expect(post(as(worker), [other])).toEqual([other])
    expect(post(as(lead))).toEqual([worker])
    f.run({ type: 'work.status', conversationId: group, assignmentId: f.state.conversations[1]!.assignment!.id, status: 'blocked', result: 'Stuck.' }, as(worker))
    expect(post(as(worker))).toEqual([lead])
  })

  // 10-29: a moved agent's alarm and answers reached no one, and the backend worker stayed down 4 h 50 min.
  it('delivers any other agent\'s post in the group to its Lead, beside the agents it names, whether or not it held the task', () => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true)
    const group = f.group(), worker = f.add('worker', 'owner', group), other = f.add('other', 'owner', group)
    const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
    const post = (actor: Actor, recipientIds: string[] = [], agentOnly?: boolean) => f.run({ type: 'message.send', conversationId: group,
      text: 'Severe: the worker is down.', replyTo: null, recipientIds, ...(agentOnly ? { agentOnly } : {}) }, actor).messages[0]!.recipients
    const assignment = () => f.state.conversations.find(c => c.id === group)!.assignment!
    expect(post(as(worker))).toEqual([lead])
    expect(post(as(lead))).toEqual([])
    f.run({ type: 'work.assign', conversationId: group, agentId: worker })
    expect(post(as(other))).toEqual([lead])
    expect(post(as(other), [worker])).toEqual([worker, lead])
    f.run({ type: 'work.cancel', conversationId: group, assignmentId: assignment().id, reason: 'Duplicate of another task' })
    expect(post(as(worker))).toEqual([lead])
    expect(post(as(worker), [other])).toEqual([other, lead])
    expect(post(as(worker), [lead])).toEqual([lead])
    // A note to itself stays its own.
    expect(post(as(worker), [worker], true)).toEqual([worker])
    expect(post(as(lead))).toEqual([])
    f.run({ type: 'work.assign', conversationId: group, agentId: other })
    f.run({ type: 'work.status', conversationId: group, assignmentId: assignment().id, status: 'stopped', result: null }, owner, { confirmedStopped: true })
    expect(post(as(other))).toEqual([lead])
    expect(() => post(as(other), ['not-an-agent'])).toThrow()
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
          ...(reply ? { reply: { id: reply.id, conversationId: group, author: reply.author as never, createdAt: 0 } } : {}),
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

    it('lets explicit recipients win and leaves replies to others and person routing alone', () => {
      const { f, lead, group, worker, other, as, post, history } = setup()
      f.run({ type: 'work.assign', conversationId: group, agentId: worker })
      expect(post(lead, [other]).recipients).toEqual([other])
      const aside = post(other)
      expect(aside.recipients).toEqual([lead])
      expect(post(lead, [], aside.id).recipients).toEqual([])
      const personMessage = f.run({ type: 'message.send', conversationId: group, text: 'Status?', replyTo: null, recipientIds: [] }).messages[0]!
      history.push({ author: { kind: 'person', id: 'owner' }, recipients: personMessage.recipients, id: personMessage.id })
      expect(personMessage.recipients).toEqual([lead])
      const reply = f.run({ type: 'message.send', conversationId: group, text: 'Ask the worker', replyTo: personMessage.id, recipientIds: [] }, as(lead), {
        reply: { id: personMessage.id, conversationId: group, author: personMessage.author, createdAt: 0 },
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

  // Review of #2188: Desktop adds the accepting computer to the Swarm only when the accept made the person a member. One
  // who joined by link on another computer while this invitation waited is a member already, and says so.
  it('says whether the accept made the person a member, and as what', () => {
    const f = fixture()
    const invited = f.run({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
    expect(f.run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer).result)
      .toEqual({ conversationId: 'lead', alreadyMember: false, role: 'collaborator' })
    const again = f.run({ type: 'invite.create', email: 'late@example.com', role: 'collaborator', conversationId: 'lead' })
    const late = { kind: 'person' as const, userId: 'late', email: 'late@example.com' }
    // Joined by link elsewhere first, as a viewer: the invitation it still had changes nothing.
    f.state.people.push({ id: 'late', email: 'late@example.com', role: 'viewer', generation: 'link' })
    expect(f.run({ type: 'invite.accept', inviteId: again.result.inviteId as string }, late).result)
      .toEqual({ conversationId: 'lead', alreadyMember: true, role: 'viewer' })
    expect(f.state.people.filter(p => p.id === 'late')).toHaveLength(1)
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
    teamMachine(f, 'peer')
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
  it('refuses a second row for a built-in model', () => {
    const sol = DEFAULT_ROUTING_POLICY.models.find(m => m.model === 'gpt-6.1-sol')!
    expect(() => commandSchema.parse({ type: 'tab.routingPolicy', policy: { models: [sol, { ...sol, enabled: false }] } }))
      .toThrow('Only one row for codex gpt-6.1-sol.')
    expect(commandSchema.parse({ type: 'tab.routingPolicy', policy: { models: [sol] } })).toBeTruthy()
  })
})

describe('tab.tidy', () => {
  it('is on until the Swarm owner turns it off, and back on', () => {
    const f = fixture()
    expect(f.state.tidy).toBeUndefined()
    f.run({ type: 'tab.tidy', enabled: false })
    expect(f.state.tidy).toBe(false)
    f.run({ type: 'tab.tidy', enabled: true })
    expect(f.state.tidy).toBeUndefined()
  })
  it('refuses a collaborator and a Lead that quotes no message of the owner', () => {
    const f = fixture()
    f.invite('collaborator')
    expect(() => f.run({ type: 'tab.tidy', enabled: false }, peer)).toThrow('Only the Swarm owner')
    const lead = f.add('lead-harness', 'owner', 'lead', true)
    expect(() => f.run({ type: 'tab.tidy', enabled: false }, { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' })).toThrow('Only the Swarm owner')
    expect(f.state.tidy).toBeUndefined()
  })
  it('lets a Lead pass on a chat message the owner wrote in the last day, and no older one', () => {
    const f = fixture()
    const lead = f.add('lead-harness', 'owner', 'lead', true)
    const asLead: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    const ownerAuthor = { kind: 'person' as const, id: 'owner', name: 'owner', membershipGeneration: f.state.people[0]!.generation }
    const askedIn = { conversationId: 'lead', messageId: 'm1' }
    expect(() => f.run({ type: 'tab.tidy', enabled: false, askedIn }, asLead,
      { askedIn: { author: ownerAuthor, source: false, createdAt: 1000 - 25 * 3_600_000 } })).toThrow('Only the Swarm owner')
    expect(() => f.run({ type: 'tab.tidy', enabled: false, askedIn }, asLead,
      { askedIn: { author: { ...ownerAuthor, kind: 'agent', id: lead }, source: false, createdAt: 900 } })).toThrow('Only the Swarm owner')
    f.run({ type: 'tab.tidy', enabled: false, askedIn }, asLead, { askedIn: { author: ownerAuthor, source: false, createdAt: 900 } })
    expect(f.state.tidy).toBe(false)
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

describe('the Lead\'s last action on a task', () => {
  it('is recorded with its time by the Lead\'s route, start, assignment and post there, and by nobody else\'s', () => {
    const f = routed(), group = f.group(), task = () => f.state.conversations.find(c => c.id === group)!
    f.define(group)
    f.run({ type: 'message.send', conversationId: group, text: 'A person posts.', replyTo: null, recipientIds: [] })
    expect(task().leadAction).toBeUndefined()
    f.run({ type: 'route.record', conversationId: group, decision: record() } as Command, f.leadActor, { now: 2000 })
    expect(task().leadAction).toEqual({ kind: 'route', at: 2000 })
    const request = { conversationId: group, machineId: 'machine', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }
    f.run({ type: 'agent.start', request, ...via }, f.leadActor, { contribution: f.contribution, ...decisionIn(group), now: 3000 })
    expect(task().leadAction).toEqual({ kind: 'start', at: 3000 })
    // Its start keeps when it was asked for: a task whose start is never launched is orphaned 10 minutes on (liveness.ts).
    expect(f.state.starts!.at(-1)!.requestedAt).toBe(3000)
    f.run({ type: 'work.assign', conversationId: group, agentId: f.worker, ...via }, f.leadActor, { ...decisionIn(group), now: 4000 })
    expect(task().leadAction).toEqual({ kind: 'assign', at: 4000 })
    f.run({ type: 'message.send', conversationId: group, text: 'Progress.', replyTo: null, recipientIds: [] }, f.workerActor, { now: 5000 })
    expect(task().leadAction).toEqual({ kind: 'assign', at: 4000 })
    f.run({ type: 'message.send', conversationId: group, text: 'Why it waits.', replyTo: null, recipientIds: [] }, f.leadActor, { now: 6000 })
    expect(task().leadAction).toEqual({ kind: 'post', at: 6000 })
  })

  it('records a task\'s wait in the command that starts it, and clears it in the one that ends it, so no sweep rewrites it', () => {
    const f = routed(), group = f.group(), task = () => f.state.conversations.find(c => c.id === group)!
    f.define(group)
    const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: f.worker, ...via }, f.leadActor, { ...decisionIn(group), now: 2000 }).result.assignmentId as string
    expect(task().liveness).toBeUndefined()
    f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'review', result: 'Ready' }, f.workerActor, { now: 3000 })
    expect(task().liveness).toEqual({ state: 'waiting', why: 'review', since: 3000 })
    f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'working', result: 'Fixing' }, f.workerActor, { now: 4000 })
    expect(task().liveness).toBeUndefined()
  })

  it('keeps whom its agent asked on the task while it waits, in the status write, and forgets it once it moves on', () => {
    const f = routed(), group = f.group(), task = () => f.state.conversations.find(c => c.id === group)!
    f.define(group)
    f.invite()
    const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: f.worker, ...via }, f.leadActor, { ...decisionIn(group), now: 2000 }).result.assignmentId as string
    f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'needs_human', result: 'Flag or not?',
      ask: { personId: 'peer', options: ['Flag', 'Ship'], recommended: 0, unblocks: 'The release' } }, f.workerActor, { now: 3000 })
    expect(task().assignment!.askedOf).toBe('peer')
    expect(task().liveness).toMatchObject({ state: 'waiting', why: 'person', personId: 'peer' })
    f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'working', result: 'Flag it' }, f.workerActor, { now: 4000 })
    expect(task().assignment!.askedOf).toBeUndefined()
  })

  it('leaves a task whose start failed orphaned, so it stays so once the failed start is no longer loaded', () => {
    const f = routed(), group = f.group(), task = () => f.state.conversations.find(c => c.id === group)!
    f.define(group)
    const request = { conversationId: group, machineId: 'machine', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }
    const startId = f.run({ type: 'agent.start', request, ...via }, f.leadActor, { contribution: f.contribution, ...decisionIn(group) }).result.startId as string
    f.run({ type: 'agent.startFailed', startId, error: 'Could not prepare the worktree' }, f.leadActor, { contribution: f.contribution, now: 7000 })
    expect(task().liveness).toEqual({ state: 'orphaned', why: 'start-failed', since: 7000 })
  })
})

// The Lead's ruling, 2026-10-29: the project chat and the Leads chat carry only what people read or decide on, and agent
// bookkeeping (routing, an agent joined or ready) is no one's there; a task's chat keeps it as its record.
describe('agent bookkeeping in the chats people read', () => {
  const shown = (row: { source?: Record<string, unknown>; recipients: string[] }) => !agentOnly(row.source, row.recipients)
  const open = (patch: Record<string, unknown> = {}) => ({ id: 'd1', conversationId: 'lead', record: record(), final: null, override: null, assignmentId: null, outcome: null, ...patch }) as unknown as RouteDecision

  it('keeps routing lines out of the project chat, and in a task\'s chat as its record', () => {
    const f = routed(), group = f.group()
    const routing = (conversationId: string) => f.run({ type: 'route.record', conversationId, decision: record() } as Command, f.leadActor, {}).messages
    expect(routing('lead').map(shown)).toEqual([false])
    expect(routing(group).map(shown)).toEqual([true])
    // The Lead choosing otherwise than its route, on a start or an assignment.
    const request = { conversationId: 'lead', machineId: 'machine', engine: 'claude', model: 'sonnet', effort: 'high', name: 'Builder', cwd: '/repo', worktree: false,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const started = f.run({ type: 'agent.start', request, routeDecisionId: 'd1', overrideReason: 'Sonnet is enough here.' }, f.leadActor, { routeDecision: open(), contribution: f.contribution })
    expect(started.messages.filter(m => m.text.startsWith('Lead started')).map(shown)).toEqual([false])
    f.define(group)
    const assigned = f.run({ type: 'work.assign', conversationId: group, agentId: f.worker, routeDecisionId: 'd1', overrideReason: 'It knows the code.' }, f.leadActor,
      { routeDecision: open({ conversationId: group }) })
    expect(assigned.messages.filter(m => m.text.startsWith('Lead assigned')).map(shown)).toEqual([true])
    // A person's choice is theirs to read wherever it is written.
    const decision = { id: 'd2', conversationId: 'lead', record: record(), final: null, override: null, assignmentId: null, outcome: null } as unknown as RouteDecision
    expect(f.run({ type: 'route.override', decisionId: 'd2', candidateId: 'c1', reason: 'Quota.' }, undefined, { routeDecision: decision }).messages.map(shown)).toEqual([true])
  })

  it('keeps an agent\'s joined and ready lines out of the project chat, and in a task\'s chat', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
    const actor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    const contribution = { machineOwnerId: 'target-owner', contributorId: 'owner', hostGrant: 'grant-1' }
    const lines = (conversationId: string, harnessId: string) => {
      const request = { conversationId, machineId: 'host', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
        requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }
      const startId = f.run({ type: 'agent.start', request, ...via }, actor, { contribution, ...decisionIn(conversationId) }).result.startId as string
      f.run({ type: 'agent.startDispatch', startId }, actor, { contribution })
      f.state.starts!.find(s => s.id === startId)!.poolGeneration = 'pool-1'
      const joined = f.run({ type: 'agent.started', startId, harnessId, configuration: { ...config, engine: 'claude' } }, actor, { contribution }).messages
      const ready = f.run({ type: 'agent.startSettled', startId, warning: null }, actor, { contribution }).messages
      return [...joined, ...ready].map(m => [m.text, shown(m)])
    }
    expect(lines('lead', 'in-lead')).toEqual([['Builder joined. Preparing its model.', false], ['Builder is ready for an assignment.', false]])
    expect(lines(group, 'in-task')).toEqual([['Builder joined. Preparing its model.', true], ['Builder is ready for an assignment.', true]])
  })
})

describe('route.record and route.override', () => {
  it('records a lead decision as a route message with its id', () => {
    const f = routed()
    const effects = f.run({ type: 'route.record', conversationId: 'lead', decision: record() } as Command, f.leadActor, {})
    expect(effects.result.routeDecisionId).toBeTruthy()
    expect(effects.routeDecisions).toEqual([{ op: 'create', id: effects.result.routeDecisionId, conversationId: 'lead', record: expect.objectContaining({ pick: 'c0' }) }])
    expect(effects.messages[0]).toMatchObject({ text: 'Routed to Title c0 — Jev 82% · "Schema change."',
      source: { kind: 'route', decisionId: effects.result.routeDecisionId, via: 'jev', p: 0.82, belowFloor: false,
        pick: { id: 'c0', title: 'Title c0' }, alternatives: [{ id: 'c1', title: 'Title c1' }] } })
  })
  it('keeps the context Jev was given with the record, bounded, and still takes a record without it', () => {
    const f = routed()
    const run = (decision: unknown) => f.run({ type: 'route.record', conversationId: 'lead', decision } as Command, f.leadActor, {})
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
    const run = (decision: unknown) => f.run({ type: 'route.record', conversationId: 'lead', decision } as Command, f.leadActor, {})
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
  it('writes the job kind from the group\'s owned paths, then the route word, and never takes one sent with the route', () => {
    const f = routed(), group = f.group()
    const route = (conversationId: string, patch: Record<string, unknown> = {}, kind?: string) => f.run({ type: 'route.record', conversationId,
      decision: record({ ...patch, assessment: { difficulty: 'high', risk: 'low', why: 'Schema change.', ...(kind ? { kind } : {}) } }) } as Command, f.leadActor, {}).routeDecisions[0]
    f.run({ type: 'work.define', conversationId: group, task: { goal: 'g', changes: 'c', constraints: 'k', owns: ['backend/src/superTabs', 'backend/src/superTabs/store.test.ts'] },
      checks: [{ description: 'Tests pass.', independent: false }] })
    expect(route(group, {}, 'ui')).toMatchObject({ record: { jobKind: 'backend', assessment: { kind: 'ui' } } })
    expect(route(group, {}, 'security')).toMatchObject({ record: { jobKind: 'security' } })
    expect(route(group, { jobKind: 'docs' })).toMatchObject({ record: { jobKind: 'backend' } })
    // The Lead conversation owns nothing: the route word decides, and a word outside the list is general.
    expect(route('lead', {}, 'mobile')).toMatchObject({ record: { jobKind: 'mobile' } })
    expect(route('lead', {}, 'parser')).toMatchObject({ record: { jobKind: 'general' } })
  })
  it('refuses a pick outside the candidates, a non-lead agent and a busy hour', () => {
    const f = routed()
    const route = (decision: unknown, actor: Actor, context: Partial<CommandContext>) =>
      f.run({ type: 'route.record', conversationId: 'lead', decision } as Command, actor, context)
    expect(() => route(record({ pick: 'c5' }), f.leadActor, {})).toThrow()
    expect(() => route(record(), f.workerActor, {})).toThrow('coordinating lead')
    expect(() => route(record(), f.leadActor, {})).not.toThrow()
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
      f.leadActor, {}).messages[0]!
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
  // An old snapshot has neither the numbers nor the counter the store by parts keeps.
  delete f.state.conversations[1]!.number
  delete f.state.conversations[2]!.number
  delete f.state.groupCounter
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
it('says in the project chat when a Product Manager on its person\'s own Mac could not launch on the model its role asks for', () => {
  const join = (extra: Record<string, unknown>, lead = true) => {
    const f = fixture(), project = { cwd: '/repo', repositoryUrl: 'https://github.com/example/project' }
    const effects = f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'pm', name: 'Lead', configuration: config, lead, project, ...extra } as Command, owner,
      { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
    return effects.messages.filter(m => m.conversationId === 'lead').map(m => m.text)
  }
  expect(join({ launchRefused: { model: 'opus', effort: 'xhigh' } })).toEqual(
    ['Product Manager started. It asked for opus at xhigh and runs its engine\u2019s own model there: this machine could not launch it with them.'])
  expect(join({})).toEqual([])
  // Only a Product Manager's start says it.
  expect(join({ launchRefused: { model: 'opus', effort: 'xhigh' } }, false)).toEqual([])
  expect(commandSchema.safeParse({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'pm', name: 'Lead', configuration: config, lead: true,
    launchRefused: { model: 'opus', other: 1 } }).success).toBe(false)
  // Only what a launch could have asked for (cli lib/launchModel.ts MODEL and EFFORT): one short word each.
  for (const launchRefused of [{ model: 'opus --dangerously-skip-permissions' }, { model: 'opus\nRead this' }, { model: 'x'.repeat(65) }, { model: 'opus', effort: 'XHIGH' }, { model: 'opus', effort: 'x'.repeat(17) }]) {
    expect(commandSchema.safeParse({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'pm', name: 'Lead', configuration: config, lead: true, launchRefused }).success, JSON.stringify(launchRefused)).toBe(false)
  }
  expect(commandSchema.safeParse({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'pm', name: 'Lead', configuration: config, lead: true,
    launchRefused: { model: 'claude-opus-5[1m]', effort: 'xhigh' } }).success).toBe(true)
})
it('accepts POSIX, Windows drive and UNC folders and refuses relative, drive-relative and control-character ones', () => {
  const contribute = (cwd: string) => commandSchema.safeParse({ type: 'machine.contribute', machineId: 'host', name: 'PC', cwd, engines: ['claude'], maxAgents: 1 })
  for (const cwd of ['/repo', 'C:\\Users\\dev\\data', 'c:/Users/dev/data', 'D:\\', '\\\\server\\share\\x']) expect(contribute(cwd).success, cwd).toBe(true)
  for (const cwd of ['repo', './repo', 'C:repo', 'C:', '\\repo', '\\\\server', '\\\\\\x', 'C:\\a\nb', '/a\u0000b']) expect(contribute(cwd).success, cwd).toBe(false)
  const refused = contribute('relative')
  expect(!refused.success && refused.error.issues[0]!.message).toBe('Use a full folder path, such as /home/me/work or C:\\Users\\me\\work.')
})
it('lets a big machine offer more than 16 agents and refuses only counts that are not whole, positive and sane', () => {
  const f = fixture()
  const contribute = (maxAgents: number) => commandSchema.safeParse({ type: 'machine.contribute', machineId: 'host', name: 'Studio', cwd: '/repo', engines: ['claude'], maxAgents })
  for (const maxAgents of [1, 17, 96, 1024]) expect(contribute(maxAgents).success, String(maxAgents)).toBe(true)
  for (const maxAgents of [0, -1, 2.5, 1025]) expect(contribute(maxAgents).success, String(maxAgents)).toBe(false)
  f.run(contribute(96).data!, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
  expect(f.state.machines![0]!.maxAgents).toBe(96)
})
// Review of #2084: saving a paused machine's settings sends the whole contribution again, and it came back unpaused.
it('keeps a paused machine paused when its owner saves other settings, until they unpause it', () => {
  const f = fixture(), owners = { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }
  const save = (maxAgents: number): Command => ({ type: 'machine.contribute', machineId: 'host', name: 'Studio', cwd: '/repo', engines: ['claude'], maxAgents })
  f.run(save(2), owner, owners)
  f.run({ type: 'machine.pause', machineId: 'host', paused: true })
  f.run(save(4), owner, owners)
  expect(f.state.machines).toEqual([expect.objectContaining({ machineId: 'host', maxAgents: 4, paused: true })])
  f.run({ type: 'machine.pause', machineId: 'host', paused: false })
  f.run(save(3), owner, owners)
  expect(f.state.machines).toEqual([expect.objectContaining({ machineId: 'host', maxAgents: 3, paused: false })])
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
  f.run({ type: 'agent.release', agentId: f.worker, decision: 'keep' }, f.leadActor, { now: 5000 })
  // A kept worker is idle from the keep, not from its task's end (tidy.ts).
  expect(f.state.agents.find(a => a.id === f.worker)!.keptAt).toBe(5000)
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

// Swarm autonomous-harness, 2026-10-29: a Builder started by hand never got a task, and its Lead could not stop it ("this
// worker has no finished assignment to release"); only a person by hand could.
it('lets the Lead stop a worker that never had an assignment, but keep only one with finished work, and never a Buddy', () => {
  const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group(), worker = f.add('worker', 'owner', group)
  const leadActor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
  expect(() => f.run({ type: 'agent.release', agentId: worker, decision: 'keep' }, leadActor)).toThrow('no finished assignment to keep')
  f.run({ type: 'agent.release', agentId: worker, decision: 'stop' }, leadActor)
  expect(f.state.agents.find(a => a.id === worker)).toMatchObject({ workDecision: 'stop', releaseId: expect.any(String) })
  const buddy = f.add('buddy', 'owner', group)
  f.state.agents.find(a => a.id === buddy)!.buddyOf = { personId: 'owner', projectId: 'lead', generation: 'g' } as never
  expect(() => f.run({ type: 'agent.release', agentId: buddy, decision: 'stop' }, leadActor)).toThrow('never released')
})

it('allows the contributor to keep a completed worker and refuses another project’s Lead', () => {
  const f = fixture(); f.invite()
  teamMachine(f, 'peer')
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
  // On another machine: a Team account running this project's Lead takes no other project's work (leadStart.ts, #895).
  const otherLead = f.run({ type: 'agent.add', conversationId: project.conversationId as string, machineId: 'other-host', harnessId: 'other-lead',
    name: 'other-lead', configuration: config, lead: true }, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
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
    // A review needs a model the policy names at quality 2 or more (rules.ts reviewRefusal).
    const reviewer = f.run({ type: 'agent.started', startId, harnessId: 'native-reviewer', configuration: { ...config, engine: 'claude', model: 'claude-opus-4-7' } }, leadActor, { contribution }).result.agentId as string
    const builder = f.add('builder', 'owner', group)
    return { f, lead, leadActor, group, reviewer, builder }
  }

  it('refuses an agent\'s review pick on the grid, below quality 2 or on the Builder\'s engine, whatever the soft rules; a person gets a warning', () => {
    const { f, leadActor, group, reviewer, builder } = reviewed()
    f.run({ type: 'work.assign', conversationId: group, agentId: builder })
    f.run({ type: 'rule.set', rule: { kind: 'preferEngine', taskKind: 'review', engine: 'codex' }, text: 'Codex reviews.' } as Command)
    const review = f.run({ type: 'conversation.create', title: 'Review', brief: 'Review it.', reviewOf: group, checks: [{ description: 'Verdict', independent: false }] },
      leadActor).result.conversationId as string
    const route = (pick: Record<string, unknown>) => f.run({ type: 'route.record', conversationId: review, decision: record({ candidates: [candidate('c0', pick)], pick: 'c0' }) } as Command, leadActor)
    expect(() => route({ model: 'default', effort: 'default', quality: 2, cost: 1, gridModel: 'moonshotai/kimi-k3', gridName: 'swarm-g' }))
      .toThrow('A review never runs on a model served on the Swarm\'s grid. Route again.')
    expect(() => route({ model: 'haiku', effort: 'auto', quality: 3 })).toThrow('A review needs a model of quality 2 or more, and Claude haiku is 1. Route again.')
    // The Builder runs Codex.
    expect(() => route({ engine: 'codex', model: 'default', effort: 'default' })).toThrow('A review runs on another engine than the reviewed Builder\'s, Codex. Route again.')
    expect(route({}).result.routeDecisionId).toBeTruthy()
    // A model the policy does not name is rated 1.
    expect(() => route({ model: 'default', effort: 'default' })).toThrow('Claude default is 1.')
    // A person assigning a grid Reviewer by hand is told.
    f.state.agents.find(a => a.id === reviewer)!.gridModel = 'qwen3'
    const byHand = f.run({ type: 'work.assign', conversationId: review, agentId: reviewer })
    expect(byHand.result.warnings).toEqual(['A review never runs on a model served on the Swarm\'s grid.'])
  })

  it('lets a Claude-only Swarm review a Claude Builder\'s work on Opus, never below the top tier, and records why on the decision', () => {
    const { f, leadActor, group, builder } = reviewed()
    // Every agent runs Claude and no machine offers Codex: no Reviewer of another engine can run here.
    for (const a of f.state.agents) a.configuration = { ...a.configuration, engine: 'claude' }
    f.run({ type: 'work.assign', conversationId: group, agentId: builder })
    const review = f.run({ type: 'conversation.create', title: 'Review', brief: 'Review it.', reviewOf: group, checks: [{ description: 'Verdict', independent: false }] },
      leadActor).result.conversationId as string
    const route = (pick: Record<string, unknown>) => f.run({ type: 'route.record', conversationId: review, decision: record({ candidates: [candidate('c0', pick)], pick: 'c0' }) } as Command, leadActor)
    expect(route({}).routeDecisions[0]).toMatchObject({ record: { sameEngine: 'No Reviewer on another engine than the Builder\'s (Claude) can run in this Swarm, so the review runs on it at the top tier.' } })
    expect(() => route({ model: 'sonnet', effort: 'medium', quality: 2 }))
      .toThrow('A review on the reviewed Builder\'s engine, Claude, needs its top tier (quality 3): no Reviewer on another engine can run in this Swarm. Route again.')
    expect(() => route({ model: 'default', effort: 'default' })).toThrow('Claude default is 1.')
    expect(() => route({ model: 'default', effort: 'default', gridModel: 'moonshotai/kimi-k3', gridName: 'swarm-g' })).toThrow('never runs on a model served on the Swarm\'s grid')
    // A machine that offers Codex makes the other engine available, and the same engine is refused again.
    f.state.machines = [{ machineId: 'codex-box', contributorId: 'owner', engines: ['codex'] } as never]
    expect(() => route({})).toThrow('A review runs on another engine than the reviewed Builder\'s, Claude. Route again.')
    // Unless that machine may not run the review: the owner's rules, or the task's own machine (review of ee4ee6c9a).
    f.run({ type: 'rule.set', rule: { kind: 'machines', machineIds: ['host', 'machine'] }, text: 'Only our machines.' } as Command)
    expect(route({}).routeDecisions[0]).toMatchObject({ record: { sameEngine: expect.stringContaining('top tier') } })
    f.run({ type: 'rule.remove', ruleId: f.state.rules!.at(-1)!.id } as Command)
    f.state.conversations.find(c => c.id === review)!.task = { goal: 'g', changes: 'c', constraints: 'k', owns: [], requires: { machines: ['machine'] } }
    expect(route({}).routeDecisions[0]).toMatchObject({ record: { sameEngine: expect.stringContaining('top tier') } })
  })

  it('never lets a small or unnamed model review: a review needs a model the policy names at quality 2 or more', () => {
    const { f, leadActor, group, builder, reviewer } = reviewed()
    // The Builder runs Claude; Codex, the other engine, is free to review.
    f.state.agents.find(a => a.id === builder)!.configuration.engine = 'claude'
    f.run({ type: 'work.assign', conversationId: group, agentId: builder })
    const review = f.run({ type: 'conversation.create', title: 'Review', brief: 'Review it.', reviewOf: group, checks: [{ description: 'Verdict', independent: false }] },
      leadActor).result.conversationId as string
    const route = (pick: Record<string, unknown>) => f.run({ type: 'route.record', conversationId: review, decision: record({ candidates: [candidate('c0', pick)], pick: 'c0' }) } as Command, leadActor)
    expect(() => route({ engine: 'codex', model: 'gpt-5.5-mini', effort: 'high' })).toThrow('A review needs a model of quality 2 or more, and Codex gpt-5.5-mini is 1.')
    expect(() => route({ engine: 'codex', model: 'gpt-5-nano', effort: 'high' })).toThrow('Codex gpt-5-nano is 1.')
    expect(route({ engine: 'codex', model: 'default', effort: 'default' }).result.routeDecisionId).toBeTruthy()
    // A member is rated by what it runs; one launched on the engine's own model by that model's row.
    const member = (configuration: Record<string, unknown>) => {
      Object.assign(f.state.agents.find(a => a.id === reviewer)!.configuration, configuration)
      return () => route({ kind: 'member', agentId: reviewer, machineId: 'host' })
    }
    expect(member({ engine: 'codex', model: 'gpt-6.1-sol' })).not.toThrow()
    // A known small model it reports is never promoted by its launch (review of ee4ee6c9a).
    expect(member({ engine: 'codex', model: 'gpt-5.5-mini' })).toThrow('Codex gpt-5.5-mini is 1.')
    expect(member({ engine: 'codex', model: 'gpt-5-nano' })).toThrow('Codex gpt-5-nano is 1.')
    // An agent from before the flag was kept is judged by its start: one that named the model is rated by that model's row.
    delete f.state.agents.find(a => a.id === reviewer)!.launchedDefault
    expect(member({ engine: 'codex', model: 'gpt-6.1-sol' })).not.toThrow()
    f.state.starts!.find(s => s.harnessId === 'native-reviewer')!.request.model = 'gpt-9-preview'
    expect(member({ engine: 'codex', model: 'gpt-9-preview' })).toThrow('Codex gpt-9-preview is 1.')
    // A named strong Codex model has its own row (Lead, 10-30): a start that named it reviews.
    f.state.starts!.find(s => s.harnessId === 'native-reviewer')!.request.model = 'gpt-6.1-sol'
    expect(member({ engine: 'codex', model: 'gpt-6.1-sol' })).not.toThrow()
  })

  it('rates a Reviewer launched on its engine\'s default by the default row after it reports its model, once its start has finished', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
    const leadActor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' } as const
    f.run({ type: 'conversation.agent', conversationId: group, agentId: lead, present: true, lead: true })
    // Started with no model: Codex runs its own default and reports none yet.
    const startId = f.run({ type: 'agent.start', request: request(group, { role: 'reviewer' }), ...via } as Command, leadActor, { contribution, ...decisionIn(group) }).result.startId as string
    f.run({ type: 'agent.startDispatch', startId }, leadActor, { contribution })
    const reviewer = f.run({ type: 'agent.started', startId, harnessId: 'native-reviewer', configuration: { ...config, model: null } }, leadActor, { contribution }).result.agentId as string
    // A command loads only unfinished starts (parts/load.ts loadActive): the finished one is gone from its state.
    f.state.starts = f.state.starts!.filter(s => !startFinished(s))
    const builder = f.add('builder', 'owner', group)
    f.state.agents.find(a => a.id === builder)!.configuration.engine = 'claude'
    f.run({ type: 'work.assign', conversationId: group, agentId: builder })
    const review = f.run({ type: 'conversation.create', title: 'Review', brief: 'Review it.', reviewOf: group, checks: [{ description: 'Verdict', independent: false }] },
      leadActor).result.conversationId as string
    const pick = () => f.run({ type: 'route.record', conversationId: review, decision: record({ candidates: [candidate('c0', { kind: 'member', agentId: reviewer, machineId: 'host' })], pick: 'c0' }) } as Command, leadActor)
    expect(pick).not.toThrow()
    // Codex then reports its slug.
    const reviewerActor = { kind: 'agent', agentId: reviewer, machineOwnerId: f.state.agents.find(a => a.id === reviewer)!.machineOwnerId } as const
    const before = f.state.agents.find(a => a.id === reviewer)!.configurationVersion!
    f.run({ type: 'agent.configuration', previousVersion: before, configuration: { ...config, model: 'gpt-6.1-sol' } }, reviewerActor)
    expect(pick).not.toThrow()
    // A small model it reports is still never promoted (review of ee4ee6c9a).
    const now = f.state.agents.find(a => a.id === reviewer)!.configurationVersion!
    f.run({ type: 'agent.configuration', previousVersion: now, configuration: { ...config, model: 'gpt-5.5-mini' } }, reviewerActor)
    expect(pick).toThrow('Codex gpt-5.5-mini is 1.')
    // A replaced terminal (Change agent) is not the session its start launched: it is rated by the model it reports.
    f.run({ type: 'agent.rebind', agentId: reviewer, machineId: 'host', projectId: 'lead', previousHarnessId: 'native-reviewer', harnessId: 'native-reviewer-2',
      configuration: { ...config, model: 'gpt-9-preview' } }, reviewerActor)
    expect(f.state.agents.find(a => a.id === reviewer)).not.toHaveProperty('launchedDefault')
    expect(pick).toThrow('Codex gpt-9-preview is 1.')
  })

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
    // While its own review is active it is busy; when it is done it is kept, waiting for no decision, until the Lead stops it.
    expect(() => f.run({ type: 'agent.release', agentId: reviewer, decision: 'stop' }, leadActor)).toThrow('active work')
    f.run({ type: 'work.status', conversationId: review, assignmentId, status: 'stopped', result: null }, owner, { confirmedStopped: true })
    f.run({ type: 'work.cancel', conversationId: group, assignmentId: built, reason: 'Obsolete' }, leadActor)
    expect(f.state.agents.find(a => a.id === reviewer)).toHaveProperty('workDecision', 'keep')
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

  describe('work waiting for its review (liveness.ts: its quiet time does not count)', () => {
    const HOUR = 3_600_000, QUIET = 30 * 60_000
    function handedOver(status: 'review' | 'working') {
      const setup = reviewed()
      const { f, group, builder, reviewer } = setup
      const built = f.run({ type: 'work.assign', conversationId: group, agentId: builder }).result.assignmentId as string
      const builderActor: Actor = { kind: 'agent', agentId: builder, machineOwnerId: 'host-owner' }
      const reviewerActor: Actor = { kind: 'agent', agentId: reviewer, machineOwnerId: 'target-owner' }
      f.run({ type: 'work.status', conversationId: group, assignmentId: built, status, result: 'Ready for review: PR #42 at abc1234' }, builderActor, { now: 2000 })
      const checkId = f.state.conversations.find(c => c.id === group)!.checks[0]!.id
      const verdict = (passed: boolean, now: number) => f.run({ type: 'work.check', conversationId: group, assignmentId: built, checkId, passed,
        evidence: passed ? 'Passed at abc1234' : 'Two findings at abc1234' }, reviewerActor, { now })
      const task = () => f.state.conversations.find(c => c.id === group)!.assignment!
      /** The task's status after the time checks ran at `now`, on a copy. */
      const swept = (now: number) => { const copy = structuredClone(f.state); sweepLiveness(copy, now); return copy.conversations.find(c => c.id === group)!.assignment!.status }
      return { ...setup, built, builderActor, verdict, task, swept }
    }

    it('moves work in review back to working when a review finds problems, tells its Engineer, and counts its quiet time from then', () => {
      const { verdict, task, swept, builder } = handedOver('review')
      const foundAt = 2000 + 2 * HOUR
      expect(swept(foundAt)).toBe('review')
      const found = verdict(false, foundAt)
      expect(task()).toMatchObject({ status: 'working', result: 'Ready for review: PR #42 at abc1234' })
      expect(found.messages.find(m => m.recipients.includes(builder))?.text).toBe('Working\n\nThe review found problems. Fix them, then hand it over for review again.')
      expect(swept(foundAt + QUIET)).toBe('working')
      expect(swept(foundAt + QUIET + 1)).toBe('lost')
    })

    it('keeps work in review when the review passes', () => {
      const { verdict, task, swept } = handedOver('review')
      expect(verdict(true, 2000 + HOUR).messages).toEqual([])
      expect(task().status).toBe('review')
      expect(swept(2000 + 2 * HOUR)).toBe('review')
    })

    it('counts a working hand-off\'s quiet time once a review finds problems, and pauses it again at the Engineer\'s next hand-off', () => {
      const { f, group, built, builderActor, verdict, task, swept } = handedOver('working')
      const foundAt = 2000 + 2 * HOUR
      expect(swept(foundAt)).toBe('working')
      verdict(false, foundAt)
      expect(task().status).toBe('working')
      expect(swept(foundAt + QUIET)).toBe('working')
      expect(swept(foundAt + QUIET + 1)).toBe('lost')
      f.run({ type: 'work.status', conversationId: group, assignmentId: built, status: 'working', result: 'Ready for review: PR #42 at def5678' }, builderActor, { now: foundAt + HOUR })
      expect(swept(foundAt + 3 * HOUR)).toBe('working')
    })

    it('counts quiet time from when the Lead moves the work out of review', () => {
      const { f, group, built, leadActor, swept } = handedOver('review')
      const movedAt = 2000 + 2 * HOUR
      f.run({ type: 'work.status', conversationId: group, assignmentId: built, status: 'working', result: 'Rebase on main' }, leadActor, { now: movedAt })
      expect(swept(movedAt + QUIET)).toBe('working')
      expect(swept(movedAt + QUIET + 1)).toBe('lost')
    })
  })

  describe('a review the Swarm opens by itself', () => {
    const pr = 'https://github.com/example/project/pull/42'
    /** reviewed() with the project's repository, the Builder working, and a second Reviewer `fresh` that is not in the group. */
    function ready(engine: 'claude' | 'codex' = 'claude') {
      const setup = reviewed()
      const { f, leadActor, group, builder } = setup
      f.state.projects![0]!.repository = { machineId: 'host', cwd: '/repo', repositoryUrl: 'https://github.com/Example/project.git' }
      const startId = f.run({ type: 'agent.start', request: request('lead', { role: 'reviewer', engine, name: 'Second reviewer' }), ...via } as Command, leadActor,
        { contribution, ...decisionIn('lead') }).result.startId as string
      f.run({ type: 'agent.startDispatch', startId }, leadActor, { contribution })
      const fresh = f.run({ type: 'agent.started', startId, harnessId: 'native-fresh', configuration: { ...config, engine, ...engine === 'claude' ? { model: 'claude-opus-4-7' } : {} } }, leadActor, { contribution }).result.agentId as string
      const built = f.run({ type: 'work.assign', conversationId: group, agentId: builder }).result.assignmentId as string
      const builderActor: Actor = { kind: 'agent', agentId: builder, machineOwnerId: 'host-owner' }
      const markReady = (result: string | null, actor: Actor = builderActor) =>
        f.run({ type: 'work.status', conversationId: group, assignmentId: built, status: 'review', result }, actor)
      const reviews = () => f.state.conversations.filter(c => c.reviewOf === group)
      return { ...setup, fresh, built, builderActor, markReady, reviews }
    }

    it('opens "Review: <group>" with the handoff, the checks and the link, assigns a free Reviewer and adds it to the reviewed group', () => {
      const { f, lead, group, reviewer, fresh, markReady, reviews } = ready()
      f.run({ type: 'agent.release', agentId: reviewer, decision: 'stop' }, { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' })
      const handoff = `Ready: yes. Revision a1b2c3..d4e5f6. Unverified: nothing.\n${pr}`
      const effects = markReady(handoff)
      expect(reviews()).toHaveLength(1)
      const review = reviews()[0]!
      expect(review).toMatchObject({ title: 'Review: Offline editing', number: 2, assignment: { agentId: fresh, status: 'working' },
        checks: [{ description: 'Verdict with the reviewed revision', independent: false, evidence: null, passedBy: null }] })
      expect(review.brief).toContain('Save edits while offline.')
      expect(review.brief).toContain('- Reconnect preserves the edits.')
      expect(review.brief).toContain(handoff)
      expect(review.brief).toContain(`Pull request: ${pr}`)
      expect(review.brief).not.toContain('Privacy first')
      expect(f.state.conversations.find(c => c.id === group)!.agentIds).toContain(fresh)
      const toReviewer = effects.messages.find(m => m.conversationId === review.id && m.recipients.includes(fresh))!
      expect(toReviewer.text).toBe(`${review.brief}\n\nAcceptance checks:\n- Verdict with the reviewed revision`)
      const toLead = effects.messages.filter(m => m.conversationId === review.id && m.recipients.includes(lead))
      expect(toLead.map(m => m.text)).toEqual(['Review opened by itself for #1: Second reviewer reviews it. Cancel it here if it is not needed.'])
      // The Lead's wake is its alone (review of #2225); the review's brief and its Reviewer's assignment stay the people's record.
      expect(effects.messages.filter(m => m.conversationId === review.id).map(m => [m.recipients, agentOnly(m.source, m.recipients)]))
        .toEqual([[[], false], [[fresh], false], [[lead], true]])
      // Every row of it is the Swarm's own, written as the project's Lead as its other notices are, never as the Engineer.
      expect(effects.messages.filter(m => m.conversationId === review.id).map(m => [m.author.kind, m.author.id, m.source?.kind]))
        .toEqual([['agent', lead, 'auto-review'], ['agent', lead, 'auto-review'], ['agent', lead, 'auto-review']])
    })

    it('prefers a free Reviewer on another engine than the Engineer\'s', () => {
      // The Engineer runs on Codex (config). `reviewer` comes first but runs on Codex too; `fresh` runs on Claude.
      const { f, fresh, reviewer, markReady, reviews } = ready('claude')
      f.state.agents.find(a => a.id === reviewer)!.configuration.engine = 'codex'
      markReady(`Ready. ${pr}`)
      expect(reviews()[0]!.assignment!.agentId).toBe(fresh)
    })

    it('prefers a free Reviewer at least as strong as the Builder, and falls back to a weaker one (review of #2274)', () => {
      // The Engineer runs Codex gpt-6.1-sol (quality 3). `reviewer` comes first on Claude Sonnet (2); `fresh` runs Claude Opus (3).
      const { f, fresh, reviewer, builder, markReady, reviews } = ready('claude')
      f.state.agents.find(a => a.id === builder)!.configuration.model = 'gpt-6.1-sol'
      f.state.agents.find(a => a.id === reviewer)!.configuration.model = 'claude-sonnet-5-5'
      markReady(`Ready. ${pr}`)
      expect(reviews()[0]!.assignment!.agentId).toBe(fresh)
    })

    it('takes a weaker free Reviewer when none is as strong as the Builder', () => {
      const { f, fresh, reviewer, builder, lead, markReady, reviews } = ready('claude')
      f.run({ type: 'agent.release', agentId: fresh, decision: 'stop' }, { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' })
      f.state.agents.find(a => a.id === builder)!.configuration.model = 'gpt-6.1-sol'
      f.state.agents.find(a => a.id === reviewer)!.configuration.model = 'claude-sonnet-5-5'
      markReady(`Ready. ${pr}`)
      expect(reviews()[0]!.assignment!.agentId).toBe(reviewer)
    })

    it('opens nothing without a link to a pull request of the project\'s repository, or when the Lead marks it ready', () => {
      const { f, lead, markReady, reviews } = ready()
      markReady('Ready. Revision abc.')
      markReady('Ready. https://github.com/example/other/pull/42')
      markReady(`Ready. ${pr}`, { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' })
      expect(reviews()).toHaveLength(0)
      f.state.projects![0]!.repository = { machineId: 'host', cwd: '/repo', repositoryUrl: null }
      markReady(`Ready again. ${pr}`)
      expect(reviews()).toHaveLength(0)
    })

    it('opens no second review while the first has no verdict, and the Reviewer is woken as before', () => {
      const { markReady, reviews, reviewer, lead } = ready()
      markReady(`Ready. ${pr}`)
      const again = markReady(`Ready, head 2. ${pr}`)
      expect(reviews()).toHaveLength(1)
      expect(again.messages.map(m => m.recipients)).toEqual([[lead, reviewer]])
    })

    it('refuses a second review by hand while the open one has no verdict, naming it, and allows one once it is cancelled', () => {
      const { f, leadActor, group, markReady, reviews } = ready()
      markReady(`Ready. ${pr}`)
      const open = reviews()[0]!
      const create = () => f.run({ type: 'conversation.create', title: 'Review: Offline editing again', brief: 'Review it.', reviewOf: group,
        checks: [{ description: 'Verdict', independent: false }] }, leadActor)
      expect(create).toThrow(`#${open.number} Review: Offline editing already reviews this work and has no verdict yet.`)
      expect(reviews()).toHaveLength(1)
      f.run({ type: 'work.cancel', conversationId: open.id, assignmentId: open.assignment!.id, reason: 'Wrong Reviewer' }, leadActor)
      create()
      expect(reviews()).toHaveLength(2)
    })

    it('puts privacy first when the task or the handoff touches sharing, access or confidentiality', () => {
      const { markReady, reviews } = ready()
      markReady(`Ready. Readers without access to the project no longer see its groups. ${pr}`)
      expect(reviews()[0]!.brief.startsWith('Privacy first:')).toBe(true)
    })

    it('keeps a review with no verdict from being archived by hand while the work it reviews is going', () => {
      const { f, leadActor, group, built, reviewer, fresh, markReady, reviews } = ready()
      for (const id of [reviewer, fresh]) f.run({ type: 'agent.release', agentId: id, decision: 'stop' }, leadActor)
      markReady(`Ready. ${pr}`)
      const review = reviews()[0]!.id
      expect(() => f.run({ type: 'conversation.archive', conversationId: review, archived: true }, leadActor)).toThrow('no verdict yet')
      expect(reviews()[0]!.archived).toBe(false)
      f.run({ type: 'work.cancel', conversationId: group, assignmentId: built, reason: 'Dropped' }, leadActor)
      f.run({ type: 'conversation.archive', conversationId: review, archived: true }, leadActor)
      expect(reviews()[0]!.archived).toBe(true)
    })

    it('waits for a Reviewer when none is free, and tells the Lead to route and start one', () => {
      const { f, lead, leadActor, reviewer, fresh, markReady, reviews } = ready()
      for (const id of [reviewer, fresh]) f.run({ type: 'agent.release', agentId: id, decision: 'stop' }, leadActor)
      const effects = markReady(`Ready. ${pr}`)
      expect(reviews()[0]!.assignment).toBeNull()
      expect(effects.messages.filter(m => m.recipients.includes(lead) && m.conversationId === reviews()[0]!.id).map(m => [m.text, agentOnly(m.source, m.recipients)]))
        .toEqual([['Review opened by itself for #1, but no Reviewer is free. Route it and start one.', true]])
    })

    it('gives a delta review to the Reviewer of the earlier head while it is still free', () => {
      const { f, group, builderActor, built, reviewer, fresh, markReady, reviews } = ready()
      markReady(`Ready. ${pr}`)
      const first = reviews()[0]!
      expect(first.assignment!.agentId).toBe(reviewer)
      const reviewerActor: Actor = { kind: 'agent', agentId: reviewer, machineOwnerId: 'target-owner' }
      // A verdict that asks for fixes still passes the review's own check: it says a verdict was given (swarm-review).
      f.run({ type: 'work.check', conversationId: first.id, assignmentId: first.assignment!.id, checkId: first.checks[0]!.id, passed: true,
        evidence: 'Ready: with fixes — revision d4e5f6, one Important finding.' }, reviewerActor)
      f.run({ type: 'work.status', conversationId: first.id, assignmentId: first.assignment!.id, status: 'done', result: 'Changes needed.' }, reviewerActor)
      f.run({ type: 'work.status', conversationId: group, assignmentId: built, status: 'working', result: null }, builderActor)
      // Now `fresh` comes first among the free Reviewers; the earlier head's Reviewer is still preferred.
      f.state.agents.sort((x, y) => Number(y.id === fresh) - Number(x.id === fresh))
      markReady(`Fixed: one finding, head 778899. ${pr}`)
      const delta = reviews().find(c => c.id !== first.id)!
      expect(delta.assignment!.agentId).toBe(reviewer)
      expect(delta.brief).toContain(`Delta review: #${first.number} reviewed the earlier head. Review only the changes since.`)
    })

    it.each([
      ['machines', { kind: 'machines', machineIds: ['elsewhere'] }],
      ['model', { kind: 'forbidModel', model: 'opus' }],
      ['effort', { kind: 'minEffort', effort: 'max' }],
    ])('gives the review to no Reviewer the owner\'s %s rule rules out, and leaves it for the Lead', (_, rule) => {
      const { f, lead, markReady, reviews } = ready()
      f.run({ type: 'rule.set', rule, text: 'The owner\'s rule.' } as Command)
      const effects = markReady(`Ready. ${pr}`)
      expect(reviews()[0]!.assignment).toBeNull()
      expect(effects.messages.filter(m => m.recipients.includes(lead) && m.conversationId === reviews()[0]!.id).map(m => m.text))
        .toEqual(['Review opened by itself for #1, but no Reviewer is free. Route it and start one.'])
    })

    it('passes over a Reviewer the owner\'s rules rule out for one they allow', () => {
      // `reviewer` comes first; only `fresh`'s machine is allowed.
      const { f, fresh, markReady, reviews } = ready()
      f.state.agents.find(a => a.id === fresh)!.machineId = 'allowed'
      f.run({ type: 'rule.set', rule: { kind: 'machines', machineIds: ['allowed'] }, text: 'Only allowed.' } as Command)
      markReady(`Ready. ${pr}`)
      expect(reviews()[0]!.assignment!.agentId).toBe(fresh)
    })

    it.each([
      ['on the grid', { gridModel: 'moonshotai/kimi-k3' }],
      ['below quality 2', { configuration: { ...config, engine: 'claude', model: 'claude-haiku-4-5' } }],
      ['on the Engineer\'s own engine', { configuration: { ...config, engine: 'codex' } }],
    ])('never gives the review to a Reviewer %s (Ken, 2026-10-29), and leaves it for the Lead', (_, patch) => {
      // The Engineer runs Codex; `fresh` is the only free Reviewer.
      const { f, leadActor, reviewer, fresh, markReady, reviews } = ready()
      f.run({ type: 'agent.release', agentId: reviewer, decision: 'stop' }, leadActor)
      Object.assign(f.state.agents.find(a => a.id === fresh)!, patch)
      markReady(`Ready. ${pr}`)
      expect(reviews()[0]!.assignment).toBeNull()
    })

    it('gives a Claude-only Swarm\'s review to its free Opus Reviewer, and to no weaker one of the same engine', () => {
      const { f, reviewer, fresh, markReady, reviews } = ready()
      for (const a of f.state.agents) a.configuration = { ...a.configuration, engine: 'claude' }
      f.state.agents.find(a => a.id === reviewer)!.configuration.model = 'claude-sonnet-4-5'
      f.state.agents.find(a => a.id === fresh)!.configuration.model = 'claude-opus-4-7'
      markReady(`Ready. ${pr}`)
      expect(reviews()[0]!.assignment!.agentId).toBe(fresh)
    })

    it('gives the review to a strong Reviewer on another engine, and to an Engineer on the grid even a Reviewer on its relay engine', () => {
      const { f, builder, fresh, reviewer, markReady, reviews } = ready()
      f.state.agents.find(a => a.id === reviewer)!.gridModel = 'qwen3'
      f.state.agents.find(a => a.id === fresh)!.configuration.model = 'claude-opus-4-7'
      // Claude Code drives the Engineer's grid model: its model family is that model, not Claude's.
      Object.assign(f.state.agents.find(a => a.id === builder)!, { configuration: { ...config, engine: 'claude' }, gridModel: 'deepseek/deepseek-v4.1-flash' })
      markReady(`Ready. ${pr}`)
      expect(reviews()[0]!.assignment!.agentId).toBe(fresh)
    })

    it('passes over a Reviewer that is down for one that is up, and waits when none is up', () => {
      // `reviewer` would be the pick, but its session is gone.
      const { f, leadActor, lead, reviewer, fresh, markReady, reviews } = ready()
      f.state.agents.find(a => a.id === reviewer)!.downSince = new Date(500).toISOString()
      markReady(`Ready. ${pr}`)
      expect(reviews()[0]!.assignment!.agentId).toBe(fresh)
      f.run({ type: 'work.cancel', conversationId: reviews()[0]!.id, assignmentId: reviews()[0]!.assignment!.id, reason: 'Again' }, leadActor)
      f.state.agents.find(a => a.id === fresh)!.downSince = new Date(500).toISOString()
      const effects = markReady(`Ready again. ${pr}`)
      const second = reviews().find(c => c.id !== reviews()[0]!.id)!
      expect(second.assignment).toBeNull()
      expect(effects.messages.filter(m => m.recipients.includes(lead) && m.conversationId === second.id).map(m => m.text))
        .toEqual(['Review opened by itself for #1, but no Reviewer is free. Route it and start one.'])
    })

    it('asks for a full review, not a delta, after a review cancelled before its verdict', () => {
      const { f, leadActor, markReady, reviews } = ready()
      markReady(`Ready. ${pr}`)
      const cancelled = reviews()[0]!
      f.run({ type: 'work.cancel', conversationId: cancelled.id, assignmentId: cancelled.assignment!.id, reason: 'Wrong Reviewer' }, leadActor)
      markReady(`Ready, same head. ${pr}`)
      const next = reviews().find(c => c.id !== cancelled.id)!
      expect(next.brief).not.toContain('Delta review')
    })
  })

  it('does not wake a Reviewer that is stopping', () => {
    const { f, lead, leadActor, group, reviewer, builder } = reviewed()
    f.run({ type: 'agent.release', agentId: reviewer, decision: 'stop' }, leadActor)
    const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: builder }).result.assignmentId as string
    const ready = f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'review', result: 'Head abc' }, { kind: 'agent', agentId: builder, machineOwnerId: 'host-owner' })
    expect(ready.messages[0]!.recipients).toEqual([lead])
  })

  it('lets the Lead keep or stop a Reviewer that only sits in a group with active work: only its own active work refuses', () => {
    const { f, leadActor, group, reviewer, builder } = reviewed()
    f.run({ type: 'work.assign', conversationId: group, agentId: builder })
    f.run({ type: 'agent.release', agentId: reviewer, decision: 'keep' }, leadActor)
    expect(f.state.agents.find(a => a.id === reviewer)).toHaveProperty('workDecision', 'keep')
    f.run({ type: 'agent.release', agentId: reviewer, decision: 'stop' }, leadActor)
    expect(f.state.agents.find(a => a.id === reviewer)).toHaveProperty('workDecision', 'stop')
    expect(() => f.run({ type: 'agent.release', agentId: builder, decision: 'stop' }, leadActor)).toThrow('active work')
  })

  it('loses a Reviewer\'s review when its model keeps failing, and keeps the Reviewer out of the decision queue', () => {
    const { f, leadActor, group, reviewer } = reviewed()
    const review = f.run({ type: 'conversation.create', title: 'Review', brief: 'Review it.', reviewOf: group, checks: [{ description: 'Verdict', independent: false }] },
      leadActor).result.conversationId as string
    f.run({ type: 'work.assign', conversationId: review, agentId: reviewer })
    f.run({ type: 'agent.alert', agentId: reviewer, alert: 'model', active: true }, { kind: 'agent', agentId: reviewer, machineOwnerId: 'target-owner' })
    expect(f.state.conversations.find(c => c.id === review)!.assignment).toMatchObject({ status: 'lost', lost: { reason: 'its model keeps failing' } })
    expect(f.state.agents.find(a => a.id === reviewer)!.lostTask).toMatchObject({ conversationId: review })
  })

  it('never makes the Lead decide about a finished Reviewer before routing, starting or assigning, even one stored as waiting', () => {
    const { f, lead, leadActor, group, reviewer, builder } = reviewed()
    const checks = [{ description: 'Verdict', independent: false }]
    const review = f.run({ type: 'conversation.create', title: 'Review', brief: 'Review it.', reviewOf: group, checks }, leadActor).result.conversationId as string
    const reviewing = f.run({ type: 'work.assign', conversationId: review, agentId: reviewer }).result.assignmentId as string
    f.run({ type: 'work.status', conversationId: review, assignmentId: reviewing, status: 'stopped', result: null }, owner, { confirmedStopped: true })
    expect(f.state.agents.find(a => a.id === reviewer)!.workDecision).toBe('keep')
    // A Reviewer a release from before this left waiting for a decision.
    f.state.agents.find(a => a.id === reviewer)!.workDecision = 'awaiting'
    const next = f.group()
    f.run({ type: 'conversation.agent', conversationId: next, agentId: lead, present: true, lead: true })
    const pick = record({ candidates: [candidate('c0', { kind: 'member', agentId: builder, machineId: 'host' })], pick: 'c0' })
    expect(f.run({ type: 'route.record', conversationId: next, decision: pick } as Command, leadActor).routeDecisions).toHaveLength(1)
    f.run({ type: 'work.assign', conversationId: next, agentId: builder, ...via }, leadActor, decisionIn(next))
  })

  it('lets the Lead keep or stop a Reviewer that never had work, and only stop such a Builder', () => {
    const { f, leadActor, reviewer, builder } = reviewed()
    f.run({ type: 'agent.release', agentId: reviewer, decision: 'keep' }, leadActor)
    expect(f.state.agents.find(a => a.id === reviewer)).toHaveProperty('workDecision', 'keep')
    f.run({ type: 'agent.release', agentId: reviewer, decision: 'stop' }, leadActor)
    expect(f.state.agents.find(a => a.id === reviewer)).toHaveProperty('workDecision', 'stop')
    expect(() => f.run({ type: 'agent.release', agentId: builder, decision: 'keep' }, leadActor)).toThrow('no finished assignment')
    f.run({ type: 'agent.release', agentId: builder, decision: 'stop' }, leadActor)
    expect(f.state.agents.find(a => a.id === builder)).toHaveProperty('workDecision', 'stop')
  })

  it('keeps the group\'s idle Reviewers when its work ends, waiting for no decision, and counts adding one to a group as reuse', () => {
    const { f, leadActor, group, reviewer, builder } = reviewed()
    const other = f.group(), busy = f.group(), otherBuilder = f.add('other-builder', 'owner', busy)
    f.run({ type: 'conversation.agent', conversationId: busy, agentId: leadActor.agentId, present: true, lead: true })
    const decision = (id: string) => f.state.agents.find(a => a.id === id)!.workDecision
    const finish = (g: string, worker: string) => {
      const assignmentId = f.run({ type: 'work.assign', conversationId: g, agentId: worker }).result.assignmentId as string
      return () => f.run({ type: 'work.cancel', conversationId: g, assignmentId, reason: 'Obsolete' }, leadActor)
    }
    // Still reviewing another group's active work: not kept yet.
    f.run({ type: 'conversation.agent', conversationId: busy, agentId: reviewer, present: true, lead: false })
    const endBusy = finish(busy, otherBuilder)
    finish(group, builder)()
    expect(decision(reviewer)).toBeUndefined()
    endBusy()
    expect(decision(reviewer)).toBe('keep')
    expect(visibleState(f.state, owner).agents.find(a => a.id === reviewer)).toHaveProperty('workDecision', 'keep')
    // Assigning elsewhere waits only for the Builders' decisions, never for the Reviewer's.
    f.run({ type: 'agent.release', agentId: builder, decision: 'keep' }, leadActor)
    f.run({ type: 'agent.release', agentId: otherBuilder, decision: 'keep' }, leadActor)
    f.run({ type: 'work.define', conversationId: other, brief: 'Next', checks: [{ description: 'Done', independent: false }] })
    // Adding it to that group reuses it.
    f.run({ type: 'conversation.agent', conversationId: other, agentId: reviewer, present: true, lead: false })
    expect(decision(reviewer)).toBeUndefined()
    f.run({ type: 'work.assign', conversationId: other, agentId: builder, ...via }, leadActor, decisionIn(other))
  })

  it('keeps a Reviewer that stays in its group reused for that group\'s next attempt', () => {
    const { f, leadActor, group, reviewer, builder } = reviewed()
    const assignmentId = f.run({ type: 'work.assign', conversationId: group, agentId: builder }).result.assignmentId as string
    f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'stopped', result: null }, owner, { confirmedStopped: true })
    expect(f.state.agents.find(a => a.id === reviewer)!.workDecision).toBe('keep')
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
    const route = (decision: unknown) => f.run({ type: 'route.record', conversationId: 'lead', decision } as Command, f.leadActor, {})
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

describe('a task that requires a machine or a device', () => {
  // 2026-10-27: a task to check a device plugged into one person's Mac was routed to another machine by policy order.
  const task = { goal: 'Check the round device', changes: 'None', constraints: 'On the Mac it is plugged into', owns: ['devices'] }
  const checks = [{ description: 'It answers.', independent: false }]
  const requiring = (f: ReturnType<typeof routed>, requires: Record<string, unknown>, actor: Actor = owner) =>
    f.run({ type: 'work.define', conversationId: 'lead', task: { ...task, requires }, checks } as Command, actor)
  const startOn = (f: ReturnType<typeof routed>, machineId: string, actor: Actor, devices: string[] = []) => f.run({ type: 'agent.start', request: { conversationId: 'lead', machineId,
    engine: 'claude', model: 'opus', effort: 'high', name: 'Builder', cwd: '/repo', worktree: true,
    requirements: { memoryBytes: 1, diskBytes: 1, maxCpuPercent: 80, tools: [], devices, quotaRequired: false } }, ...via } as Command, actor, { contribution: f.contribution, ...decisionIn() })
  const NOT_HERE = 'This task runs only on the machine it requires, and this is another machine.'

  it('keeps the requirement on the task, without naming the machine in the brief', () => {
    const f = routed()
    requiring(f, { machines: ['machine'], devices: ['/dev/cu.usbmodem1'] })
    expect(f.state.conversations[0]!.task!.requires).toEqual({ machines: ['machine'], devices: ['/dev/cu.usbmodem1'] })
    expect(f.state.conversations[0]!.brief).not.toContain('machine')
  })
  it('takes only machines of the Swarm the setter can see, and at least one machine or device', () => {
    const f = routed()
    expect(() => requiring(f, { machines: ['nowhere'] })).toThrow('Name a machine of this Swarm')
    expect(() => requiring(f, {})).toThrow()
    expect(() => requiring(f, { machines: [] })).toThrow()
    expect(() => requiring(f, { devices: ['dev/relative'] })).toThrow()
  })
  it('refuses an agent\'s start on another machine, even with an override reason, and starts on the required one', () => {
    const f = routed()
    requiring(f, { machines: ['machine'] })
    expect(() => startOn(f, 'host', f.leadActor)).toThrow(expect.objectContaining({ code: 'REQUIREMENT_UNMET', status: 403, message: `${NOT_HERE} Route again.` }))
    expect(startOn(f, 'machine', f.leadActor).result.startId).toBeTruthy()
  })
  it('refuses an agent\'s assignment of a member on another machine and a recorded pick there', () => {
    const f = routed()
    requiring(f, { machines: ['machine'] })
    // The worker runs on 'host'.
    expect(() => f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker, ...via }, f.leadActor, decisionIn())).toThrow(NOT_HERE)
    expect(() => f.run({ type: 'route.record', conversationId: 'lead', decision: record({ candidates: [candidate('c0', { machineId: 'host' })] }) } as Command, f.leadActor, {}))
      .toThrow(NOT_HERE)
    expect(f.run({ type: 'route.record', conversationId: 'lead', decision: record({ candidates: [candidate('c0', { machineId: 'machine' })] }) } as Command, f.leadActor, {})
      .result.routeDecisionId).toBeTruthy()
  })
  it('lets a person through with a warning that does not name the machine', () => {
    const f = routed()
    requiring(f, { machines: ['machine'] })
    const effects = startOn(f, 'host', owner)
    expect(effects.result.warnings).toEqual([NOT_HERE])
    expect(effects.messages.map(m => m.text)).toContain(`owner started Builder anyway. ${NOT_HERE}`)
  })
  it('refuses an agent\'s start that does not ask its machine for the required devices', () => {
    const f = routed()
    requiring(f, { devices: ['/dev/cu.usbmodem1'] })
    expect(() => startOn(f, 'machine', f.leadActor)).toThrow(expect.objectContaining({ code: 'REQUIREMENT_UNMET', message: expect.stringContaining('This task needs /dev/cu.usbmodem1') }))
    expect(startOn(f, 'machine', f.leadActor, ['/dev/cu.usbmodem1']).result.startId).toBeTruthy()
  })
  it('refuses assigning a worker whose start never had its machine check the required device, with or without an override', () => {
    const f = routed()
    requiring(f, { devices: ['/dev/cu.usbmodem1'] })
    const worker = f.state.agents.find(a => a.id === f.worker)!
    const picked = { routeDecision: { id: 'd1', conversationId: 'lead', final: null, override: null, assignmentId: null, outcome: null,
      record: record({ candidates: [candidate('c0', { kind: 'member', agentId: f.worker, machineId: 'host' })] }) } as unknown as RouteDecision }
    const assign = (patch: Record<string, unknown>, context: Partial<CommandContext>) =>
      f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker, ...patch } as Command, f.leadActor, context)
    const refused = expect.objectContaining({ code: 'REQUIREMENT_UNMET', status: 403, message: expect.stringContaining('This task needs /dev/cu.usbmodem1') })
    expect(() => assign({ routeDecisionId: 'd1' }, picked)).toThrow(refused)
    expect(() => assign(via, decisionIn())).toThrow(refused)
    expect(() => f.run({ type: 'route.record', conversationId: 'lead', decision: picked.routeDecision.record } as Command, f.leadActor, {})).toThrow(refused)
    // A start that asked for other devices is no evidence either.
    f.state.starts = [{ harnessId: worker.harnessId, request: { machineId: 'host', requirements: { devices: ['/dev/other'] } } } as never]
    expect(() => assign({ routeDecisionId: 'd1' }, picked)).toThrow(refused)
    f.state.starts = [{ harnessId: worker.harnessId, request: { machineId: 'host', requirements: { devices: ['/dev/cu.usbmodem1'] } } } as never]
    expect(assign({ routeDecisionId: 'd1' }, picked).result.assignmentId).toBeTruthy()
  })
  it('lets a person assign a worker without device evidence, with a warning', () => {
    const f = routed()
    requiring(f, { devices: ['/dev/cu.usbmodem1'] })
    const effects = f.run({ type: 'work.assign', conversationId: 'lead', agentId: f.worker })
    expect(effects.result.warnings).toEqual([expect.stringContaining('This task needs /dev/cu.usbmodem1')])
  })
  it('counts a Mac\'s Harness Team account as that Mac', () => {
    const f = routed()
    teamMachine(f, 'owner', 'team')
    f.state.machines!.find(m => m.machineId === 'team')!.hostMachineId = 'machine'
    requiring(f, { machines: ['machine'] })
    expect(startOn(f, 'team', f.leadActor).result.startId).toBeTruthy()
  })
  it('shows a reader who cannot see the machine only that the task waits for one', () => {
    const f = routed()
    requiring(f, { machines: ['machine', 'host'] })
    expect(visibleState(f.state, owner).conversations[0]!.task!.requires).toEqual({ machines: ['machine', 'host'] })
    // No machine record and no agent the reader sees runs there any more.
    f.state.agents = f.state.agents.filter(a => a.machineId !== 'machine')
    expect(visibleState(f.state, owner).conversations[0]!.task!.requires).toEqual({ machines: ['host'], unseenMachines: 1 })
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
    const route = (conversationId: string, actor: Actor) => f.run({ type: 'route.record', conversationId, decision: record({ pick: 'c1' }) } as Command, actor, {})
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
    'Could not start Builder: its machine could not prepare or launch it. The Lead and the machine owner can read why.', 'owner removed worker from the Swarm.']))
  expect(rows.filter(r => !r.source).map(r => r.text)).toEqual([])
})

// The round-device group, 2026-10-27: the host failed a queued start, the notice went to nobody, and the group sat without a
// worker for an hour. The Lead is woken to start it elsewhere once or report it (cli superTabs/start.ts).
it('delivers a failed start\'s notice to the Lead of its group, and to nobody when the group has no Lead in it', () => {
  const f = fixture(); f.invite()
  const lead = f.add('lead', 'owner', 'lead', true)
  const group = f.run({ type: 'conversation.create', title: 'Drafts', brief: 'Save drafts.', checks: [{ description: 'Saved.', independent: false }] }, owner)
    .result.conversationId as string
  const start = (id: string, conversationId: string) => ({ id, actorKey: 'person:owner', contributorId: 'owner', membershipGeneration: f.state.people[0]!.generation,
    request: { conversationId, machineId: 'mac', name: 'Builder' }, error: null })
  f.state.starts = [start('s1', 'lead'), start('s2', group)] as never
  expect(f.run({ type: 'agent.startFailed', startId: 's1', error: 'Launch refused.' }, owner).messages)
    .toMatchObject([{ conversationId: 'lead', text: 'Could not start Builder: its machine could not prepare or launch it. The Lead and the machine owner can read why.', recipients: [lead] }])
  // A Lead that left the group's members is not told there, as a removed machine's notice is not (removeMachine).
  Object.assign(f.state.conversations.find(c => c.id === group)!, { leadId: lead, agentIds: [] })
  expect(f.run({ type: 'agent.startFailed', startId: 's2', error: 'Launch refused.' }, owner).messages).toMatchObject([{ conversationId: group, recipients: [] }])
})

// A start's raw reason can name its machine, a folder on it or a token problem, and every group member reads the group
// (review of #1847): they read a generic reason, and only the Lead and the machine owner read the raw one.
describe('a failed start\'s reason', () => {
  const RAW = 'Studio (host-mac) could not prepare /Users/ken/swarm/project: the Harness GitHub App token ghs_abc123 is not in the form GitHub gives.'
  const failed = (f: ReturnType<typeof fixture>, error: string | null = null) => {
    f.state.starts = [{ id: 's1', actorKey: 'person:owner', contributorId: 'owner', membershipGeneration: f.state.people[0]!.generation,
      machineOwnerId: 'peer', request: { conversationId: 'lead', machineId: 'host-mac', name: 'Builder' }, harnessId: null, dispatched: true, error }] as never
  }
  it('tells the group a generic reason, never the machine, a folder, a token or the raw error', () => {
    const f = fixture(); f.invite()
    failed(f)
    const [notice] = f.run({ type: 'agent.startFailed', startId: 's1', error: RAW }, owner).messages
    expect(notice!.text).toBe('Could not start Builder: its machine could not prepare or launch it. The Lead and the machine owner can read why.')
    for (const hidden of ['Studio', 'host-mac', '/Users', 'token', 'ghs_', RAW]) expect(notice!.text).not.toContain(hidden)
    // The start keeps the raw reason for those who may read it.
    expect(f.state.starts![0]!.error).toBe(RAW)
  })
  // Ken's MacBook Pro, 2026-10-28: a start refused for memory read as a broken machine. Members see a machine's free memory in
  // the Machines view, so that reason, and only its numbers, is told as it is.
  it('tells the group a memory shortage with its numbers, and keeps every other reason hidden, even one that starts like it', () => {
    const f = fixture(); f.invite()
    failed(f)
    const memory = 'Not enough free memory: 1.8 GiB free, 2 GiB needed. 6 GiB more is set aside for agents still starting.'
    expect(f.run({ type: 'agent.startFailed', startId: 's1', error: memory }, owner).messages[0]!.text)
      .toBe('Could not start Builder: its machine has only 1.8 GiB of memory free, and it needs 2 GiB.')
    // A member who did not make the start reads the same, never the rest of the host's reason.
    f.state.starts![0]!.actorKey = 'person:someone'
    expect(visibleState(f.state, owner).starts![0]!.error).toBe('Its machine has only 1.8 GiB of memory free, and it needs 2 GiB.')
    for (const error of ['Not enough free memory on /Users/ken: 1.8 GiB free, 2 GiB needed.', 'Not enough free memory: lots free, 2 GiB needed.', RAW]) {
      failed(f)
      expect(f.run({ type: 'agent.startFailed', startId: 's1', error }, owner).messages[0]!.text)
        .toBe('Could not start Builder: its machine could not prepare or launch it. The Lead and the machine owner can read why.')
    }
  })
  it('hands the raw reason on the start only to its Lead and the machine owner', () => {
    const f = fixture(); f.invite()
    const lead = f.add('lead-agent', 'owner', 'lead', true), worker = f.add('worker', 'owner')
    failed(f, RAW)
    f.state.starts![0]!.actorKey = `agent:${lead}`
    const read = (actor: Actor) => visibleState(f.state, actor).starts![0]!.error
    expect(read({ kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' })).toBe(RAW)
    expect(read(peer)).toBe(RAW)
    // The tab's owner and another agent of the group read only what it means.
    expect(read(owner)).toBe('Its machine could not prepare or launch it.')
    expect(read({ kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' })).toBe('Its machine could not prepare or launch it.')
    // The group's Lead reads it even when a person made the start by hand.
    f.state.starts![0]!.actorKey = 'person:someone'
    expect(read({ kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' })).toBe(RAW)
    // A start its machine never ran reads as that; the server's own reasons name nothing and read as they are.
    f.state.starts![0]!.error = 'Studio did not start it within 3 minutes'
    expect(read(owner)).toBe('Its machine did not start it within 3 minutes.')
    f.state.starts![0]!.error = 'Studio was still preparing it after 15 minutes'
    expect(read(owner)).toBe('Its machine was still preparing it after 15 minutes.')
    f.state.starts![0]!.error = 'Studio stopped reporting while preparing it'
    expect(read(owner)).toBe('Its machine stopped reporting while preparing it.')
    expect(read(peer)).toBe('Studio stopped reporting while preparing it')
    f.state.starts![0]!.error = 'Its machine was removed from the Swarm.'
    expect(read(owner)).toBe('Its machine was removed from the Swarm.')
  })
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
  it('keeps the owner\'s opt-out from grid models first, which only ranks and refuses no start', () => {
    const f = routed()
    f.run(set({ kind: 'noGridFirst' }, 'Subscriptions first.'))
    expect(f.state.rules!.map(r => r.rule)).toEqual([{ kind: 'noGridFirst' }])
    expect(f.run({ type: 'agent.start', request: request(), ...via } as Command, f.leadActor, { contribution: f.contribution, ...decisionIn() }).result.startId).toEqual(expect.any(String))
    expect(() => f.run(set({ kind: 'noGridFirst', engine: 'claude' }))).toThrow()
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
    expect(notice).toMatchObject({ author: { kind: 'person', id: 'owner' }, source: { kind: 'machine-removed', machine: 'Studio' } })
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

  // A settings save keeps a machine's pause (review of #2084), but nothing of a removed machine is kept.
  it('starts a machine removed and added again unpaused, though its removal paused it', () => {
    const { f, removalId } = cleaning()
    expect(f.state.machines!.map(m => m.paused)).toEqual([true])
    f.run(cleaned(removalId))
    f.run({ type: 'machine.contribute', machineId: 'host', name: 'Studio', cwd: '/repo', engines: ['claude'], maxAgents: 2 }, owner,
      { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
    expect(f.state.machines).toEqual([expect.objectContaining({ machineId: 'host', paused: false })])
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

  // Diego's Mac, 2026-10-28: a host that keeps reporting but never confirms held its machine 'Cleaning up' for a day.
  it('drops the machine\'s records after 30 minutes without an acknowledgement, says so in the project\'s chat, and keeps the cleanup for its host', () => {
    const { f, removalId } = cleaning()
    const day = 30 * 60_000
    // Its host keeps reporting, so only the fallback can expire it.
    f.state.machines![0]!.observation!.receivedAt = 1000 + day - 1
    expect(f.run({ type: 'tab.rename', name: 'Still cleaning' }, owner, { now: 1000 + day - 1 }).messages).toEqual([])
    expect(f.state.machines!.map(m => m.removal?.id)).toEqual([removalId])
    expect(visibleState(f.state, owner, 1000 + day).machines).toEqual([])
    expect(f.run({ type: 'tab.rename', name: 'Half an hour later' }, owner, { now: 1000 + day }).messages).toEqual([
      expect.objectContaining({ conversationId: 'lead', source: { kind: 'machine-left', machine: 'Studio' },
        text: 'Studio left the Swarm: its host did not confirm its cleanup within 30 minutes. It finishes the cleanup when it next connects.' })])
    expect(f.state.machines).toEqual([])
    expect(f.state.machineCleanups).toEqual([{ machineId: 'host', removalId, machineOwnerId: 'owner', requestedAt: new Date(1000).toISOString() }])
    const add = { type: 'machine.contribute', machineId: 'host', name: 'Studio', cwd: '/repo', engines: ['claude'], maxAgents: 2 } as Command
    expect(() => f.run(add, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' }, now: 1000 + day - 1 })).toThrow('still cleaning up')
    // Its host's late confirmation closes the cleanup without telling anyone again.
    expect(f.run(cleaned(removalId), owner, { now: 1000 + day }).messages).toEqual([])
    expect(f.state.machineCleanups).toBeUndefined()
  })

  // Diego's Mac, 2026-10-28: its cleanup never finished, and adding it back said 'still cleaning up' for good. A cleanup that
  // has waited 30 minutes no longer holds its owner's add: the add goes through and that cleanup is dropped.
  it('lets its owner add the machine again once its cleanup has waited 30 minutes, and drops that cleanup', () => {
    const f = fixture()
    contribute(f, 'owner', 'host', null)
    f.run({ type: 'machine.remove', machineId: 'host' })
    const add = { type: 'machine.contribute', machineId: 'host', name: 'Studio', cwd: '/repo', engines: ['claude'], maxAgents: 2 } as Command
    const asOwner = (now: number) => ({ contribution: { machineOwnerId: 'owner', contributorId: 'owner' }, now })
    expect(() => f.run(add, owner, asOwner(1000 + 30 * 60_000 - 1))).toThrow(expect.objectContaining({ code: 'MACHINE_CLEANING' }))
    f.run(add, owner, asOwner(1000 + 30 * 60_000))
    expect(f.state.machineCleanups).toBeUndefined()
    expect(f.state.machines!.map(m => [m.machineId, m.removal])).toEqual([['host', undefined]])
  })

  it('lets its owner add the machine again over a cleanup recorded before cleanups carried their time', () => {
    const f = fixture()
    f.state.machineCleanups = [{ machineId: 'host', removalId: 'before', machineOwnerId: 'owner' }, { machineId: 'other', removalId: 'kept', machineOwnerId: 'owner' }]
    f.run({ type: 'machine.contribute', machineId: 'host', name: 'Studio', cwd: '/repo', engines: ['claude'], maxAgents: 2 }, owner,
      { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
    expect(f.state.machineCleanups).toEqual([{ machineId: 'other', removalId: 'kept', machineOwnerId: 'owner' }])
    expect(f.state.machines!.map(m => m.machineId)).toEqual(['host'])
  })

  it('lets only the owner of an old cleanup add its machine over it', () => {
    const f = fixture()
    f.invite()
    f.state.machineCleanups = [{ machineId: 'host', removalId: 'before', machineOwnerId: 'peer' }]
    const add = { type: 'machine.contribute', machineId: 'host', name: 'Studio', cwd: '/repo', engines: ['claude'], maxAgents: 2 } as Command
    // Another member is no owner of this machine at all.
    expect(() => f.run(add, peer, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })).toThrow(expect.objectContaining({ code: 'OWNER_REQUIRED' }))
    // The machine's owner now is not the person whose host owes that cleanup: it still holds.
    expect(() => f.run(add, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })).toThrow(expect.objectContaining({ code: 'MACHINE_CLEANING' }))
    f.run(add, peer, { contribution: { machineOwnerId: 'peer', contributorId: 'peer' } })
    expect(f.state.machineCleanups).toBeUndefined()
  })

  // Ken's remote-deepseek and WIN-DELL, 2026-10-28: removed, then their machine accounts deleted, so no host would ever
  // confirm their cleanups, which stayed for good. A machine whose account is gone takes its cleanups with it.
  it('drops the cleanups of machines whose account is deleted, on any change, and says nothing', () => {
    const f = fixture()
    f.state.machineCleanups = [{ machineId: 'gone', removalId: 'a', machineOwnerId: 'owner' }, { machineId: 'host', removalId: 'b', machineOwnerId: 'owner' },
      { machineId: 'gone', removalId: 'c', machineOwnerId: 'owner' }]
    expect(f.run({ type: 'tab.rename', name: 'Tidy' }, owner, { deletedMachineIds: ['gone'] }).messages).toEqual([])
    expect(f.state.machineCleanups).toEqual([{ machineId: 'host', removalId: 'b', machineOwnerId: 'owner' }])
    f.run({ type: 'tab.rename', name: 'Tidier' }, owner, { deletedMachineIds: ['host'] })
    expect(f.state.machineCleanups).toBeUndefined()
  })

  // Review of #1986 (Minor 2, intended): the adds a host makes by itself, the owner's machine running its Lead and a Mac's
  // Harness Team account joining where the Mac is, take an overdue cleanup's place like the owner's own add; a fresh one
  // still holds them off without an error.
  it('lets the automatic adds take an overdue cleanup\'s place, and leaves a fresh one waiting', () => {
    const f = fixture()
    const fresh = new Date(1000 + 30 * 60_000 - 1).toISOString()
    f.state.machineCleanups = [{ machineId: 'host', removalId: 'old', machineOwnerId: 'owner', requestedAt: fresh },
      { machineId: 'team', removalId: 'old', machineOwnerId: 'owner', requestedAt: fresh }]
    const add = (machineId: string) => ({ type: 'machine.contribute', machineId, name: 'Studio', cwd: '/repo', scope: 'swarm', engines: ['claude'], maxAgents: 2,
      ifMissing: true }) as Command
    const owners = (now: number, hostMachineId?: string) => ({ contribution: { machineOwnerId: 'owner', contributorId: 'owner', ...(hostMachineId ? { hostMachineId } : {}) }, now })
    // Fresh: the owner's host skips its automatic add and nothing changes.
    f.run(add('host'), owner, owners(1000 + 30 * 60_000 - 1))
    expect([f.state.machines ?? [], f.state.machineCleanups!.map(c => c.machineId)]).toEqual([[], ['host', 'team']])
    // Overdue: the owner's host adds its machine, then its Team account joins where that Mac is.
    const later = 1000 + 60 * 60_000
    f.run(add('host'), owner, owners(later))
    f.run(add('team'), owner, owners(later, 'host'))
    expect(f.state.machines!.map(m => [m.machineId, m.hostMachineId, m.removal])).toEqual([['host', undefined, undefined], ['team', 'host', undefined]])
    expect(f.state.machineCleanups).toBeUndefined()
  })

  it('tells each project\'s chat that the machine left once its host confirmed the cleanup', () => {
    const { f, removalId } = cleaning()
    const docs = f.run({ type: 'project.create', name: 'Docs', visibility: 'public', brief: '' }).result as { conversationId: string }
    expect(f.run(cleaned(removalId)).messages).toEqual(['lead', docs.conversationId].map(conversationId => expect.objectContaining({
      conversationId, source: { kind: 'machine-left', machine: 'Studio' }, recipients: [], text: 'Studio left the Swarm: its host confirmed its cleanup.' })))
  })

  it('writes the line only in the chats of projects its machine owner can open', () => {
    const f = fixture()
    f.invite()
    contribute(f, 'peer')
    f.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' })
    const removalId = f.run({ type: 'machine.remove', machineId: 'host' }, peer).result.removalId as string
    expect(f.run(cleaned(removalId), peer).messages.map(m => [m.conversationId, m.author.id])).toEqual([['lead', 'peer']])
  })

  it.each([['has no reading', null], ['was last read long ago', 1000 - 45_001]] as const)(
    'drops a machine that is offline (%s) at once, and keeps its cleanup for its host', (_why, receivedAt) => {
      const f = fixture()
      contribute(f, 'owner', 'host', receivedAt)
      // Listed, if offline, until its owner removes it.
      expect(visibleState(f.state, owner).machines).toHaveLength(1)
      const effects = f.run({ type: 'machine.remove', machineId: 'host' })
      const removalId = effects.result.removalId as string
      expect(effects.messages).toEqual([expect.objectContaining({ conversationId: 'lead', source: { kind: 'machine-left', machine: 'Studio' },
        text: 'Studio left the Swarm: it is offline. It cleans up when it next connects.' })])
      expect(f.state.machines).toEqual([])
      expect(f.state.machineCleanups).toEqual([{ machineId: 'host', removalId, machineOwnerId: 'owner', requestedAt: new Date(1000).toISOString() }])
      expect(visibleState(f.state, owner).machines).toEqual([])
      // Its host still gets the cleanup on its next connection; its later acknowledgement closes it and changes nothing else.
      f.run(cleaned(removalId))
      expect(f.state.machineCleanups).toBeUndefined()
      expect(f.state.machines).toEqual([])
    })

  it('hands its cleanup to its host once when it comes back, and a second acknowledgement changes nothing', () => {
    const f = fixture()
    contribute(f, 'owner', 'host', null)
    const removalId = f.run({ type: 'machine.remove', machineId: 'host' }).result.removalId as string
    // While its host is away, more reads and changes never queue the cleanup twice.
    const away = 1000 + 45_001
    expect(visibleState(f.state, owner, away).machines).toEqual([])
    f.run({ type: 'tab.rename', name: 'Still away' }, owner, { now: away })
    f.run({ type: 'tab.rename', name: 'Away a day' }, owner, { now: 1000 + 86_400_000 })
    expect(f.state.machineCleanups).toEqual([{ machineId: 'host', removalId, machineOwnerId: 'owner', requestedAt: new Date(1000).toISOString() }])
    // It comes back, is handed that one cleanup, and acknowledges it: nothing comes back to life.
    f.run(cleaned(removalId))
    expect(f.state.machineCleanups).toBeUndefined()
    expect(f.state.machines).toEqual([])
    // A late second acknowledgement finds nothing left to undo.
    expect(() => f.run(cleaned(removalId))).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(f.state.machines).toEqual([])
    expect(f.state.machineCleanups).toBeUndefined()
  })

  it('drops a machine already cleaning once it is offline, on the next read and on the next change', () => {
    const { f, removalId } = cleaning()
    const later = 1000 + 45_001
    // A read that finds it offline leaves it out without writing.
    expect(visibleState(f.state, owner, later).machines).toEqual([])
    expect(visibleState(f.state, owner, later).machineCleanups).toBeUndefined()
    expect(f.state.machines).toEqual([expect.objectContaining({ machineId: 'host' })])
    // The next change applies the same rule, says why, and keeps the cleanup for its host.
    expect(f.run({ type: 'tab.rename', name: 'Still cleaning' }, owner, { now: later }).messages).toEqual([expect.objectContaining({
      conversationId: 'lead', text: 'Studio left the Swarm: it is offline. It cleans up when it next connects.' })])
    expect(f.state.machines).toEqual([])
    expect(f.state.machineCleanups).toEqual([{ machineId: 'host', removalId, machineOwnerId: 'owner', requestedAt: new Date(1000).toISOString() }])
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
    teamMachine(f, 'peer')
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
    // The two Leads' to settle (Ken, 2026-10-29): people in the Leads chat do not read it.
    expect(agentOnly(alert.source, alert.recipients)).toBe(true)
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

  it('is on in a new Swarm, its grid named, so the owner\'s computer sets it up in the background', () => {
    const f = fixture()
    expect(f.state.localModels).toEqual({ grid: swarmGridName('tab'), enabled: true })
    expect(swarmGridRow('tab', f.state)).toMatchObject({ grid: swarmGridName('tab'), enabled: true, ready: null })
  })

  it('is off in a Swarm from before until the owner turns it on, mints one grid name, and keeps it when turned off', () => {
    const f = fixture()
    delete f.state.localModels
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
    delete f.state.localModels
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
    delete viewing.state.localModels
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
    const builtIn = DEFAULT_ROUTING_POLICY.localModels!.models
    expect(effectivePolicy(null, null).policy.localModels).toEqual({ quality: 1, enabled: true, models: builtIn })
    const saved = { ...DEFAULT_ROUTING_POLICY } as Record<string, unknown>
    delete saved.localModels
    expect(effectivePolicy(saved, null).policy.localModels).toEqual({ quality: 1, enabled: true, models: builtIn })
    expect(effectivePolicy(saved, { localModels: { quality: 2, enabled: true } }).policy.localModels).toEqual({ quality: 2, enabled: true, models: builtIn })
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

  it('refuses a non-Lead agent, another project’s Lead and any tag in the Leads conversation; a person tags (mentions.test.ts)', () => {
    const { f, lead, secret } = swarm(), group = f.group(), worker = f.add('worker', 'owner', group)
    expect(f.run(send(group, ['peer'])).messages[0]!.mentions).toEqual(['peer'])
    expect(() => f.run(send(group, ['peer']), as(worker))).toThrow('Only a project’s Lead can tag people.')
    expect(() => f.run(send(group, ['owner']), as(secret.lead))).toThrow('This project is unavailable.')
    expect(() => f.run(send(f.state.leadsConversationId!, ['owner']), as(lead))).toThrow('Nobody is tagged in the Leads conversation.')
  })

  it('refuses a person who cannot read the conversation or is not in the Swarm', () => {
    const { f, secret } = swarm()
    expect(() => f.run(send(secret.conversationId, ['peer']), as(secret.lead))).toThrow('peer cannot read this conversation.')
    expect(() => f.run(send(secret.conversationId, ['stranger']), as(secret.lead))).toThrow('Tag a person in this Swarm.')
    expect(f.run(send(secret.conversationId, ['owner']), as(secret.lead)).messages[0]!.mentions).toEqual(['owner'])
  })

  it('holds a tag for a notice that says a task has no worker, and only a tag can be held', () => {
    const { f, lead } = swarm(), group = f.group()
    const held = (mentions: string[]): Command => ({ ...send(group, mentions), mentionsIfNoWorker: true } as Command)
    expect(f.run(held(['peer']), as(lead)).messages[0]).toMatchObject({ mentions: ['peer'], holdMentions: true })
    expect(f.run(send(group, ['peer']), as(lead)).messages[0]).not.toHaveProperty('holdMentions')
    expect(() => f.run(held([]), as(lead))).toThrow('Hold a tag only for a message that tags someone.')
    expect(commandSchema.safeParse({ ...send(group, ['peer']), mentionsIfNoWorker: false }).success).toBe(false)
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

describe('credentials in Swarm chat', () => {
  // Assembled at run time from obviously fake parts, never a credential-shaped literal.
  const jwt = [{ alg: 'HS256', typ: 'JWT' }, { sub: 'fixture-user' }].map(part => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .concat('Fixture0Signature1Not2Real3Value4abcdefgh').join('.')
  const github = ['ghp', 'Fixture0Token1Not2Real3Value4abcdefgh'].join('_')
  const notice = 'Removed 2 credentials (JWT, GitHub token) before saving. Revoke or rotate them.'
  const pasted = `Here is my login: ${jwt}\nand the deploy token ${github} for the release.`
  const kept = `Here is my login: ${CREDENTIAL_MARKER}\nand the deploy token ${CREDENTIAL_MARKER} for the release.`
  const send = (text: string, conversationId = 'lead'): Command => ({ type: 'message.send', conversationId, text, replyTo: null, recipientIds: [] })

  it('stores a person\'s message without the credentials, keeps the rest and tells the sender what went', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true)
    const input = send(pasted)
    const sent = f.run(input)
    expect(sent.messages).toEqual([expect.objectContaining({ text: kept, recipients: [lead] })])
    expect(sent.result).toEqual({ messageId: sent.messages[0]!.id, credentialNotice: notice,
      credentialsRemoved: [{ kind: 'jwt', label: 'JWT', count: 1 }, { kind: 'github', label: 'GitHub token', count: 1 }] })
    expect(JSON.stringify([sent.messages, f.state])).not.toContain(github)
    expect(JSON.stringify([sent.messages, f.state])).not.toContain(jwt)
    // The caller's command is left as it was; only what is stored changes.
    expect(input).toEqual(send(pasted))
  })

  it('treats an agent\'s post the same: agents echo credentials from their terminals', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group(), worker = f.add('worker', 'owner', group)
    f.run({ type: 'conversation.agent', conversationId: group, agentId: lead, present: true, lead: true })
    f.run({ type: 'work.assign', conversationId: group, agentId: worker })
    const posted = f.run(send(`npm publish failed: //registry.npmjs.org/:_authToken=${github}`, group), { kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' })
    expect(posted.messages).toEqual([expect.objectContaining({ text: `npm publish failed: //registry.npmjs.org/:_authToken=${CREDENTIAL_MARKER}`, recipients: [lead] })])
    expect(posted.result.credentialNotice).toBe('Removed a credential (GitHub token) before saving. Revoke or rotate it.')
  })

  it('leaves a message without credentials, and its result, exactly as before', () => {
    const f = fixture()
    const text = 'Merged a3f1c9e27b5d4f80916e2c3b7a8d9e0f1a2b3c4d; id 123e4567-e89b-12d3-a456-426614174000, see https://github.com/example/project/pull/1680'
    const sent = f.run(send(text))
    expect(sent.messages[0]!.text).toBe(text)
    expect(sent.result).toEqual({ messageId: sent.messages[0]!.id })
  })

  it('removes credentials from task words, results, evidence and reports before they reach the state or a row', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true)
    const created = f.run({ type: 'conversation.create', title: 'Deploy', checks: [{ description: `Login works with ${github}`, independent: false }],
      task: { goal: 'Deploy', changes: `Use ${jwt} to call the API`, constraints: 'None', owns: ['backend'] } })
    expect(created.result.credentialNotice).toBe(notice)
    const group = f.state.conversations.find(c => c.id === created.result.conversationId)!
    expect(group.task!.changes).toBe(`Use ${CREDENTIAL_MARKER} to call the API`)
    expect(group.brief).toContain(`Use ${CREDENTIAL_MARKER} to call the API`)
    expect(group.checks[0]!.description).toBe(`Login works with ${CREDENTIAL_MARKER}`)
    const worker = f.add('worker', 'owner', group.id)
    const assignmentId = f.run({ type: 'work.assign', conversationId: group.id, agentId: worker }).result.assignmentId as string
    const as: Actor = { kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' }
    const blocked = f.run({ type: 'work.status', conversationId: group.id, assignmentId, status: 'blocked', result: `Rejected ${github}` }, as)
    expect(blocked.messages[0]!.text).toBe(`Stuck\n\nRejected ${CREDENTIAL_MARKER}`)
    f.run({ type: 'work.check', conversationId: group.id, assignmentId, checkId: group.checks[0]!.id, passed: true, evidence: `Signed in as ${jwt}` },
      { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' })
    const stored = f.state.conversations.find(c => c.id === group.id)!
    expect([stored.assignment!.result, stored.checks[0]!.evidence]).toEqual([`Rejected ${CREDENTIAL_MARKER}`, `Signed in as ${CREDENTIAL_MARKER}`])
    expect(JSON.stringify(f.state)).not.toMatch(new RegExp(`${github}|${jwt.replaceAll('.', '\\.')}`))
  })

  it('removes a credential from an older message when a person resends it', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true)
    const resent = f.run({ type: 'delivery.resolve', deliveryId: 'd', resolution: 'resend' }, owner,
      { delivery: { id: 'd', conversationId: 'lead', agentId: lead, messageId: 'm', text: pasted } })
    expect(resent.messages[0]).toMatchObject({ text: kept, recipients: [lead] })
    expect(resent.result.credentialNotice).toBe(notice)
  })

  it('finds the words of every kind of command, nested and in lists', () => {
    const removed: CredentialKind[] = []
    const start = withoutCredentials({ type: 'agent.start', overrideReason: `faster with ${github}`, request: { name: `Builder ${github}` } } as Command, removed)
    expect(start).toMatchObject({ overrideReason: `faster with ${CREDENTIAL_MARKER}`, request: { name: `Builder ${CREDENTIAL_MARKER}` } })
    const route = withoutCredentials({ type: 'route.record', conversationId: 'lead', decision: { assessment: { why: `needs ${jwt}` }, why: 'ok',
      excluded: [{ title: 'Mini', reason: `asked for ${github}` }], candidates: [{ title: 'New agent', label: 'plain' }] } } as unknown as Command, removed)
    expect(route).toMatchObject({ decision: { assessment: { why: `needs ${CREDENTIAL_MARKER}` }, excluded: [{ reason: `asked for ${CREDENTIAL_MARKER}` }] } })
    const owns = withoutCredentials({ type: 'work.define', conversationId: 'g', checks: [], task: { goal: 'g', changes: 'c', constraints: 'n', owns: ['src', github] } } as unknown as Command, removed)
    expect(owns).toMatchObject({ task: { owns: ['src', CREDENTIAL_MARKER] } })
    const rename = withoutCredentials({ type: 'buddy.rename', conversationId: 'chat', name: github } as Command, removed)
    expect(rename).toMatchObject({ name: CREDENTIAL_MARKER })
    expect(removed).toEqual(['github', 'github', 'jwt', 'github', 'github', 'github'])
    // Commands with no words of their own are passed through untouched.
    const pause: Command = { type: 'tab.pause', paused: true }
    expect(withoutCredentials(pause, removed)).toBe(pause)
  })
})

describe('lost work (liveness.ts)', () => {
  /** A Lead, and a group with two workers, the first assigned; the clock is at 1000 in every command. */
  const lostFixture = () => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true)
    const group = f.group(), worker = f.add('worker', 'owner', group), other = f.add('other', 'owner', group)
    const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
    f.run({ type: 'work.assign', conversationId: group, agentId: worker })
    const task = () => f.state.conversations.find(c => c.id === group)!
    const limit = () => f.run({ type: 'agent.alert', agentId: worker, alert: 'limit', active: true, resetAt: new Date(3_600_000).toISOString() }, as(worker))
    return { f, lead, group, worker, other, as, task, limit }
  }

  it('loses a worker\'s task once its host says the model kept failing (its ten-minute alert); an ended alert loses nothing', () => {
    const { f, worker, as, task } = lostFixture()
    const model = (active: boolean) => f.run({ type: 'agent.alert', agentId: worker, alert: 'model', active }, as(worker))
    model(false)
    expect(task().assignment!.status).toBe('working')
    model(true)
    expect(task().assignment).toMatchObject({ status: 'lost', lost: { reason: 'its model keeps failing' } })
    // Where it failed stays on the group, for routing the work again even once its agent is gone (cli routeCommand.ts).
    expect(task().lostAttempt).toEqual({ id: task().assignment!.id, agentId: worker, machineId: 'host', engine: config.engine })
  })

  it('lets the Lead hand lost work to another agent without first deciding about the lost one', () => {
    const { f, lead, group, other, as, task, limit } = lostFixture()
    limit()
    expect(task().assignment!.status).toBe('lost')
    f.run({ type: 'work.assign', conversationId: group, agentId: other, ...via }, as(lead), decisionIn(group))
    expect(task().assignment).toMatchObject({ agentId: other, status: 'working', leaseUntil: 1000 + 5 * 60_000 })
  })

  it('leaves the lost agent undecided when the Lead cancels lost work, without telling it twice or blocking the next assignment', () => {
    const { f, lead, group, worker, other, as, task, limit } = lostFixture()
    limit()
    const cancelled = f.run({ type: 'work.cancel', conversationId: group, assignmentId: task().assignment!.id, reason: 'Not needed' }, as(lead))
    expect(task().assignment!.status).toBe('cancelled')
    expect(cancelled.messages[0]!.recipients).toEqual([])
    expect(f.state.agents.find(a => a.id === worker)!.workDecision).toBeUndefined()
    // The Lead's next assignment in the project goes to a healthy worker without deciding about the dead one first.
    const next = f.group()
    f.run({ type: 'work.assign', conversationId: next, agentId: other, ...via }, as(lead), decisionIn(next))
    expect(f.state.conversations.find(c => c.id === next)!.assignment).toMatchObject({ agentId: other, status: 'working' })
  })

  it('renews the lease on the worker\'s own post in its task\'s group, not on anyone else\'s', () => {
    const { f, lead, group, worker, as, task } = lostFixture()
    task().assignment!.leaseUntil = 0
    f.run({ type: 'message.send', conversationId: group, text: 'Halfway.', replyTo: null, recipientIds: [] }, as(lead))
    expect(task().assignment!.leaseUntil).toBe(0)
    f.run({ type: 'message.send', conversationId: group, text: 'Halfway.', replyTo: null, recipientIds: [] }, as(worker))
    expect(task().assignment).toMatchObject({ leaseUntil: 1000 + 5 * 60_000, progressAt: 1000 })
  })

  it('keeps the lost worker marked when the Lead cancels its task or hands it to another agent (final review, Important 3)', () => {
    const marked = { conversationId: expect.any(String), assignmentId: expect.any(String), reason: expect.stringContaining('usage limit'), at: 1000,
      resumeAt: '1970-01-01T01:00:00.000Z' }
    for (const close of ['cancel', 'reassign'] as const) {
      const { f, lead, group, worker, other, as, task, limit } = lostFixture()
      limit()
      const lostId = task().assignment!.id
      expect(f.state.agents.find(a => a.id === worker)!.lostTask).toEqual({ ...marked, conversationId: group, assignmentId: lostId })
      if (close === 'cancel') f.run({ type: 'work.cancel', conversationId: group, assignmentId: lostId, reason: 'Not needed' }, as(lead))
      else f.run({ type: 'work.assign', conversationId: group, agentId: other, ...via }, as(lead), decisionIn(group))
      expect(f.state.agents.find(a => a.id === worker)!.lostTask).toEqual({ ...marked, conversationId: group, assignmentId: lostId })
    }
  })

  it('clears the mark once the worker finishes a new task, but not when the Lead merely assigns it one', () => {
    const { f, lead, group, worker, as, task, limit } = lostFixture()
    limit()
    f.run({ type: 'work.cancel', conversationId: group, assignmentId: task().assignment!.id, reason: 'Not needed' }, as(lead))
    const next = f.group()
    const assignmentId = f.run({ type: 'work.assign', conversationId: next, agentId: worker, ...via }, as(lead), decisionIn(next)).result.assignmentId as string
    expect(f.state.agents.find(a => a.id === worker)!.lostTask).toBeDefined()
    f.run({ type: 'work.status', conversationId: next, assignmentId, status: 'review', result: 'Ready' }, as(worker))
    expect(f.state.agents.find(a => a.id === worker)!.lostTask).toBeDefined()
    const checkId = f.state.conversations.find(c => c.id === next)!.checks[0]!.id
    f.run({ type: 'work.check', conversationId: next, assignmentId, checkId, passed: true, evidence: 'Verified' })
    f.run({ type: 'work.status', conversationId: next, assignmentId, status: 'done', result: 'Delivered' }, as(worker))
    expect(f.state.agents.find(a => a.id === worker)!.lostTask).toBeUndefined()
  })

  it('clears the mark when a person assigns the worker by hand', () => {
    const { f, lead, group, worker, as, task, limit } = lostFixture()
    limit()
    f.run({ type: 'work.cancel', conversationId: group, assignmentId: task().assignment!.id, reason: 'Not needed' }, as(lead))
    const next = f.group()
    f.run({ type: 'work.assign', conversationId: next, agentId: worker })
    expect(f.state.agents.find(a => a.id === worker)!.lostTask).toBeUndefined()
  })

  it('clears the mark when the worker\'s terminal is replaced (Change agent)', () => {
    const { f, group, worker, as, limit } = lostFixture()
    limit()
    f.run({ type: 'agent.rebind', agentId: worker, machineId: 'host', projectId: 'lead', previousHarnessId: 'worker', harnessId: 'worker-2', configuration: config }, as(worker))
    expect(f.state.agents.find(a => a.id === worker)).toMatchObject({ harnessId: 'worker-2' })
    expect(f.state.agents.find(a => a.id === worker)!.lostTask).toBeUndefined()
    expect(f.state.conversations.find(c => c.id === group)!.lostAttempt).toMatchObject({ agentId: worker })
  })

  it('records when a task lost to a usage limit with a reset time resumes, and tells the Lead it resumes then unless handed on', () => {
    const { f, worker, task, limit } = lostFixture()
    const lead = limit().messages.find(m => m.source?.kind === 'work-lost' && !m.recipients.includes(worker))!
    expect(task().assignment!.lost).toEqual({ reason: expect.stringContaining('usage limit'), at: 1000, resumeAt: '1970-01-01T01:00:00.000Z' })
    expect(f.state.agents.find(a => a.id === worker)!.lostTask).toMatchObject({ resumeAt: '1970-01-01T01:00:00.000Z' })
    expect(lead.text).toContain('It resumes by itself when its limit resets at 01:00 UTC, unless you hand it on first.')
    expect(lead.text).not.toContain('Assign it to another agent now')
  })

  it('records no resume time for a task lost to a model that keeps failing, though its alert names a reset time', () => {
    const { f, worker, as, task } = lostFixture()
    f.run({ type: 'agent.alert', agentId: worker, alert: 'model', active: true, resetAt: new Date(3_600_000).toISOString() }, as(worker))
    expect(task().assignment).toMatchObject({ status: 'lost', lost: { reason: 'its model keeps failing' } })
    expect(task().assignment!.lost).not.toHaveProperty('resumeAt')
    expect(f.state.agents.find(a => a.id === worker)!.lostTask).not.toHaveProperty('resumeAt')
  })

  it('records no resume time for a usage limit whose screen gave no reset time', () => {
    const { f, worker, as, task } = lostFixture()
    const rows = f.run({ type: 'agent.alert', agentId: worker, alert: 'limit', active: true }, as(worker)).messages
    expect(task().assignment!.lost).not.toHaveProperty('resumeAt')
    expect(f.state.agents.find(a => a.id === worker)!.lostTask).not.toHaveProperty('resumeAt')
    expect(rows.find(m => m.source?.kind === 'work-lost' && !m.recipients.includes(worker))!.text).toContain('Assign it to another agent now, or cancel it.')
  })

  it('gives the worker its own lost task back once its limit has reset, and accepts its status again', () => {
    const { f, lead, group, worker, as, task, limit } = lostFixture()
    limit()
    const assignmentId = task().assignment!.id
    const resumed = f.run({ type: 'work.resume', conversationId: group, assignmentId, lostAt: 1000 }, as(worker), { now: 3_600_000 })
    expect(task().assignment).toMatchObject({ id: assignmentId, agentId: worker, status: 'working', leaseUntil: 3_600_000 + 5 * 60_000 })
    expect(task().assignment).not.toHaveProperty('lost')
    expect(task().lostAttempt).toBeUndefined()
    expect(f.state.agents.find(a => a.id === worker)!.lostTask).toBeUndefined()
    expect(resumed.messages).toEqual([expect.objectContaining({ conversationId: group, recipients: [lead],
      text: 'worker resumed its task after its usage limit reset.' })])
    f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'review', result: 'Ready' }, as(worker), { now: 3_600_001 })
    expect(task().assignment!.status).toBe('review')
  })

  it('resumes each loss of one task once: a second usage limit is a new loss, and the first one\'s resume no longer applies (#1757 review, 1)', () => {
    const { f, group, worker, as, task, limit } = lostFixture()
    limit()
    const assignmentId = task().assignment!.id
    f.run({ type: 'work.resume', conversationId: group, assignmentId, lostAt: 1000 }, as(worker), { now: 3_600_000 })
    // The limit screen goes, the task runs, and the engine hits its limit again an hour later.
    f.run({ type: 'agent.alert', agentId: worker, alert: 'limit', active: false }, as(worker), { now: 3_600_100 })
    f.run({ type: 'agent.alert', agentId: worker, alert: 'limit', active: true, resetAt: new Date(9_000_000).toISOString() }, as(worker), { now: 7_200_000 })
    expect(task().assignment).toMatchObject({ id: assignmentId, status: 'lost', lost: { at: 7_200_000, resumeAt: '1970-01-01T02:30:00.000Z' } })
    expect(f.state.agents.find(a => a.id === worker)!.lostTask).toMatchObject({ assignmentId, at: 7_200_000, resumeAt: '1970-01-01T02:30:00.000Z' })
    expect(() => f.run({ type: 'work.resume', conversationId: group, assignmentId, lostAt: 1000 }, as(worker), { now: 9_000_000 }))
      .toThrow('This task was handed on or closed, so it does not resume.')
    f.run({ type: 'work.resume', conversationId: group, assignmentId, lostAt: 7_200_000 }, as(worker), { now: 9_000_000 })
    expect(task().assignment).toMatchObject({ id: assignmentId, agentId: worker, status: 'working' })
  })

  it('does not resume a lost task before its limit resets', () => {
    const { f, group, worker, as, task, limit } = lostFixture()
    limit()
    expect(() => f.run({ type: 'work.resume', conversationId: group, assignmentId: task().assignment!.id, lostAt: 1000 }, as(worker), { now: 3_599_999 }))
      .toThrow('Its usage limit has not reset yet.')
    expect(task().assignment!.status).toBe('lost')
  })

  it('does not resume a lost task the Lead cancelled or handed to another agent before the reset', () => {
    for (const close of ['cancel', 'reassign'] as const) {
      const { f, lead, group, worker, other, as, task, limit } = lostFixture()
      limit()
      const lostId = task().assignment!.id
      if (close === 'cancel') f.run({ type: 'work.cancel', conversationId: group, assignmentId: lostId, reason: 'Not needed' }, as(lead))
      else f.run({ type: 'work.assign', conversationId: group, agentId: other, ...via }, as(lead), decisionIn(group))
      const before = structuredClone(task().assignment)
      expect(() => f.run({ type: 'work.resume', conversationId: group, assignmentId: lostId, lostAt: 1000 }, as(worker), { now: 3_600_000 }))
        .toThrow('This task was handed on or closed, so it does not resume.')
      expect(task().assignment).toEqual(before)
    }
  })

  it('resumes a lost task only for its own worker, and only after a loss that gave a reset time', () => {
    const { f, lead, group, worker, other, as, task, limit } = lostFixture()
    limit()
    const assignmentId = task().assignment!.id
    for (const actor of [as(other), as(lead), owner]) {
      expect(() => f.run({ type: 'work.resume', conversationId: group, assignmentId, lostAt: 1000 }, actor, { now: 3_600_000 }))
        .toThrow('Only the agent that lost this task resumes it.')
    }
    const plain = lostFixture()
    plain.f.run({ type: 'agent.alert', agentId: plain.worker, alert: 'limit', active: true }, plain.as(plain.worker))
    expect(() => plain.f.run({ type: 'work.resume', conversationId: plain.group, assignmentId: plain.task().assignment!.id, lostAt: 1000 }, plain.as(plain.worker), { now: 99_000_000 }))
      .toThrow('This task was not lost to a usage limit with a reset time.')
  })

  it('does not lose work a Lead holds: Leads are not covered here', () => {
    const { f, lead, as } = lostFixture()
    const own = f.group()
    f.run({ type: 'work.assign', conversationId: own, agentId: lead })
    f.run({ type: 'agent.alert', agentId: lead, alert: 'limit', active: true }, as(lead))
    expect(f.state.conversations.find(c => c.id === own)!.assignment!.status).toBe('working')
  })
})

describe('the morning digest setting (digest.ts)', () => {
  const setup = () => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true), worker = f.add('worker', 'owner', f.group())
    const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
    const digest = () => f.state.projects?.find(p => p.id === 'lead')?.digest
    return { f, lead, worker, as, digest }
  }

  it('sets the project\'s local digest time for a person or its Lead, from tomorrow once today\'s has passed, and clears it', () => {
    const { f, lead, as, digest } = setup()
    // 07:00 on 27 October in Vietnam.
    const at = { now: Date.UTC(2026, 9, 27, 0, 0) }
    f.run({ type: 'project.digest', projectId: 'lead', time: '08:00', timeZone: 'Asia/Ho_Chi_Minh' }, owner, at)
    expect(digest()).toEqual({ time: '08:00', timeZone: 'Asia/Ho_Chi_Minh' })
    f.run({ type: 'project.digest', projectId: 'lead', time: '06:30', timeZone: 'Asia/Ho_Chi_Minh' }, as(lead), at)
    expect(digest()).toEqual({ time: '06:30', timeZone: 'Asia/Ho_Chi_Minh', lastOn: '2026-10-27' })
    f.run({ type: 'project.digest', projectId: 'lead', time: null, timeZone: 'Asia/Ho_Chi_Minh' }, owner, at)
    expect(digest()).toBeUndefined()
  })

  // Today's digest message has a stable id (digest.ts digestRequest): sent again at the later time, it is a duplicate, and
  // every Lead poll failed on it for the rest of the day (prod slow log, 2026-10-28).
  it('keeps today\'s digest counted as sent when its time moves later the same day', () => {
    const { f, digest } = setup()
    // 07:00 on 27 October in Vietnam, after today's 06:30 digest.
    const at = { now: Date.UTC(2026, 9, 27, 0, 0) }
    f.run({ type: 'project.digest', projectId: 'lead', time: '06:30', timeZone: 'Asia/Ho_Chi_Minh' }, owner, at)
    f.run({ type: 'project.digest', projectId: 'lead', time: '09:00', timeZone: 'Asia/Ho_Chi_Minh' }, owner, at)
    expect(digest()).toEqual({ time: '09:00', timeZone: 'Asia/Ho_Chi_Minh', lastOn: '2026-10-27' })
    // Another day's mark does not hold today's back.
    f.run({ type: 'project.digest', projectId: 'lead', time: '10:00', timeZone: 'Asia/Ho_Chi_Minh' }, owner, { now: Date.UTC(2026, 9, 28, 0, 0) })
    expect(digest()).toEqual({ time: '10:00', timeZone: 'Asia/Ho_Chi_Minh' })
  })

  it('refuses a worker, an unknown time zone and a time that is not a time of day', () => {
    const { f, worker, as, digest } = setup()
    expect(() => f.run({ type: 'project.digest', projectId: 'lead', time: '08:00', timeZone: 'UTC' }, as(worker))).toThrow('A person or the project’s Lead sets its morning digest.')
    expect(() => f.run({ type: 'project.digest', projectId: 'lead', time: '08:00', timeZone: 'Mars/Olympus' })).toThrow('Name a time zone such as Asia/Ho_Chi_Minh.')
    expect(() => f.run(commandSchema.parse({ type: 'project.digest', projectId: 'lead', time: '24:00', timeZone: 'UTC' }))).toThrow()
    expect(digest()).toBeUndefined()
  })
})

describe('agent.stopRefused', () => {
  /** A worker the idle check marked for stopping (tidy.ts), as it was before: awaiting its Lead's decision. */
  function idleStopped() {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), worker = f.add('worker', 'owner', f.group())
    const target = f.state.agents.find(a => a.id === worker)!
    Object.assign(target, { workDecision: 'stop', releaseId: 'idle-release', idleStop: { previous: 'awaiting' } })
    const asWorker: Actor = { kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' }
    return { f, lead, worker, asWorker, member: () => f.state.agents.find(a => a.id === worker)! }
  }

  it('lets the worker\'s own host withdraw an idle stop its folder\'s changes forbid, restarting its idle time', () => {
    const t = idleStopped()
    t.f.run({ type: 'agent.stopRefused', agentId: t.worker, releaseId: 'idle-release' }, t.asWorker, { now: 7000 })
    expect(t.member()).toMatchObject({ workDecision: 'awaiting', keptAt: 7000 })
    expect(t.member().releaseId).toBeUndefined()
    expect(t.member().idleStop).toBeUndefined()
  })

  it('refuses another agent, a stale stop, and a stop its Lead asked for', () => {
    const t = idleStopped()
    expect(() => t.f.run({ type: 'agent.stopRefused', agentId: t.worker, releaseId: 'idle-release' }, { kind: 'agent', agentId: t.lead, machineOwnerId: 'host-owner' })).toThrow('Only the execution host')
    expect(() => t.f.run({ type: 'agent.stopRefused', agentId: t.worker, releaseId: 'older' }, t.asWorker)).toThrow('Only the execution host')
    delete t.member().idleStop
    expect(() => t.f.run({ type: 'agent.stopRefused', agentId: t.worker, releaseId: 'idle-release' }, t.asWorker)).toThrow('Only the execution host')
    expect(t.member().workDecision).toBe('stop')
  })

  it('keeps a stop its Lead asked for after the idle check made it', () => {
    const t = idleStopped()
    t.f.run({ type: 'agent.release', agentId: t.worker, decision: 'stop' }, { kind: 'agent', agentId: t.lead, machineOwnerId: 'host-owner' })
    expect(() => t.f.run({ type: 'agent.stopRefused', agentId: t.worker, releaseId: 'idle-release' }, t.asWorker)).toThrow('Only the execution host')
    expect(t.member().workDecision).toBe('stop')
  })
})

// Ken, 2026-10-29: simple work runs on a grid model first, and a failed first review or a grid host that never starts the
// agent steps it up a tier (Sonnet, then Opus), at most twice per group.
describe('stepping up from a cheap model', () => {
  const pr = 'https://github.com/example/project/pull/41'
  function cheap() {
    const f = routed(), group = f.group()
    f.run({ type: 'conversation.agent', conversationId: group, agentId: f.lead, present: true, lead: true })
    f.run({ type: 'work.define', conversationId: group, brief: 'Fix the docs.', checks: [{ description: 'Reviewed.', independent: true }] })
    const builder = (name: string, model: string | null, gridModel?: string) => {
      const id = f.add(name, 'owner', group)
      Object.assign(f.state.agents.find(a => a.id === id)!, { configuration: { ...config, engine: 'claude', model }, ...(gridModel ? { gridModel } : {}) })
      return id
    }
    const assign = (agentId: string) => {
      const effects = f.run({ type: 'work.assign', conversationId: group, agentId })
      return { assignmentId: effects.result.assignmentId as string, brief: effects.messages.find(m => m.recipients.includes(agentId))!.text }
    }
    const fail = (assignmentId: string, agentId: string) => {
      f.run({ type: 'work.status', conversationId: group, assignmentId, status: 'review', result: `Ready: yes. Branch fix/docs. ${pr}` }, { kind: 'agent', agentId, machineOwnerId: 'host-owner' })
      const check = f.state.conversations.find(c => c.id === group)!.checks[0]!
      return f.run({ type: 'work.check', conversationId: group, assignmentId, checkId: check.id, passed: false, evidence: 'Ready: no. Two links are broken.' })
    }
    const g = () => f.state.conversations.find(c => c.id === group)!
    return { f, group, builder, assign, fail, g }
  }

  it('steps a grid attempt up when its first review says Ready no: closes it, keeps the branch and findings, and wakes the Lead', () => {
    const { f, group, builder, assign, fail, g } = cheap()
    const kimi = builder('kimi', 'default', 'moonshotai/kimi-k3')
    const first = assign(kimi)
    const effects = fail(first.assignmentId, kimi)
    expect(g().assignment).toMatchObject({ id: first.assignmentId, status: 'cancelled', result: 'Stepped up: its first review said Ready no.' })
    expect(g().stepUp).toMatchObject({ attempt: 2, floor: 2, reason: 'Its first review said Ready no.', at: 1000 })
    expect(g().stepUp!.carry).toContain(pr)
    expect(g().stepUp!.carry).toContain('Ready: no. Two links are broken.')
    expect(g().stepUp!.carry).toContain('Ready: yes. Branch fix/docs.')
    // Told only to stop: a stepped-up attempt is not handed back to fix its findings.
    expect(effects.messages.filter(m => m.recipients.includes(kimi)).map(m => m.text)).toEqual([expect.stringContaining('Stop working on it.')])
    // Each row its own: one write stores them all.
    expect(new Set(effects.messages.map(m => m.id)).size).toBe(effects.messages.length)
    expect(effects.messages.find(m => m.recipients.includes(f.lead))!.text)
      .toBe(`#${g().number} stepped up to attempt 2: its first review said Ready no. Route it again: the route leaves out models on the grid and below quality 2, and the new attempt's brief carries the branch, the last result and the findings.`)
    // Ken, 2026-10-29: each its recipient's alone; people read the step on the task's status line and its record.
    for (const to of [kimi, f.lead]) {
      const row = effects.messages.find(m => m.recipients.includes(to) && /stepped/.test(m.text))!
      expect(agentOnly(row.source, row.recipients)).toBe(true)
    }
    // The next attempt may not go back to the grid; a stronger model takes the carry-over in its brief and the step in its record.
    f.run({ type: 'agent.release', agentId: kimi, decision: 'stop' }, f.leadActor)
    const route = (pick: Record<string, unknown>) => f.run({ type: 'route.record', conversationId: group, decision: record({ candidates: [candidate('c0', pick)], pick: 'c0' }) } as Command, f.leadActor)
    expect(() => route({ model: 'default', effort: 'default', quality: 2, gridModel: 'deepseek/deepseek-v4.1', gridName: 'swarm-g' }))
      .toThrow('This task stepped up from a cheaper model: it runs on no model on the grid and nothing below quality 2. Route again.')
    expect(() => route({ model: 'haiku', effort: 'auto', quality: 1 })).toThrow('nothing below quality 2')
    expect(route({ model: 'sonnet', effort: 'medium', quality: 2 }).routeDecisions[0]).toMatchObject({ op: 'create', record: { stepUp: { attempt: 2, reason: 'Its first review said Ready no.' } } })
    const sonnet = builder('sonnet', 'claude-sonnet-4-5')
    const second = assign(sonnet)
    expect(second.brief).toContain(`Carry-over from attempt 1:\n${g().stepUp!.carry}`)
    expect(g().ledger!.runs!.at(-1)).toMatchObject({ assignmentId: second.assignmentId, stepUp: { attempt: 2, reason: 'Its first review said Ready no.' } })
    // Sonnet fails its first review too: Opus next, and that is the last step.
    fail(second.assignmentId, sonnet)
    expect(g().stepUp).toMatchObject({ attempt: 3, floor: 3 })
    const opus = builder('opus', 'claude-opus-4-7'), third = assign(opus)
    expect(fail(third.assignmentId, opus).messages.some(m => m.text.includes('stepped up'))).toBe(false)
    // Not stepped up: a review that found problems hands it back to its Builder (liveness.ts reviewFoundProblems).
    expect(g().assignment).toMatchObject({ id: third.assignmentId, status: 'working' })
  })

  it('stops after two steps, and never steps up work that did not start on the grid', () => {
    const { builder, assign, fail, g } = cheap()
    const opus = builder('opus', 'claude-opus-4-7')
    const first = assign(opus)
    fail(first.assignmentId, opus)
    expect(g().stepUp).toBeUndefined()
    expect(g().assignment!.status).toBe('working')
    // At the cap a failed Sonnet attempt stays with its Builder.
    const { builder: other, assign: give, fail: failIt, g: group } = cheap()
    group().stepUp = { attempt: 3, floor: 3, reason: 'Earlier.', at: 1, carry: '' }
    const sonnet = other('sonnet', 'claude-sonnet-4-5')
    failIt(give(sonnet).assignmentId, sonnet)
    expect(group().stepUp!.attempt).toBe(3)
    expect(group().assignment!.status).toBe('working')
  })

  it('steps up a group whose grid start failed, and not one whose subscription start failed', () => {
    const { f, group, g } = cheap()
    const start = (id: string, gridModel?: string) => ({ id, actorKey: 'person:owner', contributorId: 'owner', membershipGeneration: f.state.people[0]!.generation,
      request: { conversationId: group, machineId: 'mac', name: 'Builder', engine: 'claude', ...(gridModel ? { gridModel, gridName: 'swarm-g' } : {}) }, error: null })
    f.state.starts = [start('s1'), start('s2', 'moonshotai/kimi-k3')] as never
    f.run({ type: 'agent.startFailed', startId: 's1', error: 'Launch refused.' })
    expect(g().stepUp).toBeUndefined()
    const effects = f.run({ type: 'agent.startFailed', startId: 's2', error: 'Launch refused.' })
    expect(g().stepUp).toMatchObject({ attempt: 2, floor: 2, reason: 'Its grid host did not start the agent.' })
    expect(new Set(effects.messages.map(m => m.id)).size).toBe(effects.messages.length)
    expect(effects.messages.map(m => m.text)).toContain(`#${g().number} stepped up to attempt 2: its grid host did not start the agent. Route it again: the route leaves out models on the grid and below quality 2, and the new attempt's brief carries the branch, the last result and the findings.`)
  })

  it('never steps up again from a top-tier attempt that its ledger names by a slug the policy does not', () => {
    const { f, builder, assign, fail, g } = cheap()
    g().stepUp = { attempt: 2, floor: 2, reason: 'Its first review said Ready no.', at: 1, carry: '' }
    // Launched on Codex's own model, it reports its slug: rated by the default row, the top tier.
    const codex = builder('codex', 'gpt-6.1-sol')
    Object.assign(f.state.agents.find(a => a.id === codex)!.configuration, { engine: 'codex' })
    f.state.starts = [...f.state.starts ?? [], { harnessId: 'codex', request: { machineId: 'host', engine: 'codex', model: 'default' } } as never]
    const attempt = assign(codex)
    fail(attempt.assignmentId, codex)
    expect(g().stepUp!.attempt).toBe(2)
    expect(g().assignment).toMatchObject({ id: attempt.assignmentId, status: 'working' })
  })

  it('steps up once for one failed grid start, however often its failure is reported', () => {
    const { f, group, g } = cheap()
    f.state.starts = [{ id: 's1', actorKey: 'person:owner', contributorId: 'owner', membershipGeneration: f.state.people[0]!.generation,
      request: { conversationId: group, machineId: 'mac', name: 'Builder', engine: 'claude', gridModel: 'moonshotai/kimi-k3', gridName: 'swarm-g' }, error: null }] as never
    f.run({ type: 'agent.startFailed', startId: 's1', error: 'Launch refused.' })
    const again = f.run({ type: 'agent.startFailed', startId: 's1', error: 'Launch refused again.' })
    expect(g().stepUp).toMatchObject({ attempt: 2, startId: 's1' })
    expect(again.messages.some(m => m.text.includes('stepped up'))).toBe(false)
  })
})

// Ken, 2026-10-28: work kept landing on engines that could not run on their machine (Codex with no tokens on Diego's Mac),
// until a person told the Product Manager. The server counts failed starts per engine and machine, and the start check
// refuses an engine its machine reads as signed out, out of quota or suspended.
describe('an engine that cannot run on a contributed machine', () => {
  const grid = 'swarm-0123456789ab'
  const setup = (reading: Record<string, unknown> = {}) => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true)
    const leadActor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    f.state.machines = [{ machineId: 'mac', name: 'Mac', contributorId: 'owner', membershipGeneration: f.state.people[0]!.generation, generation: 'g1',
      cwd: '/repo', engines: ['codex'], maxAgents: 8, paused: false, observation: { generation: 'g1', receivedAt: 1000,
        resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null,
          deviceType: null, chip: null, os: null, gpuPercent: null }, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [], ...reading } }] as never
    const start = (id: string, extra: Record<string, unknown> = {}) => ({ id, actorKey: 'person:owner', contributorId: 'owner',
      membershipGeneration: f.state.people[0]!.generation, machineOwnerId: 'owner', hostGrant: null, poolGeneration: 'g1',
      request: { conversationId: 'lead', machineId: 'mac', engine: 'codex', name: 'Builder', cwd: '/repo', ...extra }, harnessId: null, dispatched: true, error: null })
    f.state.starts = ['s1', 's2', 's3', 's4'].map(id => start(id)) as never
    const fail = (startId: string) => f.run({ type: 'agent.startFailed', startId, error: 'Codex could not launch.' }, owner).messages[0]!
    const request = (extra: Record<string, unknown> = {}) => ({ conversationId: 'lead', machineId: 'mac', engine: 'codex', name: 'Builder', cwd: '/repo',
      worktree: true, requirements: { memoryBytes: 1, diskBytes: 1, maxCpuPercent: 100, tools: ['git'], devices: [], quotaRequired: false }, ...extra })
    const begin = (extra: Record<string, unknown> = {}) => f.run({ type: 'agent.start', request: request(extra), ...via } as Command, leadActor,
      { contribution: { machineOwnerId: 'owner', contributorId: 'owner' }, ...decisionIn('lead') })
    return { f, lead, fail, begin, start }
  }

  it('is suspended by its second failed start in a row, telling the Lead and tagging the machine owner once', () => {
    const { f, lead, fail } = setup()
    const first = fail('s1')
    expect(first.mentions).toBeUndefined()
    expect(first.text).not.toContain('suspended')
    const second = fail('s2')
    expect(second).toMatchObject({ recipients: [lead], mentions: ['owner'] })
    expect(second.text).toContain('Codex is suspended on this machine for new work: its last 2 starts there failed.')
    for (const later of ['s3', 's4']) {
      const notice = fail(later)
      expect(notice.mentions).toBeUndefined()
      expect(notice.text).not.toContain('suspended')
    }
    expect(Object.keys(f.state.machines![0]!.engineSuspensions!)).toEqual(['codex'])
  })

  it('counts only failures in a row: a start that ran in between resets the count', () => {
    const { f, fail } = setup()
    fail('s1')
    f.run({ type: 'agent.started', startId: 's2', harnessId: 'native-2', configuration: config }, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null } })
    expect(fail('s3').mentions).toBeUndefined()
    expect(fail('s4').mentions).toEqual(['owner'])
  })

  // Review of 4ddd0a1e0: the server timed a start out, then its host reported it failed too; one flaky start suspended Codex.
  it('counts a start once: a host failure after the server timed the same start out is not a second failure', () => {
    const { f, fail } = setup()
    const timedOut = f.state.starts![0]!
    timedOut.dispatchedAt = 0
    sweepLiveness(f.state, 3 * 60_000 + 1)
    expect(timedOut.error).toBeTruthy()
    const late = fail('s1')
    expect(late.mentions).toBeUndefined()
    expect(late.text).not.toContain('suspended')
    expect(f.state.machines![0]!.engineSuspensions ?? {}).toEqual({})
    // A different start that fails next is the second in a row.
    expect(fail('s2').mentions).toEqual(['owner'])
  })

  it('is refused by the start check while suspended, signed out or out of quota, and a grid model there is not', () => {
    const suspended = setup()
    suspended.fail('s1'); suspended.fail('s2')
    expect(() => suspended.begin()).toThrow('Codex is suspended on this machine')
    const signedOut = setup({ readiness: { engines: [{ engine: 'codex', installed: true, signedIn: false }] }, localModels: [{ grid, model: 'qwen3', kind: 'local' }] })
    expect(() => signedOut.begin()).toThrow('Codex is not signed in to a subscription on this machine.')
    signedOut.f.state.localModels = { grid, enabled: true }
    expect(signedOut.begin({ gridModel: 'qwen3', gridName: grid }).result.startId).toBeTruthy()
    const exhausted = setup({ quotas: [{ engine: 'codex', known: true, windows: [{ name: 'weekly', usedPercent: 100, resetsAt: null }] }] })
    expect(() => exhausted.begin()).toThrow('Codex has no subscription quota left on this machine until its usage window resets.')
    // A reading that says nothing of the engine keeps today's behaviour.
    expect(setup().begin().result.startId).toBeTruthy()
  })

  it('is resumed by the machine owner, or by a Lead passing on the owner\'s message, and by nobody else', () => {
    const { f, lead, fail } = setup()
    fail('s1'); fail('s2')
    const leadActor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    const resume = { type: 'machine.engineResume', machineId: 'mac', engine: 'codex' } as Command
    f.invite()
    expect(() => f.run(resume, peer)).toThrow('Only the machine\'s owner')
    expect(() => f.run(resume, leadActor)).toThrow('Only the machine\'s owner')
    const askedIn = { conversationId: 'lead', messageId: 'm-owner' }
    expect(() => f.run({ ...resume, askedIn } as Command, leadActor, { askedIn: { author: { kind: 'person', id: 'peer' } as never, source: false, createdAt: 1000 } }))
      .toThrow('Only the machine\'s owner')
    f.run({ ...resume, askedIn } as Command, leadActor, { askedIn: { author: { kind: 'person', id: 'owner' } as never, source: false, createdAt: 1000 } })
    expect(f.state.machines![0]!.engineSuspensions).toEqual({})
    fail('s3'); fail('s4')
    f.run(resume, owner)
    expect(f.state.machines![0]!.engineSuspensions).toEqual({})
    expect(commandSchema.safeParse({ ...resume, engine: 'Not An Engine' }).success).toBe(false)
  })
})
