import { describe, expect, it } from 'vitest'
import { opensStep, storedStep, type StepCommand } from './steps.test-support.js'
import { storeOldLeads } from './leads.test-support.js'
import { applyCommand, assertUniqueMessageIds, commandSchema, LOOP_NOTICE_AT, swarmGridName, withoutCredentials, WORDS, type Command, type CommandContext } from './commands.js'
import { CREDENTIAL_MARKER, type CredentialKind } from './credentials.js'
import { loseTasks, sweepLiveness } from './liveness.js'
import { SWITCH_UNCLAIMED_MS } from './tidy.js'
import { defaultProfileId, hostLocalGrid, machineSlots, removalPreview, swarmGridRow } from './machines.js'
import { agentOnly, agentRole, createSuperTab, visibleState, type Actor, type AgentConfiguration, type Author } from './model.js'
import { LEAD_CAPABILITY, leadHost } from './leadStart.js'
import { NOW, owner as richOwner, peer as richPeer, richSwarm } from './read/fixture.test-support.js'
import { groupView } from './read/views.js'
import { weekStart } from './leaderboard/week.js'
import { lentIn, weekSpan } from './leaderboard/rolling.js'
import { storedAssignment, storedStatus } from './storedWork.test-support.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
/** What an older client's routing, policy, skill-set or role save answers (project instructions, phase 4). */
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const config: AgentConfiguration = { engine: 'codex', model: 'test-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command | StepCommand, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    if (opensStep(command)) return storedStep(state, command, actor)
    const effects = applyCommand(state, actor, command, { now: 1000, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invite = (role: 'viewer' | 'collaborator' = 'collaborator') => {
    const invited = run({ type: 'invite.create', email: peer.email, role, conversationId: 'lead' })
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  }
  /** [agentId] stored in the project chat as a Swarm from before #2207 holds one there: it stays until removed, though no
   *  command adds an agent but the coordinator there now. */
  const seat = (agentId: string) => {
    const chat = state.conversations.find(c => c.id === 'lead')!
    if (!chat.agentIds.includes(agentId)) chat.agentIds.push(agentId)
  }
  const add = (harnessId: string, contributorId = 'owner', group = 'lead', lead = false) => {
    const result = run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId,
      name: harnessId, configuration: config, lead }, contributorId === 'owner' ? owner : peer,
    { contribution: { machineOwnerId: 'host-owner', contributorId } })
    const agentId = result.result.agentId as string
    if (group === 'lead' && !lead) seat(agentId)
    return agentId
  }
  const group = () => run({ type: 'conversation.create', title: 'Offline editing', brief: 'Save edits while offline.',
    checks: [{ description: 'Reconnect preserves the edits.', independent: true }] }).result.conversationId as string
  /** [lead]'s own chat with its person: where a person posts, as only agents post in a project's channel and its tasks' chats
   *  (agentsOnly.test.ts). */
  const pmChat = (lead: string) => state.conversations.find(c => c.kind === 'agent-chat' && c.agentIds.includes(lead))!.id
  return { run, invite, add, seat, group, pmChat, get state() { return state } }
}

/** Makes [machineId] [contributorId]'s own contributed computer, reporting now, so its agents take any project [contributorId]
 *  reads, in their own account (machines.ts teamWorkCheck; Swarm v3 has no Team accounts, task #4120). */
function ownMachine(f: ReturnType<typeof fixture>, contributorId: string, machineId = 'host') {
  if (f.state.machines?.some(m => m.machineId === machineId)) return
  f.state.machines = [...(f.state.machines ?? []), { machineId, name: 'Studio', contributorId, membershipGeneration: f.state.people.find(p => p.id === contributorId)!.generation,
    generation: 'g1', cwd: '/repo', engines: ['claude'], maxAgents: 2, paused: false, observation: { generation: 'g1', receivedAt: 1000,
      resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null,
        deviceType: null, chip: null, os: null, gpuPercent: null }, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] } }]
}

/** Puts [agentId] on [machineId], [contributorId]'s own computer: another person's computer when [contributorId] is not the
 *  agent's person, which Swarm v3 gives none of its work (task #4120). */
function placeOn(f: ReturnType<typeof fixture>, agentId: string, contributorId: string, machineId: string) {
  ownMachine(f, contributorId, machineId)
  f.state.agents.find(a => a.id === agentId)!.machineId = machineId
}

describe('five-part tasks', () => {
  const task = { goal: 'Save edits', changes: 'Persist the draft', constraints: 'No dependencies', owns: ['backend/src/superTabs'] }
  const brief = 'Goal:\nSave edits\n\nChanges:\nPersist the draft\n\nConstraints:\nNo dependencies\n\nOwns:\n- backend/src/superTabs'
  const checks = [{ description: 'Reconnect preserves edits', independent: false }]

  it('creates a structured task with a trimmed compatibility brief', () => {
    const f = fixture()
    const create = commandSchema.parse({ type: 'conversation.create', title: 'Drafts', task: { ...task, goal: ' Save edits ', owns: [' backend/src/superTabs '] }, checks })
    f.run(create)
    expect(f.state.conversations[1]).toMatchObject({ task, brief })
  })

  it('renders a review plan under "Review:" and refuses an empty, too long or third-review plan', () => {
    const f = fixture()
    const review = { focus: ' Check revoked access first. ', reviews: 2 }
    const group = f.run(commandSchema.parse({ type: 'conversation.create', title: 'Drafts', task: { ...task, review }, checks })).result.conversationId as string
    expect(f.state.conversations.find(c => c.id === group)).toMatchObject({ task: { ...task, review: { focus: 'Check revoked access first.', reviews: 2 } },
      brief: `${brief}\n\nReview:\nCheck revoked access first.\nTwo independent reviews, each by a different Reviewer.` })
    for (const bad of [{}, { focus: '' }, { focus: 'x'.repeat(2001) }, { reviews: 3 }, { reviews: 0 }, { focus: 'x', reviewers: 2 }]) {
      expect([bad, commandSchema.safeParse({ type: 'conversation.create', title: 'Drafts', task: { ...task, review: bad }, checks }).success]).toEqual([bad, false])
    }
    expect(commandSchema.safeParse({ type: 'conversation.create', title: 'Drafts', task: { ...task, review: { focus: 'x'.repeat(2000) } }, checks }).success).toBe(true)
  })

  it('bounds task strings and requires every part, or a brief', () => {
    const base = { type: 'conversation.create', title: 'Drafts' }
    for (const invalid of [null, {}, { ...task, goal: ' ' }, { ...task, changes: '' }, { ...task, constraints: '' },
      { ...task, goal: 'x'.repeat(8001) }, { ...task, changes: 'x'.repeat(8001) }, { ...task, constraints: 'x'.repeat(8001) },
      { ...task, owns: [] }, { ...task, owns: [' '] }, { ...task, owns: Array(41).fill('path') }, { ...task, owns: ['x'.repeat(4097)] },
      { ...task, extra: 'unexpected' }]) {
      expect(commandSchema.safeParse({ ...base, brief: 'legacy', task: invalid, checks }).success).toBe(false)
    }
    expect(commandSchema.safeParse({ ...base, task: { ...task, owns: Array(40).fill('path') }, checks }).success).toBe(true)
    expect(commandSchema.safeParse({ ...base, task: { ...task, owns: Array(40).fill('x'.repeat(4096)) }, checks }).success).toBe(false)
    expect(commandSchema.safeParse({ ...base, checks }).success).toBe(false)
  })
})

describe('person removal notices', () => {
  it('tells each remaining Lead who removed an agent and its open task', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group(), worker = f.add('worker', 'owner', group)
    f.seat(worker)
    storedAssignment(f.state, group, worker, 1000)
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
    storedAssignment(f.state, group, worker, 1000)
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
    storedAssignment(f.state, group, worker, 1000)
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
    expect(result.messages).toEqual([expect.objectContaining({ text: 'Discuss the architecture.', recipients: [], author: expect.objectContaining({ kind: 'person', id: 'owner' }) }),
      expect.objectContaining({ text: `owner added "${f.state.agents[0]!.displayName}".`, recipients: [], source: { kind: 'system' } })])
    expect(f.state.conversations[0]!.leadId).toBe(result.result.agentId)
  })
  it('keeps adding an agent separate from creating conversations and assigning work', () => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true)
    const group = f.group()
    const worker = f.add('worker', 'owner', group)
    expect(f.state.conversations.filter(c => c.kind !== 'agent-chat').map(c => c.title)).toEqual(['Lead', 'Offline editing'])
    expect(f.state.conversations.find(c => c.id === group)).toMatchObject({ leadId: lead, agentIds: [lead, worker], assignment: null })
    f.run({ type: 'conversation.agent', conversationId: group, agentId: worker, present: true, lead: false })
    expect(f.state.agents).toHaveLength(2)
    expect(f.state.conversations.filter(c => c.kind !== 'agent-chat')).toHaveLength(2) // Lead and the group
  })

  it('reaches only who an agent\'s post names, and refuses a reply to a message of another conversation', () => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true)
    const worker = f.add('worker')
    const posted = f.run({ type: 'message.send', conversationId: 'lead', text: 'Which behavior?', replyTo: null, recipientIds: [] },
      { kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' }).messages[0]!
    // An agent's post reaches only who it names (#2963).
    expect(posted.recipients).toEqual([])
    expect(() => f.run({ type: 'message.send', conversationId: 'lead', text: 'Cross-group reply', replyTo: posted.id, recipientIds: [] },
      { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' },
      { reply: { id: posted.id, conversationId: 'elsewhere', author: posted.author, createdAt: 0 } })).toThrow('Reply to a message in this conversation')
  })

  it('files a reply under its thread root, never a nested thread, and keeps a reply to a pre-thread message inline', () => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true), worker: Actor = { kind: 'agent', agentId: f.add('worker'), machineOwnerId: 'host-owner' }
    const root = f.run({ type: 'message.send', conversationId: 'lead', text: 'Should we do threads?', replyTo: null, recipientIds: [] }, worker).messages[0]!
    expect(root.thread).toBeUndefined()
    const first = f.run({ type: 'message.send', conversationId: 'lead', text: 'Yes.', replyTo: root.id, recipientIds: [] },
      { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }, { reply: { id: root.id, conversationId: 'lead', author: root.author, createdAt: 0, thread: root.id } }).messages[0]!
    expect(first).toMatchObject({ replyTo: root.id, thread: root.id })
    expect(first.alsoInChat).toBeUndefined()
    // A reply to a reply joins the root's thread.
    const second = f.run({ type: 'message.send', conversationId: 'lead', text: 'Agreed.', replyTo: first.id, recipientIds: [], alsoSend: true },
      worker, { reply: { id: first.id, conversationId: 'lead', author: first.author, createdAt: 0, thread: root.id } }).messages[0]!
    expect(second).toMatchObject({ replyTo: first.id, thread: root.id, alsoInChat: true })
    // A message written before threads has none: a reply to it stays an inline quote.
    const inline = f.run({ type: 'message.send', conversationId: 'lead', text: 'Old question answered.', replyTo: 'old-message', recipientIds: [], alsoSend: true },
      worker, { reply: { id: 'old-message', conversationId: 'lead', author: root.author, createdAt: 0, thread: null } }).messages[0]!
    expect(inline.replyTo).toBe('old-message')
    expect(inline.thread).toBeUndefined()
    expect(inline.alsoInChat).toBeUndefined()
  })

  it('delivers an assigned worker\'s own post to the agents it names alone, and the Lead\'s unnamed one to the worker', () => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true)
    const group = f.group(), worker = f.add('worker', 'owner', group), other = f.add('other', 'owner', group)
    const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
    const post = (actor: Actor, recipientIds: string[] = []) => f.run({ type: 'message.send', conversationId: group, text: 'PR is green.',
      replyTo: null, recipientIds }, actor).messages[0]!.recipients
    storedAssignment(f.state, group, worker, 1000)
    expect(post(as(worker))).toEqual([])
    expect(post(as(worker), [other])).toEqual([other])
    expect(post(as(worker), [lead])).toEqual([lead])
    expect(post(as(lead))).toEqual([worker])
    storedStatus(f.state, group, 'blocked', 'Stuck.')
    expect(post(as(worker))).toEqual([])
  })

  // 10-29: a moved agent's alarm and answers reached no one, and the backend worker stayed down 4 h 50 min. Since #2963 an
  // alarm names the PM: an unnamed post reaches the assignee at most.
  it('delivers another agent\'s unnamed post in the group to its assignee alone, and a named one only to the agents it names', () => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true)
    const group = f.group(), worker = f.add('worker', 'owner', group), other = f.add('other', 'owner', group)
    const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
    const post = (actor: Actor, recipientIds: string[] = [], agentOnly?: boolean) => f.run({ type: 'message.send', conversationId: group,
      text: 'Severe: the worker is down.', replyTo: null, recipientIds, ...(agentOnly ? { agentOnly } : {}) }, actor).messages[0]!.recipients
    expect(post(as(worker))).toEqual([])
    expect(post(as(lead))).toEqual([])
    storedAssignment(f.state, group, worker, 1000)
    expect(post(as(other))).toEqual([worker])
    expect(post(as(other), [lead])).toEqual([lead])
    storedStatus(f.state, group, 'cancelled', 'Duplicate of another task')
    expect(post(as(worker))).toEqual([])
    expect(post(as(worker), [other])).toEqual([other])
    expect(post(as(worker), [lead])).toEqual([lead])
    // A note to itself stays its own.
    expect(post(as(worker), [worker], true)).toEqual([worker])
    expect(post(as(lead))).toEqual([])
    storedAssignment(f.state, group, other, 1000)
    storedStatus(f.state, group, 'stopped')
    expect(post(as(other))).toEqual([])
    expect(() => post(as(other), ['not-an-agent'])).toThrow()
  })

  // Project instructions, phase 1: agents talk to each other directly, not through the PM.
  describe('messages between agents of a project', () => {
    const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
    const send = (f: ReturnType<typeof fixture>, actor: Actor, conversationId: string, recipientIds: string[], agentOnly?: boolean) =>
      f.run({ type: 'message.send', conversationId, text: 'PR #12 is ready.', replyTo: null, recipientIds, ...(agentOnly ? { agentOnly } : {}) }, actor).messages[0]!

    it('lets an agent post in another task of its project and name agents outside it, who join', () => {
      const f = fixture()
      const lead = f.add('lead', 'owner', 'lead', true)
      const build = f.group(), review = f.group()
      const engineer = f.add('engineer', 'owner', build), reviewer = f.add('reviewer', 'owner', review)
      const sent = send(f, as(engineer), build, [reviewer])
      expect(sent.recipients).toEqual([reviewer])
      expect(f.state.conversations.find(c => c.id === build)!.agentIds).toContain(reviewer)
      // The reviewer answers in its own review task, naming the engineer, who joins it.
      const answer = send(f, as(reviewer), review, [engineer])
      expect(answer.recipients).toEqual([engineer])
      expect(f.state.conversations.find(c => c.id === review)!.agentIds).toContain(engineer)
      // And an agent may post in a task of its project it was never in: it joins.
      const third = f.group()
      expect(send(f, as(engineer), third, [reviewer]).recipients).toEqual([reviewer])
      expect(f.state.conversations.find(c => c.id === third)!.agentIds).toEqual(expect.arrayContaining([engineer, reviewer]))
      expect([sent, answer].some(m => m.recipients.includes(lead))).toBe(false)
    })

    // The PM's digest gathers its own skills notices (docs/plans/2026-11-02-pm-digest-more-kinds-design.md).
    it('marks an agent\'s own skills notice', () => {
      const f = fixture()
      f.add('lead', 'owner', 'lead', true)
      const build = f.group(), engineer = f.add('engineer', 'owner', build)
      const sent = f.run(commandSchema.parse({ type: 'message.send', conversationId: build, text: 'The project\'s instructions changed.', replyTo: null,
        recipientIds: [engineer], agentOnly: true, notice: 'skills' }), as(engineer)).messages[0]!
      expect(sent.source).toEqual({ kind: 'agent-only', notice: 'skills' })
      expect(sent.recipients).toEqual([engineer])
    })

    it('refuses the skills mark anywhere but an agent\'s own agent-only notice', () => {
      const f = fixture()
      const lead = f.add('lead', 'owner', 'lead', true)
      const build = f.group(), engineer = f.add('engineer', 'owner', build), other = f.add('other', 'owner', build)
      const mark = (actor: Actor, recipientIds: string[], agentOnly?: true, conversationId = build) => () => f.run(commandSchema.parse({ type: 'message.send', conversationId,
        text: 'Hidden.', replyTo: null, recipientIds, ...(agentOnly ? { agentOnly } : {}), notice: 'skills' }), actor)
      expect(mark(as(engineer), [engineer])).toThrow('A skills notice is an agent-only notice to the agent itself.')
      expect(mark({ kind: 'person', userId: 'owner', email: 'owner@example.com' }, [lead], true, f.pmChat(lead))).toThrow('An agent sends an agent-only notice to itself alone.')
      expect(mark(as(engineer), [other], true)).toThrow('An agent sends an agent-only notice to itself alone.')
      expect(() => commandSchema.parse({ type: 'message.send', conversationId: build, text: 'x', replyTo: null, recipientIds: [engineer],
        agentOnly: true, notice: 'other' })).toThrow()
    })

    it('keeps recipients and posts inside the project and out of the Leads conversation', () => {
      const f = fixture()
      f.add('lead', 'owner', 'lead', true)
      const build = f.group(), engineer = f.add('engineer', 'owner', build)
      const other = f.run({ type: 'project.create', name: 'Other', visibility: 'public', brief: '' }).result
      const outsider = f.add('outsider', 'owner', other.conversationId as string)
      expect(() => send(f, as(engineer), build, [outsider])).toThrow('Choose an agent in this conversation')
      expect(f.state.conversations.find(c => c.id === build)!.agentIds).not.toContain(outsider)
      expect(() => send(f, as(outsider), build, [])).toThrow()
      const leads = storeOldLeads(f.state)
      expect(() => send(f, as(engineer), leads, [])).toThrow(expect.objectContaining({ code: 'LEADS_CONVERSATION_REMOVED' }))
    })

    it('tells the Lead once when two agents have exchanged 20 messages in a row', () => {
      const f = fixture()
      const lead = f.add('lead', 'owner', 'lead', true)
      const group = f.group(), engineer = f.add('engineer', 'owner', group), reviewer = f.add('reviewer', 'owner', group)
      const agentAuthor = (id: string) => ({ kind: 'agent', id, name: id }) as never
      // Newest first, as the store reads them: alternating between the pair, all inside the last 30 minutes.
      const exchanged = (count: number) => Array.from({ length: count }, (_, i) => {
        const from = i % 2 === 0 ? reviewer : engineer
        return { author: agentAuthor(from), recipients: [from === reviewer ? engineer : reviewer], createdAt: 1000 - i }
      })
      const ping = (recent: NonNullable<CommandContext['recent']>) => f.run({ type: 'message.send', conversationId: group, text: 'Fixed, look again.',
        replyTo: null, recipientIds: [reviewer] }, as(engineer), { recent }).messages
      const twentieth = ping(exchanged(LOOP_NOTICE_AT - 1))
      expect(twentieth).toHaveLength(2)
      expect(twentieth[1]).toMatchObject({ recipients: [lead] })
      expect(twentieth[1]!.text).toContain(`${LOOP_NOTICE_AT} messages`)
      expect(ping(exchanged(LOOP_NOTICE_AT))).toHaveLength(1)
      // A person's message in between starts the count again.
      const broken = exchanged(LOOP_NOTICE_AT - 1)
      broken.splice(3, 0, { author: { kind: 'person', id: 'owner', name: 'owner' } as never, recipients: [], createdAt: 1000 })
      expect(ping(broken)).toHaveLength(1)
      // Older than 30 minutes does not count.
      expect(ping(exchanged(LOOP_NOTICE_AT - 1).map(m => ({ ...m, createdAt: 1000 - 31 * 60_000 })))).toHaveLength(1)
    })

    it('treats a post that names only its sender as unnamed, so it reaches the assignee', () => {
      const f = fixture()
      f.add('lead', 'owner', 'lead', true)
      const group = f.group(), worker = f.add('worker', 'owner', group)
      const other = f.add('other', 'owner', group)
      storedAssignment(f.state, group, worker, 1000)
      expect(send(f, as(other), group, [other]).recipients).toEqual([worker])
    })

    it('does not count its own loop notice as a break, so an endless pair is reported once', () => {
      const f = fixture()
      f.add('lead', 'owner', 'lead', true)
      const group = f.group(), engineer = f.add('engineer', 'owner', group), reviewer = f.add('reviewer', 'owner', group)
      const exchanged = Array.from({ length: LOOP_NOTICE_AT - 1 }, (_, i) => {
        const from = i % 2 === 0 ? reviewer : engineer
        return { author: { kind: 'agent', id: from, name: from } as never, recipients: [from === reviewer ? engineer : reviewer], createdAt: 1000 - i }
      })
      const ping = (recent: NonNullable<CommandContext['recent']>) => f.run({ type: 'message.send', conversationId: group, text: 'Again.',
        replyTo: null, recipientIds: [reviewer] }, as(engineer), { recent }).messages
      const [message, notice] = ping(exchanged)
      expect(notice).toBeDefined()
      // The store reads back the 20th message and the notice after it; 20 more messages later there is still no second notice.
      const after = [{ author: notice!.author, recipients: notice!.recipients, createdAt: 1000, source: notice!.source }, { author: message!.author, recipients: message!.recipients, createdAt: 1000 }, ...exchanged]
      const forty = [...Array.from({ length: LOOP_NOTICE_AT - 1 }, (_, i) => exchanged[i % exchanged.length]!), ...after]
      expect(ping(forty)).toHaveLength(1)
    })

    it('copies nothing to the Lead, named or unnamed', () => {
      const f = fixture()
      f.add('lead', 'owner', 'lead', true)
      const group = f.group(), worker = f.add('worker', 'owner', group), other = f.add('other', 'owner', group)
      expect(send(f, as(other), group, [worker]).recipients).toEqual([worker])
      expect(send(f, as(other), group, []).recipients).toEqual([])
    })

    // A linked task takes any agent, a Reviewer-kind one too (project instructions, phase 4): joining it hands it no work.
    it('lets any agent be named into or post in a linked task, and in the project\'s channel (Swarm v4)', () => {
      const f = fixture()
      const lead = f.add('lead', 'owner', 'lead', true)
      const build = f.group(), engineer = f.add('engineer', 'owner', build), reviewer = f.add('reviewer', 'owner', f.group())
      f.state.agents.find(a => a.id === reviewer)!.role = 'reviewer'
      const review = f.run({ type: 'conversation.create', title: 'Review', brief: 'Review it.', reviewOf: build,
        checks: [{ description: 'Verdict', independent: false }] }, as(lead)).result.conversationId as string
      expect(send(f, as(engineer), review, [reviewer]).recipients).toEqual([reviewer])
      expect(f.state.conversations.find(c => c.id === review)!.agentIds).toEqual(expect.arrayContaining([engineer, reviewer]))
      const other = f.run({ type: 'conversation.create', title: 'Review', brief: 'Review it.', reviewOf: f.group(),
        checks: [{ description: 'Verdict', independent: false }] }, as(lead)).result.conversationId as string
      expect(send(f, as(reviewer), other, []).recipients).toEqual([])
      expect(f.state.conversations.find(c => c.id === other)!.agentIds).toContain(reviewer)
      // The project chat is its channel, where its agents talk (anh Dee 2026-11-08): an agent of it posts and is named there.
      expect(send(f, as(engineer), 'lead', []).recipients).toEqual([])
      expect(send(f, as(lead), 'lead', [engineer]).recipients).toEqual([engineer])
    })

    it('never delivers an agent its own message, except its note to itself', () => {
      const f = fixture()
      f.add('lead', 'owner', 'lead', true)
      const build = f.group(), engineer = f.add('engineer', 'owner', build), other = f.add('other', 'owner', build)
      const both = send(f, as(engineer), build, [engineer, other]).recipients
      expect(both).toContain(other)
      expect(both).not.toContain(engineer)
      expect(send(f, as(engineer), build, [engineer], true).recipients).toEqual([engineer])
    })

    // A person posts in their own chat with an agent alone (agentsOnly.test.ts): naming another agent there adds it to nothing.
    it('keeps a person\'s message from adding agents', () => {
      const f = fixture()
      const lead = f.add('lead', 'owner', 'lead', true)
      const engineer = f.add('engineer', 'owner', f.group()), chat = f.pmChat(lead)
      const before = [...f.state.conversations.find(c => c.id === chat)!.agentIds]
      expect(() => f.run({ type: 'message.send', conversationId: chat, text: 'Take a look.', replyTo: null, recipientIds: [engineer] }))
        .toThrow(expect.objectContaining({ code: 'INVALID_RECIPIENT' }))
      expect(f.state.conversations.find(c => c.id === chat)!.agentIds).toEqual(before)
    })

    it('never adds a stopping agent', () => {
      const f = fixture()
      f.add('lead', 'owner', 'lead', true)
      const build = f.group(), engineer = f.add('engineer', 'owner', build), stopping = f.add('stopping', 'owner', f.group())
      Object.assign(f.state.agents.find(a => a.id === stopping)!, { workDecision: 'stop', releaseId: 'r1' })
      expect(() => send(f, as(engineer), build, [stopping])).toThrow(expect.objectContaining({ code: 'INVALID_RECIPIENT' }))
      expect(f.state.conversations.find(c => c.id === build)!.agentIds).not.toContain(stopping)
      expect(() => send(f, as(stopping), build, [])).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
      expect(f.state.conversations.find(c => c.id === build)!.agentIds).not.toContain(stopping)
    })

    it('keeps a private chat closed to posts', () => {
      const f = fixture()
      f.add('lead', 'owner', 'lead', true)
      const build = f.group(), engineer = f.add('engineer', 'owner', build)
      const closed = (patch: Record<string, unknown>) => {
        const id = f.group()
        Object.assign(f.state.conversations.find(c => c.id === id)!, patch)
        return id
      }
      const chat = closed({ audience: { people: [{ id: 'owner', generation: f.state.people[0]!.generation }] } })
      // A private chat it cannot read is not found, so it never learns the chat exists.
      expect(() => send(f, as(engineer), chat, [])).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
      expect(f.state.conversations.find(c => c.id === chat)!.agentIds).not.toContain(engineer)
    })
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
          recent: history.slice().reverse().map(m => ({ author: m.author as never, recipients: m.recipients })),
          ...(reply ? { reply: { id: reply.id, conversationId: group, author: reply.author as never, createdAt: 0 } } : {}),
        }).messages[0]!
        history.push({ author: { kind: 'agent', id: agentId }, recipients: sent.recipients, id: sent.id })
        return sent
      }
      return { f, lead, group, worker, other, as, post, history }
    }

    it('reaches the assigned worker for a plain post, only while the work is active', () => {
      const { f, lead, group, worker, post } = setup()
      expect(post(lead).recipients).toEqual([])
      storedAssignment(f.state, group, worker, 1000)
      expect(post(lead).recipients).toEqual([worker])
      storedStatus(f.state, group, 'cancelled', 'Duplicate of another task')
      expect(post(lead).recipients).toEqual([])
    })

    it('reaches the assigned worker for a reply to the worker\'s message', () => {
      const { f, lead, group, worker, post } = setup()
      storedAssignment(f.state, group, worker, 1000)
      const report = post(worker)
      expect(report.recipients).toEqual([])
      expect(post(lead, [], report.id).recipients).toEqual([worker])
    })

    it('lets explicit recipients win and leaves replies to others alone', () => {
      const { f, lead, group, worker, other, as, post, history } = setup()
      storedAssignment(f.state, group, worker, 1000)
      expect(post(lead, [other]).recipients).toEqual([other])
      // Another agent's unnamed post reaches the assignee, and a reply to it reaches its author (#2963).
      const aside = post(other)
      expect(aside.recipients).toEqual([worker])
      expect(post(lead, [], aside.id).recipients).toEqual([other, worker])
      // A person's message there from before only agents posted in a task's chat.
      const personMessage = { id: 'person-message', author: { kind: 'person', id: 'owner' } as Author }
      history.push({ author: { kind: 'person', id: 'owner' }, recipients: [lead], id: personMessage.id })
      const reply = f.run({ type: 'message.send', conversationId: group, text: 'Ask the worker', replyTo: personMessage.id, recipientIds: [] }, as(lead), {
        reply: { id: personMessage.id, conversationId: group, author: personMessage.author, createdAt: 0 },
      }).messages[0]!
      expect(reply.recipients).toEqual([worker])
    })

    // Answers go right below, not in a thread (anh Dee, 2026-11-04; task #2929): an answer is routed as a reply to the same
    // message is, and its row opens no thread.
    it('routes an answer below a message as a reply to it, in the main flow', () => {
      const { f, lead, group, worker, as, post } = setup()
      storedAssignment(f.state, group, worker, 1000)
      const answer = (answers: { id: string; author: Author }) => f.run({ type: 'message.send', conversationId: group, text: 'Done.', replyTo: null,
        answers: answers.id, recipientIds: [] }, as(lead), { reply: { id: answers.id, conversationId: group, author: answers.author, createdAt: 0 } }).messages[0]!
      const report = post(worker)
      const below = answer(report)
      expect(below).toMatchObject({ replyTo: null, recipients: [worker] })
      expect(below.thread).toBeUndefined()
      // Answering a person's message there from before only agents posted reaches the task's assignee, as any unnamed post in a
      // task does (#2963), and as a reply to them does.
      expect(answer({ id: 'person-message', author: { kind: 'person', id: 'owner' } as Author }).recipients).toEqual([worker])
    })

    it('refuses an answer to a message it cannot find here, and an answer that is also a reply', () => {
      const { f, lead, group, worker, as, post } = setup()
      const asked = post(worker)
      const reply = { id: asked.id, conversationId: group, author: asked.author, createdAt: 0 }
      const send = (fields: { replyTo?: string | null; answers?: string }, context: Partial<CommandContext>) => () =>
        f.run({ type: 'message.send', conversationId: group, text: 'Done.', replyTo: null, recipientIds: [], ...fields } as Command, as(lead), context)
      expect(send({ answers: asked.id }, {})).toThrow(expect.objectContaining({ code: 'INVALID_ANSWER' }))
      expect(send({ answers: asked.id }, { reply: { ...reply, conversationId: 'lead' } })).toThrow(expect.objectContaining({ code: 'INVALID_ANSWER' }))
      expect(send({ answers: asked.id, replyTo: asked.id }, { reply })).toThrow(expect.objectContaining({ code: 'INVALID_ANSWER' }))
      expect(send({ answers: asked.id }, { reply }))
        .not.toThrow()
    })

    it('delivers the Lead\'s approval of the worker\'s plan, and each one\'s reply to the other (#1549)', () => {
      const { f, lead, group, worker, post } = setup()
      storedAssignment(f.state, group, worker, 1000)
      const plan = post(worker)
      expect(plan.recipients).toEqual([])
      const approval = post(lead)
      expect(approval.recipients).toEqual([worker])
      expect(post(worker, [], approval.id).recipients).toEqual([lead])
      expect(post(lead, [], plan.id).recipients).toEqual([worker])
    })

    // #2963: the worker's unnamed post reaches no one, so no automatic round trip is left to bound.
    it('has no automatic round trip between the Lead and its worker', () => {
      const { f, lead, group, worker, post } = setup()
      storedAssignment(f.state, group, worker, 1000)
      const hops: string[][] = []
      let speaker = worker
      // Each agent answers every message it receives with an unnamed post, the worst case for a loop.
      for (let turn = 0; turn < 50; turn++) {
        const sent = post(speaker)
        hops.push(sent.recipients)
        const next = sent.recipients[0]
        if (!next) break
        speaker = next
      }
      expect(hops).toEqual([[]])
      expect(post(lead).recipients).toEqual([worker])
      expect(post(worker).recipients).toEqual([])
    })
  })

  it('lets a viewer read and leave, but not send, attach or invite', () => {
    const f = fixture()
    f.invite('viewer')
    const commands: Command[] = [
      { type: 'message.send', conversationId: 'lead', text: 'Run this', replyTo: null, recipientIds: [] },
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

  it('withdraws a departing contributor and keeps its work\'s execution identity', () => {
    const f = fixture()
    f.invite()
    ownMachine(f, 'peer')
    const group = f.group()
    const worker = f.add('worker', 'peer', group)
    storedAssignment(f.state, group, worker, 1000)
    const removed = f.run({ type: 'member.remove', userId: 'peer' })
    expect(removed.cancelledAgents).toEqual([worker])
    expect(f.state.conversations.find(c => c.id === group)!.assignment).toMatchObject({ status: 'reconciling', execution: { machineId: 'host', harnessId: 'worker', machineOwnerId: 'host-owner' } })
    f.invite()
    expect(f.state.agents).toHaveLength(0)
  })

  it('keeps a task\'s lead while its work is active', () => {
    const f = fixture()
    f.add('lead', 'owner', 'lead', true)
    const group = f.group()
    const worker = f.add('worker', 'owner', group)
    storedAssignment(f.state, group, worker, 1000)
    expect(() => f.run({ type: 'conversation.agent', conversationId: group, agentId: worker, present: true, lead: true })).toThrow('replacing its lead')
  })

  it('allows discussion while paused and refuses new work, without mutating rejected state', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true)
    f.run({ type: 'tab.pause', paused: true })
    const before = JSON.stringify(f.state)
    expect(() => f.group()).toThrow('paused')
    expect(JSON.stringify(f.state)).toBe(before)
    expect(f.run({ type: 'message.send', conversationId: 'lead', text: 'Let’s reconsider.', replyTo: null, recipientIds: [] },
      { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }).messages).toHaveLength(1)
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
  const contribution = { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null }
  const request = { conversationId: group, machineId: 'host', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
    requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }
  const startId = f.run({ type: 'agent.start', request }, actor, { contribution }).result.startId as string
  expect(f.state.starts![0]).toMatchObject({ request, hostGrant: null, dispatched: false })
  expect(f.state.agents).toHaveLength(1)
  expect(f.state.conversations.filter(c => c.kind !== 'agent-chat')).toHaveLength(2) // Lead and the group
  expect(() => f.run({ type: 'agent.startDispatch', startId }, actor, { contribution: { ...contribution, hostGrant: 'new-grant' } })).toThrow('revoked')
  f.run({ type: 'agent.startDispatch', startId }, actor, { contribution })
  expect(() => f.run({ type: 'agent.startDispatch', startId }, actor, { contribution })).toThrow('already requested')
  const worker = f.run({ type: 'agent.started', startId, harnessId: 'native-worker', configuration: { ...config, engine: 'claude' } }, actor, { contribution }).result.agentId
  expect(f.state.agents).toHaveLength(2)
  expect(f.state.conversations.find(c => c.id === group)).toMatchObject({ agentIds: [lead, worker], assignment: null })
  expect(f.state.conversations[0]!.agentIds).toEqual([lead])
  f.run({ type: 'tab.pause', paused: true })
  expect(() => f.run({ type: 'agent.start', request }, actor, { contribution })).toThrow('paused')
})

// Task #2972 (Ken, 2026-11-04): 67 of 71 Codex picks were `default default`, which ran whatever the account's CLI defaulted to
// (gpt-6-luna on one Mac owner's account). A start that asks Codex for `default` runs the catalog's named default instead.
describe('a Codex start that asks for default', () => {
  const stored = (patch: Record<string, unknown>) => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
    const actor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    const contribution = { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null }
    const request = { conversationId: group, machineId: 'host', engine: 'codex', name: 'Builder', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false }, ...patch }
    f.run({ type: 'agent.start', request } as Command, actor, { contribution })
    const { model, effort } = f.state.starts![0]!.request
    return { model, effort }
  }
  it('runs the catalog\'s named default, Sol at high', () => {
    expect(stored({ model: 'default', effort: 'default' })).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' })
    expect(stored({ model: 'default' })).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' })
  })
  it('keeps an effort a person named', () => {
    expect(stored({ model: 'default', effort: 'xhigh' })).toMatchObject({ model: 'gpt-6.1-sol', effort: 'xhigh' })
  })
  it('leaves a named model, a grid model, an unnamed model and Claude as they were', () => {
    expect(stored({ model: 'gpt-6-astra', effort: 'xhigh' })).toMatchObject({ model: 'gpt-6-astra', effort: 'xhigh' })
    expect(stored({ model: 'gpt-6-luna', effort: 'high' })).toMatchObject({ model: 'gpt-6-luna', effort: 'high' })
    expect(stored({ model: 'default', effort: 'default', gridModel: 'kimi', gridName: 'grid' })).toMatchObject({ model: 'default', effort: 'default' })
    expect(stored({})).toEqual(expect.objectContaining({ model: undefined, effort: undefined }))
    expect(stored({ engine: 'claude', model: 'default', effort: 'default' })).toMatchObject({ model: 'default', effort: 'default' })
  })
})

