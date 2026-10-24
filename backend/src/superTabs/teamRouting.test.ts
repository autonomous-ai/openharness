import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { admitMachineStart, machineObservationSchema, machineSlots, observedPrivacy, PRIVACY_FRESH_MS, removalPreview, teamWorkRefusal, type ContributedMachine, type MachinePrivacy } from './machines.js'
import { createSuperTab, SuperTabError, visibleState, type Actor, type AgentConfiguration, type AgentStart, type SuperTabState } from './model.js'
import type { RouteDecision } from './routeRecord.js'

// Teammates' work runs only on Team machines (docs/plans/2026-10-24-swarm-team-account.md, Task 3): a start or an
// assignment for a project whose owner did not contribute the machine needs a Harness Team account whose privacy check
// passed, or a machine used only for agents. A person's own projects on their own machine are unchanged.
//
// Everything below runs with the rule required everywhere (SWARM_TEAM_ACCOUNT_REQUIRED=1), except the last block: until
// then, a machine without a team account takes a teammate's work as it did before.
beforeEach(() => { process.env.SWARM_TEAM_ACCOUNT_REQUIRED = '1' })
afterEach(() => { delete process.env.SWARM_TEAM_ACCOUNT_REQUIRED })

const NOW = 50_000_000
const MINUTE = 60_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
const config: AgentConfiguration = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const requirements = { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }
const resources = { cpuPercent: 1, memoryTotalBytes: 8, memoryUsedBytes: 1, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
const PASSED: MachinePrivacy = { mode: 'account', passed: true, checkedAt: NOW - MINUTE }
const FAILED: MachinePrivacy = { mode: 'account', passed: false, item: 'gitconfig', detail: 'The team account could read ~/.gitconfig.', checkedAt: NOW - MINUTE }
type Reading = NonNullable<ContributedMachine['observation']>
/** A reading as the store keeps it: stamped with the reporting session's kind and, from a team session, its privacy. */
const reading = (sessionKind: 'team' | 'computer', privacy?: MachinePrivacy, receivedAt = NOW, seenAt = receivedAt): Reading => ({
  generation: 'g1', receivedAt, sessionKind, resources, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [],
  ...(privacy ? { privacy: { ...privacy, seenAt } } : {}) })
const refusal = (body: () => unknown): SuperTabError | null => {
  try { body(); return null } catch (error) { if (error instanceof SuperTabError) return error; throw error }
}

/** The owner's Swarm: the owner's project ('lead') and the teammate's own project, the owner's Mac, the teammate's
 *  personal MacBook and the teammate's Team machine, all contributed for every project. */
function swarm() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: mate.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, mate)
  const generation = (userId: string) => state.people.find(p => p.id === userId)!.generation
  const pool = (machineId: string, contributorId: string, name: string, observation: Reading): ContributedMachine => ({ machineId, name, contributorId,
    membershipGeneration: generation(contributorId), generation: 'g1', cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 4, paused: false, observation })
  state.machines = [
    pool('owner-mac', 'owner', 'Owner Mac', reading('computer')),
    pool('mate-mac', 'mate', 'MacBook Pro', reading('computer')),
    pool('mate-team', 'mate', 'MacBook Pro · Team', reading('team', PASSED)),
  ]
  const mine = String(run({ type: 'project.create', name: 'Mine', visibility: 'public', brief: '' }, mate).result.projectId)
  const group = (projectId = 'lead', actor: Actor = owner) => String(run({ type: 'conversation.create', projectId, title: 'Work', brief: 'Build it.',
    checks: [{ description: 'Tests pass.', independent: false }] }, actor).result.conversationId)
  /** An agent already in the Swarm on [machineId], run by [contributorId]'s grant there. */
  const member = (id: string, machineId: string, contributorId: string, projectId = 'lead', extra: Record<string, unknown> = {}) => {
    state.agents.push({ id, machineId, harnessId: `harness-${id}`, projectId, machineOwnerId: contributorId, contributorId,
      membershipGeneration: generation(contributorId), hostGrant: null, name: id, configuration: config, ...extra })
    return id
  }
  const machine = (machineId: string) => state.machines!.find(m => m.machineId === machineId)!
  /** A start request for [conversationId] on a contributed machine, in the folder the contribution gives that project. */
  const request = (conversationId: string, machineId: string, projectId = 'lead') =>
    ({ conversationId, machineId, engine: 'codex', name: 'Builder', cwd: `/swarm/${projectId}`, worktree: true, requirements })
  const pooled = (machineId: string) => ({ contribution: { machineOwnerId: machine(machineId).contributorId, contributorId: machine(machineId).contributorId, hostGrant: null } })
  return { run, group, member, machine, request, pooled, mine, get state() { return state } }
}

describe('the privacy field of a machine reading', () => {
  const { receivedAt: _receivedAt, sessionKind: _kind, ...sent } = reading('computer')

  it('takes each shape the Harness Team account sends, and nothing else', () => {
    for (const privacy of [PASSED, FAILED, { mode: 'dedicated' }, { ...FAILED, item: 'unchecked', detail: 'The privacy check did not run: EIO' }]) {
      expect(machineObservationSchema.safeParse({ ...sent, privacy }).success, JSON.stringify(privacy)).toBe(true)
    }
    expect(machineObservationSchema.safeParse(sent).success).toBe(true)
    for (const privacy of [
      { mode: 'account', passed: true }, { ...PASSED, item: 'gitconfig' }, { ...PASSED, checkedAt: -1 }, { ...PASSED, checkedAt: 'now' },
      { mode: 'account', passed: false, item: 'gitconfig', checkedAt: NOW }, { ...FAILED, item: 'Git Config' }, { ...FAILED, item: '' },
      { ...FAILED, detail: 'x'.repeat(1001) }, { mode: 'dedicated', passed: true }, { mode: 'vm' }, { ...PASSED, extra: 1 }, null,
    ]) expect(machineObservationSchema.safeParse({ ...sent, privacy }).success, JSON.stringify(privacy)).toBe(false)
  })

  it('is kept only from a team session\'s reading, dated by when this server first received that check', () => {
    expect(observedPrivacy(undefined, PASSED, true, NOW)).toEqual({ ...PASSED, seenAt: NOW })
    // An ordinary computer's reading proves nothing about a team account, so what it claims is dropped.
    expect(observedPrivacy(undefined, PASSED, false, NOW)).toBeUndefined()
    expect(observedPrivacy({ ...PASSED, seenAt: NOW }, { mode: 'dedicated' }, false, NOW)).toBeUndefined()
    expect(observedPrivacy({ ...PASSED, seenAt: NOW }, undefined, true, NOW)).toBeUndefined()
    // The same check sent again keeps its first date, so a check that stops running goes stale whatever the Mac's clock says.
    expect(observedPrivacy({ ...PASSED, seenAt: NOW - 20 * MINUTE }, PASSED, true, NOW)).toEqual({ ...PASSED, seenAt: NOW - 20 * MINUTE })
    expect(observedPrivacy({ ...PASSED, seenAt: NOW - 20 * MINUTE }, { ...PASSED, checkedAt: NOW }, true, NOW)).toEqual({ ...PASSED, checkedAt: NOW, seenAt: NOW })
    expect(observedPrivacy({ ...PASSED, seenAt: NOW - 20 * MINUTE }, { ...FAILED, checkedAt: PASSED.checkedAt }, true, NOW)).toMatchObject({ passed: false, seenAt: NOW })
    expect(observedPrivacy({ mode: 'dedicated', seenAt: NOW - 20 * MINUTE }, { mode: 'dedicated' }, true, NOW)).toEqual({ mode: 'dedicated', seenAt: NOW - 20 * MINUTE })
  })

  it('shows a failing check\'s detail only to the machine\'s contributor', () => {
    const f = swarm()
    f.machine('mate-team').observation = reading('team', FAILED)
    const privacy = (actor: Actor) => visibleState(f.state, actor, NOW).machines!.find(m => m.machineId === 'mate-team')!.observation!.privacy
    expect(privacy(mate)).toMatchObject({ item: 'gitconfig', detail: FAILED.detail })
    expect(privacy(owner)).toEqual({ mode: 'account', passed: false, item: 'gitconfig', checkedAt: FAILED.checkedAt, seenAt: NOW })
  })
})

describe('which machines take a teammate\'s project', () => {
  const pool = (observation?: Reading) => ({ machineId: 'mac', name: 'MacBook Pro', contributorId: 'mate', membershipGeneration: 'g', generation: 'g1',
    cwd: '/swarm', engines: ['codex'], maxAgents: 2, paused: false, ...(observation ? { observation } : {}) }) as ContributedMachine

  it('a Team machine whose privacy check passed and is fresh', () => {
    expect(teamWorkRefusal(pool(reading('team', PASSED)), NOW)).toBeNull()
    // Fresh up to the bound, measured from when the server first received the check.
    expect(teamWorkRefusal(pool(reading('team', PASSED, NOW, NOW - PRIVACY_FRESH_MS)), NOW)).toBeNull()
  })

  it('a machine used only for agents', () => {
    expect(teamWorkRefusal(pool(reading('team', { mode: 'dedicated' }, NOW, NOW - 60 * MINUTE)), NOW)).toBeNull()
  })

  it('not with a stale check', () => {
    expect(teamWorkRefusal(pool(reading('team', PASSED, NOW, NOW - PRIVACY_FRESH_MS - MINUTE)), NOW)).toEqual({ code: 'PRIVACY_CHECK_STALE',
      reason: 'The privacy check on MacBook Pro last passed 16 minutes ago, so it runs only its owner\'s projects until it passes again.' })
  })

  it('not with a failing check, naming the item', () => {
    expect(teamWorkRefusal(pool(reading('team', FAILED)), NOW)).toEqual({ code: 'PRIVACY_CHECK_FAILED',
      reason: 'The Harness Team account on MacBook Pro is not private (gitconfig: it could read its owner\'s ~/.gitconfig), so it runs only its owner\'s projects.' })
    expect(teamWorkRefusal(pool(reading('team', { ...FAILED, item: 'standard-user' })), NOW)?.reason).toContain('(standard-user: the team account is an administrator)')
    expect(teamWorkRefusal(pool(reading('team', { ...FAILED, item: 'unchecked' })), NOW)?.reason).toContain('(unchecked: the check did not run)')
    expect(teamWorkRefusal(pool(reading('team', { ...FAILED, item: 'icloud' })), NOW)?.reason).toContain('(icloud)')
  })

  it('not on a machine with no Harness Team account', () => {
    expect(teamWorkRefusal(pool(reading('computer')), NOW)).toEqual({ code: 'TEAM_ACCOUNT_REQUIRED',
      reason: 'MacBook Pro has no Harness Team account yet, so it runs only its owner\'s projects.' })
    // A reading from before readings were stamped with their session is an ordinary machine's.
    const { sessionKind: _kind, ...unstamped } = reading('computer')
    expect(teamWorkRefusal(pool(unstamped as Reading), NOW)?.code).toBe('TEAM_ACCOUNT_REQUIRED')
  })

  it('not on a Team machine that reported no privacy check', () => {
    expect(teamWorkRefusal(pool(reading('team')), NOW)).toEqual({ code: 'PRIVACY_UNCHECKED',
      reason: 'MacBook Pro has not reported a privacy check from its Harness Team account, so it runs only its owner\'s projects.' })
    // Its account row says team, but the reading came from an ordinary sign-in, which carries no privacy.
    expect(teamWorkRefusal(pool(reading('computer')), NOW, true)?.code).toBe('PRIVACY_UNCHECKED')
  })

  it('not while offline', () => {
    for (const offline of [pool(), pool(reading('team', PASSED, NOW - 46_000))]) {
      expect(teamWorkRefusal(offline, NOW)).toEqual({ code: 'MACHINE_OFFLINE',
        reason: 'MacBook Pro is offline, so it cannot show that its Harness Team account is private.' })
    }
  })
})