it.each(['opencode', 'kilo'])('refuses to dispatch a stored legacy %s start before native launch', engine => {
  const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
  const actor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
  const contribution = { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null }
  const request = { conversationId: group, machineId: 'host', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
    requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }
  const startId = f.run({ type: 'agent.start', request }, actor, { contribution }).result.startId as string
  f.state.starts![0]!.request.engine = engine // Simulate a start stored before the engine restriction.
  expect(() => f.run({ type: 'agent.startDispatch', startId }, actor, { contribution })).toThrow('Claude Code or Codex')
  expect(f.state.starts![0]!.dispatched).toBe(false)
})

describe('agent.start on the Swarm\'s listed machines', () => {
  const request = (group: string, machineId: string) => ({ conversationId: group, machineId, engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
    requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } })
  const grant = { machineOwnerId: 'owner', contributorId: 'owner' }

  it('refuses an agent\'s start on a machine nobody listed, and records nothing', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
    const actor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    expect(() => f.run({ type: 'agent.start', request: request(group, 'account-vm') }, actor, { contribution: grant }))
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
    f.run({ type: 'agent.start', request: request(group, 'lead-machine') }, actor, { contribution: grant })
    expect(f.state.starts).toHaveLength(1)
  })

  it('lets an agent start on a contributed machine', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
    const actor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    f.state.machines = [{ machineId: 'contributed', name: 'Mini', contributorId: 'owner', membershipGeneration: f.state.people[0]!.generation, generation: 'g1',
      cwd: '/repo', engines: ['claude'], maxAgents: 2, paused: false, observation: { receivedAt: 1000 } } as never]
    f.run({ type: 'agent.start', request: request(group, 'contributed') }, actor, { contribution: grant })
    expect(f.state.starts).toHaveLength(1)
  })

  // Scholes's goals, piece 5: a start says the heavy work it runs, which later routes count on its machine.
  it('keeps the heavy work a start declares, and refuses any other value', () => {
    const f = fixture(), group = f.group()
    f.run({ type: 'agent.start', request: { ...request(group, 'my-laptop'), heavy: ['build', 'e2e'] } }, owner, { contribution: grant })
    expect(f.state.starts![0]!.request.heavy).toEqual(['build', 'e2e'])
    const parse = (heavy: unknown) => commandSchema.safeParse({ type: 'agent.start', request: { ...request(group, 'm'), heavy } }).success
    expect(parse(['e2e'])).toBe(true)
    for (const heavy of [[], ['compile'], ['build', 'build'], 'build', ['build', 'e2e', 'build']]) expect(parse(heavy)).toBe(false)
    // A start without it is as before.
    expect(commandSchema.safeParse({ type: 'agent.start', request: request(group, 'm') }).success).toBe(true)
  })

  it('keeps a person\'s start on a machine of their own, before anything is listed', () => {
    const f = fixture(), group = f.group()
    f.run({ type: 'agent.start', request: request(group, 'my-laptop') }, owner, { contribution: grant })
    expect(f.state.starts).toHaveLength(1)
  })
})

/** The base fixture plus a coordinating Lead and a worker, both on one host. */
function routed() {
  const f = fixture()
  const lead = f.add('lead', 'owner', 'lead', true), worker = f.add('worker')
  // An agent runs on 'machine', so the Swarm lists it and a start there is allowed.
  f.seat(f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'machine', harnessId: 'remote', name: 'Remote', configuration: config, lead: false },
    owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string)
  const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  /** Records a completed native start for an agent, as the decision's `new` final refers to it. */
  const startedFor = (agentId: string) => {
    const member = f.state.agents.find(a => a.id === agentId)!
    f.state.starts ??= []
    f.state.starts.push({ id: `start-${agentId}`, harnessId: member.harnessId, request: { machineId: member.machineId } } as never)
    return `start-${agentId}`
  }
  return { ...f, get state() { return f.state }, lead, worker, startedFor, contribution: { machineOwnerId: 'owner', contributorId: 'owner' },
    leadActor: agentActor(lead), workerActor: agentActor(worker) }
}

describe('the last action of the project\'s agents on a task', () => {
  it('is recorded with its time by any agent\'s start there, and by the coordinator\'s post', () => {
    const f = routed(), group = f.group(), task = () => f.state.conversations.find(c => c.id === group)!
    expect(task().leadAction).toBeUndefined()
    const request = { conversationId: group, machineId: 'machine', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }
    f.run({ type: 'agent.start', request }, f.leadActor, { contribution: f.contribution, now: 3000 })
    expect(task().leadAction).toEqual({ kind: 'start', at: 3000 })
    // Its start keeps when it was asked for: a task whose start is never launched is orphaned 10 minutes on (liveness.ts).
    expect(f.state.starts!.at(-1)!.requestedAt).toBe(3000)
    // Another agent's post handles nothing: a person's held tag stays, and an unstarted start's clock runs on (final review).
    f.run({ type: 'message.send', conversationId: group, text: 'Progress.', replyTo: null, recipientIds: [] }, f.workerActor, { now: 5000 })
    expect(task().leadAction).toEqual({ kind: 'start', at: 3000 })
    f.run({ type: 'message.send', conversationId: group, text: 'Why it waits.', replyTo: null, recipientIds: [] }, f.leadActor, { now: 6000 })
    expect(task().leadAction).toEqual({ kind: 'post', at: 6000 })
  })

  it('leaves a task whose start failed orphaned, so it stays so once the failed start is no longer loaded', () => {
    const f = routed(), group = f.group(), task = () => f.state.conversations.find(c => c.id === group)!
    const request = { conversationId: group, machineId: 'machine', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }
    const startId = f.run({ type: 'agent.start', request }, f.leadActor, { contribution: f.contribution }).result.startId as string
    f.run({ type: 'agent.startFailed', startId, error: 'Could not prepare the worktree' }, f.leadActor, { contribution: f.contribution, now: 7000 })
    expect(task().liveness).toEqual({ state: 'orphaned', why: 'start-failed', since: 7000 })
  })

  // Task #3861: a start stayed Queued for hours with its machine's fault only in that machine's log. Its host reports why it waits.
  describe('a start its machine reports waiting', () => {
    const FOLDER = 'CREATION_STORAGE_FAILED: The creation folder ~/.harness/cli/data/agent-creations is not usable by this account (permissions). It must belong to this account with mode 700; the owner of this computer fixes that, Harness does not change it.'
    const started = () => {
      const f = routed(), group = f.group()
      const request = { conversationId: group, machineId: 'machine', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
        requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }
      const startId = f.run({ type: 'agent.start', request }, f.leadActor, { contribution: f.contribution }).result.startId as string
      const start = () => f.state.starts!.find(s => s.id === startId)!
      return { f, startId, start, wait: (reason: string, now = 5000) => f.run({ type: 'agent.startWaiting', startId, reason }, f.leadActor, { contribution: f.contribution, now }) }
    }

    it('keeps the reason and when it was first told, on the start', () => {
      const { start, wait } = started()
      wait(FOLDER, 5000)
      expect(start().waiting).toEqual({ reason: FOLDER, at: 5000 })
      wait(FOLDER, 9000)
      expect(start().waiting).toEqual({ reason: FOLDER, at: 5000 })
      wait('CREATION_STORAGE_FAILED: other', 9500)
      expect(start().waiting).toEqual({ reason: 'CREATION_STORAGE_FAILED: other', at: 9500 })
    })
    it('is read whole by its coordinator and as what it means by anyone else', () => {
      const { f, start, wait } = started()
      f.invite()
      wait(FOLDER)
      expect(visibleState(f.state, f.leadActor).starts!.find(s => s.id === start().id)!.waiting!.reason).toBe(FOLDER)
      expect(visibleState(f.state, peer).starts!.find(s => s.id === start().id)!.waiting!.reason).toContain("Its machine's creation folder ~/.harness/cli/data/agent-creations is not usable")
    })
    it('ends with the start: failed or started', () => {
      const { f, startId, start, wait } = started()
      wait(FOLDER)
      f.run({ type: 'agent.startFailed', startId, error: FOLDER }, f.leadActor, { contribution: f.contribution, now: 6000 })
      expect(start().waiting).toBeUndefined()
      // A report that arrives after the start ended changes nothing.
      wait(FOLDER, 7000)
      expect(start().waiting).toBeUndefined()
    })
  })
})

// The Lead's ruling, 2026-10-29: the project chat and the Leads chat carry only what people read or decide on, and agent
// bookkeeping (routing, an agent joined or ready) is no one's there; a task's chat keeps it as its record.
describe('agent bookkeeping in the chats people read', () => {
  const shown = (row: { source?: Record<string, unknown>; recipients: string[] }) => !agentOnly(row.source, row.recipients)

  it('keeps an agent\'s joined and ready lines out of the project chat, and in a task\'s chat', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
    const actor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    const contribution = { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null }
    const lines = (conversationId: string, harnessId: string) => {
      const request = { conversationId, machineId: 'host', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
        requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }
      const startId = f.run({ type: 'agent.start', request }, actor, { contribution }).result.startId as string
      f.run({ type: 'agent.startDispatch', startId }, actor, { contribution })
      f.state.starts!.find(s => s.id === startId)!.poolGeneration = 'pool-1'
      const joined = f.run({ type: 'agent.started', startId, harnessId, configuration: { ...config, engine: 'claude' } }, actor, { contribution }).messages
      const ready = f.run({ type: 'agent.startSettled', startId, warning: null }, actor, { contribution }).messages
      return [...joined, ...ready].map(m => [m.text, shown(m)])
    }
    // No agent but its coordinator starts into the project chat (#2207); its coordinator's lines are lead.start's (leadStart.test).
    expect(() => lines('lead', 'in-lead')).toThrow(expect.objectContaining({ code: 'PROJECT_CHAT_COORDINATOR_ONLY' }))
    const pm = f.state.agents.find(a => a.id === lead)!.displayName
    expect(lines(group, 'in-task')).toEqual([[`"${pm}" added "Builder". Preparing its model.`, true], ['Builder is ready for an assignment.', true]])
  })
})

// The server refuses no start for its model, its machine, a task's requirement or quota; only facts and access (project
// instructions, phase 4).
describe('what a start may run', () => {
  const request = (patch: Record<string, unknown> = {}) => ({ conversationId: 'lead', machineId: 'machine', engine: 'claude', model: 'opus', effort: 'high',
    name: 'Builder', cwd: '/repo', worktree: false, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false },
    ...patch }) as Extract<Command, { type: 'agent.start' }>['request']

  it('starts for an agent as for a person', () => {
    const f = routed(), task = f.group()
    expect(f.run({ type: 'agent.start', request: request({ conversationId: task }) }, f.leadActor, { contribution: f.contribution }).result.startId).toBeTruthy()
    const g = routed(), gTask = g.group()
    expect(g.run({ type: 'agent.start', request: request({ conversationId: gTask }) }, owner, { contribution: g.contribution }).result.startId).toBeTruthy()
  })

  it('takes any model for a build or a review', () => {
    const f = routed(), build = f.group()
    const review = f.run({ type: 'conversation.create', title: 'Review', brief: 'Review it.', reviewOf: build, checks: [] }).result.conversationId as string
    // A Sonnet build an agent starts.
    expect(f.run({ type: 'agent.start', request: request({ conversationId: build, model: 'sonnet', effort: 'medium' }) }, f.leadActor, { contribution: f.contribution })
      .result.warnings).toBeUndefined()
    // A grid-model start into the review.
    expect(f.run({ type: 'agent.start', request: request({ conversationId: review, model: undefined, effort: undefined, gridModel: 'moonshotai/kimi-k3', gridName: 'swarm-g' }) },
      f.leadActor, { contribution: f.contribution }).result.warnings).toBeUndefined()
  })

  it('ignores a task\'s machine and device requirement', () => {
    const f = routed()
    const requires = { machines: ['machine'], devices: ['/dev/cu.usbmodem1'] }
    const [group, other] = [0, 1].map(() => f.run({ type: 'conversation.create', title: 'Device', task: { goal: 'Check the device', changes: 'None', constraints: 'On its Mac',
      owns: ['devices'], requires }, checks: [] }).result.conversationId as string) as [string, string]
    // No start on 'host' had its machine check the device.
    expect(f.run({ type: 'agent.start', request: request({ conversationId: other, machineId: 'host' }) }, f.leadActor, { contribution: f.contribution }).result.warnings)
      .toBeUndefined()
    // The requirement stays on the task, as information.
    expect(f.state.conversations.find(c => c.id === group)!.task!.requires).toEqual(requires)
  })

  it('starts with no role default', () => {
    const f = routed()
    // An older client's custom set with defaults per role: no command fills them now.
    Object.assign(f.state.projects![0]!, { skillSet: 'custom', roles: [
      { id: 'pm', name: 'PM', kind: 'lead', version: 'v1', defaults: { engine: 'claude', model: 'sonnet', effort: 'high' } },
      { id: 'dev', name: 'Engineer', kind: 'builder', version: 'v1', defaults: { engine: 'claude', model: 'sonnet', effort: 'high' } }] })
    const { model: _model, effort: _effort, ...unnamed } = request({ roleId: 'dev', conversationId: f.group() })
    f.run({ type: 'agent.start', request: unnamed }, owner, { contribution: f.contribution })
    expect(f.state.starts!.at(-1)!.request).not.toHaveProperty('model')
    expect(f.state.starts!.at(-1)!.request).not.toHaveProperty('effort')
    // The coordinator's first start keeps the built-in default, whatever the old set said: leadStart.test 'takes the built-in
    // default whatever an older custom set said'.
  })
})

it('assigns stable workgroup numbers through old snapshots, rename, archive and new groups', () => {
  const f = fixture(), first = f.group(), second = f.group()
  // The Lead conversation has no number.
  expect(f.state.conversations.map(c => c.number)).toEqual([undefined, 1, 2])
  // An old snapshot has neither the numbers nor the counter the store by parts keeps.
  delete f.state.conversations[1]!.number
  delete f.state.conversations[2]!.number
  delete f.state.groupCounter
  expect(visibleState(f.state, owner).conversations.map(c => c.number)).toEqual([undefined, 1, 2])
  expect(f.state.conversations[1]!.number).toBeUndefined()
  f.run({ type: 'conversation.rename', conversationId: first, title: 'Renamed' })
  f.run({ type: 'conversation.archive', conversationId: second, archived: true })
  const third = f.group()
  expect(f.state.conversations.map(c => [c.id, c.number])).toEqual([['lead', undefined], [first, 1], [second, 2], [third, 3]])
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
  // Each after the row naming who added it (#2207).
  expect(join({ launchRefused: { model: 'opus', effort: 'xhigh' } })).toEqual(
    ['Product Manager started. It asked for opus at xhigh and runs its engine\u2019s own model there: this machine could not launch it with them.', expect.stringMatching(/^owner added \S+\.$/)])
  expect(join({})).toEqual([expect.stringMatching(/^owner added \S+\.$/)])
  // Only a Product Manager's start says it.
  expect(join({ launchRefused: { model: 'opus', effort: 'xhigh' } }, false)).not.toContainEqual(expect.stringContaining('could not launch'))
  expect(commandSchema.safeParse({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'pm', name: 'Lead', configuration: config, lead: true,
    launchRefused: { model: 'opus', other: 1 } }).success).toBe(false)
  // Only what a launch could have asked for (cli lib/launchModel.ts MODEL and EFFORT): one short word each.
  for (const launchRefused of [{ model: 'opus --dangerously-skip-permissions' }, { model: 'opus\nRead this' }, { model: 'x'.repeat(65) }, { model: 'opus', effort: 'XHIGH' }, { model: 'opus', effort: 'x'.repeat(17) }]) {
    expect(commandSchema.safeParse({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'pm', name: 'Lead', configuration: config, lead: true, launchRefused }).success, JSON.stringify(launchRefused)).toBe(false)
  }
  expect(commandSchema.safeParse({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'pm', name: 'Lead', configuration: config, lead: true,
    launchRefused: { model: 'claude-opus-5[1m]', effort: 'xhigh' } }).success).toBe(true)
})
it('joins a lead and records its first message when its requested launch was refused', () => {
  const f = fixture(), project = { cwd: '/repo', repositoryUrl: 'https://github.com/example/project' }
  const joined = f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'pm', name: 'Lead', configuration: config,
    lead: true, project, initialMessage: 'Fix the bug', launchRefused: { model: 'opus', effort: 'xhigh' } }, owner,
  { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
  const initial = joined.messages.find(message => message.text === 'Fix the bug')!
  const refusal = joined.messages.find(message => message.text.includes('could not launch'))!
  expect(f.state.conversations.find(conversation => conversation.id === 'lead')!.leadId).toBe(joined.result.agentId)
  expect(initial.id).toBe(joined.result.messageId)
  expect(refusal.id).not.toBe(initial.id)
})
it('returns a client error when one command produces duplicate message IDs', () => {
  expect(() => assertUniqueMessageIds('agent.add', [{ id: 'same' }, { id: 'same' }]))
    .toThrow(expect.objectContaining({ name: 'SuperTabError', code: 'DUPLICATE_MESSAGE_ID', status: 400,
      message: expect.stringContaining('duplicate message IDs') }))
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
describe('saving a machine again', () => {
  const owners = { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }
  const save = (maxAgents: number): Command => ({ type: 'machine.contribute', machineId: 'host', name: 'Studio', cwd: '/repo', engines: ['claude'], maxAgents })
  it('keeps its Lent hours, engine health and last reading when its owner saves other settings', () => {
    const f = fixture()
    f.run(save(2), owner, owners)
    const week = weekStart(NOW)
    const kept = {
      lent: [{ week, busyMs: 18_000_000 }],
      lentDays: [{ day: week, projectId: 'lead', busyMs: 18_000_000 }],
      engineFailures: { codex: 1 },
      engineBackoff: { codex: { level: 3, cause: 'engine' } },
      machineFailures: 1, machineBackoff: 2, machineSuspension: { at: NOW, durationMs: 3_600_000 },
      engineSuspensions: { claude: { at: NOW, fine: false } },
      observation: { receivedAt: NOW, runningHarnessIds: ['h1'], stoppedHarnessIds: [] } as never,
    }
    Object.assign(f.state.machines![0]!, structuredClone(kept))
    const lentThisWeek = () => lentIn(f.state.machines![0]!, weekSpan(week), NOW, { projects: new Set(['lead']), unsplit: true })
    expect(lentThisWeek()).toBe(18_000_000)
    f.run(save(3), owner, owners)
    expect(f.state.machines).toEqual([expect.objectContaining({ machineId: 'host', maxAgents: 3, ...kept })])
    expect(lentThisWeek()).toBe(18_000_000)
  })
  it('gives a first-time contribution a clean record', () => {
    const f = fixture()
    f.run(save(2), owner, owners)
    const record = f.state.machines![0]!
    for (const key of ['lent', 'lentDays', 'engineFailures', 'engineSuspensions', 'observation']) expect(record).not.toHaveProperty(key)
  })
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
  // A person sends files in their own chat with their agent (agentsOnly.test.ts).
  const send = (attachmentIds?: string[], text = '', conversationId = 'lead'): Command =>
    ({ type: 'message.send', conversationId, text, replyTo: null, recipientIds: [], ...(attachmentIds ? { attachmentIds } : {}) })
  it('records verified files on the message and allows empty text with one', () => {
    const f = fixture(), chat = f.pmChat(f.add('lead', 'owner', 'lead', true))
    const sent = f.run(send(['file-1', 'file-1'], '', chat), owner, { attachments: [file] })
    expect(sent.messages).toEqual([expect.objectContaining({ text: '', attachments: [file] })])
    expect(f.run(send(undefined, 'Plain text.', chat)).messages[0]).not.toHaveProperty('attachments')
  })
  it('refuses empty text without files and a file the store did not verify', () => {
    const f = fixture(), chat = f.pmChat(f.add('lead', 'owner', 'lead', true))
    expect(() => f.run(send(undefined, '', chat))).toThrow('Write a message or attach a file.')
    expect(() => f.run(send(['file-1'], '', chat))).toThrow('Upload this file again')
    expect(() => commandSchema.parse(send(Array.from({ length: 11 }, (_, i) => `file-${i}`)))).toThrow()
  })
  it('resends a message with its files', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true)
    const resent = f.run({ type: 'delivery.resolve', deliveryId: 'd', resolution: 'resend' }, owner,
      { delivery: { id: 'd', conversationId: 'lead', agentId: lead, messageId: 'm', text: '', attachments: [file] } })
    expect(resent.messages[0]).toMatchObject({ recipients: [lead], attachments: [file] })
  })
})