describe('starting a teammate\'s work', () => {
  it('is refused on a personal machine, with a reason a person understands', () => {
    const f = swarm(), group = f.group()
    expect(refusal(() => f.run({ type: 'agent.start', request: f.request(group, 'mate-mac') }, owner, f.pooled('mate-mac'))))
      .toMatchObject({ code: 'TEAM_ACCOUNT_REQUIRED', status: 403, message: 'MacBook Pro has no Harness Team account yet, so it runs only its owner\'s projects.' })
    expect(f.state.starts ?? []).toEqual([])
  })

  it('is admitted on the teammate\'s Team machine whose privacy check passed', () => {
    const f = swarm(), group = f.group()
    f.run({ type: 'agent.start', request: f.request(group, 'mate-team') }, owner, f.pooled('mate-team'))
    expect(f.state.starts).toHaveLength(1)
  })

  it('is refused on a Team machine whose check is stale, failing or missing, and while it is offline', () => {
    for (const [observation, code] of [[reading('team', PASSED, NOW, NOW - 20 * MINUTE), 'PRIVACY_CHECK_STALE'], [reading('team', FAILED), 'PRIVACY_CHECK_FAILED'],
      [reading('team'), 'PRIVACY_UNCHECKED'], [reading('team', PASSED, NOW - 60_000), 'MACHINE_OFFLINE']] as const) {
      const f = swarm(), group = f.group()
      f.machine('mate-team').observation = observation
      expect(refusal(() => f.run({ type: 'agent.start', request: f.request(group, 'mate-team') }, owner, f.pooled('mate-team')))?.code).toBe(code)
    }
  })

  it('reads the account row too: a team row with an ordinary reading has no privacy check to show', () => {
    const f = swarm(), group = f.group()
    expect(refusal(() => f.run({ type: 'agent.start', request: f.request(group, 'mate-mac') }, owner, { ...f.pooled('mate-mac'), teamMachines: ['mate-mac'] }))?.code)
      .toBe('PRIVACY_UNCHECKED')
  })

  it('leaves a person\'s own projects on their own machines as they were', () => {
    const f = swarm()
    f.run({ type: 'agent.start', request: f.request(f.group(), 'owner-mac') }, owner, f.pooled('owner-mac'))
    const mine = f.group(f.mine, mate)
    f.run({ type: 'agent.start', request: f.request(mine, 'mate-mac', f.mine) }, mate, f.pooled('mate-mac'))
    expect(f.state.starts).toHaveLength(2)
    // The teammate's project on the owner's Mac is the same rule the other way round.
    expect(refusal(() => f.run({ type: 'agent.start', request: f.request(mine, 'owner-mac', f.mine) }, mate, f.pooled('owner-mac')))?.code).toBe('TEAM_ACCOUNT_REQUIRED')
  })

  it('is re-checked when its host launches it: an admitted start whose check went stale waits', () => {
    const f = swarm(), group = f.group()
    f.run({ type: 'agent.start', request: f.request(group, 'mate-team') }, owner, f.pooled('mate-team'))
    const start = f.state.starts![0]! as AgentStart
    f.machine('mate-team').observation = reading('team', PASSED, NOW, NOW - 20 * MINUTE)
    expect(refusal(() => admitMachineStart(f.state, start.request, NOW, start))?.code).toBe('PRIVACY_CHECK_STALE')
  })

  it('is refused on a machine outside the Swarm\'s Machines list, which shows no privacy check', () => {
    const f = swarm(), group = f.group()
    // The teammate by hand, on their own uncontributed laptop, for the owner's project.
    expect(refusal(() => f.run({ type: 'agent.start', request: { ...f.request(group, 'mate-laptop'), cwd: '/work' } }, mate,
      { contribution: { machineOwnerId: 'mate', contributorId: 'mate' } }))).toMatchObject({ code: 'TEAM_ACCOUNT_REQUIRED',
      message: 'This machine is not a Team machine of this Swarm, so it runs only its owner\'s projects.' })
    // Their own project there, or the owner's project on a machine shared with the owner by name, as before.
    f.run({ type: 'agent.start', request: { ...f.request(f.group(f.mine, mate), 'mate-laptop'), cwd: '/work' } }, mate, { contribution: { machineOwnerId: 'mate', contributorId: 'mate' } })
    f.run({ type: 'agent.start', request: { ...f.request(group, 'shared-mac'), cwd: '/work' } }, owner, { contribution: { machineOwnerId: 'mate', contributorId: 'owner', hostGrant: 'grant-1' } })
    expect(f.state.starts).toHaveLength(2)
  })
})