describe('voice messages', () => {
  const voice = { durationMs: 81_000, waveform: new Array(48).fill(7), transcribed: true }
  const clip = { id: 'voice-1', name: 'Voice message.wav', mime: 'audio/wav', size: 2_592_044, url: 'https://cdn.example.test/super-tabs/tab/abc/Voice_message.wav', voice }
  const file = { id: 'file-1', name: 'screen.png', mime: 'image/png', size: 12, url: 'https://cdn.example.test/super-tabs/tab/abc/screen.png' }
  /** [f]'s PM, and a voice message to it in its person's own chat with it (agentsOnly.test.ts). */
  const toPm = (f: ReturnType<typeof fixture>) => {
    const lead = f.add('lead', 'owner', 'lead', true), chat = f.pmChat(lead)
    return { lead, send: (attachmentIds: string[], text = ''): Command => ({ type: 'message.send', conversationId: chat, text, replyTo: null, recipientIds: [], attachmentIds }) }
  }
  it('makes the clip\'s words the message\'s text, and keeps its facts on the file', () => {
    const f = fixture(), { lead, send } = toPm(f)
    const sent = f.run(send(['voice-1']), owner, { attachments: [clip], voiceWords: { 'voice-1': 'Ship the parser today.' } })
    expect(sent.messages).toEqual([expect.objectContaining({ text: 'Ship the parser today.', attachments: [clip], recipients: [lead] })])
  })
  it('sends a clip with no words with an empty text', () => {
    const f = fixture(), { send } = toPm(f)
    const quiet = { ...clip, voice: { ...voice, transcribed: false, failure: 'limit' as const } }
    expect(f.run(send(['voice-1']), owner, { attachments: [quiet] }).messages[0]).toMatchObject({ text: '', attachments: [quiet] })
  })
  it('sends a voice message alone: no typed text, tags or other files with it', () => {
    const f = fixture(), { send } = toPm(f)
    expect(() => f.run(send(['voice-1'], 'and also this'), owner, { attachments: [clip] })).toThrow(expect.objectContaining({ code: 'VOICE_ALONE', status: 400 }))
    expect(() => f.run(send(['voice-1', 'file-1']), owner, { attachments: [clip, file] })).toThrow(expect.objectContaining({ code: 'VOICE_ALONE' }))
  })
  it('removes a credential spoken in it, as from typed text', () => {
    const f = fixture(), { send } = toPm(f)
    const token = ['ghp', 'Fixture0Token1Not2Real3Value4abcdefgh'].join('_')
    const sent = f.run(send(['voice-1']), owner, { attachments: [clip], voiceWords: { 'voice-1': `the token is ${token}` } })
    expect(sent.messages[0]!.text).toBe(`the token is ${CREDENTIAL_MARKER}`)
  })
})

 describe('finished worker decisions', () => {
  function finished() {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
    const worker = f.add('worker', 'owner', group), other = f.add('other', 'owner', group)
    const leadActor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    const workerActor: Actor = { kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' }
    storedAssignment(f.state, group, worker, 1000)
    storedStatus(f.state, group, 'stopped')
    return { f, worker, other, leadActor, workerActor }
  }
  // Nothing waits for a decision about a finished worker (project instructions, phase 4): the mark is shown, never read.
  it('permits any agent of the project or the owner to keep or stop, and refuses another person', () => {
    const { f, worker, leadActor, workerActor } = finished()
    f.invite()
    const release = { type: 'agent.release', agentId: worker, decision: 'keep' } as Command
    expect(() => f.run(release, peer)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    f.run(release, workerActor)
    expect(f.state.agents.find(a => a.id === worker)).toHaveProperty('workDecision', 'keep')
    f.run({ ...release, decision: 'stop' } as Command)
    expect(() => f.run(release, leadActor)).toThrow('stopping')
  })
  it('allows only the execution host of a requested stop to acknowledge removal', () => {
    const { f, worker, other, leadActor, workerActor } = finished()
    expect(() => f.run({ type: 'agent.remove', agentId: worker }, workerActor)).toThrow()
    f.run({ type: 'agent.release', agentId: worker, decision: 'stop' } as Command, owner)
    expect(() => f.run({ type: 'agent.remove', agentId: worker }, { ...workerActor, agentId: other })).toThrow()
    const releaseId = f.state.agents.find(a => a.id === worker)!.releaseId!
    const chats = f.state.conversations.filter(c => c.agentIds.includes(worker)).map(c => c.id)
    // A quiet chat it was in too: a row there would wake it (Luna's re-review).
    const quiet = f.group()
    Object.assign(f.state.conversations.find(c => c.id === quiet)!, { agentIds: [worker], dormant: true })
    const name = f.state.agents.find(a => a.id === worker)!.displayName
    const removed = f.run({ type: 'agent.remove', agentId: worker, releaseId }, workerActor)
    // Each chat it was in says it left (Luna's review of #2207): its own host confirmed the stop. The quiet one stays quiet.
    expect(chats.length).toBeGreaterThan(0)
    expect(removed.messages.map(m => [m.conversationId, m.text, m.recipients])).toEqual(chats.map(id => [id, `"${name}" left.`, []]))
    expect(f.state.conversations.find(c => c.id === quiet)).toMatchObject({ agentIds: [], dormant: true })
    expect(removed.cancelledAgents).toContain(worker)
    expect(f.state.agents.some(a => a.id === worker)).toBe(false)
    // Its host closed the session before confirming; nothing is left for it to close.
    expect(f.state.closingSessions).toBeUndefined()
  })
 })

it('requires the exact stop request for host acknowledgement and prevents promotion while stopping', () => {
  const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group(), worker = f.add('worker', 'owner', group)
  const leadActor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
  const workerActor: Actor = { kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' }
  storedAssignment(f.state, group, worker, 1000)
  storedStatus(f.state, group, 'stopped')
  f.run({ type: 'agent.release', agentId: worker, decision: 'stop' }, owner)
  expect(() => f.run({ type: 'agent.remove', agentId: worker, releaseId: 'old-release' } as Command, workerActor)).toThrow('stop request')
  expect(() => f.run({ type: 'conversation.agent', conversationId: group, agentId: worker, present: true, lead: true })).toThrow('stopping')
  expect(() => f.add('worker', 'owner', group, true)).toThrow('stopping')
})

// Swarm autonomous-harness, 2026-10-29: a Builder started by hand never got a task, and its Lead could not stop it ("this
// worker has no finished assignment to release"); only a person by hand could. Keeping one needs no finished work either
// (project instructions, phase 4: 'keeps or stops any agent on request').
it('lets the Lead stop a worker that never had an assignment', () => {
  const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group(), worker = f.add('worker', 'owner', group)
  const leadActor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
  f.run({ type: 'agent.release', agentId: worker, decision: 'stop' }, owner)
  expect(f.state.agents.find(a => a.id === worker)).toMatchObject({ workDecision: 'stop', releaseId: expect.any(String) })
})

it('allows the contributor to keep a completed worker and refuses another project’s Lead', () => {
  const f = fixture(); f.invite()
  ownMachine(f, 'peer')
  f.add('lead', 'owner', 'lead', true)
  const group = f.group(), worker = f.add('worker', 'peer', group)
  storedAssignment(f.state, group, worker, 1000)
  storedStatus(f.state, group, 'done', 'Delivered')
  f.run({ type: 'agent.release', agentId: worker, decision: 'keep' }, peer)
  expect(f.state.agents.find(a => a.id === worker)!.workDecision).toBe('keep')
  const project = f.run({ type: 'project.create', name: 'Other', visibility: 'public', brief: '' }).result
  // On another machine: a Team account running this project's Lead takes no other project's work (leadStart.ts, #895).
  const otherLead = f.run({ type: 'agent.add', conversationId: project.conversationId as string, machineId: 'other-host', harnessId: 'other-lead',
    name: 'other-lead', configuration: config, lead: true }, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  expect(() => f.run({ type: 'agent.release', agentId: worker, decision: 'stop' }, { kind: 'agent', agentId: otherLead, machineOwnerId: 'host-owner' })).toThrow()
})

// Who does a task's work is workflow, so the project's instructions decide it; the server checks only access (project
// instructions, phase 4). The Swarm's settings and who coordinates stay the coordinator's and people's.
describe('any agent of the project', () => {
  /** routed()'s coordinator and worker A, and an Engineer E: three agents of one project. */
  function project() {
    const f = routed(), engineer = f.add('engineer')
    return { f, engineer, E: { kind: 'agent', agentId: engineer, machineOwnerId: 'host-owner' } as Actor }
  }
  const coordinatorRequired = expect.objectContaining({ code: 'COORDINATOR_REQUIRED' })

  it('lets any agent of the project run the task commands', () => {
    const { f, E } = project(), A = f.worker
    const group = f.run({ type: 'conversation.create', title: 'Offline editing', brief: 'Save edits while offline.',
      checks: [{ description: 'Reconnect preserves the edits.', independent: false }], priority: 'P2', requesterId: 'owner' }, E).result.conversationId as string
    const task = () => f.state.conversations.find(c => c.id === group)!
    f.run({ type: 'conversation.rename', conversationId: group, title: 'Drafts offline' }, E)
    f.run({ type: 'conversation.requester', conversationId: group, personId: 'owner' }, E)
    expect(task()).toMatchObject({ title: 'Drafts offline', requesterId: 'owner' })
    // A, as the Swarm started it: any agent of the project releases it.
    f.state.agents.find(a => a.id === A)!.startedSession = { creationId: 'super-start', sessionId: 'session', createdAt: new Date(0).toISOString() }
    expect(() => f.run({ type: 'agent.release', agentId: A, decision: 'stop' }, E)).toThrow('Only its person stops an agent')
    expect(f.state.agents.find(a => a.id === A)!.workDecision).not.toBe('stop')
    f.run({ type: 'conversation.archive', conversationId: group, archived: true }, E)
    expect(task().archived).toBe(true)
  })

  it('keeps settings and who coordinates to the coordinator and people', () => {
    const { f, engineer, E } = project(), group = f.group()
    for (const command of [{ type: 'tab.rename', name: 'Renamed' }, { type: 'tab.pause', paused: true },
      { type: 'project.report', projectId: 'lead', throughRevision: 0, text: 'Progress.' },
      { type: 'conversation.agent', conversationId: group, agentId: engineer, present: true, lead: true }] as Command[]) {
      expect(() => f.run(command, E)).toThrow(coordinatorRequired)
    }
    // No agent adds a session at all (security review S2), so none names a new lead that way.
    expect(() => f.run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId: 'new-lead', name: 'New lead', configuration: config, lead: true },
      E, { contribution: f.contribution })).toThrow(expect.objectContaining({ code: 'HUMAN_REQUIRED' }))
    expect(() => f.run({ type: 'agent.release', agentId: f.lead, decision: 'stop' }, E)).toThrow(expect.objectContaining({ code: 'PERSON_STOPS' }))
    expect(f.state).toMatchObject({ name: 'Pilot', paused: false })
    f.run({ type: 'tab.rename', name: 'Renamed' }, f.leadActor)
    expect(f.state.name).toBe('Renamed')
  })

  // The project chat is the people's and is never archived: its members stay as its coordinator or a person set them (final
  // review of the branch), as a post cannot add anyone there either (joinsProject).
  it('keeps the project chat\'s members to the coordinator and people', () => {
    const { f, engineer, E } = project(), group = f.group()
    const member = (agentId: string, present: boolean) => ({ type: 'conversation.agent', conversationId: 'lead', agentId, present, lead: false }) as Command
    const chat = () => f.state.conversations.find(c => c.id === 'lead')!.agentIds
    const outside = f.add('outside', 'owner', group)
    expect(() => f.run(member(outside, true), E)).toThrow(coordinatorRequired)
    expect(() => f.run(member(f.worker, false), E)).toThrow(coordinatorRequired)
    expect(chat()).not.toContain(outside)
    // An agent stored there before the project chat held only its coordinator is still the coordinator's or a person's to take out.
    f.run(member(f.worker, false), owner)
    expect(chat()).not.toContain(f.worker)
    // A task's members are any agent's to add.
    f.run({ type: 'conversation.agent', conversationId: group, agentId: engineer, present: true, lead: false }, E)
    expect(f.state.conversations.find(c => c.id === group)!.agentIds).toContain(engineer)
  })

  // Ken, 2026-11-02: a Reviewer was a member of the project chat next to the PM, so Desktop opened two terminals there and the
  // Reviewer posted an announcement in it. The project chat holds only its coordinator among agents, whoever adds one and by
  // whichever path; an announcement goes in its task, for the coordinator or its requester to repost.
  it('refuses any agent but the coordinator in the project chat, by every path', () => {
    const { f, engineer } = project(), group = f.group()
    const reviewer = f.add('reviewer', 'owner', group)
    const chat = () => f.state.conversations.find(c => c.id === 'lead')!
    const refused = expect.objectContaining({ code: 'PROJECT_CHAT_COORDINATOR_ONLY', message: expect.stringContaining('holds only its coordinator') })
    const member = (agentId: string, lead = false) => ({ type: 'conversation.agent', conversationId: 'lead', agentId, present: true, lead }) as Command
    const request = { conversationId: 'lead', machineId: 'machine', engine: 'claude', name: 'Finn 2', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 80, tools: [], devices: [], quotaRequired: false } }
    const before = structuredClone(f.state)
    for (const actor of [f.leadActor, owner]) {
      expect(() => f.run(member(reviewer), actor)).toThrow(refused)
      expect(() => f.run({ type: 'agent.start', request } as Command, actor, { contribution: f.contribution })).toThrow(refused)
    }
    // A person sharing there a session already in the Swarm.
    expect(() => f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'reviewer', name: 'reviewer', configuration: config, lead: false },
      owner, { contribution: f.contribution })).toThrow(refused)
    expect(f.state).toEqual(before)
    // An agent stored there before is named as before (it stays until removed); the coordinator and a new one are still set.
    f.run({ type: 'message.send', conversationId: 'lead', text: 'Your turn.', replyTo: null, recipientIds: [f.worker] }, f.leadActor)
    f.run(member(f.lead), owner)
    expect(chat().agentIds).not.toContain(reviewer)
    // A project chat with no coordinator still takes one.
    const g = fixture(), task = g.group(), pm = g.add('pm', 'owner', task)
    g.run({ type: 'conversation.agent', conversationId: 'lead', agentId: pm, present: true, lead: true })
    expect(g.state.conversations.find(c => c.id === 'lead')).toMatchObject({ leadId: pm, agentIds: [pm] })
    // A new session shared there, as Desktop's New agent in the project chat does, joins the project for its tasks, and the
    // chat says who added it and why it is not a member.
    const shared = f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'shared', name: 'Shared', configuration: config, lead: false },
      owner, { contribution: f.contribution })
    expect(f.state.agents.map(a => a.id)).toContain(shared.result.agentId)
    expect(chat().agentIds).not.toContain(shared.result.agentId)
    expect(shared.messages).toEqual([expect.objectContaining({ conversationId: 'lead', recipients: [], source: { kind: 'system' },
      text: 'owner added "Shared" to the project. The project chat holds only its coordinator among agents, so "Shared" works in its tasks.' })])
    // Swarm v4: a post that names an agent of the project reaches it, in the channel where agents talk.
    const named = f.run({ type: 'message.send', conversationId: 'lead', text: 'Announce the review.', replyTo: null, recipientIds: [reviewer] }, f.leadActor)
    expect(named.messages.map(m => [m.text, m.recipients])).toEqual([['Announce the review.', [reviewer]]])
  })

  // Dee, 2026-11-04 (#2924): the agent doing the work answers people in the project chat itself. It posts there without
  // joining it, so #2207 holds: the chat's members stay the coordinator alone, and no second terminal opens there.
  describe('an agent with work in the project posting in its chat', () => {
    const actorOf = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
    const post = (text: string, replyTo: string | null = null, recipientIds: string[] = []) =>
      ({ type: 'message.send', conversationId: 'lead', text, replyTo, recipientIds }) as Command
    /** routed()'s coordinator, an Engineer assigned a task and a Reviewer holding its step, neither in the project chat. */
    function working() {
      const f = routed(), task = f.group()
      const engineer = f.add('engineer', 'owner', task)
      storedAssignment(f.state, task, engineer, 1000)
      const step = f.run({ type: 'conversation.create', title: 'Review', brief: 'Review it.', reviewOf: task, checks: [] }).result.conversationId as string
      const reviewer = f.add('reviewer', 'owner', step)
      storedAssignment(f.state, step, reviewer, 1000)
      const chat = () => f.state.conversations.find(c => c.id === 'lead')!
      /** A new agent assigned a task of its own in the project, with its assignment in [status]. */
      const assigned = (name: string, status?: 'done' | 'lost' | 'stopped') => {
        const own = f.group(), agentId = f.add(name, 'owner', own)
        storedAssignment(f.state, own, agentId, 1000)
        if (status) storedStatus(f.state, own, status)
        return { agentId, get task() { return f.state.conversations.find(c => c.id === own)! } }
      }
      return { f, task, step, engineer, reviewer, chat, assigned }
    }

    it('posts a top-level line and a thread reply there, joins nothing, and reaches the coordinator only by name (#2963)', () => {
      const { f, engineer, reviewer, chat } = working()
      const members = [...chat().agentIds]
      for (const agentId of [engineer, reviewer]) {
        // A person's ask there from before only agents posted in a project's channel.
        const asked = { id: `asked-${agentId}`, author: { kind: 'person', id: 'owner' } as Author }
        const line = f.run(post('I am on it.'), actorOf(agentId)).messages.at(-1)!
        expect(line).toMatchObject({ conversationId: 'lead', author: { kind: 'agent', id: agentId }, replyTo: null, recipients: [] })
        const reply = f.run(post('Found it: the token expired.', asked.id), actorOf(agentId),
          { reply: { id: asked.id, conversationId: 'lead', author: asked.author, createdAt: 0, thread: asked.id } }).messages.at(-1)!
        expect(reply).toMatchObject({ conversationId: 'lead', replyTo: asked.id, thread: asked.id, recipients: [] })
        expect(f.run(post('Need a ruling.', null, [f.lead]), actorOf(agentId)).messages.at(-1)!.recipients).toEqual([f.lead])
      }
      expect(chat().agentIds).toEqual(members)
      expect(chat().agentIds).not.toContain(engineer)
      expect(chat().agentIds).not.toContain(reviewer)
    })

    it('refuses another project\'s agent and a stopping one there, and adds no agent by hand', () => {
      const { f, task, engineer, chat, assigned } = working()
      // Of this project, with no task or step in it: added to a task it is not assigned.
      const idle = f.add('idle', 'owner', task)
      // Its task ended: cancelled, or lost to another agent.
      const ended = f.add('ended', 'owner', f.group())
      const endedTask = f.state.conversations.find(c => c.agentIds.includes(ended))!.id
      storedAssignment(f.state, endedTask, ended, 1000)
      storedStatus(f.state, endedTask, 'cancelled', 'Not needed.')
      // Of another project, working on a task there.
      const other = f.run({ type: 'project.create', name: 'Other', visibility: 'public', brief: '' }).result
      const otherTask = f.run({ type: 'conversation.create', projectId: other.projectId as string, title: 'Elsewhere', brief: 'Build it.', checks: [] }).result.conversationId as string
      const outsider = f.add('outsider', 'owner', otherTask)
      storedAssignment(f.state, otherTask, outsider, 1000)
      // A stopping agent with its task still open.
      const stopping = f.add('stopping', 'owner', f.group())
      const stoppingTask = f.state.conversations.find(c => c.agentIds.includes(stopping))!.id
      storedAssignment(f.state, stoppingTask, stopping, 1000)
      f.state.agents.find(a => a.id === stopping)!.workDecision = 'stop'
      // A task lost to another agent or stopped, and one archived, whatever its status (security reviews of #2924).
      const lost = assigned('lost', 'lost').agentId, stopped = assigned('stopped', 'stopped').agentId
      const archive = assigned('archived')
      archive.task.archived = true
      const before = structuredClone(f.state)
      // Another project's agent does not read this chat at all.
      // Swarm v4: any other agent of this project posts in its channel, task or not (joinsChannel).
      void [idle, ended, lost, stopped, archive]
      const refusals: Array<[string, string]> = [[outsider, 'NOT_FOUND'], [stopping, 'FORBIDDEN']]
      for (const [agentId, code] of refusals) {
        expect(() => f.run(post('Hello room.'), actorOf(agentId))).toThrow(expect.objectContaining({ code }))
      }
      // Adding one by hand is refused as before (#2207).
      for (const actor of [f.leadActor, owner, actorOf(engineer)]) {
        expect(() => f.run({ type: 'conversation.agent', conversationId: 'lead', agentId: engineer, present: true, lead: false }, actor)).toThrow()
      }
      expect(f.state).toEqual(before)
      expect(chat().agentIds).not.toContain(engineer)
    })

    // Decided, not by accident (security reviews of #2924): a done task's agent posts its result line in main until the task
    // archives with its merged pull request.
    it('lets a done task\'s agent post there, and after its task archives as any agent of the project', () => {
      const { f, chat, assigned } = working()
      const done = assigned('done', 'done')
      f.run(post('Shipped: the login bug is fixed.'), actorOf(done.agentId))
      expect(chat().agentIds).not.toContain(done.agentId)
      // Swarm v4: once archived it is still an agent of the project, and posts in its channel as any of them may.
      done.task.archived = true
      f.run(post('One more thing.'), actorOf(done.agentId))
      expect(chat().agentIds).toContain(done.agentId)
    })

  })

  // Ken, 2026-11-02: nothing recorded who put the Reviewer in the project chat. Each agent added to or removed from a chat
  // leaves a row there naming who did it, shown to the chat's readers and waking nobody.
  it('leaves a row naming who added or removed an agent', () => {
    const { f, engineer, E } = project(), group = f.group()
    const rows = (effects: { messages: Array<{ conversationId: string; text: string; recipients: string[]; source?: Record<string, unknown> }> }) =>
      effects.messages.filter(m => m.source?.kind === 'system' && /^\S+( \S+)? (added|removed|joined|left)\b/.test(m.text) && !m.text.includes('Swarm'))
        .map(m => [m.conversationId, m.text, m.recipients])
    // Quoted, as the rows give agents' names (Luna's review).
    const name = (id: string) => JSON.stringify(f.state.agents.find(a => a.id === id)!.displayName)
    const member = (agentId: string, present: boolean) => ({ type: 'conversation.agent', conversationId: group, agentId, present, lead: false }) as Command
    expect(rows(f.run(member(engineer, true), owner))).toEqual([[group, `owner added ${name(engineer)}.`, []]])
    expect(rows(f.run(member(engineer, false), f.leadActor))).toEqual([[group, `${name(f.lead)} removed ${name(engineer)}.`, []]])
    // A post naming an agent from outside, and an agent's own first post there, each say so too.
    f.run(member(engineer, true), owner)
    expect(rows(f.run({ type: 'message.send', conversationId: group, text: 'Please review.', replyTo: null, recipientIds: [f.worker] }, E)))
      .toEqual([[group, `${name(engineer)} added ${name(f.worker)}.`, []]])
    const outsider = f.add('outsider', 'owner', f.group())
    expect(rows(f.run({ type: 'message.send', conversationId: group, text: 'Here too.', replyTo: null, recipientIds: [] }, { kind: 'agent', agentId: outsider, machineOwnerId: 'host-owner' })))
      .toEqual([[group, `${name(outsider)} joined.`, []]])
    // A start's line names who started it.
    const request = { conversationId: group, machineId: 'machine', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 80, tools: [], devices: [], quotaRequired: false } }
    const startId = f.run({ type: 'agent.start', request } as Command, f.leadActor, { contribution: f.contribution }).result.startId as string
    f.run({ type: 'agent.startDispatch', startId }, f.leadActor, { contribution: f.contribution })
    expect(f.run({ type: 'agent.started', startId, harnessId: 'builder', configuration: { ...config, engine: 'claude' } }, f.leadActor, { contribution: f.contribution })
      .messages.map(m => m.text)).toEqual([`${name(f.lead)} added "Builder". Ready for an assignment.`])
    // Nothing changed, nothing said; an agent removed from the Swarm has its removal row alone.
    expect(rows(f.run(member(engineer, true), owner))).toEqual([])
    expect(rows(f.run({ type: 'agent.remove', agentId: outsider }))).toEqual([])
  })

  // Orion's review of #2207: refusing a post's recipient by name told whoever held another project's agent id its name.
  it('names in a refusal only an agent of the chat\'s own project', () => {
    const { f } = project()
    const other = f.run({ type: 'project.create', name: 'Private', visibility: 'private', brief: '' }).result as { conversationId: string }
    const theirs = f.run({ type: 'agent.add', conversationId: other.conversationId, machineId: 'host', harnessId: 'theirs', name: 'Secret name', configuration: config,
      lead: true }, owner, { contribution: f.contribution }).result.agentId as string
    const sent = () => f.run({ type: 'message.send', conversationId: 'lead', text: 'Hello.', replyTo: null, recipientIds: [theirs] }, f.leadActor)
    expect(sent).toThrow(expect.objectContaining({ code: 'INVALID_RECIPIENT' }))
    expect(sent).not.toThrow('Secret name')
  })

  // Security review L2: the project chat is the people's and is never archived, so its work, name and records are its
  // coordinator's or a person's, as its members are. Any agent defined work there, assigned it, started agents into it,
  // renamed it and recorded merges on it.
  it('keeps the project chat\'s work, name and records to the coordinator and people', () => {
    const { f, E } = project()
    const request = { conversationId: 'lead', machineId: 'machine', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 80, tools: [], devices: [], quotaRequired: false } }
    const commands: Array<[Command, Partial<CommandContext>]> = [
      [{ type: 'agent.start', request } as Command, { contribution: f.contribution }],
      [{ type: 'conversation.rename', conversationId: 'lead', title: 'Renamed by an agent' }, {}],
      [{ type: 'conversation.requester', conversationId: 'lead', personId: 'owner' }, {}],
    ]
    const before = structuredClone(f.state)
    for (const [command, context] of commands) expect(() => f.run(command, E, context), command.type).toThrow(coordinatorRequired)
    expect(f.state).toEqual(before)
    // The coordinator still does each there but a start, which no agent but its coordinator joins (#2207), and a person renames it.
    for (const [command, context] of commands) {
      if (command.type === 'agent.start') expect(() => f.run(command, f.leadActor, context)).toThrow(expect.objectContaining({ code: 'PROJECT_CHAT_COORDINATOR_ONLY' }))
      else f.run(command, f.leadActor, context)
    }
    expect(f.state.conversations.find(c => c.id === 'lead')!).toMatchObject({ title: 'Renamed by an agent' })
    f.run({ type: 'conversation.rename', conversationId: 'lead', title: 'Pilot chat' }, owner)
    expect(f.state.conversations.find(c => c.id === 'lead')!.title).toBe('Pilot chat')
  })

  // Security review L5: a session a person shared by hand is closed by its host when it is stopped, so it stays the
  // coordinator's and people's to release. Any agent of the project releases one the Swarm started.
  it('lets any agent release a session the Swarm started, and only the coordinator and people one a person added', () => {
    const { f, E } = project(), A = f.worker, group = f.group()
    const before = structuredClone(f.state)
    expect(() => f.run({ type: 'agent.release', agentId: A, decision: 'keep' }, E)).toThrow(coordinatorRequired)
    expect(f.state).toEqual(before)
    f.run({ type: 'agent.release', agentId: A, decision: 'keep' }, f.leadActor, { now: 2000 })
    f.run({ type: 'agent.release', agentId: A, decision: 'keep' }, owner, { now: 3000 })
    expect(f.state.agents.find(a => a.id === A)!.keptAt).toBe(3000)
    // One the Swarm started, from an agent's start: any agent of the project releases it.
    const startId = f.run({ type: 'agent.start', request: { conversationId: group, machineId: 'machine', engine: 'claude', name: 'Builder', cwd: '/repo',
      worktree: true, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 80, tools: [], devices: [], quotaRequired: false } } }, f.workerActor,
    { contribution: f.contribution }).result.startId as string
    const started = f.run({ type: 'agent.started', startId, harnessId: 'started', configuration: config,
      startedSession: { sessionId: 'session-1', createdAt: new Date(0).toISOString() } }, f.workerActor, { contribution: f.contribution }).result.agentId as string
    f.run({ type: 'agent.release', agentId: started, decision: 'stop' }, owner)
    expect(f.state.agents.find(a => a.id === started)!.workDecision).toBe('stop')
  })

  // Security review S2: nothing an agent runs sends agent.add (Desktop sends it as its person), and an agent naming a session
  // already in the Swarm skipped conversation.agent's checks, or registered any session of its contributor's machines. An
  // agent starts a new agent instead.
  it('refuses agent.add from every agent, the coordinator included, writing nothing', () => {
    const { f, engineer, E } = project(), group = f.group()
    const add = (conversationId: string, harnessId: string, machineId = 'host', lead = false) =>
      ({ type: 'agent.add', conversationId, machineId, harnessId, name: harnessId, configuration: config, lead }) as Command
    const engineerHarness = f.state.agents.find(a => a.id === engineer)!.harnessId
    const before = structuredClone(f.state)
    for (const [command, actor] of [[add(group, 'personal'), E], [add('lead', 'personal'), E], [add(group, engineerHarness), E],
      [add(group, 'unlisted', 'not-in-the-swarm'), E], [add(group, 'personal'), f.leadActor], [add('lead', 'personal', 'host', true), f.leadActor]] as Array<[Command, Actor]>) {
      expect(() => f.run(command, actor, { contribution: f.contribution })).toThrow(expect.objectContaining({ code: 'HUMAN_REQUIRED' }))
    }
    expect(f.state).toEqual(before)
  })

  it('refuses agents of another project, writing nothing', () => {
    const { f } = project(), group = f.group()
    f.invite()
    // Private, so the peer, who reads this project, does not read that one.
    const other = f.run({ type: 'project.create', name: 'Other', visibility: 'private', brief: '' }).result
    const outsider: Actor = { kind: 'agent', agentId: f.add('outsider', 'owner', other.conversationId as string), machineOwnerId: 'host-owner' }
    storedAssignment(f.state, group, f.worker, 1000)
    const request = { conversationId: group, machineId: 'machine', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }
    const commands: Array<[Command, Partial<CommandContext>]> = [
      [{ type: 'agent.start', request } as Command, { contribution: f.contribution }],
      [{ type: 'agent.input', agentId: f.worker, keys: ['Enter'] }, {}],
      [{ type: 'conversation.create', projectId: 'lead', title: 'Mine', brief: 'Do it.', checks: [{ description: 'Done.', independent: false }] }, {}],
    ]
    const before = JSON.stringify(f.state)
    for (const [command, context] of commands) {
      // The outsider reads none of this project, and its own project's chat is not the peer's to read.
      expect(() => f.run(command, outsider, context), command.type).toThrow(expect.objectContaining({
        code: command.type === 'agent.input' ? 'AGENT_UNAVAILABLE' : 'NOT_FOUND' }))
    }
    expect(JSON.stringify(f.state)).toBe(before)
  })


  // A person keeps today's rule (decision 4); an agent's start, its maker and the project's coordinator (decision 6).
  it('lets a person carry on only a start they made, and an agent its own start or, as the coordinator, any agent\'s of the project', () => {
    const { f, engineer, E } = project(), group = f.group()
    f.invite()
    // In a task: the project chat's starts are its coordinator's or a person's (security review L2).
    const request = { conversationId: group, machineId: 'machine', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }
    const start = (actor: Actor) => f.run({ type: 'agent.start', request } as Command, actor, { contribution: f.contribution }).result.startId as string
    const failed = (startId: string) => f.state.starts!.find(s => s.id === startId)!.error
    const fail = (startId: string, actor: Actor) => f.run({ type: 'agent.startFailed', startId, error: 'Could not prepare the worktree' }, actor)
    const owners = start(owner)
    expect(() => fail(owners, peer)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => fail(owners, f.leadActor)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(failed(owners)).toBeNull()
    fail(owners, owner)
    expect(failed(owners)).toBe('Could not prepare the worktree')
    const engineers = start(E), again = start(E)
    expect(() => fail(engineers, f.workerActor)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => fail(engineers, peer)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(failed(engineers)).toBeNull()
    fail(engineers, E)
    fail(again, f.leadActor)
    expect([failed(engineers), failed(again)]).toEqual(['Could not prepare the worktree', 'Could not prepare the worktree'])
    expect(f.state.starts!.find(s => s.id === engineers)!.actorKey).toBe(`agent:${engineer}`)
  })
})