describe('giving an existing agent a teammate\'s work', () => {
  it('work.assign is refused for an agent on a personal machine and admitted on a Team machine', () => {
    const f = swarm(), group = f.group()
    const personal = f.member('personal', 'mate-mac', 'mate'), team = f.member('team', 'mate-team', 'mate')
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: group, agentId: personal })))
      .toMatchObject({ code: 'TEAM_ACCOUNT_REQUIRED', status: 403, message: 'MacBook Pro has no Harness Team account yet, so it runs only its owner\'s projects.' })
    f.run({ type: 'work.assign', conversationId: group, agentId: team })
    expect(f.state.conversations.find(c => c.id === group)!.assignment).toMatchObject({ agentId: team, status: 'working' })
  })

  it('work.assign of a person\'s own project to their own agent is unchanged', () => {
    const f = swarm(), group = f.group(f.mine, mate)
    const personal = f.member('personal', 'mate-mac', 'mate', f.mine)
    f.run({ type: 'work.assign', conversationId: group, agentId: personal }, mate)
    expect(f.state.conversations.find(c => c.id === group)!.assignment).toMatchObject({ agentId: personal })
  })

  it('adding a Reviewer to a group, which hands it the review, is refused on a personal machine', () => {
    const f = swarm(), group = f.group()
    const reviewer = f.member('reviewer', 'mate-mac', 'mate', 'lead', { role: 'reviewer' })
    expect(refusal(() => f.run({ type: 'conversation.agent', conversationId: group, agentId: reviewer, present: true, lead: false }))?.code).toBe('TEAM_ACCOUNT_REQUIRED')
    const teamReviewer = f.member('team-reviewer', 'mate-team', 'mate', 'lead', { role: 'reviewer' })
    f.run({ type: 'conversation.agent', conversationId: group, agentId: teamReviewer, present: true, lead: false })
    expect(f.state.conversations.find(c => c.id === group)!.agentIds).toContain(teamReviewer)
  })
})