// An older client's role kind (builder or reviewer) is stored for older readers and decides nothing; its custom role or
// kind becomes the agent's role name (project instructions, phase 4, decision 2).
describe('role kinds decide nothing', () => {
  const contribution = { machineOwnerId: 'owner', contributorId: 'owner' }
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const request = (group: string, extra: Record<string, unknown> = {}) => ({ conversationId: group, machineId: 'host', engine: 'claude', name: 'Reviewer',
    cwd: '/repo', worktree: true, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }, ...extra })
  /** An agent a person starts into [group], as an older client does with its kind (`role`) or custom role (`roleId`). */
  function started(f: ReturnType<typeof fixture>, group: string, extra: Record<string, unknown> = { role: 'reviewer' }, harnessId = 'native-reviewer') {
    const startId = f.run({ type: 'agent.start', request: request(group, extra) } as Command, owner, { contribution }).result.startId as string
    return f.run({ type: 'agent.started', startId, harnessId, configuration: config }, owner, { contribution }).result.agentId as string
  }
  /** A project with its coordinator, a task, an agent started in it as a Reviewer and a Builder added to it. */
  function project() {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
    return { f, lead, coordinator: as(lead), group, reviewer: started(f, group), builder: f.add('builder', 'owner', group) }
  }
  const review = (f: ReturnType<typeof fixture>, reviewOf: string, actor: Actor = owner) => f.run({ type: 'conversation.create', title: 'Review',
    brief: 'Review it.', reviewOf, checks: [{ description: 'Verdict', independent: false }] }, actor).result.conversationId as string

  it('lets an agent of any kind lead or be named into a linked task', () => {
    const { f, coordinator, group, reviewer, builder } = project()
    const other = f.group()
    f.run({ type: 'conversation.agent', conversationId: other, agentId: reviewer, present: true, lead: true }, coordinator)
    expect(f.state.conversations.find(c => c.id === other)!.leadId).toBe(reviewer)
    // A person adding its session again as a group's lead is accepted too.
    f.run({ type: 'agent.add', conversationId: f.group(), machineId: 'host', harnessId: 'native-reviewer', name: 'Reviewer', configuration: config, lead: true },
      owner, { contribution })
    const linked = review(f, group, coordinator)
    expect(f.state.conversations.find(c => c.id === linked)!.agentIds).not.toContain(reviewer)
    const sent = f.run({ type: 'message.send', conversationId: linked, text: 'PR #12 is ready.', replyTo: null, recipientIds: [reviewer] }, as(builder))
    expect(sent.messages[0]!.recipients).toEqual([reviewer])
    expect(f.state.conversations.find(c => c.id === linked)!.agentIds).toContain(reviewer)
  })

  it('holds nothing for an undecided worker', () => {
    const f = routed(), group = f.group()
    // Its work stopped, as an older Swarm left it: awaiting a decision.
    storedAssignment(f.state, group, f.worker, 1000)
    storedStatus(f.state, group, 'stopped')
    f.state.agents.find(a => a.id === f.worker)!.workDecision = 'awaiting'
    const startRequest = { conversationId: group, machineId: 'machine', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: false,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const startId = f.run({ type: 'agent.start', request: startRequest }, f.leadActor, { contribution: f.contribution }).result.startId as string
    f.run({ type: 'agent.startDispatch', startId }, f.leadActor, { contribution: f.contribution })
    expect(f.state.starts!.find(s => s.id === startId)!.dispatched).toBe(true)
    // Still awaiting: shown, and read by no command.
    expect(f.state.agents.find(a => a.id === f.worker)!.workDecision).toBe('awaiting')
  })

  it('keeps or stops any agent on request', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group(), worker = f.add('worker', 'owner', group)
    f.run({ type: 'agent.release', agentId: worker, decision: 'keep' }, as(lead), { now: 5000 })
    expect(f.state.agents.find(a => a.id === worker)).toMatchObject({ workDecision: 'keep', keptAt: 5000 })
    f.run({ type: 'agent.release', agentId: worker, decision: 'stop' }, owner)
    expect(f.state.agents.find(a => a.id === worker)).toMatchObject({ workDecision: 'stop', releaseId: expect.any(String) })
  })

  it('adds any agent with its team access checked', () => {
    const f = fixture()
    f.invite()
    const lead = f.add('lead', 'owner', 'lead', true), group = f.group(), other = f.group()
    // The teammate's own Mac takes another person's work in their own account; another person's computer takes none (task #4120).
    ownMachine(f, 'peer')
    const mate = f.add('mate', 'peer', group), own = f.add('own', 'peer', group)
    placeOn(f, mate, 'owner', 'owner-studio')
    expect(() => f.run({ type: 'conversation.agent', conversationId: other, agentId: mate, present: true, lead: false }, as(lead)))
      .toThrow(expect.objectContaining({ code: 'NOT_YOUR_COMPUTER' }))
    expect(f.state.conversations.find(c => c.id === other)!.agentIds).not.toContain(mate)
    f.run({ type: 'conversation.agent', conversationId: other, agentId: own, present: true, lead: false }, as(lead))
    expect(f.state.conversations.find(c => c.id === other)!.agentIds).toContain(own)
    // The project owner's own agent on their own computer: added, and its finished-work decision cleared as an assignment clears it.
    const mine = f.add('mine', 'owner', group)
    placeOn(f, mine, 'owner', 'owner-mac')
    f.state.agents.find(a => a.id === mine)!.workDecision = 'awaiting'
    f.run({ type: 'conversation.agent', conversationId: other, agentId: mine, present: true, lead: false }, as(lead))
    expect(f.state.agents.find(a => a.id === mine)).not.toHaveProperty('workDecision')
    f.state.agents.find(a => a.id === mine)!.workDecision = 'stop'
    expect(() => f.run({ type: 'conversation.agent', conversationId: f.group(), agentId: mine, present: true, lead: false }, as(lead)))
      .toThrow(expect.objectContaining({ code: 'STOP_REQUESTED' }))
  })
})

// The team-access check applies to every agent added to a task (spec, "Kept as access"): one named into it, one that posts
// into it and one that opens it join it, as conversation.agent adds one (final review of the branch).
describe('an agent joining a task by a post or by opening it', () => {
  /** A teammate's agent (mate) on another person's computer, which Swarm v3 gives none of its work (task #4120), and the project
   *  owner's own agent (mine) on the owner's own computer. */
  function teammate() {
    const f = fixture()
    f.invite()
    const lead = f.add('lead', 'owner', 'lead', true), group = f.group(), other = f.group()
    ownMachine(f, 'peer')
    const mate = f.add('mate', 'peer', group), mine = f.add('mine', 'owner', group)
    placeOn(f, mate, 'owner', 'owner-studio')
    placeOn(f, mine, 'owner', 'owner-mac')
    return { f, lead, group, other, mate, mine }
  }
  const refused = expect.objectContaining({ code: 'NOT_YOUR_COMPUTER' })
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const post = (conversationId: string, recipientIds: string[] = []) =>
    ({ type: 'message.send', conversationId, text: 'Look at this.', replyTo: null, recipientIds }) as Command

  it('checks the team access of an agent another agent names into a task, writing nothing', () => {
    const { f, other, mate, mine } = teammate()
    const before = structuredClone(f.state)
    expect(() => f.run(post(other, [mate]), as(mine))).toThrow(refused)
    expect(f.state).toEqual(before)
    // The project owner's own agent joins.
    f.run(post(other, [mine]), as(mine))
    expect(f.state.conversations.find(c => c.id === other)!.agentIds).toContain(mine)
  })

  it('checks the team access of an agent that posts into a task it is not in', () => {
    const { f, other, mate } = teammate()
    expect(() => f.run(post(other), as(mate))).toThrow(refused)
    expect(f.state.conversations.find(c => c.id === other)!.agentIds).not.toContain(mate)
  })

  // Security review S2: agent.add naming a session already in the Swarm added it with none of conversation.agent's checks.
  it('checks a person\'s add of a session already in the Swarm as conversation.agent does', () => {
    const { f, other, mate, mine } = teammate()
    const again = (harnessId: string, actor: Extract<Actor, { kind: 'person' }>) => f.run({ type: 'agent.add', conversationId: other,
      machineId: f.state.agents.find(a => a.harnessId === harnessId)!.machineId, harnessId, name: harnessId, configuration: config, lead: false }, actor,
      { contribution: { machineOwnerId: 'host-owner', contributorId: actor.userId } })
    const members = (id: string) => f.state.conversations.find(c => c.id === id)!.agentIds
    expect(() => again('mate', peer)).toThrow(refused)
    f.state.agents.find(a => a.id === mine)!.workDecision = 'stop'
    expect(() => again('mine', owner)).toThrow(expect.objectContaining({ code: 'STOP_REQUESTED' }))
    delete f.state.agents.find(a => a.id === mine)!.workDecision
    expect(members(other)).not.toContain(mate)
    expect(members(other)).not.toContain(mine)
    again('mine', owner)
    expect(members(other)).toContain(mine)
  })

  it('checks the team access of an agent that opens a task, which it would be in', () => {
    const { f, mate, mine } = teammate()
    const create = { type: 'conversation.create', title: 'Fix it', brief: 'Fix it.', checks: [{ description: 'Done', independent: false }], priority: 'P2', requesterId: 'owner' } as Command
    const groups = f.state.conversations.length
    expect(() => f.run(create, as(mate))).toThrow(refused)
    expect(f.state.conversations).toHaveLength(groups)
    expect(f.run(create, as(mine)).result.conversationId).toEqual(expect.any(String))
  })
})

describe('Reviewer role', () => {
  const contribution = { machineOwnerId: 'owner', contributorId: 'owner' }
  const request = (group: string, extra: Record<string, unknown> = {}) => ({ conversationId: group, machineId: 'host', engine: 'claude', name: 'Reviewer',
    cwd: '/repo', worktree: true, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }, ...extra })
  function reviewed() {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
    const leadActor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' } as const
    f.run({ type: 'conversation.agent', conversationId: group, agentId: lead, present: true, lead: true })
    const start = { type: 'agent.start', request: request(group, { role: 'reviewer' }) } as Command
    const startId = f.run(start, leadActor, { contribution }).result.startId as string
    f.run({ type: 'agent.startDispatch', startId }, leadActor, { contribution })
    const reviewer = f.run({ type: 'agent.started', startId, harnessId: 'native-reviewer', configuration: { ...config, engine: 'claude', model: 'claude-opus-4-7' } }, leadActor, { contribution }).result.agentId as string
    const builder = f.add('builder', 'owner', group)
    return { f, lead, leadActor, group, reviewer, builder }
  }

  it('lets the Builder join its own review group: joining is not reviewing (review of #2313)', () => {
    const { f, leadActor, group, builder } = reviewed()
    storedAssignment(f.state, group, builder, 1000)
    const review = f.run({ type: 'conversation.create', title: 'Review', brief: 'Review it.', reviewOf: group, checks: [{ description: 'Verdict', independent: false }] },
      leadActor).result.conversationId as string
    const added = f.run({ type: 'conversation.agent', conversationId: review, agentId: builder, present: true, lead: false }, leadActor)
    expect(added.result.warnings).toBeUndefined()
    expect(f.state.conversations.find(c => c.id === review)!.agentIds).toContain(builder)
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

  describe('work waiting for its review (liveness.ts: its quiet time does not count)', () => {
    const HOUR = 3_600_000

    it('keeps work in review', () => {
      const { f, group, builder } = reviewed()
      storedAssignment(f.state, group, builder, 2000)
      storedStatus(f.state, group, 'review', 'Ready for review: PR #42 at abc1234')
      // The task's status after the time checks ran, on a copy.
      const copy = structuredClone(f.state)
      loseTasks(copy, 2000 + 2 * HOUR)
      expect(copy.conversations.find(c => c.id === group)!.assignment!.status).toBe('review')
    })
  })

  it('lets the Lead keep or stop a Reviewer that only sits in a group with active work: only its own active work refuses', () => {
    const { f, leadActor, group, reviewer, builder } = reviewed()
    storedAssignment(f.state, group, builder, 1000)
    f.run({ type: 'agent.release', agentId: reviewer, decision: 'keep' }, leadActor)
    expect(f.state.agents.find(a => a.id === reviewer)).toHaveProperty('workDecision', 'keep')
    f.run({ type: 'agent.release', agentId: reviewer, decision: 'stop' }, owner)
    expect(f.state.agents.find(a => a.id === reviewer)).toHaveProperty('workDecision', 'stop')
    expect(() => f.run({ type: 'agent.release', agentId: builder, decision: 'stop' }, owner)).toThrow('active work')
  })

  it('loses a Reviewer\'s review when its model keeps failing, and keeps the Reviewer out of the decision queue', () => {
    const { f, leadActor, group, reviewer } = reviewed()
    const review = f.run({ type: 'conversation.create', title: 'Review', brief: 'Review it.', reviewOf: group, checks: [{ description: 'Verdict', independent: false }] },
      leadActor).result.conversationId as string
    storedAssignment(f.state, review, reviewer, 1000)
    f.run({ type: 'agent.alert', agentId: reviewer, alert: 'model', active: true }, { kind: 'agent', agentId: reviewer, machineOwnerId: 'owner' })
    expect(f.state.conversations.find(c => c.id === review)!.assignment).toMatchObject({ status: 'lost', lost: { reason: 'its model keeps failing' } })
    expect(f.state.agents.find(a => a.id === reviewer)!.lostTask).toMatchObject({ conversationId: review })
  })

  it('lets the Lead keep or stop a Reviewer or a Builder that never had work', () => {
    const { f, leadActor, reviewer, builder } = reviewed()
    for (const id of [reviewer, builder]) {
      f.run({ type: 'agent.release', agentId: id, decision: 'keep' }, leadActor)
      expect(f.state.agents.find(a => a.id === id)).toHaveProperty('workDecision', 'keep')
      f.run({ type: 'agent.release', agentId: id, decision: 'stop' }, owner)
      expect(f.state.agents.find(a => a.id === id)).toHaveProperty('workDecision', 'stop')
    }
  })
})

describe('a task that requires a machine or a device', () => {
  // 2026-10-27: a task to check a device plugged into one person's Mac was routed to another machine by policy order.
  const task = { goal: 'Check the round device', changes: 'None', constraints: 'On the Mac it is plugged into', owns: ['devices'] }
  const checks = [{ description: 'It answers.', independent: false }]
  /** A new task requiring [requires], by [actor]: its id. */
  const requiring = (f: ReturnType<typeof routed>, requires: Record<string, unknown>, actor: Actor = owner) =>
    f.run({ type: 'conversation.create', title: 'Device check', task: { ...task, requires }, checks } as Command, actor).result.conversationId as string
  const startOn = (f: ReturnType<typeof routed>, conversationId: string, machineId: string, actor: Actor, devices: string[] = []) => f.run({ type: 'agent.start', request: { conversationId, machineId,
    engine: 'claude', model: 'opus', effort: 'high', name: 'Builder', cwd: '/repo', worktree: true,
    requirements: { memoryBytes: 1, diskBytes: 1, maxCpuPercent: 80, tools: [], devices, quotaRequired: false } } } as Command, actor, { contribution: f.contribution })

  it('keeps the requirement on the task, without naming the machine in the brief', () => {
    const f = routed()
    const id = requiring(f, { machines: ['machine'], devices: ['/dev/cu.usbmodem1'] })
    const at = f.state.conversations.find(c => c.id === id)!
    expect(at.task!.requires).toEqual({ machines: ['machine'], devices: ['/dev/cu.usbmodem1'] })
    expect(at.brief).not.toContain('machine')
  })
  it('takes only machines of the Swarm the setter can see, and at least one machine or device', () => {
    const f = routed()
    expect(() => requiring(f, { machines: ['nowhere'] })).toThrow('Name a machine of this Swarm')
    expect(() => requiring(f, {})).toThrow()
    expect(() => requiring(f, { machines: [] })).toThrow()
    expect(() => requiring(f, { devices: ['dev/relative'] })).toThrow()
  })
  // A requirement is information (project instructions, phase 4): nothing refuses a start elsewhere ('what a start may run >
  // ignores a task's machine and device requirement').
  it('refuses no agent\'s start on another machine or without the device, and warns no person', () => {
    const f = routed()
    const group = requiring(f, { machines: ['machine'], devices: ['/dev/cu.usbmodem1'] })
    for (const actor of [f.leadActor, owner]) {
      const started = startOn(f, group, 'host', actor)
      expect(started.result.warnings).toBeUndefined()
      expect(started.messages.map(m => m.text)).not.toContain(expect.stringContaining('anyway'))
    }
  })
  it('shows a reader who cannot see the machine only that the task waits for one', () => {
    const f = routed()
    const id = requiring(f, { machines: ['machine', 'host'] })
    const requires = () => visibleState(f.state, owner).conversations.find(c => c.id === id)!.task!.requires
    expect(requires()).toEqual({ machines: ['machine', 'host'] })
    // No machine record and no agent the reader sees runs there any more.
    f.state.agents = f.state.agents.filter(a => a.machineId !== 'machine')
    expect(requires()).toEqual({ machines: ['host'], unseenMachines: 1 })
  })
})

describe('a Swarm of projects', () => {
  function projects() {
    const f = fixture(); f.invite()
    const app = f.run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }).result.conversationId as string
    const site = f.run({ type: 'project.create', name: 'Site', visibility: 'public', brief: '' }).result.conversationId as string
    f.run({ type: 'project.delete', projectId: 'lead' })
    const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
    return { ...f, get state() { return f.state }, app, site, lead: agentActor(f.add('app-lead', 'owner', app, true)),
      worker: agentActor(f.add('app-worker', 'owner', app)), siteLead: agentActor(f.add('site-lead', 'owner', site, true)) }
  }

  it('tells each project\'s Lead chat which of its starts were abandoned when the machine joins', () => {
    const f = projects()
    const start = (id: string, conversationId: string, name: string) => ({ id, request: { conversationId, machineId: 'mac', name }, error: null })
    f.state.starts = [start('s1', f.app, 'Builder'), start('s2', f.site, 'Writer'), start('s3', f.app, 'Reviewer')] as never
    const joined = f.run({ type: 'machine.contribute', machineId: 'mac', name: 'Mac', cwd: '/swarm', engines: ['codex'], maxAgents: 2 },
      owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' }, abandonedStartIds: ['s1', 's2', 's3'] })
    expect(joined.messages.map(m => [m.conversationId, m.text])).toEqual([
      [f.app, 'Builder, Reviewer never started and will not start now.'],
      [f.site, 'Writer never started and will not start now.']])
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
  storedAssignment(f.state, group, worker, 1000)
  storedStatus(f.state, group, 'blocked', 'Waiting.')
  run({ type: 'delivery.resolve', deliveryId: 'd1', resolution: 'received' },
    { delivery: { id: 'd1', conversationId: group, agentId: worker, messageId: 'm1', text: 'Earlier.' } })
  run({ type: 'delivery.resolve', deliveryId: 'd2', resolution: 'resend' },
    { delivery: { id: 'd2', conversationId: group, agentId: worker, messageId: 'm2', text: 'Earlier.' } })
  storedStatus(f.state, group, 'cancelled', 'Obsolete.')
  run({ type: 'agent.remove', agentId: worker })
  const start = (id: string) => ({ id, actorKey: 'person:owner', contributorId: 'owner', membershipGeneration: f.state.people[0]!.generation,
    request: { conversationId: 'lead', machineId: 'mac', name: 'Builder' }, error: null })
  f.state.starts = [start('s1'), start('s2')] as never
  run({ type: 'agent.startFailed', startId: 's1', error: 'Launch refused.' })
  run({ type: 'machine.contribute', machineId: 'mac', name: 'Mac', cwd: '/swarm', engines: ['codex'], maxAgents: 2 },
    { contribution: { machineOwnerId: 'owner', contributorId: 'owner' }, abandonedStartIds: ['s2'] })
  expect(rows.map(r => r.text)).toEqual(expect.arrayContaining(['Builder never started and will not start now.',
    'Could not start Builder: its machine could not prepare or launch it. Whoever started it, the Product Manager and the machine owner can read why.', 'owner removed "worker" from the Swarm.']))
  expect(rows.filter(r => !r.source).map(r => r.text)).toEqual([])
})

// The round-device group, 2026-10-27: the host failed a queued start, the notice went to nobody, and the group sat without a
// worker for an hour. The Lead is woken to start it elsewhere once or report it (cli superTabs/start.ts).
it('delivers a failed start\'s notice to the Lead of its group, and to the coordinator in its own chat when the group has no Lead in it', () => {
  const f = fixture(); f.invite()
  const lead = f.add('lead', 'owner', 'lead', true)
  const group = f.run({ type: 'conversation.create', title: 'Drafts', brief: 'Save drafts.', checks: [{ description: 'Saved.', independent: false }] }, owner)
    .result.conversationId as string
  const start = (id: string, conversationId: string) => ({ id, actorKey: 'person:owner', contributorId: 'owner', membershipGeneration: f.state.people[0]!.generation,
    request: { conversationId, machineId: 'mac', name: 'Builder' }, error: null })
  f.state.starts = [start('s1', 'lead'), start('s2', group)] as never
  expect(f.run({ type: 'agent.startFailed', startId: 's1', error: 'Launch refused.' }, owner).messages)
    .toMatchObject([{ conversationId: 'lead', text: 'Could not start Builder: its machine could not prepare or launch it. Whoever started it, the Product Manager and the machine owner can read why.', recipients: [lead] }])
  // A Lead that left the group's members is not told there, as a removed machine's notice is not (removeMachine); as the
  // project's coordinator it hears it in its own chat, so a failed start is never told to nobody (final review).
  Object.assign(f.state.conversations.find(c => c.id === group)!, { leadId: lead, agentIds: [] })
  const rows = f.run({ type: 'agent.startFailed', startId: 's2', error: 'Launch refused.' }, owner).messages
  expect(rows).toMatchObject([{ conversationId: group, recipients: [] }, { conversationId: 'lead', recipients: [lead], source: { recipientsOnly: true } }])
  expect(rows[1]!.text).toBe(rows[0]!.text)
  expect(new Set(rows.map(r => r.id)).size).toBe(2)
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
    expect(notice!.text).toBe('Could not start Builder: its machine could not prepare or launch it. Whoever started it, the Product Manager and the machine owner can read why.')
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
        .toBe('Could not start Builder: its machine could not prepare or launch it. Whoever started it, the Product Manager and the machine owner can read why.')
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

  // Task #3212: Desktop's join add leaves out a computer its person took out of the Swarm, reading this record; Add machine
  // brings it back. The record is per Swarm, person and computer, and only that person reads it.
  it('remembers a machine its person took out, only for them, until they add it again', () => {
    const f = fixture()
    f.invite()
    contribute(f, 'peer', 'peer-mac', null)
    f.run({ type: 'machine.remove', machineId: 'peer-mac' }, peer)
    expect(f.state.removedMachines).toEqual([{ machineId: 'peer-mac', contributorId: 'peer' }])
    expect(visibleState(f.state, peer).removedMachines).toEqual(['peer-mac'])
    expect(visibleState(f.state, owner).removedMachines).toBeUndefined()

    for (const cleanup of f.state.machineCleanups ?? []) cleanup.requestedAt = new Date(-60 * 60_000).toISOString()
    f.run({ type: 'machine.contribute', machineId: 'peer-mac', name: 'Peer Mac', cwd: '/repo', scope: 'swarm', engines: ['claude'], maxAgents: 2,
      teamAccountOnly: true }, peer, { contribution: { machineOwnerId: 'peer', contributorId: 'peer', hostGrant: null } })
    expect(f.state.machines!.some(m => m.machineId === 'peer-mac' && !m.removal)).toBe(true)
    expect(f.state.removedMachines).toBeUndefined()
    expect(visibleState(f.state, peer).removedMachines).toBeUndefined()
  })

  // The phone and the web offer Pause/Resume only to the person who lent the machine; the server holds the same line.
  it('lets only the contributor pause or resume a machine', () => {
    const f = fixture()
    f.invite()
    contribute(f, 'owner')
    expect(() => f.run({ type: 'machine.pause', machineId: 'host', paused: true }, peer)).toThrow(expect.objectContaining({ code: 'OWNER_REQUIRED', status: 403 }))
    expect(f.state.machines![0]!.paused).toBe(false)
    f.run({ type: 'machine.pause', machineId: 'host', paused: true })
    expect(f.state.machines![0]!.paused).toBe(true)
    expect(() => f.run({ type: 'machine.pause', machineId: 'host', paused: false }, peer)).toThrow(expect.objectContaining({ code: 'OWNER_REQUIRED' }))
    expect(f.state.machines![0]!.paused).toBe(true)
  })

  it('takes the machine out with the Swarm\'s agents on it, and tells each group whose task needs a new worker', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group(), worker = f.add('worker', 'owner', group)
    f.state.agents.find(a => a.id === lead)!.machineId = 'elsewhere'
    contribute(f)
    storedAssignment(f.state, group, worker, 1000)
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
    // Its name quoted, as in every row naming an agent (Luna's re-review of #2207).
    expect(notice.text).toBe(`owner removed Studio from the Swarm, and "${workerName}" with it. Its task "Offline editing" has no agent now.`)
    expect(notice.recipients).toEqual([lead])
    // Its own row names the agent it took, so no member row repeats it (Echo's review of #2207).
    expect(effects.messages.map(m => m.conversationId)).toEqual([group])
    expect(new Set(effects.messages.map(m => m.id)).size).toBe(effects.messages.length)
  })

  it('does not return IDs for agents the machine owner cannot read', () => {
    const s = richSwarm(NOW)
    s.contribute('host')
    const hiddenTask = s.group('Secret task', s.secret)
    const hidden = s.add('hidden-harness', hiddenTask)
    s.edit(state => {
      state.agents.find(agent => agent.id === s.lead)!.machineId = 'elsewhere'
      const machine = state.machines!.find(item => item.machineId === 'host')!
      machine.contributorId = richPeer.userId
      machine.membershipGeneration = state.people.find(person => person.id === richPeer.userId)!.generation
    })

    const result = s.run({ type: 'machine.remove', machineId: 'host' }, richPeer)

    expect(result.removedAgents).not.toContain(hidden)
    expect(JSON.stringify(result)).not.toContain(hidden)
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
  // anh Dee, 11-04 (#2742): the Machines list shows which machines are in the Swarm; no chat says one left.
  it('drops the machine\'s records after 30 minutes without an acknowledgement, says nothing in any chat, and keeps the cleanup for its host', () => {
    const { f, removalId } = cleaning()
    const day = 30 * 60_000
    // Its host keeps reporting, so only the fallback can expire it.
    f.state.machines![0]!.observation!.receivedAt = 1000 + day - 1
    expect(f.run({ type: 'tab.rename', name: 'Still cleaning' }, owner, { now: 1000 + day - 1 }).messages).toEqual([])
    expect(f.state.machines!.map(m => m.removal?.id)).toEqual([removalId])
    expect(visibleState(f.state, owner, 1000 + day).machines).toEqual([])
    expect(f.run({ type: 'tab.rename', name: 'Half an hour later' }, owner, { now: 1000 + day }).messages).toEqual([])
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

  // Review of #1986 (Minor 2, intended): the add a host makes by itself, the owner's machine running its Lead, takes an overdue
  // cleanup's place like the owner's own add; a fresh one still holds it off without an error.
  it('lets the automatic add take an overdue cleanup\'s place, and leaves a fresh one waiting', () => {
    const f = fixture()
    const fresh = new Date(1000 + 30 * 60_000 - 1).toISOString()
    f.state.machineCleanups = [{ machineId: 'host', removalId: 'old', machineOwnerId: 'owner', requestedAt: fresh }]
    const add = (machineId: string) => ({ type: 'machine.contribute', machineId, name: 'Studio', cwd: '/repo', scope: 'swarm', engines: ['claude'], maxAgents: 2,
      ifMissing: true }) as Command
    const owners = (now: number) => ({ contribution: { machineOwnerId: 'owner', contributorId: 'owner' }, now })
    // Fresh: the owner's host skips its automatic add and nothing changes.
    f.run(add('host'), owner, owners(1000 + 30 * 60_000 - 1))
    expect([f.state.machines ?? [], f.state.machineCleanups!.map(c => c.machineId)]).toEqual([[], ['host']])
    // Overdue: the owner's host adds its machine.
    f.run(add('host'), owner, owners(1000 + 60 * 60_000))
    expect(f.state.machines!.map(m => [m.machineId, m.removal])).toEqual([['host', undefined]])
    expect(f.state.machineCleanups).toBeUndefined()
  })

  it('says nothing in any project\'s chat once its host confirmed the cleanup', () => {
    const { f, removalId } = cleaning()
    f.run({ type: 'project.create', name: 'Docs', visibility: 'public', brief: '' })
    expect(f.run(cleaned(removalId)).messages).toEqual([])
    expect(f.state.machines).toEqual([])
  })

  it.each([['has no reading', null], ['was last read long ago', 1000 - 45_001]] as const)(
    'drops a machine that is offline (%s) at once, and keeps its cleanup for its host', (_why, receivedAt) => {
      const f = fixture()
      contribute(f, 'owner', 'host', receivedAt)
      // Listed, if offline, until its owner removes it.
      expect(visibleState(f.state, owner).machines).toHaveLength(1)
      const effects = f.run({ type: 'machine.remove', machineId: 'host' })
      const removalId = effects.result.removalId as string
      expect(effects.messages.filter(m => m.source?.kind === 'machine-left')).toEqual([])
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
    // The next change applies the same rule, says nothing, and keeps the cleanup for its host.
    expect(f.run({ type: 'tab.rename', name: 'Still cleaning' }, owner, { now: later }).messages).toEqual([])
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

  it.each(['leaves', 'is removed'] as const)('puts the machines of a person who %s through the same removal', how => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
    f.state.agents.find(a => a.id === lead)!.machineId = 'elsewhere'
    f.invite()
    contribute(f, 'peer')
    ownMachine(f, 'peer')
    const worker = f.add('worker', 'peer', group), owners = f.add('owners', 'owner')
    storedAssignment(f.state, group, worker, 1000)
    const effects = f.run({ type: 'member.remove', userId: 'peer' }, how === 'leaves' ? peer : owner)
    const pool = f.state.machines!.find(m => m.machineId === 'host')!
    expect([pool.removal?.state, pool.paused]).toEqual(['cleaning', true])
    expect(f.state.agents.map(a => a.id)).toEqual([lead])
    expect(f.state.agents.some(a => a.id === owners)).toBe(false)
    expect(f.state.conversations.find(c => c.id === group)!.assignment!.status).toBe('reconciling')
    expect(effects.messages.map(m => [m.conversationId, m.text])).toEqual(expect.arrayContaining([
      [group, expect.stringContaining('Its task "Offline editing" has no agent now.')]]))
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
    storedAssignment(f.state, group, worker, 1000)
    f.state.project = { machineId: 'host', cwd: '/repo', repositoryUrl: null }
    f.state.projects![0]!.repository = { machineId: 'host', cwd: '/repo', repositoryUrl: null }
    const docs = f.run({ type: 'project.create', name: 'Docs', visibility: 'public', brief: '' }).result.projectId as string
    f.state.projects!.find(p => p.id === docs)!.repository = { machineId: 'host', cwd: '/docs', repositoryUrl: 'https://github.com/example/docs' }
    const named = (id: string) => { const a = f.state.agents.find(x => x.id === id)!; return a.displayName ?? a.name }
    expect(removalPreview(f.state, owner, 'host')).toEqual({ blockedBy: { projectId: 'lead', projectName: 'Pilot' },
      agents: [{ id: lead, name: named(lead), projectName: 'Pilot' }, { id: worker, name: named(worker), projectName: 'Pilot', task: 'Offline editing' }],
      hiddenAgentCount: 0, soleSourceProjects: [{ id: 'lead', name: 'Pilot' }], hiddenSoleSourceProjectCount: 0 })
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

describe('Product Managers chat, removed (Dee, 2026-10-31)', () => {
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const send = (conversationId: string, text: string, recipientIds: string[] = []): Command =>
    ({ type: 'message.send', conversationId, text, replyTo: null, recipientIds })
  /** A Swarm from before the removal: the Leads conversation and its history are still stored. */
  const swarm = () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), worker = f.add('worker')
    const docs = f.run({ type: 'project.create', name: 'Docs', visibility: 'public', brief: 'Docs' }).result as { projectId: string; conversationId: string }
    const docsLead = f.add('docs-lead', 'owner', docs.conversationId, true)
    const leads = 'stored-leads'
    f.state.leadsConversationId = leads
    f.state.conversations.push({ id: leads, kind: 'leads', title: 'Leads', leadId: null, agentIds: [lead, docsLead], archived: false,
      brief: '', checks: [], assignment: null, lastMessageSequence: 7 })
    return { f, lead, worker, docs, docsLead, leads }
  }
  const REMOVED = expect.objectContaining({ code: 'LEADS_CONVERSATION_REMOVED',
    message: 'The Product Managers chat was removed. Post in your project\'s chat instead.' })

  it('is not made for a new Swarm', () => {
    const f = fixture()
    expect(f.state.conversations.filter(c => c.kind === 'leads')).toEqual([])
    expect(f.state).not.toHaveProperty('leadsConversationId')
    f.run({ type: 'tab.rename', name: 'Renamed' })
    expect(f.state.conversations.filter(c => c.kind === 'leads')).toEqual([])
    expect(f.state).not.toHaveProperty('leadsConversationId')
  })

  it('reaches no reader of an old Swarm, person or agent, and keeps its stored history', () => {
    const { f, lead, worker, docsLead, leads } = swarm()
    f.invite('viewer')
    for (const actor of [owner, peer, as(lead), as(docsLead), as(worker)]) {
      const view = visibleState(f.state, actor)
      expect(view.conversations.filter(c => c.id === leads || c.kind === 'leads')).toEqual([])
      expect(view).not.toHaveProperty('leadsConversationId')
    }
    f.run({ type: 'tab.rename', name: 'Renamed' })
    expect(f.state.conversations.find(c => c.id === leads)).toMatchObject({ kind: 'leads', lastMessageSequence: 7, agentIds: [lead, docsLead] })
  })

  it('refuses every post and command on it with one plain message, for people and Leads alike', () => {
    const { f, lead, worker, docsLead, leads } = swarm()
    for (const actor of [owner, as(lead), as(docsLead), as(worker)]) {
      expect(() => f.run(send(leads, 'Who goes first?'), actor)).toThrow(REMOVED)
    }
    expect(() => f.run(send(leads, 'Pilot, can you go first?', [lead]))).toThrow(REMOVED)
    for (const command of [
      { type: 'conversation.archive', conversationId: leads, archived: true },
      { type: 'conversation.rename', conversationId: leads, title: 'Chat' },
      { type: 'conversation.agent', conversationId: leads, agentId: worker, present: true, lead: false },
    ] as Command[]) expect(() => f.run(command)).toThrow(REMOVED)
  })

  it('leaves project chats, workgroups and their recipients as before', () => {
    const { f, lead, worker, docs, docsLead } = swarm()
    expect(f.run(send('lead', 'Status?', [lead]), as(worker)).messages[0]!.recipients).toEqual([lead])
    expect(f.run(send(docs.conversationId, 'Docs status?'), as(docsLead)).messages[0]!.recipients).toEqual([])
    const group = f.group()
    expect(visibleState(f.state, as(worker)).conversations.map(c => c.id)).toEqual(expect.arrayContaining(['lead', group]))
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
      storedAssignment(f.state, group, worker, 1000)
      return { group, worker }
    }
    return { f, lead, project, work }
  }

  it('shows a Lead the active work of every other shared project, and nobody else', () => {
    const { f, lead, project, work } = swarm()
    const docs = project('Docs', 'public'), secret = project('Secret', 'private')
    const roster = work(docs.projectId, 'Roster', ['desktop/lib/super_tabs'])
    storedStatus(f.state, roster.group, 'review', 'Ready: https://github.com/example/project/pull/12 head abc.')
    const finished = work(docs.projectId, 'Finished', ['docs'])
    storedStatus(f.state, finished.group, 'cancelled', 'Not needed.')
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

  it('tells each Lead once, in its own project chat and to it alone, when a task\'s owned code overlaps another project\'s active task', () => {
    const { f, lead, project, work } = swarm()
    const docs = project('Docs', 'public')
    const roster = work(docs.projectId, 'Roster', ['desktop/lib/super_tabs'])
    const name = (id: string) => f.state.agents.find(a => a.id === id)!.displayName
    const overlaps = (effects: ReturnType<typeof f.run>) => effects.messages.filter(m => (m.source as { kind?: string } | undefined)?.kind === 'overlap')
    const created = f.run({ type: 'conversation.create', title: 'Agents filter', task: task([' ./desktop/lib/super_tabs/roster.dart ', 'cli']), checks, priority: 'P2', requesterId: 'owner' }, as(lead))
    const group = created.result.conversationId as string
    const text = `"Agents filter" (Pilot, ${name(lead)}) and "Roster" (Docs, ${name(docs.lead)}) both change desktop/lib/super_tabs/roster.dart.`
    // The acting Lead created the overlap and is not told again; the other project's Lead hears it in its own project chat.
    expect(overlaps(created)).toEqual([expect.objectContaining({ conversationId: docs.conversationId, author: expect.objectContaining({ id: docs.lead }),
      recipients: [docs.lead], text, source: { kind: 'overlap', conversationIds: [group, roster.group] } })])
    // The two Leads' to settle (Ken, 2026-10-29): people in the project chat do not read it.
    expect(agentOnly(overlaps(created)[0]!.source, overlaps(created)[0]!.recipients)).toBe(true)
    expect(f.state.conversations.some(c => c.kind === 'leads')).toBe(false)
    expect(visibleState(f.state, owner)).not.toHaveProperty('overlapAlerts')
  })

  it('tells both Leads, each in its own project chat, when a person makes the overlap', () => {
    const { f, lead, project, work } = swarm()
    const docs = project('Docs', 'public')
    const roster = work(docs.projectId, 'Roster', ['desktop/lib/super_tabs'])
    const effects = f.run({ type: 'conversation.create', title: 'Agents filter', task: task(['desktop/lib']), checks })
    expect(effects.messages.filter(m => (m.source as { kind?: string } | undefined)?.kind === 'overlap')
      .map(m => [m.conversationId, m.recipients]).sort()).toEqual([['lead', [lead]], [docs.conversationId, [docs.lead]]].sort())
    expect(roster.group).toBeTruthy()
  })

  it('stays silent within one project, for owned code that is not a path, and for private projects', () => {
    const { f, project, work } = swarm()
    const secret = project('Secret', 'private'), docs = project('Docs', 'public')
    work('lead', 'Own', ['desktop/lib'])
    work(secret.projectId, 'Hidden', ['desktop/lib'])
    work(docs.projectId, 'Phrase', ['The Desktop roster'])
    for (const owns of [['desktop/lib/super_tabs'], ['The Desktop roster']]) {
      const effects = f.run({ type: 'conversation.create', title: 'More', task: task(owns), checks })
      expect(effects.messages.filter(m => (m.source as { kind?: string } | undefined)?.kind === 'overlap')).toEqual([])
    }
    expect(f.run({ type: 'conversation.create', projectId: secret.projectId, title: 'Secret too', task: task(['desktop/lib']), checks })
      .messages.filter(m => (m.source as { kind?: string } | undefined)?.kind === 'overlap')).toEqual([])
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
  const grant = { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }

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
    const f = fixture(), task = f.group()
    const grid = f.run({ type: 'localModels.set', enabled: true }).result.grid as string
    served(f, grid)
    f.run({ type: 'agent.start', request: start(grid, { conversationId: task }) }, owner, grant)
    expect(f.state.starts).toHaveLength(1)

    const refused = (request: Record<string, unknown>, now = 1000) => () => applyCommand(f.state, owner, { type: 'agent.start', request } as Command,
      { now, operationId: 'op-x', ...grant })
    expect(refused(start('swarm-other', { conversationId: task }))).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
    expect(refused(start(grid, { conversationId: task, gridModel: 'llama-70b' }))).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
    expect(refused(start(grid, { conversationId: task, model: 'opus' }))).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
    // A reading too old to trust says nothing is served.
    expect(refused(start(grid, { conversationId: task }), 1000 + 60_000)).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
    f.run({ type: 'localModels.set', enabled: false })
    expect(refused(start(grid, { conversationId: task }))).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
  })

  it('lets a machine run a Builder on a model shared with its owner on another grid, and only that machine', () => {
    const f = fixture(), task = f.group()
    const grid = f.run({ type: 'localModels.set', enabled: true }).result.grid as string
    served(f, grid)
    const host = f.state.machines![0]!
    host.observation!.localModels = [{ grid: 'team-grid', model: 'qwen3-30b', kind: 'shared' }]
    // A second machine whose reading does not list it.
    f.state.machines!.push({ ...structuredClone(host), machineId: 'mini', name: 'Mini', observation: { ...structuredClone(host.observation!), localModels: [] } })
    const refused = (request: Record<string, unknown>, now = 1000) => () => applyCommand(f.state, owner, { type: 'agent.start', request } as Command,
      { now, operationId: 'op-x', ...grant })
    expect(refused(start('team-grid', { conversationId: task, machineId: 'mini' }))).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
    expect(refused(start('team-grid', { conversationId: task, gridModel: 'llama-70b' }))).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
    expect(refused(start('team-grid', { conversationId: task }), 1000 + 60_000)).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
    f.run({ type: 'agent.start', request: start('team-grid', { conversationId: task }) }, owner, grant)
    expect(f.state.starts).toEqual([expect.objectContaining({ request: expect.objectContaining({ machineId: 'host', gridName: 'team-grid', gridModel: 'qwen3-30b' }) })])
    // Not while the add-on is off.
    f.run({ type: 'localModels.set', enabled: false })
    expect(refused(start('team-grid', { conversationId: task }))).toThrow(expect.objectContaining({ code: 'OUTSIDE_CONTRIBUTION' }))
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

  it('lets the PM and any other agent tag, and refuses another project’s Lead and the removed Leads conversation', () => {
    const { f, lead, secret } = swarm(), group = f.group(), worker = f.add('worker', 'owner', group)
    // Swarm v4 routes no tag through the PM: the worker tags the person.
    expect(f.run(send(group, ['peer']), as(worker)).messages.flatMap(m => m.mentions ?? [])).toEqual(['peer'])
    expect(() => f.run(send(group, ['owner']), as(secret.lead))).toThrow('This conversation is unavailable.')
    expect(() => f.run(send(storeOldLeads(f.state), ['owner']), as(lead))).toThrow(expect.objectContaining({ code: 'LEADS_CONVERSATION_REMOVED' }))
  })

  it('refuses a person who cannot read the conversation or is not in the Swarm', () => {
    const { f, secret } = swarm()
    expect(() => f.run(send(secret.conversationId, ['peer']), as(secret.lead))).toThrow('peer cannot read this conversation.')
    expect(() => f.run(send(secret.conversationId, ['stranger']), as(secret.lead))).toThrow('Tag a person in this Swarm.')
    expect(f.run(send(secret.conversationId, ['owner']), as(secret.lead)).messages[0]!.mentions).toEqual(['owner'])
  })

  it('tags at most five people', () => {
    expect(commandSchema.safeParse(send('lead', ['a', 'b', 'c', 'd', 'e'])).success).toBe(true)
    expect(commandSchema.safeParse(send('lead', ['a', 'b', 'c', 'd', 'e', 'f'])).success).toBe(false)
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

  // A person posts in their own chat with their agent (agentsOnly.test.ts).
  it('stores a person\'s message without the credentials, keeps the rest and tells the sender what went', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true)
    const input = send(pasted, f.pmChat(lead))
    const sent = f.run(input)
    expect(sent.messages).toEqual([expect.objectContaining({ text: kept, recipients: [lead] })])
    expect(sent.result).toEqual({ messageId: sent.messages[0]!.id, credentialNotice: notice,
      credentialsRemoved: [{ kind: 'jwt', label: 'JWT', count: 1 }, { kind: 'github', label: 'GitHub token', count: 1 }] })
    expect(JSON.stringify([sent.messages, f.state])).not.toContain(github)
    expect(JSON.stringify([sent.messages, f.state])).not.toContain(jwt)
    // The caller's command is left as it was; only what is stored changes.
    expect(input).toEqual(send(pasted, f.pmChat(lead)))
  })

  it('treats an agent\'s post the same: agents echo credentials from their terminals', () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group(), worker = f.add('worker', 'owner', group)
    f.run({ type: 'conversation.agent', conversationId: group, agentId: lead, present: true, lead: true })
    storedAssignment(f.state, group, worker, 1000)
    const posted = f.run(send(`npm publish failed: //registry.npmjs.org/:_authToken=${github}`, group), { kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' })
    expect(posted.messages).toEqual([expect.objectContaining({ text: `npm publish failed: //registry.npmjs.org/:_authToken=${CREDENTIAL_MARKER}`, recipients: [] })])
    expect(posted.result.credentialNotice).toBe('Removed a credential (GitHub token) before saving. Revoke or rotate it.')
  })

  it('leaves a message without credentials, and its result, exactly as before', () => {
    const f = fixture()
    const text = 'Merged a3f1c9e27b5d4f80916e2c3b7a8d9e0f1a2b3c4d; id 123e4567-e89b-12d3-a456-426614174000, see https://github.com/example/project/pull/1680'
    const sent = f.run(send(text, f.pmChat(f.add('lead', 'owner', 'lead', true))))
    expect(sent.messages[0]!.text).toBe(text)
    expect(sent.result).toEqual({ messageId: sent.messages[0]!.id })
  })

  it('removes credentials from task words before they reach the state or a row', () => {
    const f = fixture()
    f.add('lead', 'owner', 'lead', true)
    const created = f.run({ type: 'conversation.create', title: 'Deploy', checks: [{ description: `Login works with ${github}`, independent: false }],
      task: { goal: 'Deploy', changes: `Use ${jwt} to call the API`, constraints: 'None', owns: ['backend'] } })
    expect(created.result.credentialNotice).toBe(notice)
    const group = f.state.conversations.find(c => c.id === created.result.conversationId)!
    expect(group.task!.changes).toBe(`Use ${CREDENTIAL_MARKER} to call the API`)
    expect(group.brief).toContain(`Use ${CREDENTIAL_MARKER} to call the API`)
    expect(group.checks[0]!.description).toBe(`Login works with ${CREDENTIAL_MARKER}`)
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
    const start = withoutCredentials({ type: 'agent.start', request: { name: `Builder ${github}`, roleName: `Writer ${jwt}` } } as Command, removed)
    expect(start).toMatchObject({ request: { name: `Builder ${CREDENTIAL_MARKER}`, roleName: `Writer ${CREDENTIAL_MARKER}` } })
    const owns = withoutCredentials({ type: 'conversation.create', title: 't', checks: [], task: { goal: 'g', changes: 'c', constraints: 'n', owns: ['src', github] } } as Command, removed)
    expect(owns).toMatchObject({ task: { owns: ['src', CREDENTIAL_MARKER] } })
    expect(removed).toEqual(['github', 'jwt', 'github'])
    // Commands with no words of their own are passed through untouched.
    const pause: Command = { type: 'tab.pause', paused: true }
    expect(withoutCredentials(pause, removed)).toBe(pause)
  })
})

// Task #4340: WORDS listed only the older commands, so these were stored, and copied, as typed.
describe('credentials in every command', () => {
  const github = ['ghp', 'Fixture0Token1Not2Real3Value4abcdefgh'].join('_')
  /** A command holding [value] at [path] (`[]` an item of a list), with only what withoutCredentials reads. */
  const holding = (type: string, path: string, value: string): Command => {
    const command: Record<string, unknown> = { type }
    let holder = command
    const keys = path.split('.')
    keys.forEach((key, i) => {
      const many = key.endsWith('[]'), name = many ? key.slice(0, -2) : key, last = i === keys.length - 1
      const next = last ? value : {}
      holder[name] = many ? [next] : next
      holder = next as Record<string, unknown>
    })
    return command as unknown as Command
  }
  const at = (command: unknown, path: string): unknown => path.split('.').reduce<unknown>((value, key) => {
    const many = key.endsWith('[]'), item = (value as Record<string, unknown>)[many ? key.slice(0, -2) : key]
    return many ? (item as unknown[])[0] : item
  }, command)

  it.each([
    ['agent.new', 'name'], ['agent.new', 'projectName'],
    ['agent.add', 'roleName'], ['agent.start', 'request.roleName'],
    ['swarm.delete', 'name'],
    ['conversation.create', 'task.requires.access[]'], ['agent.screenResult', 'error'],
  ])('removes a credential from %s %s', (type, path) => {
    const removed: CredentialKind[] = []
    expect(at(withoutCredentials(holding(type, path, `see ${github}`), removed), path)).toBe(`see ${CREDENTIAL_MARKER}`)
    expect(removed).toEqual(['github'])
  })

  /** Strings that are not words people read, or that must reach their reader exactly, each with why. Anything else a
   *  command takes as a string is in WORDS: a new command's text fails the walk below until it is listed in one of the two. */
  const NOT_WORDS: readonly (readonly [why: string, fields: readonly string[]])[] = [
    // agent.input: the host types the exact text and terminal.ts redacts its chat row. A screen goes, exact, only to the agent that asked.
    ['A terminal\'s exact text', ['agent.input text', 'agent.screenResult text', 'agent.inputResult text']],
    // A token here fails the launch rather than reaching anyone.
    ['A lab\'s engine, model, effort or grid, passed to its CLI or matched to a list', [
      'agent.add configuration.engine', 'agent.add configuration.model', 'agent.add configuration.effort', 'agent.add configuration.engineVersion',
      'agent.add launchRefused.model', 'agent.add launchRefused.effort',
      ...['agent.configuration', 'agent.rebind', 'agent.started', 'agent.startSettled'].flatMap(type =>
        ['engine', 'model', 'effort', 'engineVersion'].map(field => `${type} configuration.${field}`)),
      'agent.new engine', 'agent.new model', 'lead.start engine', 'lead.start model', 'lead.start effort', 'lead.switch engine', 'lead.switch model',
      'lead.switch effort', 'machine.contribute engines[]', 'machine.engineResume engine', 'localModels.status grid',
      'agent.start request.engine', 'agent.start request.model', 'agent.start request.effort', 'agent.start request.permissionMode',
      'agent.start request.gridModel', 'agent.start request.gridName', 'agent.start request.requirements.tools[]']],
    // A repository URL that holds a credential is refused by its schema.
    ['A folder a host opens, or a URL or ref held to its shape', ['agent.add project.cwd', 'agent.add project.repositoryUrl', 'github.relay repository', 'github.relay login',
      'agent.new repositoryUrl', 'agent.start request.cwd', 'agent.start request.codexHome', 'agent.start request.branchRef',
      'agent.start request.requirements.devices[]', 'lead.start branchRef', 'lead.start repositoryUrl',
      'machine.contribute cwd', 'project.repository repositoryUrl', 'tab.project project.cwd', 'tab.project project.repositoryUrl',
      'conversation.create task.requires.devices[]']],
    ['An id, an account key, a time or a time zone', ['agent.add roleId', 'agent.rebind profileId', 'agent.start request.roleId',
      'project.closeTab tabOperation']],
    ['The address an invitation goes to, which its person signs in with', ['invite.create email']],
  ]

  /** Every string a command takes, as `type path`, but ids and ISO times (shapes no credential fits). */
  const strings = (): string[] => {
    const found: string[] = []
    const ID = /^[A-Za-z0-9_-]+$/.source
    const walk = (schema: { _zod: { def: Record<string, any> } }, type: string, path: string): void => {
      const def = schema._zod.def
      switch (def.type) {
        case 'object': for (const [key, field] of Object.entries(def.shape)) if (key !== 'type' || path) walk(field as never, type, path ? `${path}.${key}` : key); return
        case 'array': return walk(def.element, type, `${path}[]`)
        case 'tuple': return def.items.forEach((item: never) => walk(item, type, `${path}[]`))
        case 'record': return walk(def.valueType, type, `${path}{}`)
        case 'optional': case 'nullable': case 'default': case 'readonly': return walk(def.innerType, type, path)
        case 'pipe': return walk(def.in._zod.def.type === 'transform' ? def.out : def.in, type, path)
        case 'union': return def.options.forEach((option: never) => walk(option, type, path))
        case 'lazy': return walk(def.getter(), type, path)
        case 'string': {
          const checks: { format?: string; pattern?: RegExp }[] = (def.checks ?? []).map((check: { _zod: { def: object } }) => check._zod.def)
          const patterns = checks.map(check => check.pattern?.source).filter(Boolean)
          const time = [def.format, ...checks.map(check => check.format)].some(format => format === 'datetime' || format === 'date')
          if (time || (patterns.length === 1 && patterns[0] === ID)) return
          return void found.push(`${type} ${path}`)
        }
        case 'enum': case 'literal': case 'number': case 'int': case 'boolean': case 'null': case 'undefined': return
        default: throw new Error(`The walk does not read a ${def.type} (${type} ${path}): teach it.`)
      }
    }
    for (const option of (commandSchema as unknown as { _zod: { def: { options: { _zod: { def: Record<string, any> } }[] } } })._zod.def.options) {
      walk(option, option._zod.def.shape.type._zod.def.values[0], '')
    }
    return [...new Set(found)]
  }

  it('walks every command: each string is in WORDS or named, with why, as not words', () => {
    const exempt = NOT_WORDS.flatMap(([, fields]) => fields)
    const covered = new Set([...Object.entries(WORDS).flatMap(([type, paths]) => paths!.map(path => `${type} ${path}`)), ...exempt])
    const all = strings()
    expect(all.length).toBeGreaterThan(100)
    expect(all.filter(field => !covered.has(field))).toEqual([])
    // Nothing listed is stale or listed twice.
    expect([...covered].filter(field => !all.includes(field))).toEqual([])
    expect(exempt.filter(field => Object.entries(WORDS).some(([type, paths]) => paths!.some(path => `${type} ${path}` === field)))).toEqual([])
  })
})

describe('lost work (liveness.ts)', () => {
  /** A Lead, and a group with two workers, the first assigned; the clock is at 1000 in every command. */
  const lostFixture = () => {
    const f = fixture()
    const lead = f.add('lead', 'owner', 'lead', true)
    const group = f.group(), worker = f.add('worker', 'owner', group), other = f.add('other', 'owner', group)
    const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
    storedAssignment(f.state, group, worker, 1000)
    const task = () => f.state.conversations.find(c => c.id === group)!
    const limit = () => f.run({ type: 'agent.alert', agentId: worker, alert: 'limit', active: true, resetAt: new Date(3_600_000).toISOString() }, as(worker))
    return { f, lead, group, worker, other, as, task, limit }
  }

  // Task #2321 (Ken, 11-03): River stayed "limited" after its notice went, as only `alerting` cleared and `limitedUntil` waited
  // for its time; the roster, routing and notices kept treating it as limited.
  it('clears the limit mark when the limit notice goes', () => {
    const { f, worker, as, limit } = lostFixture()
    limit()
    const marked = () => f.state.agents.find(a => a.id === worker)!
    expect(marked().limitedUntil).toBe(new Date(3_600_000).toISOString())
    f.run({ type: 'agent.alert', agentId: worker, alert: 'limit', active: false }, as(worker), { now: 2000 })
    expect(marked()).toMatchObject({ limitedUntil: null, alerting: [] })
  })

  it('keeps the limit mark on posts its host sends as the agent, and on anyone else\'s', () => {
    const { f, lead, group, worker, other, as, limit } = lostFixture()
    limit()
    const marked = () => f.state.agents.find(a => a.id === worker)!
    f.run({ type: 'message.send', conversationId: group, text: 'Still here.', replyTo: null, recipientIds: [] }, as(other))
    f.run({ type: 'message.send', conversationId: group, text: 'Checking.', replyTo: null, recipientIds: [] }, as(lead))
    // Its host posts as the agent too: a skill refresh only it reads, a stop it could not make (review of #2712, Important 2).
    f.run({ type: 'message.send', conversationId: group, text: 'Your skills changed.', replyTo: null, recipientIds: [worker], agentOnly: true }, as(worker))
    f.run({ type: 'message.send', conversationId: group, text: 'Could not stop worker on host.', replyTo: null, recipientIds: [lead] }, as(worker))
    expect(marked().limitedUntil).toBe(new Date(3_600_000).toISOString())
  })

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

  it('renews the lease on the worker\'s own post in its task\'s group, not on anyone else\'s', () => {
    const { f, lead, group, worker, as, task } = lostFixture()
    task().assignment!.leaseUntil = 0
    f.run({ type: 'message.send', conversationId: group, text: 'Halfway.', replyTo: null, recipientIds: [] }, as(lead))
    expect(task().assignment!.leaseUntil).toBe(0)
    f.run({ type: 'message.send', conversationId: group, text: 'Halfway.', replyTo: null, recipientIds: [] }, as(worker))
    expect(task().assignment).toMatchObject({ leaseUntil: 1000 + 5 * 60_000, progressAt: 1000 })
  })

  it('clears the mark when the worker\'s terminal is replaced (Change agent)', () => {
    const { f, group, worker, as, limit } = lostFixture()
    limit()
    f.run({ type: 'agent.rebind', agentId: worker, machineId: 'host', projectId: 'lead', previousHarnessId: 'worker', harnessId: 'worker-2', configuration: config }, as(worker))
    expect(f.state.agents.find(a => a.id === worker)).toMatchObject({ harnessId: 'worker-2' })
    expect(f.state.agents.find(a => a.id === worker)!.lostTask).toBeUndefined()
    expect(f.state.conversations.find(c => c.id === group)!.lostAttempt).toMatchObject({ agentId: worker })
  })

  // No task resumes after a usage limit since Swarm v4 (work.resume is retired, 2026-11-10): nothing promises it.
  it('records no resume time for a task lost to a usage limit with a reset time, and never tells the Lead it resumes', () => {
    const { f, worker, task, limit } = lostFixture()
    const lead = limit().messages.find(m => m.source?.kind === 'work-lost' && !m.recipients.includes(worker))!
    expect(task().assignment!.lost).toEqual({ reason: expect.stringContaining('usage limit'), at: 1000 })
    expect(f.state.agents.find(a => a.id === worker)!.lostTask).not.toHaveProperty('resumeAt')
    expect(lead.text).not.toContain('resumes')
    // What happened, never the next step (project instructions, phase 4).
    expect(lead.text).not.toMatch(/Assign it|assign it there|unless you hand it on/)
  })

  it('records no resume time for a usage limit whose screen gave no reset time', () => {
    const { f, worker, as, task } = lostFixture()
    const rows = f.run({ type: 'agent.alert', agentId: worker, alert: 'limit', active: true }, as(worker)).messages
    expect(task().assignment!.lost).not.toHaveProperty('resumeAt')
    expect(f.state.agents.find(a => a.id === worker)!.lostTask).not.toHaveProperty('resumeAt')
    const told = rows.find(m => m.source?.kind === 'work-lost' && !m.recipients.includes(worker))!.text
    expect(told).toMatch(/Last result: none\.$/)
    expect(told).not.toContain('Assign it')
  })

  it('does not lose work a Lead holds: Leads are not covered here', () => {
    const { f, lead, as } = lostFixture()
    const own = f.group()
    storedAssignment(f.state, own, lead, 1000)
    f.run({ type: 'agent.alert', agentId: lead, alert: 'limit', active: true }, as(lead))
    expect(f.state.conversations.find(c => c.id === own)!.assignment!.status).toBe('working')
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
    t.f.run({ type: 'agent.release', agentId: t.worker, decision: 'stop' }, owner)
    expect(() => t.f.run({ type: 'agent.stopRefused', agentId: t.worker, releaseId: 'idle-release' }, t.asWorker)).toThrow('Only the execution host')
    expect(t.member().workDecision).toBe('stop')
  })
})

describe('archiving unfinished work', () => {
  /** A task Peer asked for (or, with [asked] false, the owner opened for themselves), its worker's attempt left at [status],
   *  in the Swarm's first project or in [project] when given (a project Peer creates, so its owner is not the Swarm owner). */
  function task(status: 'lost' | 'stopped' | 'cancelled' | 'done' | 'working', { asked = true, peerProject = false } = {}) {
    const f = fixture()
    f.invite()
    const projectId = peerProject ? f.run({ type: 'project.create', name: 'Dial', visibility: 'public', brief: '' }, peer).result.projectId as string : undefined
    const group = f.run({ type: 'conversation.create', title: 'Round tabs', brief: 'Drop closed tabs.', ...(asked ? { requesterId: 'peer' } : {}),
      ...(projectId ? { projectId } : {}), checks: [{ description: 'Closed tabs leave the dial.', independent: false }] }).result.conversationId as string
    const worker = f.add('worker', 'owner', group)
    storedAssignment(f.state, group, worker, 1000)
    if (status === 'cancelled') storedStatus(f.state, group, status, 'Superseded by the dial rewrite.')
    else if (status !== 'working') storedStatus(f.state, group, status)
    return { f, group }
  }
  const archive = (t: ReturnType<typeof task>, actor: Actor = owner) => t.f.run({ type: 'conversation.archive', conversationId: t.group, archived: true }, actor)
  const at = (t: ReturnType<typeof task>) => t.f.state.conversations.find(c => c.id === t.group)!
  const WHO_CANCELS_ENDED = 'Only the person who asked for this task, its project\'s owner, the Swarm owner or an agent of this project can close it.'
  const WHO_CANCELS_LIVE = 'Only an agent of this project or the Swarm owner can close work in progress.'

  // Security review 2 of #2907: a collaborator who did not ask could name themselves its requester, then cancel it. Among
  // people only an owner names who asked; agents still name the person they opened it for.
  it('refuses a collaborator who names themselves requester of a lost task', () => {
    const t = task('lost', { asked: false })
    expect(() => t.f.run({ type: 'conversation.requester', conversationId: t.group, personId: 'peer' }, peer))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN', message: 'Among people, only the Swarm owner or the project\'s owner names who asked for a task.' }))
    expect(() => t.f.run({ type: 'conversation.requester', conversationId: t.group, personId: null }, peer)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(at(t).requesterId).toBe('owner')
    // The owner of the task's project still names them.
    t.f.run({ type: 'conversation.requester', conversationId: t.group, personId: 'peer' })
    expect(at(t).requesterId).toBe('peer')
  })

  // Swarm v4 retired work.cancel and work.status (2026-11-10): archiving is how a task stored before it closes. It says so in
  // the task, so nothing unfinished closes silently, and its requester is tagged as for any cancelled task.
  it.each(['lost', 'stopped'] as const)('closes a %s task it archives, saying so in the task', status => {
    const t = task(status)
    const effects = archive(t)
    expect(at(t)).toMatchObject({ archived: true, assignment: { status: 'cancelled', result: 'Archived before it finished.' } })
    expect(effects.messages.map(m => m.text)).toEqual(['owner archived this task before it finished.',
      'Archived without shipping: the task was cancelled (Archived before it finished).'])
  })

  it('tells a task\'s working agent to stop when it is archived, and frees it', () => {
    const t = task('working')
    const worker = at(t).assignment!.agentId
    const effects = archive(t)
    expect(at(t)).toMatchObject({ archived: true, assignment: { status: 'cancelled' } })
    expect(effects.messages[0]).toMatchObject({ text: 'owner archived this task before it finished. Stop working on it.', recipients: [worker] })
  })

  it('names who may close unfinished work when someone else archives it', () => {
    const lost = task('lost', { asked: false })
    expect(() => archive(lost, peer)).toThrow(expect.objectContaining({ code: 'FORBIDDEN', message: WHO_CANCELS_ENDED }))
    expect(at(lost).archived).toBe(false)
    const working = task('working')
    expect(() => archive(working, peer)).toThrow(expect.objectContaining({ code: 'FORBIDDEN', message: WHO_CANCELS_LIVE }))
    // Its requester closes it once it ended, as work.cancel let them.
    const asked = task('lost')
    archive(asked, peer)
    expect(at(asked).archived).toBe(true)
  })

  it('tags the requester with the reason when a cancelled task is archived', () => {
    const t = task('cancelled')
    expect(archive(t).messages).toEqual([expect.objectContaining({ conversationId: t.group, mentions: ['peer'],
      text: 'Archived without shipping: the task was cancelled (Superseded by the dial rewrite).' })])
  })

  it('archives a done task without tagging anyone', () => {
    const t = task('done')
    expect(archive(t).messages).toEqual([])
    expect(t.f.state.conversations.find(c => c.id === t.group)!.archived).toBe(true)
  })
})

// Checks are information (project instructions, phase 4): who passes one is the project's workflow, and Done is the agent's
// word. The server records every verdict and refuses none for who gave it.
describe('checks are information', () => {
  it('creates a task with no checks', () => {
    const f = routed()
    const group = f.run({ type: 'conversation.create', title: 'Docs', brief: 'Fix the docs.', checks: [] }, owner).result.conversationId as string
    expect(f.state.conversations.find(c => c.id === group)!.checks).toEqual([])
  })
})

// Project instructions, phase 4 (decisions 8 and 18): a failed first review on the grid and a failed start are notices to the
// coordinator; nothing is stepped up, cancelled or started elsewhere, and the instructions say what happens next.
describe('notices of failed work', () => {
  /** The phrases notices used to end with: the coordinator's next step, which its instructions now give. */
  const NEXT_STEP = /Assign it to another agent now|assign it there now|Act on|Stop it, or give the work|Hand this task over|needs to be assigned again|Start it again|If this work should continue|Agree an order/
  /** A worker at work on a task, and its terminal's alert. */
  const alerted = (alert: 'limit' | 'model', resetAt?: string) => {
    const f = fixture()
    f.add('lead', 'owner', 'lead', true)
    const group = f.group(), worker = f.add('worker', 'owner', group)
    storedAssignment(f.state, group, worker, 1000)
    return f.run({ type: 'agent.alert', agentId: worker, alert, active: true, ...(resetAt ? { resetAt } : {}) }, { kind: 'agent', agentId: worker, machineOwnerId: 'host-owner' })
  }
  function task() {
    const f = routed(), group = f.group()
    f.run({ type: 'conversation.agent', conversationId: group, agentId: f.lead, present: true, lead: true })
    const builder = (name: string, model: string | null, gridModel?: string) => {
      const id = f.add(name, 'owner', group)
      Object.assign(f.state.agents.find(a => a.id === id)!, { configuration: { ...config, engine: 'claude', model }, ...(gridModel ? { gridModel } : {}) })
      return id
    }
    const g = () => f.state.conversations.find(c => c.id === group)!
    return { f, group, builder, g }
  }

  it('tells a failed start to the coordinator and the agent that made it', () => {
    const { f, group, builder, g } = task()
    const engineer = builder('engineer', 'claude-opus-4-7')
    const start = (id: string, actorKey: string, request: Record<string, unknown>) => ({ id, actorKey, contributorId: 'owner', membershipGeneration: f.state.people[0]!.generation,
      request: { conversationId: group, machineId: 'mac', name: 'Builder', engine: 'claude', ...request }, error: null })
    f.state.starts = [start('s1', `agent:${engineer}`, { gridModel: 'moonshotai/kimi-k3', gridName: 'swarm-g' }),
      start('s2', 'person:owner', { model: 'opus' }), start('s3', `agent:${f.worker}`, {})] as never
    // Each reported as its maker, as the host's route does (store.ts poolHostActor).
    const effects = f.run({ type: 'agent.startFailed', startId: 's1', error: 'Launch refused.' }, { kind: 'agent', agentId: engineer, machineOwnerId: 'host-owner' })
    expect(effects.messages).toEqual([expect.objectContaining({ conversationId: group, recipients: [f.lead, engineer],
      text: 'Could not start Builder on moonshotai/kimi-k3: its machine could not prepare or launch it. Whoever started it, the Product Manager and the machine owner can read why.' })])
    // A person's start: the coordinator alone, with the model it asked for; an agent of the project not in the task is not told.
    expect(f.run({ type: 'agent.startFailed', startId: 's2', error: 'Launch refused.' }).messages).toEqual([expect.objectContaining({ recipients: [f.lead],
      text: expect.stringContaining('Could not start Builder on opus:') })])
    expect(f.run({ type: 'agent.startFailed', startId: 's3', error: 'Launch refused.' }, f.workerActor).messages).toEqual([expect.objectContaining({ recipients: [f.lead],
      text: expect.stringMatching(/^Could not start Builder: /) })])
  })

  // What a notice says is what happened; the instructions say what to do about it (project instructions, phase 4).
  it('states what happened, never the next step', () => {
    const texts: string[] = []
    const keep = (effects: { messages: Array<{ text: string }> }) => { texts.push(...effects.messages.map(m => m.text)); return effects }
    // A lost task, with and without a reset time, and a model alert.
    keep(alerted('limit'))
    keep(alerted('limit', new Date(3_600_000).toISOString()))
    keep(alerted('model'))
    // A removed agent with a task, a removed machine with an agent at work, and starts abandoned when their machine joined.
    const removal = fixture()
    removal.add('lead', 'owner', 'lead', true)
    const removalGroup = removal.group(), removed = removal.add('worker', 'owner', removalGroup)
    storedAssignment(removal.state, removalGroup, removed, 1000)
    keep(removal.run({ type: 'agent.remove', agentId: removed }))
    const machine = fixture(), machineGroup = machine.group(), atWork = machine.add('worker', 'owner', machineGroup)
    storedAssignment(machine.state, machineGroup, atWork, 1000)
    machine.state.machines = [{ machineId: 'host', name: 'Studio', contributorId: 'owner', membershipGeneration: machine.state.people[0]!.generation,
      generation: 'g1', cwd: '/repo', engines: ['claude'], maxAgents: 2, paused: false }] as never
    keep(machine.run({ type: 'machine.remove', machineId: 'host' }))
    const joining = fixture()
    joining.state.starts = [{ id: 's1', request: { conversationId: 'lead', machineId: 'mac', name: 'Builder' }, error: null }] as never
    keep(joining.run({ type: 'machine.contribute', machineId: 'mac', name: 'Mac', cwd: '/swarm', engines: ['codex'], maxAgents: 2 },
      owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' }, abandonedStartIds: ['s1'] }))
    expect(texts.length).toBeGreaterThanOrEqual(7)
    for (const text of texts) expect(text).not.toMatch(NEXT_STEP)
    expect(texts).toEqual(expect.arrayContaining([expect.stringContaining('lost its task'), expect.stringContaining('can\'t get answers from its model'),
      expect.stringContaining('removed "worker" from the Swarm. Its task "Offline editing" has no agent now.'),
      expect.stringContaining('removed Studio from the Swarm'), 'Builder never started and will not start now.']))
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
    const task = f.group()
    const request = (extra: Record<string, unknown> = {}) => ({ conversationId: task, machineId: 'mac', engine: 'codex', name: 'Builder', cwd: '/repo',
      worktree: true, requirements: { memoryBytes: 1, diskBytes: 1, maxCpuPercent: 100, tools: ['git'], devices: [], quotaRequired: false }, ...extra })
    const begin = (extra: Record<string, unknown> = {}) => f.run({ type: 'agent.start', request: request(extra) } as Command, leadActor,
      { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
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
    // A different engine failure is only its first; the timeout counted against the machine.
    expect(fail('s2').mentions).toBeUndefined()
    expect(fail('s3').mentions).toEqual(['owner'])
  })

  // Quota is information, not a gate (project instructions, phase 4).
  it('is refused by the start check while suspended or signed out, never for quota, and a grid model there is not', () => {
    const suspended = setup()
    suspended.fail('s1'); suspended.fail('s2')
    expect(() => suspended.begin()).toThrow('Codex is suspended on this machine')
    const signedOut = setup({ readiness: { engines: [{ engine: 'codex', installed: true, signedIn: false }] }, localModels: [{ grid, model: 'qwen3', kind: 'local' }] })
    expect(() => signedOut.begin()).toThrow('Codex is not signed in to a subscription on this machine.')
    signedOut.f.state.localModels = { grid, enabled: true }
    expect(signedOut.begin({ gridModel: 'qwen3', gridName: grid }).result.startId).toBeTruthy()
    const exhausted = setup({ quotas: [{ engine: 'codex', known: true, windows: [{ name: 'weekly', usedPercent: 100, resetsAt: null }] }] })
    expect(exhausted.begin().result.startId).toBeTruthy()
    // A reading that says nothing of the engine keeps today's behaviour.
    expect(setup().begin().result.startId).toBeTruthy()
  })

  it('refuses every engine and grid starts while the machine is suspended', () => {
    const { f, begin } = setup({ localModels: [{ grid, model: 'qwen3', kind: 'local' }] })
    f.state.localModels = { grid, enabled: true }
    f.state.machines![0]!.engines = ['codex', 'claude']
    for (const startId of ['s1', 's2']) f.run({ type: 'agent.startFailed', startId,
      error: 'Mac did not start it within 3 minutes' }, owner)
    for (const extra of [{}, { engine: 'claude' }, { gridModel: 'qwen3', gridName: grid }]) {
      expect(() => begin(extra)).toThrow('This machine is suspended')
    }
  })

  it.each(['owner', 'lead'])('admits starts after the %s resumes a machine cooldown with the owner\'s authority', (who) => {
    const { f, lead, begin } = setup()
    for (const startId of ['s1', 's2']) f.run({ type: 'agent.startFailed', startId,
      error: 'Mac did not start it within 3 minutes' }, owner)
    const resume = { type: 'machine.engineResume', machineId: 'mac', engine: 'codex' } as Command
    const leadActor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    f.invite()
    expect(() => f.run(resume, peer)).toThrow('Only the machine\'s owner')
    expect(() => f.run(resume, leadActor)).toThrow('Only the machine\'s owner')
    expect(() => begin()).toThrow('This machine is suspended')
    if (who === 'owner') f.run(resume, owner)
    else f.run({ ...resume, askedIn: { conversationId: 'lead', messageId: 'm-owner' } } as Command, leadActor,
      { askedIn: { author: { kind: 'person', id: 'owner' } as never, source: false, createdAt: 1000 } })
    expect(begin().result.startId).toBeTruthy()
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

// Scholes, 2026-10-30: the sidebar's Models showed "Codex, model not reported". A Codex agent at its own default reported its
// model only after the work it was assigned 30 s after its start was recorded; the start now settles with what it saw.
describe('a settling start names the model its agent runs', () => {
  const contribution = { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null }
  const reported = { engine: 'codex', model: 'gpt-6.1-sol', effort: 'auto', contextWindow: null, engineVersion: '0.165.0' }
  const setup = () => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
    const actor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    const start = (harnessId: string) => {
      const request = { conversationId: group, machineId: 'host', engine: 'codex', name: 'Builder', cwd: '/repo', worktree: true,
        requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }
      const startId = f.run({ type: 'agent.start', request }, actor, { contribution }).result.startId as string
      f.run({ type: 'agent.startDispatch', startId }, actor, { contribution })
      f.state.starts!.find(s => s.id === startId)!.poolGeneration = 'pool-1'
      // Codex at its own default reports no model when it joins.
      const agentId = f.run({ type: 'agent.started', startId, harnessId, configuration: { ...reported, model: null, effort: null } }, actor, { contribution })
        .result.agentId as string
      return { startId, agentId }
    }
    const settle = (startId: string, configuration?: AgentConfiguration, context: Partial<CommandContext> = { contribution }) =>
      f.run({ type: 'agent.startSettled', startId, warning: null, ...(configuration ? { configuration } : {}) }, actor, context)
    const worker = (agentId: string) => f.state.agents.find(a => a.id === agentId)!
    return { f, start, settle, worker }
  }

  it('records the model the start saw on the agent', () => {
    const t = setup(), { startId, agentId } = t.start('codex-1')
    const ready = t.settle(startId, reported).messages
    expect(ready.map(m => m.text)).toEqual(['Builder is ready for an assignment.'])
    expect(t.worker(agentId).configuration).toEqual(reported)
  })

  it('settles without a model when the agent reported none in time', () => {
    const t = setup(), { startId, agentId } = t.start('codex-2')
    expect(t.settle(startId).messages.map(m => m.text)).toEqual(['Builder is ready for an assignment.'])
    expect(t.worker(agentId).configuration.model).toBeNull()
  })

  it('takes no reading from another machine grant, for another engine, for a grid model, or once settled', () => {
    const t = setup()
    const other = t.start('codex-3')
    t.settle(other.startId, reported, { contribution: { ...contribution, hostGrant: 'grant-2' } })
    expect(t.worker(other.agentId).configuration.model).toBeNull()
    const engine = t.start('codex-4')
    t.settle(engine.startId, { ...reported, engine: 'claude', model: 'opus' })
    expect(t.worker(engine.agentId).configuration).toMatchObject({ engine: 'codex', model: null })
    const grid = t.start('codex-5')
    t.worker(grid.agentId).gridModel = 'moonshotai/kimi-k3'
    t.settle(grid.startId, reported)
    expect(t.worker(grid.agentId).configuration.model).toBeNull()
    // A settle already made is a replay: it changes nothing, whatever it carries.
    const settled = t.start('codex-6')
    t.settle(settled.startId)
    t.settle(settled.startId, reported)
    expect(t.worker(settled.agentId).configuration.model).toBeNull()
  })

  it('a host from before the field still settles, and an unknown field is still refused', () => {
    const t = setup(), { startId } = t.start('codex-7')
    expect(t.settle(startId).messages).toHaveLength(1)
    expect(() => commandSchema.parse({ type: 'agent.startSettled', startId, warning: null, model: 'gpt-6.1-sol' })).toThrow()
  })
})

describe('the state a command works on', () => {
  it('fails loudly on a state value it cannot copy', () => {
    expect(() => applyCommand({ ...richSwarm().state, stray: new Map() } as never, richOwner,
      { type: 'message.send', conversationId: 'lead', text: 'hi', replyTo: null, recipientIds: [] }, { now: NOW, operationId: 'op' }))
      .toThrow(/cannot copy a Map at stray/)
  })
})

describe('lead.switch', () => {
  const WORK = 'a'.repeat(16)
  const setup = (capabilities: string[] | undefined = ['leadSwitch'], contributorId = 'owner') => {
    const f = fixture()
    f.invite()
    const pm = f.add('pm', contributorId, 'lead', true)
    // Its person's own computer (Swarm v3 has no Team accounts, task #4120).
    f.state.machines = [{ machineId: 'host', name: 'Studio', contributorId, membershipGeneration: f.state.people.find(p => p.id === contributorId)!.generation,
      generation: 'g1', cwd: '/repo', engines: ['claude', 'codex'], maxAgents: 2, paused: false, observation: { generation: 'g1', receivedAt: 1000,
        ...(capabilities ? { capabilities } : {}),
        profiles: [{ engine: 'codex', id: WORK, label: 'Work', leftPercent: 80, resetsAt: null }],
        resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null,
          deviceType: null, chip: null, os: null, gpuPercent: null }, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] } }]
    const agent = () => f.state.agents.find(a => a.id === pm)!
    const as: Actor = { kind: 'agent', agentId: pm, machineOwnerId: 'host-owner' }
    const sid = () => agent().switchRequest!.id
    const request = { type: 'lead.switch', projectId: 'lead', engine: 'codex', profileId: 'default' } as const
    return { f, pm, agent, as, request, sid }
  }
  const code = (run: () => unknown) => { try { run() } catch (error) { return (error as { code?: string }).code } }

  it('lets the project owner and the PM machine\'s owner switch, and refuses a member', () => {
    const mine = setup()
    mine.f.run(mine.request)
    expect(mine.agent().switchRequest).toMatchObject({ engine: 'codex', profileId: defaultProfileId('host', 'codex'), requestedBy: 'owner' })
    const theirs = setup(['leadSwitch'], 'peer')
    theirs.agent().machineOwnerId = 'peer'
    theirs.f.run(theirs.request, peer)
    expect(theirs.agent().switchRequest).toMatchObject({ requestedBy: 'peer' })
    const other = setup()
    expect(code(() => other.f.run(other.request, peer))).toBe('PROJECT_OWNER_REQUIRED')
  })

  it('refuses NO_LEAD, MACHINE_OFFLINE, HOST_OUTDATED, LEAD_SWITCHING, DEFAULT_ACCOUNT_ONLY and ENGINE_NOT_OFFERED', () => {
    const none = fixture()
    expect(code(() => none.run({ type: 'lead.switch', projectId: 'lead', engine: 'codex', profileId: 'default' }))).toBe('NO_LEAD')
    const offline = setup()
    expect(code(() => offline.f.run(offline.request, owner, { now: 1000 + 60_000 }))).toBe('MACHINE_OFFLINE')
    const old = setup([])
    expect(code(() => old.f.run(old.request))).toBe('HOST_OUTDATED')
    const twice = setup()
    twice.f.run(twice.request)
    expect(code(() => twice.f.run({ ...twice.request, profileId: 'default' }))).toBe('LEAD_SWITCHING')
    // The default account alone: not one an older CLI still reports (Work), one it never did, or another engine's.
    const other = setup()
    for (const patch of [{ profileId: WORK }, { profileId: 'b'.repeat(16) }, { engine: 'claude', profileId: WORK }] as const) {
      expect(() => other.f.run({ ...other.request, ...patch })).toThrow(expect.objectContaining({ code: 'DEFAULT_ACCOUNT_ONLY', status: 403,
        message: 'A Product Manager runs on Studio\'s default account only.' }))
    }
    expect(other.agent().switchRequest).toBeUndefined()
    other.f.run({ ...other.request, profileId: defaultProfileId('host', 'codex') })
    const missing = setup()
    missing.f.state.machines![0]!.engines = ['claude']
    expect(code(() => missing.f.run(missing.request))).toBe('ENGINE_NOT_OFFERED')
  })

  // Task #3022 (Ken, 11-05): a PM runs at high effort or above, whoever moves it.
  it('refuses an effort below high, and asks for high when a model is named with none', () => {
    for (const effort of ['medium', 'low', 'minimal']) {
      const s = setup()
      expect(code(() => s.f.run({ ...s.request, model: 'gpt-6-astra', effort }))).toBe('EFFORT_TOO_LOW')
      expect(s.agent().switchRequest).toBeUndefined()
    }
    const named = setup()
    named.f.run({ ...named.request, model: 'gpt-6-astra' })
    expect(named.agent().switchRequest).toMatchObject({ model: 'gpt-6-astra', effort: 'high' })
    const xhigh = setup()
    xhigh.f.run({ ...xhigh.request, model: 'gpt-6-astra', effort: 'xhigh' })
    expect(xhigh.agent().switchRequest).toMatchObject({ effort: 'xhigh' })
    // Review of #3066, 3: Claude Opus named with no effort keeps the coordinator's own default, as its start does.
    const opus = setup()
    opus.f.run({ ...opus.request, engine: 'claude', profileId: 'default', model: 'opus' })
    expect(opus.agent().switchRequest).toMatchObject({ model: 'opus', effort: 'xhigh' })
    // No model named: the engine's own model and effort, as before.
    const own = setup()
    own.f.run(own.request)
    expect(own.agent().switchRequest).not.toHaveProperty('effort')
  })

  // Task #3395 (anh Dee, 11-05): Switch PM's "Default" sent no model, and the new PM started on its engine's own
  // default (the machine's last-used Claude Code model, Sonnet medium). Claude with no model gets the coordinator's
  // built-in default, as lead.start does; a person's named model is kept.
  it('gives a Claude switch with no model the PM default, on the same machine and on another, and keeps a named one', () => {
    const here = setup()
    here.f.run({ ...here.request, engine: 'claude', profileId: 'default' })
    expect(here.agent().switchRequest).toMatchObject({ engine: 'claude', model: 'opus', effort: 'xhigh' })

    const moved = setup()
    const destination = structuredClone(moved.f.state.machines![0]!)
    Object.assign(destination, { machineId: 'destination', name: 'Destination Mac', generation: 'g2' })
    destination.observation!.generation = 'g2'
    destination.observation!.capabilities = ['leadSwitch', 'leadStart']
    moved.f.state.machines!.push(destination)
    moved.f.run({ ...moved.request, engine: 'claude', profileId: 'default', machineId: 'destination' })
    expect(moved.agent().switchRequest).toMatchObject({ targetMachineId: 'destination', model: 'opus', effort: 'xhigh' })
    expect(moved.f.state.starts).toContainEqual(expect.objectContaining({ request: expect.objectContaining({
      machineId: 'destination', engine: 'claude', model: 'opus', effort: 'xhigh' }) }))

    const picked = setup()
    picked.f.run({ ...picked.request, engine: 'claude', profileId: 'default', model: 'sonnet' })
    expect(picked.agent().switchRequest).toMatchObject({ model: 'sonnet', effort: 'high' })
    const effort = setup()
    effort.f.run({ ...effort.request, engine: 'claude', profileId: 'default', effort: 'max' })
    expect(effort.agent().switchRequest).toMatchObject({ model: 'opus', effort: 'max' })
  })

  it('works while the Swarm is paused', () => {
    const s = setup()
    s.f.state.paused = true
    s.f.run(s.request)
    expect(s.agent().switchRequest).toBeDefined()
  })

  it('starts a destination candidate with the chosen model while the source remains the project lead', () => {
    const s = setup()
    const destination = structuredClone(s.f.state.machines![0]!)
    destination.machineId = 'destination'
    destination.name = 'Destination Mac'
    destination.generation = 'g2'
    destination.observation!.generation = 'g2'
    destination.observation!.capabilities = ['leadSwitch', 'leadStart']
    s.f.state.machines!.push(destination)

    s.f.run({ ...s.request, machineId: 'destination', model: 'gpt-5.1' })

    expect(s.agent().switchRequest).toMatchObject({ targetMachineId: 'destination', model: 'gpt-5.1' })
    expect(s.f.state.conversations.find(c => c.id === 'lead')!.leadId).toBe(s.pm)
    expect(s.f.state.starts).toContainEqual(expect.objectContaining({ request: expect.objectContaining({
      machineId: 'destination', model: 'gpt-5.1', leadFor: expect.objectContaining({ switchId: s.sid() }) }) }))
  })

  it('starts a candidate whose switch, asked before the default account alone, names another account on the default one', () => {
    const s = setup()
    const destination = structuredClone(s.f.state.machines![0]!)
    destination.machineId = 'destination'
    destination.generation = 'g2'
    destination.observation!.generation = 'g2'
    destination.observation!.capabilities = ['leadSwitch', 'leadStart']
    s.f.state.machines!.push(destination)
    s.f.run({ ...s.request, machineId: 'destination', model: 'gpt-5.1' })
    const start = s.f.state.starts!.find(candidate => candidate.request.leadFor?.switchId === s.sid())!
    s.f.run({ type: 'agent.switchClaim', agentId: s.pm, switchId: s.sid() }, s.as)
    s.f.run({ type: 'agent.switchHandoff', agentId: s.pm, switchId: s.sid(), handoffChangeId: 'e'.repeat(32), note: 'Handoff' }, s.as)
    // The destination still reports the account, as a CLI of the last 30 days does; that CLI starts it on its default account.
    s.agent().switchRequest!.profileId = WORK
    s.f.state.starts!.find(candidate => candidate.id === start.id)!.request.profileId = WORK
    s.f.run({ type: 'agent.startDispatch', startId: start.id }, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null } })
    const dispatched = s.f.state.starts!.find(candidate => candidate.id === start.id)!
    expect(dispatched.dispatched).toBe(true)
    expect(dispatched.request.profileId).toBe(defaultProfileId('destination', 'codex'))
    expect(s.agent().switchRequest!.profileId).toBe(defaultProfileId('destination', 'codex'))
  })

  it('publishes the prepared handoff only to the destination host start after the source claims the switch', () => {
    const s = setup()
    const destination = structuredClone(s.f.state.machines![0]!)
    destination.machineId = 'destination'
    destination.generation = 'g2'
    destination.observation!.generation = 'g2'
    destination.observation!.capabilities = ['leadSwitch', 'leadStart']
    s.f.state.machines!.push(destination)
    s.f.run({ ...s.request, machineId: 'destination', model: 'gpt-5.1' })
    const switchId = s.sid()
    const start = s.f.state.starts!.find(candidate => candidate.request.leadFor?.switchId === switchId)!
    s.f.run({ type: 'agent.switchClaim', agentId: s.pm, switchId }, s.as)

    s.f.run({ type: 'agent.switchHandoff', agentId: s.pm, switchId, handoffChangeId: 'f'.repeat(32), note: 'Prior work summary.' }, s.as)

    expect(s.f.state.starts!.find(candidate => candidate.request.leadFor?.switchId === switchId)!.request)
      .toMatchObject({ handoffChangeId: 'f'.repeat(32), handoffSourceAgentId: s.agent().harnessId, handoffNote: 'Prior work summary.' })
  })

  it('requires the source claim before dispatch and keeps the handoff out of ordinary reads', () => {
    const s = setup()
    const destination = structuredClone(s.f.state.machines![0]!)
    destination.machineId = 'destination'
    destination.generation = 'g2'
    destination.observation!.generation = 'g2'
    destination.observation!.capabilities = ['leadSwitch', 'leadStart']
    s.f.state.machines!.push(destination)
    s.f.run({ ...s.request, machineId: 'destination', model: 'gpt-5.1' })
    const switchId = s.sid()
    const start = s.f.state.starts!.find(candidate => candidate.request.leadFor?.switchId === switchId)!
    const contribution = { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null }

    expect(code(() => s.f.run({ type: 'agent.startDispatch', startId: start.id }, owner, { contribution }))).toBe('HANDOFF_PENDING')
    expect(visibleState(s.f.state, owner).starts![0]!.request).not.toHaveProperty('handoffNote')
    expect(code(() => s.f.run({ type: 'agent.switchHandoff', agentId: s.pm, switchId, handoffChangeId: 'f'.repeat(32), note: 'private' }, s.as)))
      .toBe('STALE_SWITCH')

    s.f.run({ type: 'agent.switchClaim', agentId: s.pm, switchId }, s.as)
    s.f.run({ type: 'agent.switchHandoff', agentId: s.pm, switchId, handoffChangeId: 'f'.repeat(32), note: 'private' }, s.as)
    expect(visibleState(s.f.state, owner).starts![0]!.request).not.toHaveProperty('handoffNote')
    expect(s.f.state.starts!.find(candidate => candidate.request.leadFor?.switchId === switchId)!.request.handoffNote).toBe('private')
  })

  it('promotes a running destination candidate to the same lead conversation exactly when it starts', () => {
    const s = setup()
    s.agent().configuration.engine = 'claude'
    const destination = structuredClone(s.f.state.machines![0]!)
    destination.machineId = 'destination'
    destination.name = 'Destination Mac'
    destination.generation = 'g2'
    destination.observation!.generation = 'g2'
    destination.observation!.capabilities = ['leadSwitch', 'leadStart']
    s.f.state.machines!.push(destination)
    s.f.run({ ...s.request, machineId: 'destination', model: 'gpt-5.1' })
    const switchId = s.sid()
    const start = s.f.state.starts!.find(candidate => candidate.request.leadFor?.switchId === switchId)!
    const contribution = { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null }
    s.f.run({ type: 'agent.switchClaim', agentId: s.pm, switchId }, s.as)
    s.f.run({ type: 'agent.switchHandoff', agentId: s.pm, switchId, handoffChangeId: 'f'.repeat(32), note: 'Prior work' }, s.as)

    const started = s.f.run({ type: 'agent.started', startId: start.id, harnessId: 'destination-pm',
      configuration: { ...config, engine: 'codex', model: 'gpt-5.1' } }, owner, { contribution })

    const candidateId = started.result.agentId as string
    expect(s.f.state.conversations.find(c => c.id === 'lead')!.leadId).toBe(candidateId)
    expect(s.f.state.agents.find(a => a.id === s.pm)!.switchLanded).toMatchObject({ id: switchId, candidateAgentId: candidateId })
    const result = s.f.run({ type: 'agent.switchResult', agentId: s.pm, switchId, ok: true }, s.as)
    expect(result.messages.at(-1)!.text).toContain('PM moved to Codex')
  })

  // Security review of #4558: the account a moved PM lands on would be the destination machine's owner's. No person moves a PM
  // onto another member's computer at all (Swarm v3, #4120), so no member's account runs it without their knowing.
  it('refuses moving the PM onto another member\'s computer', () => {
    const s = setup()
    const destination = structuredClone(s.f.state.machines![0]!)
    Object.assign(destination, { machineId: 'destination', name: 'Peer Mac', generation: 'g2', contributorId: 'peer',
      membershipGeneration: s.f.state.people.find(p => p.id === 'peer')!.generation })
    destination.observation!.generation = 'g2'
    destination.observation!.capabilities = ['leadSwitch', 'leadStart']
    s.f.state.machines!.push(destination)
    for (const profileId of [WORK, 'default']) {
      expect(code(() => s.f.run({ ...s.request, profileId, machineId: 'destination', model: 'gpt-5.1' }))).toBe('NOT_YOUR_COMPUTER')
    }
    expect(s.agent().switchRequest).toBeUndefined()
  })

  it('keeps the source lead and posts one safe line when the destination candidate fails', () => {
    const s = setup()
    const destination = structuredClone(s.f.state.machines![0]!)
    destination.machineId = 'destination'
    destination.generation = 'g2'
    destination.observation!.generation = 'g2'
    destination.observation!.capabilities = ['leadSwitch', 'leadStart']
    s.f.state.machines!.push(destination)
    s.f.run({ ...s.request, machineId: 'destination', model: 'gpt-5.1' })
    const startId = s.f.state.starts!.find(candidate => candidate.request.leadFor?.switchId === s.sid())!.id

    const failed = s.f.run({ type: 'agent.startFailed', startId, error: '/private/path: sign in failed' }, owner)

    expect(s.f.state.conversations.find(c => c.id === 'lead')!.leadId).toBe(s.pm)
    expect(s.agent().switchRequest).toBeUndefined()
    expect(failed.messages).toHaveLength(1)
    expect(failed.messages[0]!.text).toBe("Couldn't switch the PM: its machine could not prepare or launch it. It is back on Codex.")
    expect(s.f.run({ type: 'agent.startFailed', startId, error: '/private/path: sign in failed' }, owner).messages).toEqual([])
  })

  it('lets only the PM itself claim, with a 15 minute lease', () => {
    const s = setup()
    s.f.run(s.request)
    const claim = { type: 'agent.switchClaim', agentId: s.pm, switchId: s.sid() } as const
    expect(code(() => s.f.run(claim))).toBe('STALE_SWITCH')
    expect(code(() => s.f.run({ ...claim, switchId: 'other' }, s.as))).toBe('STALE_SWITCH')
    const claimed = s.f.run(claim, s.as)
    expect(claimed.result).toMatchObject({ expiresAt: 1000 + 15 * 60_000 })
    expect(s.agent().switchRequest!.claimedUntil).toBe(new Date(1000 + 15 * 60_000).toISOString())
  })

  it('writes the result in the PM chat and clears the request', () => {
    const s = setup()
    s.f.run(s.request)
    const done = s.f.run({ type: 'agent.switchResult', agentId: s.pm, switchId: s.sid(), ok: true }, s.as)
    expect(done.messages).toMatchObject([{ conversationId: 'lead', recipients: [], text: 'PM moved to Codex.' }])
    expect(s.agent().switchRequest).toBeUndefined()
    expect(s.agent().profileId).toBeUndefined()
    const bad = setup()
    bad.f.run(bad.request)
    expect(code(() => bad.f.run({ type: 'agent.switchResult', agentId: bad.pm, switchId: 'nope', ok: true }, bad.as))).toBe('STALE_SWITCH')
    const failed = bad.f.run({ type: 'agent.switchResult', agentId: bad.pm, switchId: bad.sid(), ok: false, error: 'no sign-in' }, bad.as)
    expect(failed.messages[0]!.text).toBe('Couldn\'t switch the PM: no sign-in. It is back on Codex.')
    expect(bad.agent().switchRequest).toBeUndefined()
    expect(bad.agent().profileId).toBeUndefined()
  })

  it('refuses a borrower of a lent machine, and lets the machine\'s lender switch', () => {
    // Tony (peer) borrowed Ken's Mac: the pool's contributor is Tony, the machine's owner is Ken.
    const lent = setup(['leadSwitch'], 'peer')
    lent.agent().machineOwnerId = 'ken'
    expect(code(() => lent.f.run(lent.request, peer))).toBe('PROJECT_OWNER_REQUIRED')
    const lender = setup(['leadSwitch'], 'peer')
    lender.agent().machineOwnerId = 'peer'
    lender.f.run(lender.request, peer)
    expect(lender.agent().switchRequest).toMatchObject({ requestedBy: 'peer' })
  })

  it('serves a machine\'s accounts only to its owner and the owners of projects whose PM runs there', () => {
    const s = setup(['leadSwitch'], 'peer')
    s.agent().machineOwnerId = 'peer'
    s.f.state.people.push({ id: 'third', email: 'third@example.com', role: 'member', generation: 'g' } as never)
    const read = (actor: Actor) => visibleState(s.f.state, actor, 1000).machines?.[0]?.observation?.profiles
    expect(read(owner)).toHaveLength(1)
    expect(read(peer)).toHaveLength(1)
    expect(read({ kind: 'person', userId: 'third', email: 'third@example.com' })).toBeUndefined()
    expect(read({ ...s.as, machineOwnerId: 'peer' })).toBeUndefined()
  })

  it('drops a request nobody claimed on any machine\'s report, and refuses a late claim', () => {
    const s = setup()
    s.f.run(s.request)
    const claim = { type: 'agent.switchClaim', agentId: s.pm, switchId: s.sid() } as const
    expect(code(() => s.f.run(claim, s.as, { now: 1000 + SWITCH_UNCLAIMED_MS }))).toBe('STALE_SWITCH')
    const swept = sweepLiveness(s.f.state, 1000 + SWITCH_UNCLAIMED_MS)
    expect(swept).toMatchObject([{ text: "Couldn't switch the PM: its machine did not answer." }])
    expect(s.agent().switchRequest).toBeUndefined()
  })

  it('does not extend a claim\'s lease by claiming again', () => {
    const s = setup()
    s.f.run(s.request)
    const claim = { type: 'agent.switchClaim', agentId: s.pm, switchId: s.sid() } as const
    s.f.run(claim, s.as)
    const again = s.f.run(claim, s.as, { now: 1000 + 10 * 60_000 })
    expect(again.result).toMatchObject({ expiresAt: 1000 + 15 * 60_000 })
    expect(s.agent().switchRequest!.claimedUntil).toBe(new Date(1000 + 15 * 60_000).toISOString())
  })

  it('agent.rebind that keeps the account leaves the limit mark, one that moves it clears it', () => {
    const s = setup()
    s.agent().limitedUntil = new Date(5_000_000).toISOString()
    s.agent().alerting = ['limit', 'prompt']
    s.f.run(s.request)
    const rebind = (patch: object, from: string, to: string) => s.f.run({ type: 'agent.rebind', agentId: s.pm, machineId: 'host', projectId: 'lead',
      previousHarnessId: from, harnessId: to, configuration: config, ...patch } as never, s.as)
    // Same engine (codex), no profile: the limited account stays, though a request for another one was pending.
    rebind({}, 'pm', 'pm-2')
    expect(s.agent()).toMatchObject({ alerting: ['limit', 'prompt'], limitedUntil: new Date(5_000_000).toISOString() })
    expect(s.agent().switchRequest).toBeUndefined()
    // Same engine, another account reported: the mark goes.
    rebind({ profileId: WORK }, 'pm-2', 'pm-3')
    expect(s.agent()).toMatchObject({ alerting: ['prompt'], limitedUntil: null, profileId: WORK })
    // Another engine without a profile: back to the default account.
    rebind({ configuration: { ...config, engine: 'claude' } }, 'pm-3', 'pm-4')
    expect(s.agent().profileId).toBeUndefined()
    // Same engine, no profile: kept.
    s.agent().profileId = WORK
    rebind({ configuration: { ...config, engine: 'claude' } }, 'pm-4', 'pm-5')
    expect(s.agent().profileId).toBe(WORK)
  })

  it('names the default account by one id: a rebind that keeps it never clears the limit', () => {
    const s = setup()
    const DEFAULT = defaultProfileId('host', 'codex')
    s.agent().limitedUntil = new Date(5_000_000).toISOString()
    s.agent().alerting = ['limit']
    const rebind = (profileId: string, from: string, to: string) => s.f.run({ type: 'agent.rebind', agentId: s.pm, machineId: 'host', projectId: 'lead',
      previousHarnessId: from, harnessId: to, configuration: config, profileId } as never, s.as)
    rebind(DEFAULT, 'pm', 'pm-2')
    expect(s.agent()).toMatchObject({ alerting: ['limit'], limitedUntil: new Date(5_000_000).toISOString() })
    expect(s.agent().profileId).toBeUndefined()
    rebind('default', 'pm-2', 'pm-3')
    expect(s.agent().limitedUntil).toBe(new Date(5_000_000).toISOString())
    // A legacy stored hex default counts as the default too.
    s.agent().profileId = DEFAULT
    rebind('default', 'pm-3', 'pm-4')
    expect(s.agent().limitedUntil).toBe(new Date(5_000_000).toISOString())
    expect(s.agent().profileId).toBeUndefined()
    // The Claude default is not the Codex default.
    rebind(defaultProfileId('host', 'claude'), 'pm-4', 'pm-5')
    expect(s.agent()).toMatchObject({ limitedUntil: null, profileId: defaultProfileId('host', 'claude') })
  })

  it('stores a literal default switch as the default account\'s id, and reports it with no label', () => {
    const s = setup()
    s.f.run({ ...s.request, profileId: 'default' })
    expect(s.agent().switchRequest!.profileId).toBe(defaultProfileId('host', 'codex'))
    const done = s.f.run({ type: 'agent.switchResult', agentId: s.pm, switchId: s.sid(), ok: true }, s.as)
    expect(done.messages[0]!.text).toBe('PM moved to Codex.')
    expect(s.agent().profileId).toBeUndefined()
    const hex = setup()
    hex.f.run({ ...hex.request, profileId: defaultProfileId('host', 'codex') })
    expect(hex.agent().switchRequest!.profileId).toBe(defaultProfileId('host', 'codex'))
    const other = setup()
    expect(code(() => other.f.run({ ...other.request, profileId: defaultProfileId('host', 'claude') }))).toBe('DEFAULT_ACCOUNT_ONLY')
  })

  it('writes one line per switch: a late or repeated result writes nothing', () => {
    const s = setup()
    s.f.run(s.request)
    const switchId = s.sid()
    const result = { type: 'agent.switchResult', agentId: s.pm, switchId, ok: true } as const
    // The sweep gave up on it first: the host's late result is stale.
    const late = setup()
    late.f.run(late.request)
    const lateId = late.sid()
    sweepLiveness(late.f.state, 1000 + SWITCH_UNCLAIMED_MS)
    expect(code(() => late.f.run({ ...result, switchId: lateId }, late.as))).toBe('STALE_SWITCH')
    // The rebind landed it: the result still tells the chat once, and a retry with a new operation id does not.
    s.f.run({ type: 'agent.rebind', agentId: s.pm, machineId: 'host', projectId: 'lead', previousHarnessId: 'pm', harnessId: 'pm-2',
      configuration: { ...config, engine: 'claude' } }, s.as)
    expect(s.f.run(result, s.as).messages[0]!.text).toBe('PM moved to Claude.')
    expect(code(() => s.f.run(result, s.as))).toBe('STALE_SWITCH')
    // A made-up id with nothing pending is refused too.
    expect(code(() => s.f.run({ ...result, switchId: 'made-up' }, s.as))).toBe('STALE_SWITCH')
  })

  it('never says a landed switch failed: a rebind that beat a failure report wins', () => {
    const s = setup()
    s.f.run(s.request)
    const switchId = s.sid()
    s.f.run({ type: 'agent.rebind', agentId: s.pm, machineId: 'host', projectId: 'lead', previousHarnessId: 'pm', harnessId: 'pm-2', profileId: WORK,
      configuration: { ...config, engine: 'codex' } }, s.as)
    const done = s.f.run({ type: 'agent.switchResult', agentId: s.pm, switchId, ok: false, error: 'the new session did not start in time' }, s.as)
    expect(done.messages[0]!.text).toBe('PM moved to Codex.')
  })

  it('says a PM that has not come back is not back', () => {
    const s = setup()
    s.f.run(s.request)
    const failed = s.f.run({ type: 'agent.switchResult', agentId: s.pm, switchId: s.sid(), ok: false, error: 'the new session could not start', down: true }, s.as)
    expect(failed.messages[0]!.text).toBe("Couldn't switch the PM: the new session could not start. It has not come back on Codex yet; its machine keeps trying.")
  })

  it('writes the host\'s error as one clean line', () => {
    const s = setup()
    s.f.run(s.request)
    const failed = s.f.run({ type: 'agent.switchResult', agentId: s.pm, switchId: s.sid(), ok: false, error: 'signed out.\nplease\tretry.. ' }, s.as)
    expect(failed.messages[0]!.text).toBe("Couldn't switch the PM: signed out. please retry. It is back on Codex.")
  })

  // Desktop dropped the page where a person offered another account and could take it back (F9): a PM a switch left on one is
  // moved back to the default account (pmAccount.ts).
  describe('a PM on another account of its machine', () => {
    const onWork = (capabilities?: string[]) => {
      const s = setup(capabilities)
      s.agent().profileId = WORK
      return s
    }
    const fresh = (s: ReturnType<typeof setup>, now: number) => { s.f.state.machines![0]!.observation!.receivedAt = now }
    const failed = (s: ReturnType<typeof setup>) =>
      s.f.run({ type: 'agent.switchResult', agentId: s.pm, switchId: s.sid(), ok: false, error: 'not signed in' }, s.as)

    it('is moved to the default account by its machine, as Switch PM would, and its chat hears it once', () => {
      const s = onWork()
      expect(sweepLiveness(s.f.state, 1000)).toMatchObject([{ conversationId: 'lead', recipients: [], text: 'Moving the PM to Studio\'s default account.' }])
      expect(s.agent().switchRequest).toEqual({ id: expect.any(String), engine: 'codex', profileId: defaultProfileId('host', 'codex'), model: 'test-model',
        effort: 'high', requestedBy: s.agent().machineOwnerId, at: new Date(1000).toISOString() })
      const switchId = s.sid()
      // Asked once: the next sweeps leave the request as it is.
      expect(sweepLiveness(s.f.state, 1000)).toEqual([])
      expect(s.sid()).toBe(switchId)
      // Its machine carries it out like any switch.
      s.f.run({ type: 'agent.switchClaim', agentId: s.pm, switchId }, s.as)
      expect(s.f.run({ type: 'agent.switchResult', agentId: s.pm, switchId, ok: true }, s.as).messages[0]!.text).toBe('PM moved to Codex.')
      expect(s.agent().profileId).toBeUndefined()
      expect(sweepLiveness(s.f.state, 1000)).toEqual([])
      expect(s.agent().switchRequest).toBeUndefined()
      expect(s.agent().accountReturn).toBeUndefined()
    })

    it('is asked again 2, 4, 8 minutes after each failed try ended, and its chat hears once after the third', () => {
      const s = onWork()
      let now = 1000
      const sweep = (at: number) => { now = at; fresh(s, now); return sweepLiveness(s.f.state, now) }
      const asked = () => s.agent().switchRequest !== undefined
      sweep(now)
      failed(s)
      // The wait starts once the sweep sees the try ended, however long it ran.
      sweep(now + 10 * 60_000)
      expect(sweep(now + 2 * 60_000 - 1)).toEqual([])
      expect(asked()).toBe(false)
      sweep(now + 1)
      expect(asked()).toBe(true)
      failed(s)
      sweep(now + 10_000)
      sweep(now + 4 * 60_000 - 1)
      expect(asked()).toBe(false)
      sweep(now + 1)
      expect(asked()).toBe(true)
      failed(s)
      expect(sweep(now + 10_000)).toEqual([])
      expect(sweep(now + 1)).toMatchObject([{ conversationId: 'lead',
        text: 'The PM still runs on another account on Studio: moving it to the default account failed 3 times. Use Switch PM to move it.' }])
      expect(asked()).toBe(false)
      // It keeps being asked, saying nothing more, at most 6 hours apart: its account is spent while it stays.
      expect(sweep(now + 8 * 60_000)).toEqual([])
      expect(asked()).toBe(true)
      failed(s)
      s.agent().accountReturn = { tries: 20, at: now }
      sweep(now + 6 * 3_600_000 - 1)
      expect(asked()).toBe(false)
      expect(sweep(now + 1)).toEqual([])
      expect(asked()).toBe(true)
      // Once it lands on the default account, nothing is left.
      s.f.run({ type: 'agent.switchResult', agentId: s.pm, switchId: s.sid(), ok: true }, s.as)
      sweep(now)
      expect(s.agent().accountReturn).toBeUndefined()
      expect(asked()).toBe(false)
    })

    it('asks for high effort or above, as Switch PM does', () => {
      const s = onWork()
      s.agent().configuration = { ...s.agent().configuration, effort: 'medium' }
      sweepLiveness(s.f.state, 1000)
      expect(s.agent().switchRequest).toMatchObject({ model: 'test-model', effort: 'high' })
    })

    it('waits for its machine to be online, new enough and offering its engine, and leaves a PM on the default account alone', () => {
      const offline = onWork()
      expect(sweepLiveness(offline.f.state, 1000 + 60_000)).toEqual([])
      expect(offline.agent().switchRequest).toBeUndefined()
      const old = onWork([])
      expect(sweepLiveness(old.f.state, 1000)).toEqual([])
      expect(old.agent().switchRequest).toBeUndefined()
      const gone = onWork()
      gone.f.state.machines![0]!.engines = ['claude']
      expect(sweepLiveness(gone.f.state, 1000)).toEqual([])
      expect(gone.agent().switchRequest).toBeUndefined()
      // A stored hex default is the default account too.
      const plain = setup()
      plain.agent().profileId = defaultProfileId('host', 'codex')
      expect(sweepLiveness(plain.f.state, 1000)).toEqual([])
      expect(plain.agent().switchRequest).toBeUndefined()
    })
  })
})

// A task's priority, P0-P3 (task #3117): a hotfix for a broken release must not wait behind ordinary work.
describe('a task\'s priority (conversation.create)', () => {
  function prioritized() {
    const f = routed()
    const task = (id: string) => f.state.conversations.find(g => g.id === id)!
    // An agent's task says its check, priority and who asked (taskContract.ts); a step carries no priority, a person's defaults.
    const create = (fields: Record<string, unknown> = {}, actor: Actor = f.leadActor) =>
      f.run(commandSchema.parse({ type: 'conversation.create', title: 'Sign-in broken', brief: 'Fix it.',
        checks: [{ description: 'Done', independent: false }], ...actor.kind === 'agent' && !fields.reviewOf ? { priority: 'P2', requesterId: 'owner' } : {}, ...fields }), actor)
    return { f, task, create }
  }

  it('takes the PM\'s priority when it creates a task', () => {
    const { task, create } = prioritized()
    const created = create({ priority: 'P0' })
    expect(created.result).toMatchObject({ priority: 'P0' })
    expect(created.result.warnings ?? []).not.toContainEqual(expect.stringContaining('No priority given'))
    expect(task(created.result.conversationId as string).priority).toBe('P0')
    expect(groupView(task(created.result.conversationId as string), new Set())).toMatchObject({ priority: 'P0' })
  })

  it('gives a task created without one P2, and the reply says so', () => {
    const { task, create } = prioritized()
    const created = create({}, owner)
    expect(task(created.result.conversationId as string).priority).toBe('P2')
    expect(created.result).toMatchObject({ priority: 'P2',
      warnings: expect.arrayContaining(['No priority given: this task is P2. Give P0-P3 when you create a task.']) })
  })

  it('lets only the PM or a person create a P0, while any agent may open a P1-P3 task', () => {
    const { f, task, create } = prioritized()
    expect(() => create({ priority: 'P0' }, f.workerActor)).toThrow(expect.objectContaining({ code: 'PRIORITY_P0', status: 403 }))
    expect(task(create({ priority: 'P1' }, f.workerActor).result.conversationId as string).priority).toBe('P1')
    expect(task(create({ priority: 'P0' }, owner).result.conversationId as string).priority).toBe('P0')
  })

  it('takes only P0 to P3', () => {
    const parse = (priority: unknown) => commandSchema.safeParse({ type: 'conversation.create', title: 'T', brief: 'B', checks: [], priority }).success
    for (const priority of ['P0', 'P1', 'P2', 'P3']) expect(parse(priority)).toBe(true)
    for (const priority of ['P4', 'p0', 'high', 'urgent', 0, null]) expect(parse(priority), String(priority)).toBe(false)
  })
})

describe('agent.rename (renaming a harness renames its agent, task #2912)', () => {
  const rename = (agentId: string, name: string): Command => ({ type: 'agent.rename', agentId, name })
  const shownTo = (f: ReturnType<typeof fixture>, reader: Actor, agentId: string) =>
    visibleState(f.state, reader).agents.find(a => a.id === agentId)!.displayName
  const peerContributorAgent = (f: ReturnType<typeof fixture>) => { f.invite(); return f.add('mine', 'peer') }

  it('lets the agent\'s contributor rename it, and every reader sees the new name', () => {
    const f = fixture(), agentId = peerContributorAgent(f)
    f.run(rename(agentId, '  Darren\'s PM  '), peer)
    expect(shownTo(f, owner, agentId)).toBe('Darren\'s PM')
    expect(shownTo(f, peer, agentId)).toBe('Darren\'s PM')
    // A later command does not hand it a generated name again.
    f.run({ type: 'conversation.create', title: 'Later', brief: 'Anything.', checks: [] })
    expect(shownTo(f, owner, agentId)).toBe('Darren\'s PM')
  })

  it('lets the machine owner rename it', () => {
    const f = fixture(), agentId = peerContributorAgent(f)
    f.state.people.push({ id: 'host-owner', email: 'host-owner@example.com', role: 'collaborator', generation: 'g' } as never)
    f.run(rename(agentId, 'Studio'), { kind: 'person', userId: 'host-owner', email: 'host-owner@example.com' })
    expect(shownTo(f, owner, agentId)).toBe('Studio')
  })

  it('refuses a teammate who is neither, the Swarm owner and an agent, writing nothing', () => {
    const f = fixture(), agentId = peerContributorAgent(f), other = f.add('other', 'owner')
    const before = JSON.stringify(f.state)
    for (const [actor, code] of [
      [owner, 'FORBIDDEN'],
      [{ kind: 'agent', agentId: other, machineOwnerId: 'host-owner' }, 'FORBIDDEN'],
      [{ kind: 'agent', agentId, machineOwnerId: 'host-owner' }, 'FORBIDDEN'],
    ] as Array<[Actor, string]>) {
      expect(() => f.run(rename(agentId, 'Stolen'), actor), JSON.stringify(actor)).toThrow(expect.objectContaining({ code }))
    }
    expect(JSON.stringify(f.state)).toBe(before)
  })

  it('refuses a role\'s name, another agent\'s name, an empty or invisible name', () => {
    const f = fixture(), agentId = f.add('mine'), taken = f.add('taken')
    f.run(rename(taken, 'Quinn'))
    for (const name of ['Lead', 'Engineer 2', 'Reviewer', 'quinn', ' ', '​​']) {
      expect(() => f.run(rename(agentId, name)), name).toThrow(expect.objectContaining({ code: expect.stringMatching(/^(AGENT_NAME_ROLE|AGENT_NAME_TAKEN|INVALID_AGENT_NAME)$/) }))
    }
    expect(commandSchema.safeParse(rename(agentId, 'x'.repeat(201))).success).toBe(false)
    // Its own name again is no conflict.
    f.run(rename(taken, 'Quinn'))
  })

  // Security review 2 of #3015: an agent's name passes every rule a person's does, and tells nobody what they cannot read.
  it('refuses the Swarm\'s own voices, a web address or link, and a blank made of Braille (security review 2)', () => {
    const f = fixture(), agentId = f.add('mine')
    for (const name of ['System', 'Harness', 'Admin', 'Everyone', 'You', 'Someone 2', 'Tester', 'www.evil.example', '[Approve](https://ev.il)', '[Approve](//ev.il)',
      'Lead\u2800', '\u2800', '\u2800\u2800\u2800']) {
      expect(() => f.run(rename(agentId, name)), name).toThrow(expect.objectContaining({ code: expect.stringMatching(/^(INVALID_AGENT_NAME|AGENT_NAME_ROLE|INVALID_NAME|NAME_RESERVED)$/) }))
    }
  })

  it('refuses a name a person here goes by: their name, username or email', () => {
    const f = fixture(), agentId = f.add('mine')
    f.invite()
    f.state.people.find(p => p.id === 'peer')!.name = 'Minh Nguyen'
    for (const name of ['minh nguyen', 'Ｍinh Nguyen', 'peer', '@Peer', 'peer@example.com', 'owner']) {
      expect(() => f.run(rename(agentId, name)), name).toThrow(expect.objectContaining({ code: expect.stringMatching(/^(AGENT_NAME_TAKEN|NAME_TAKEN)$/) }))
    }
  })

  it('does not tell a reader that an agent they cannot read has a name (security review 2)', () => {
    const f = fixture()
    f.invite()
    const other = f.run({ type: 'project.create', name: 'Other', visibility: 'private', brief: '' }).result
    const hidden = f.add('hidden', 'owner', other.conversationId as string)
    f.run(rename(hidden, 'Quinn'))
    const mine = f.add('mine', 'peer')
    // The peer reads nothing of the private project: the name is not taken for them, and no refusal says it exists.
    f.run(rename(mine, 'Quinn'), peer)
    expect(shownTo(f, peer, mine)).toBe('Quinn')
    // The owner reads both, so a second Quinn is refused for them.
    const third = f.add('third', 'owner')
    expect(() => f.run(rename(third, 'Quinn'))).toThrow(expect.objectContaining({ code: 'AGENT_NAME_TAKEN' }))
  })

  it('refuses a viewer', () => {
    const f = fixture()
    f.invite()
    const agentId = f.add('mine', 'peer')
    f.state.people.find(p => p.id === 'peer')!.role = 'viewer'
    expect(() => f.run(rename(agentId, 'Studio'), peer)).toThrow(expect.objectContaining({ code: 'READ_ONLY' }))
  })

  it('refuses a non-member and an agent of the machine owner, writing nothing', () => {
    const f = fixture()
    f.invite()
    const agentId = f.add('mine', 'peer')
    const team = f.add('team-agent', 'owner')
    const before = JSON.stringify(f.state)
    // Not a member of this Swarm at all.
    expect(() => f.run(rename(agentId, 'Studio'), { kind: 'person', userId: 'stranger', email: 'stranger@example.com' }), 'non-member').toThrow()
    // An agent the machine owner runs acts as an agent, never as the person.
    expect(() => f.run(rename(agentId, 'Studio'), { kind: 'agent', agentId: team, machineOwnerId: 'host-owner' }), 'team session').toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(JSON.stringify(f.state)).toBe(before)
  })

  // Task #2912, security review 2: Add agent sends the typed harness name, so it gets the same rules; a name that fails them
  // gives the agent a member name instead, as a role's name does, and the add still succeeds.
  it('agent.add gives a member name to a name that is the Swarm\'s voice, a link, a person\'s or another agent\'s', () => {
    const f = fixture()
    f.invite()
    f.state.people.find(p => p.id === 'peer')!.name = 'Minh Nguyen'
    f.run(rename(f.add('first'), 'Quinn'))
    const group = f.group()
    const named = (name: string, harnessId: string) => {
      const id = f.run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId, name, configuration: config, lead: false },
        owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
      f.run({ type: 'conversation.create', title: `After ${harnessId}`, brief: 'Anything.', checks: [] })
      return f.state.agents.find(a => a.id === id)!.displayName
    }
    for (const [i, name] of ['System', 'Everyone', '[Approve](https://ev.il)', 'minh nguyen', 'peer@example.com', 'quinn', 'Lead\u2800'].entries()) {
      expect(named(name, `h${i}`), name).not.toBe(name)
      expect(named(name, `h${i}`)).toBeTruthy()
    }
    expect(named('Release notes', 'ok')).toBe('Release notes')
  })

  // The row Add agent writes in the project chat names the agent as readers see it, never the name the rules refused.
  it('agent.add in the project chat writes no refused name into its row', () => {
    const f = fixture()
    for (const [i, name] of ['[Approve](https://ev.il)', '[Approve](//ev.il)', 'System'].entries()) {
      const effects = f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: `p${i}`, name, configuration: config, lead: false },
        owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } })
      const row = effects.messages.find(m => m.text.includes('to the project'))!.text
      expect(row, name).not.toContain(name)
      // Both halves name the agent as its readers' lists show it: its member name, not "Agent".
      const shown = visibleState(f.state, owner).agents.find(a => a.id === effects.result.agentId)!.displayName!
      expect(row, name).toBe(`owner added "${shown}" to the project. The project chat holds only its coordinator among agents, so "${shown}" works in its tasks.`)
    }
  })

  it('cleans credentials out of the name', () => {
    const github = ['ghp', 'Fixture0Token1Not2Real3Value4abcdefgh'].join('_'), removed: CredentialKind[] = []
    expect(withoutCredentials(rename('a', github), removed)).toMatchObject({ name: CREDENTIAL_MARKER })
    expect(removed).toEqual(['github'])
  })
})

// Task #3211 (vie, 11-05): a project whose lead started in a folder with no GitHub origin has nothing to clone, so its work
// starts on other machines in an empty folder of its own, without a worktree; a project with a repository keeps today's rule.
describe('a start for a project with no repository', () => {
  const pool = (machineId: string) => ({ machineId, name: machineId, contributorId: 'owner', membershipGeneration: 'pilot', generation: 'g1',
    cwd: '/data/swarm-projects/tab', scope: 'swarm' as const, engines: ['claude'], maxAgents: 4, paused: false,
    observation: { generation: 'g1', receivedAt: 1000, capabilities: [LEAD_CAPABILITY], resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null,
      diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null, deviceType: null, chip: null, os: null, gpuPercent: null },
      tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] } })
  const setUp = (repositoryUrl: string | null) => {
    const f = fixture(), lead = f.add('lead', 'owner', 'lead', true), group = f.group()
    f.state.machines = [{ ...pool('source'), membershipGeneration: f.state.people[0]!.generation }, { ...pool('other'), membershipGeneration: f.state.people[0]!.generation }]
    f.state.projects![0]!.repository = { machineId: 'source', cwd: '/Users/vie/outreach', repositoryUrl }
    return { f, lead, group }
  }
  const start = (repositoryUrl: string | null, machineId: string, cwd: string) => {
    const { f, lead, group } = setUp(repositoryUrl)
    const actor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host-owner' }
    const request = { conversationId: group, machineId, engine: 'claude', name: 'Writer', cwd, worktree: true, branchRef: 'refs/remotes/origin/main',
      requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: [], devices: [], quotaRequired: false } }
    f.run({ type: 'agent.start', request } as Command, actor, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
    return f.state.starts!.at(-1)!.request
  }

  it('starts on another machine in the project\'s own folder there, without a worktree', () => {
    const request = start(null, 'other', '/data/swarm-projects/tab/lead')
    expect(request).toMatchObject({ machineId: 'other', cwd: '/data/swarm-projects/tab/lead', worktree: false })
    expect(request.branchRef).toBeUndefined()
  })

  it('keeps a worktree on the machine whose folder it started in, and wherever it has a repository', () => {
    expect(start(null, 'source', '/Users/vie/outreach')).toMatchObject({ worktree: true, branchRef: 'refs/remotes/origin/main' })
    expect(start('https://github.com/vie/outreach', 'other', '/data/swarm-projects/tab/lead')).toMatchObject({ worktree: true, branchRef: 'refs/remotes/origin/main' })
  })

  it('starts its Product Manager on another machine without a worktree too', () => {
    const { f } = setUp(null)
    const project = f.state.projects![0]!
    const leadFor = { projectId: project.id, personId: 'owner', generation: f.state.people[0]!.generation }
    expect(leadHost(f.state, project, 'other', { engine: 'claude' }, leadFor, { now: 1000 })).toMatchObject({ cwd: '/data/swarm-projects/tab/lead', worktree: false })
    f.state.projects![0]!.repository!.repositoryUrl = 'https://github.com/vie/outreach'
    expect(leadHost(f.state, project, 'other', { engine: 'claude' }, leadFor, { now: 1000 })).toMatchObject({ worktree: true })
  })
})

describe('a held task shows one of four reasons', () => {
  const REASONS = {
    task: (taskNumber: number) => ({ kind: 'task' as const, taskNumber }),
    person: { kind: 'person' as const, personId: 'owner', defaultAt: '2026-11-06T02:00:00.000Z' },
    reset: { kind: 'reset' as const, what: 'quota' as const, at: '2026-11-06T09:00:00.000Z' },
    requester: { kind: 'requester' as const },
  }

  it('shows each of the four reasons on a not-before hold, and on blocked and needs_human work', () => {
    const f = fixture(), group = f.group(), worker = f.add('worker', 'owner', group), other = f.group()
    const task = () => f.state.conversations.find(c => c.id === group)!
    const reasons = { ...REASONS, task: REASONS.task(f.state.conversations.find(c => c.id === other)!.number!) }
    for (const [name, reason] of Object.entries(reasons)) {
      Object.assign(task(), { notBefore: '2026-12-04', hold: reason })
      expect(groupView(task(), new Set()).held, name).toEqual(reason)
    }
    delete task().notBefore
    delete task().hold
    storedAssignment(f.state, group, worker, 1000)
    for (const held of ['blocked', 'needs_human'] as const) {
      for (const [name, reason] of Object.entries(reasons)) {
        storedStatus(f.state, group, held, 'Waiting.').hold = reason
        expect(groupView(task(), new Set()).held, `${held} ${name}`).toEqual(reason)
      }
    }
  })

  it('shows a hold from before reasons as no reason, and a task that is not held as nothing', () => {
    const f = fixture(), held = f.group(), open = f.group(), blocked = f.group(), worker = f.add('worker', 'owner', blocked)
    const task = (id: string) => f.state.conversations.find(c => c.id === id)!
    task(held).notBefore = '2026-12-04'
    expect(groupView(task(held), new Set()).held).toEqual({ kind: 'none' })
    expect(groupView(task(open), new Set())).not.toHaveProperty('held')
    storedAssignment(f.state, blocked, worker, 1000)
    storedStatus(f.state, blocked, 'blocked', 'Waiting.')
    expect(groupView(task(blocked), new Set()).held).toEqual({ kind: 'none' })
  })
})