describe('routing a teammate\'s work', () => {
  const candidate = (id: string, machineId: string, patch: Record<string, unknown> = {}) => ({ id, kind: 'new', machineId, engine: 'codex',
    model: 'default', effort: 'default', quality: 3, cost: 2, title: `${id} on ${machineId}`, label: `Label ${id}`, ...patch })
  const record = (candidates: unknown[], pick = 'c0') => ({ assessment: { difficulty: 'medium', risk: 'low', why: 'A small change.' },
    candidates, excluded: [{ title: 'Owner Mac · claude', reason: 'Subscription exhausted.' }], floor: 2, notes: false, pick, via: 'order', p: null,
    belowFloor: false, why: 'Policy order.' })
  function routed() {
    const f = swarm()
    const lead = String(f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: 'lead', name: 'Lead', configuration: config, lead: true },
      owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).result.agentId)
    const group = f.group()
    const leadActor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'owner' }
    const personal = f.member('personal', 'mate-mac', 'mate')
    return { ...f, get state() { return f.state }, group, leadActor, personal }
  }

  it('leaves out the machines that cannot take it, and says why', () => {
    const f = routed()
    const effects = f.run({ type: 'route.record', conversationId: f.group, decision: record([candidate('c0', 'mate-team'), candidate('c1', 'mate-mac'),
      candidate('c2', 'mate-mac', { kind: 'member', agentId: f.personal, title: 'personal on mate-mac' }), candidate('c3', 'owner-mac')]) } as Command,
    f.leadActor, { recentRoutes: 0 })
    expect(effects.routeDecisions[0]).toMatchObject({ op: 'create', record: {
      candidates: [{ id: 'c0' }, { id: 'c3' }],
      excluded: [
        { title: 'c1 on mate-mac', reason: 'MacBook Pro has no Harness Team account yet, so it runs only its owner\'s projects.' },
        { title: 'personal on mate-mac', reason: 'MacBook Pro has no Harness Team account yet, so it runs only its owner\'s projects.' },
        { title: 'Owner Mac · claude', reason: 'Subscription exhausted.' },
      ] } })
    expect(effects.messages[0]!.source).toMatchObject({ pick: { id: 'c0' }, alternatives: [{ id: 'c3', title: 'c3 on owner-mac' }] })
  })

  it('names the failing item and a stale or missing check in the exclusion', () => {
    const f = routed()
    f.state.machines!.push({ ...structuredClone(f.machine('mate-team')), machineId: 'mate-stale', name: 'Mini · Team',
      observation: reading('team', PASSED, NOW, NOW - 30 * MINUTE) })
    f.machine('mate-team').observation = reading('team', FAILED)
    const effects = f.run({ type: 'route.record', conversationId: f.group, decision: record([candidate('c0', 'owner-mac'), candidate('c1', 'mate-team'),
      candidate('c2', 'mate-stale')]) } as Command, f.leadActor, { recentRoutes: 0 })
    expect((effects.routeDecisions[0] as { record: { excluded: { reason: string }[] } }).record.excluded.map(e => e.reason)).toEqual([
      'The Harness Team account on MacBook Pro · Team is not private (gitconfig: it could read its owner\'s ~/.gitconfig), so it runs only its owner\'s projects.',
      'The privacy check on Mini · Team last passed 30 minutes ago, so it runs only its owner\'s projects until it passes again.',
      'Subscription exhausted.',
    ])
  })

  it('refuses a pick that cannot take it, so no decision names it', () => {
    const f = routed()
    expect(refusal(() => f.run({ type: 'route.record', conversationId: f.group, decision: record([candidate('c0', 'mate-mac'), candidate('c1', 'mate-team')]) } as Command,
      f.leadActor, { recentRoutes: 0 }))).toMatchObject({ code: 'TEAM_ACCOUNT_REQUIRED',
      message: 'MacBook Pro has no Harness Team account yet, so it runs only its owner\'s projects. Route again.' })
  })

  it('refuses a person\'s reroute to a candidate whose machine can no longer take it', () => {
    const f = routed()
    const decision = { id: 'd1', conversationId: f.group, record: record([candidate('c0', 'owner-mac'), candidate('c1', 'mate-team')]),
      final: null, override: null, assignmentId: null, outcome: null } as unknown as RouteDecision
    f.machine('mate-team').observation = reading('team', FAILED)
    expect(refusal(() => f.run({ type: 'route.override', decisionId: 'd1', candidateId: 'c1', reason: 'More quota there.' }, owner, { routeDecision: decision }))?.code)
      .toBe('PRIVACY_CHECK_FAILED')
    f.machine('mate-team').observation = reading('team', PASSED)
    expect(f.run({ type: 'route.override', decisionId: 'd1', candidateId: 'c1', reason: 'More quota there.' }, owner, { routeDecision: decision }).routeDecisions)
      .toEqual([expect.objectContaining({ op: 'override', id: 'd1' })])
  })

  it('keeps a person\'s own project routing as it was', () => {
    const f = routed()
    const effects = f.run({ type: 'route.record', conversationId: f.group, decision: record([candidate('c0', 'owner-mac')]) } as Command, f.leadActor, { recentRoutes: 0 })
    expect(effects.routeDecisions[0]).toMatchObject({ record: { candidates: [{ id: 'c0' }], excluded: [{ title: 'Owner Mac · claude' }] } })
  })
})

describe('agents already working on a personal machine', () => {
  it('keep their task, its reports and their messages; only new work for them is refused', () => {
    const f = swarm(), group = f.group()
    // Work assigned before the rule: a teammate's agent on their personal Mac doing the owner's project.
    const old = f.member('old', 'mate-mac', 'mate')
    const work = f.state.conversations.find(c => c.id === group)!
    work.agentIds.push(old)
    work.assignment = { id: 'before-release', agentId: old, status: 'working', configuration: config,
      execution: { machineId: 'mate-mac', harnessId: 'harness-old', machineOwnerId: 'mate' }, result: null }
    const oldActor: Actor = { kind: 'agent', agentId: old, machineOwnerId: 'mate' }
    f.run({ type: 'work.status', conversationId: group, assignmentId: 'before-release', status: 'blocked', result: 'Needs a token.' }, oldActor)
    expect(f.run({ type: 'message.send', conversationId: group, text: 'Here it is.', replyTo: null, recipientIds: [old] }).messages[0]!.recipients).toEqual([old])
    expect(f.state.agents.find(a => a.id === old)).not.toHaveProperty('workDecision')
    expect(f.state.conversations.find(c => c.id === group)!.assignment).toMatchObject({ id: 'before-release', status: 'blocked' })
    f.run({ type: 'work.cancel', conversationId: group, assignmentId: 'before-release', reason: 'Moving it.' })
    expect(refusal(() => f.run({ type: 'work.assign', conversationId: group, agentId: old }))?.code).toBe('TEAM_ACCOUNT_REQUIRED')
  })
})

describe('until a team account is required everywhere', () => {
  beforeEach(() => { delete process.env.SWARM_TEAM_ACCOUNT_REQUIRED })
  const pool = (observation?: Reading) => ({ machineId: 'mac', name: 'MacBook Pro', contributorId: 'mate', membershipGeneration: 'g', generation: 'g1',
    cwd: '/swarm', engines: ['codex'], maxAgents: 2, paused: false, ...(observation ? { observation } : {}) }) as ContributedMachine

  it('a machine without a team account takes a teammate\'s project as before, online or not', () => {
    expect(teamWorkRefusal(pool(reading('computer')), NOW)).toBeNull()
    expect(teamWorkRefusal(pool(reading('computer', undefined, NOW - 60 * MINUTE)), NOW)).toBeNull()
    expect(teamWorkRefusal(pool(), NOW)).toBeNull()
  })

  it('a machine with one already follows the rule, by its reading or its account row', () => {
    expect(teamWorkRefusal(pool(reading('team', FAILED)), NOW)?.code).toBe('PRIVACY_CHECK_FAILED')
    expect(teamWorkRefusal(pool(reading('team', PASSED, NOW, NOW - 20 * MINUTE)), NOW)?.code).toBe('PRIVACY_CHECK_STALE')
    expect(teamWorkRefusal(pool(reading('computer')), NOW, true)?.code).toBe('PRIVACY_UNCHECKED')
    expect(teamWorkRefusal(pool(reading('team', PASSED)), NOW)).toBeNull()
  })

  it('starts, assignments and Reviewers on a personal machine or off the Machines list are admitted as before', () => {
    const f = swarm(), group = f.group()
    f.run({ type: 'agent.start', request: f.request(group, 'mate-mac') }, owner, f.pooled('mate-mac'))
    f.run({ type: 'agent.start', request: { ...f.request(group, 'mate-laptop'), cwd: '/work' } }, mate, { contribution: { machineOwnerId: 'mate', contributorId: 'mate' } })
    expect(f.state.starts).toHaveLength(2)
    const personal = f.member('personal', 'mate-mac', 'mate')
    f.run({ type: 'work.assign', conversationId: group, agentId: personal })
    expect(f.state.conversations.find(c => c.id === group)!.assignment).toMatchObject({ agentId: personal, status: 'working' })
    const reviewer = f.member('reviewer', 'mate-mac', 'mate', 'lead', { role: 'reviewer' })
    f.run({ type: 'conversation.agent', conversationId: f.group(), agentId: reviewer, present: true, lead: false })
  })

  it('a Team machine whose check fails still refuses it', () => {
    const f = swarm(), group = f.group()
    f.machine('mate-team').observation = reading('team', FAILED)
    expect(refusal(() => f.run({ type: 'agent.start', request: f.request(group, 'mate-team') }, owner, f.pooled('mate-team')))?.code).toBe('PRIVACY_CHECK_FAILED')
  })
})

// One machine ("One machine" in docs/plans/2026-10-24-swarm-team-account.md): a Mac's Harness Team account is a
// mechanism under the scenes. Its pool names the Mac it lives on (`hostMachineId`), shows the Mac's name, joins where
// the Mac was added and follows the Mac's pause, slots and removal. A teammate's project started on the Mac runs in
// the team account; the Mac's owner's own projects stay with the owner's daemon.
describe('one machine: a Mac and its Harness Team account', () => {
  function oneMachine() {
    const f = swarm()
    Object.assign(f.machine('mate-team'), { hostMachineId: 'mate-mac', name: 'MacBook Pro', cwd: '/team-swarm' })
    return f
  }

  it('a teammate\'s project started on the Mac runs in its Harness Team account, in that account\'s folder', () => {
    const f = oneMachine(), group = f.group()
    f.run({ type: 'agent.start', request: f.request(group, 'mate-mac') }, owner, f.pooled('mate-mac'))
    expect(f.state.starts).toEqual([expect.objectContaining({ poolGeneration: 'g1', machineOwnerId: 'mate',
      request: expect.objectContaining({ machineId: 'mate-team', cwd: '/team-swarm/lead' }) })])
    // A Lead that already named the team account's folder keeps it.
    f.run({ type: 'agent.start', request: { ...f.request(group, 'mate-mac'), cwd: '/team-swarm/lead' } }, owner, f.pooled('mate-mac'))
    expect(f.state.starts![1]!.request).toMatchObject({ machineId: 'mate-team', cwd: '/team-swarm/lead' })
  })

  it('is refused with the team account\'s own reason, and never falls back to the Mac\'s owner', () => {
    const f = oneMachine(), group = f.group()
    f.machine('mate-team').observation = reading('team', FAILED)
    expect(refusal(() => f.run({ type: 'agent.start', request: f.request(group, 'mate-mac') }, owner, f.pooled('mate-mac')))).toMatchObject({
      code: 'PRIVACY_CHECK_FAILED', message: 'The Harness Team account on MacBook Pro is not private (gitconfig: it could read its owner\'s ~/.gitconfig), so it runs only its owner\'s projects.' })
    f.machine('mate-team').observation = reading('team', PASSED, NOW - 60_000)
    expect(refusal(() => f.run({ type: 'agent.start', request: f.request(group, 'mate-mac') }, owner, f.pooled('mate-mac')))?.code).toBe('MACHINE_OFFLINE')
    expect(f.state.starts ?? []).toEqual([])
  })

  it('leaves the Mac\'s owner\'s own projects on the owner\'s daemon', () => {
    const f = oneMachine(), mine = f.group(f.mine, mate)
    f.run({ type: 'agent.start', request: f.request(mine, 'mate-mac', f.mine) }, mate, f.pooled('mate-mac'))
    expect(f.state.starts![0]!.request).toMatchObject({ machineId: 'mate-mac', cwd: `/swarm/${f.mine}` })
  })

  it('still takes a start that names the team account\'s machine directly', () => {
    const f = oneMachine(), group = f.group()
    f.run({ type: 'agent.start', request: { ...f.request(group, 'mate-team'), cwd: '/team-swarm/lead' } }, owner, f.pooled('mate-team'))
    expect(f.state.starts![0]!.request).toMatchObject({ machineId: 'mate-team' })
  })

  it('a Mac whose team account is not in the Swarm refuses as before', () => {
    const f = oneMachine(), group = f.group()
    f.state.machines = f.state.machines!.filter(m => m.machineId !== 'mate-team')
    expect(refusal(() => f.run({ type: 'agent.start', request: f.request(group, 'mate-mac') }, owner, f.pooled('mate-mac')))?.code).toBe('TEAM_ACCOUNT_REQUIRED')
  })

  it('a machines rule naming the Mac allows its team account', () => {
    const f = oneMachine(), group = f.group()
    f.run({ type: 'rule.set', projectId: 'lead', rule: { kind: 'machines', machineIds: ['mate-mac'] }, text: 'Only the MacBook Pro.' })
    const effects = f.run({ type: 'agent.start', request: f.request(group, 'mate-mac') }, owner, f.pooled('mate-mac'))
    expect(effects.result.warnings).toBeUndefined()
    expect(effects.messages).toEqual([])
  })

  it('a route that picked the Mac for a teammate\'s project keeps it, and the start there is the pick', () => {
    const f = oneMachine()
    const lead = String(f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: 'lead', name: 'Lead', configuration: config, lead: true },
      owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).result.agentId)
    const group = f.group(), leadActor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'owner' }
    const candidate = { id: 'c0', kind: 'new', machineId: 'mate-mac', engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2,
      title: 'Builder on MacBook Pro', label: 'Codex' }
    const effects = f.run({ type: 'route.record', conversationId: group, decision: { assessment: { difficulty: 'medium', risk: 'low', why: 'A small change.' },
      candidates: [candidate], excluded: [], floor: 2, notes: false, pick: 'c0', via: 'order', p: null, belowFloor: false, why: 'Policy order.' } } as Command,
    leadActor, { recentRoutes: 0 })
    const recorded = effects.routeDecisions[0] as unknown as { id: string; record: RouteDecision['record'] }
    expect(recorded.record.candidates).toEqual([expect.objectContaining({ id: 'c0' })])
    const decision = { id: recorded.id, conversationId: group, record: recorded.record, final: null, override: null, assignmentId: null, outcome: null } as unknown as RouteDecision
    const started = f.run({ type: 'agent.start', routeDecisionId: recorded.id, request: { ...f.request(group, 'mate-mac'), model: 'default', effort: 'default' } },
      leadActor, { ...f.pooled('mate-mac'), routeDecision: decision })
    expect(f.state.starts!.at(-1)!.request.machineId).toBe('mate-team')
    expect(started.routeDecisions).toEqual([expect.objectContaining({ op: 'final', id: recorded.id })])
    expect(started.routeDecisions[0]).not.toHaveProperty('override')
  })

  it('joins by itself where its owner added the Mac, under the Mac\'s name, slots and pause', () => {
    const f = swarm()
    f.state.machines = f.state.machines!.filter(m => m.machineId !== 'mate-team')
    f.machine('mate-mac').paused = true
    const join = { type: 'machine.contribute', machineId: 'mate-team', name: 'MacBook Pro · Team', cwd: '/team-swarm', scope: 'swarm', engines: ['codex'],
      maxAgents: 2, ifMissing: true } as Command
    f.run(join, mate, { contribution: { machineOwnerId: 'mate', contributorId: 'mate', hostMachineId: 'mate-mac' } })
    expect(f.machine('mate-team')).toMatchObject({ hostMachineId: 'mate-mac', name: 'MacBook Pro', cwd: '/team-swarm', maxAgents: 4, paused: true, contributorId: 'mate' })
    // Once there, a join again changes nothing.
    f.run({ ...join, maxAgents: 1 } as Command, mate, { contribution: { machineOwnerId: 'mate', contributorId: 'mate', hostMachineId: 'mate-mac' } })
    expect(f.machine('mate-team').maxAgents).toBe(4)
  })

  it('never joins by itself where its Mac is not in the Swarm', () => {
    const f = swarm()
    f.state.machines = f.state.machines!.filter(m => m.machineId !== 'mate-team' && m.machineId !== 'mate-mac')
    expect(refusal(() => f.run({ type: 'machine.contribute', machineId: 'mate-team', name: 'x', cwd: '/team-swarm', scope: 'swarm', engines: ['codex'],
      maxAgents: 2, ifMissing: true } as Command, mate, { contribution: { machineOwnerId: 'mate', contributorId: 'mate', hostMachineId: 'mate-mac' } }))?.code).toBe('OWNER_REQUIRED')
  })

  it('follows its Mac: paused, given other slots, renamed and removed with it', () => {
    const f = oneMachine()
    const teamAgent = f.member('team-agent', 'mate-team', 'mate')
    f.run({ type: 'machine.pause', machineId: 'mate-mac', paused: true }, mate)
    expect(f.machine('mate-team').paused).toBe(true)
    f.run({ type: 'machine.contribute', machineId: 'mate-mac', name: 'Work MacBook', cwd: '/swarm', scope: 'swarm', engines: ['codex'], maxAgents: 6 }, mate,
      { contribution: { machineOwnerId: 'mate', contributorId: 'mate' } })
    expect(f.machine('mate-team')).toMatchObject({ maxAgents: 6, paused: false, name: 'Work MacBook', generation: 'g1' })
    const removed = f.run({ type: 'machine.remove', machineId: 'mate-mac' }, mate)
    expect(f.machine('mate-team').removal).toMatchObject({ state: 'cleaning' })
    expect(removed.result.removedAgents).toContain(teamAgent)
    expect(f.state.agents.some(a => a.id === teamAgent)).toBe(false)
  })

  it('a teammate never moves another person\'s team account with their own Mac', () => {
    const f = oneMachine()
    f.machine('mate-team').contributorId = 'owner'
    f.run({ type: 'machine.pause', machineId: 'mate-mac', paused: true }, mate)
    expect(f.machine('mate-team').paused).toBe(false)
  })
})

describe('one machine: the Mac\'s agent slots', () => {
  it('are shared by the Mac and its Harness Team account', () => {
    const f = swarm(), group = f.group()
    Object.assign(f.machine('mate-team'), { hostMachineId: 'mate-mac', name: 'MacBook Pro', cwd: '/team-swarm', maxAgents: 2 })
    f.machine('mate-mac').maxAgents = 2
    f.member('mine', 'mate-mac', 'mate', f.mine)
    f.run({ type: 'agent.start', request: f.request(group, 'mate-mac') }, owner, f.pooled('mate-mac'))
    // One on the owner's daemon and one in the team account: the Mac's two slots are taken, whichever side asks.
    expect(machineSlots(f.state, f.machine('mate-mac'))).toBe(2)
    expect(machineSlots(f.state, f.machine('mate-team'))).toBe(2)
    expect(refusal(() => f.run({ type: 'agent.start', request: f.request(group, 'mate-mac') }, owner, f.pooled('mate-mac')))?.code).toBe('MACHINE_FULL')
    // A machine without a team account counts only its own.
    expect(machineSlots(f.state, f.machine('owner-mac'))).toBe(0)
  })
})

describe('one machine: a Mac whose Harness Team account was made again', () => {
  // `harness team remove`, then `harness team setup`: a new account, computer and machine, while the old team machine's
  // pool is still in the Swarm, silent. The Mac joins with the new one too (store.ts hostTabs).
  function remade() {
    const f = swarm()
    Object.assign(f.machine('mate-team'), { hostMachineId: 'mate-mac', name: 'MacBook Pro', cwd: '/old-team', observation: reading('team', PASSED, NOW - 3_600_000) })
    f.state.machines!.push({ ...structuredClone(f.machine('mate-team')), machineId: 'mate-team-2', cwd: '/team-swarm', observation: reading('team', PASSED) })
    return f
  }

  it('sends a teammate\'s start on the Mac to the account that runs, not the old one', () => {
    const f = remade(), group = f.group()
    f.member('old-agent', 'mate-team', 'mate')
    f.run({ type: 'agent.start', request: f.request(group, 'mate-mac') }, owner, f.pooled('mate-mac'))
    expect(f.state.starts![0]!.request).toMatchObject({ machineId: 'mate-team-2', cwd: '/team-swarm/lead' })
    // The old account's leftover agent holds none of the Mac's slots.
    expect(machineSlots(f.state, f.machine('mate-mac'))).toBe(1)
  })

  it('pauses and removes both with the Mac, and its removal preview names every agent it takes', () => {
    const f = remade()
    const old = f.member('old-agent', 'mate-team', 'mate'), fresh = f.member('new-agent', 'mate-team-2', 'mate')
    f.run({ type: 'machine.pause', machineId: 'mate-mac', paused: true }, mate)
    expect([f.machine('mate-team').paused, f.machine('mate-team-2').paused]).toEqual([true, true])
    expect(removalPreview(f.state, mate, 'mate-mac').agents.map(a => a.id).sort()).toEqual([fresh, old].sort())
    f.run({ type: 'machine.remove', machineId: 'mate-mac' }, mate)
    expect(f.machine('mate-team-2').removal?.state).toBe('cleaning')
    // The silent old one leaves the list at once; its cleanup waits for its host, as for any offline machine.
    expect(f.state.machines!.some(m => m.machineId === 'mate-team')).toBe(false)
    expect(f.state.machineCleanups).toEqual(expect.arrayContaining([expect.objectContaining({ machineId: 'mate-team' })]))
  })

  it('never sends work to an account that is being removed', () => {
    const f = swarm(), group = f.group()
    Object.assign(f.machine('mate-team'), { hostMachineId: 'mate-mac', name: 'MacBook Pro', removal: { id: 'r', state: 'cleaning', requestedAt: new Date(NOW).toISOString() } })
    expect(refusal(() => f.run({ type: 'agent.start', request: f.request(group, 'mate-mac') }, owner, f.pooled('mate-mac')))?.code).toBe('TEAM_ACCOUNT_REQUIRED')
  })
})
