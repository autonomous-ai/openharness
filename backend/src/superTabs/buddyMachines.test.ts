// A Buddy on its person's own machine that is not one of the Swarm's machines (Dee, 10-29: "I just wanted to create my
// buddy. I don't want to add my machine to the swarm."). The machine was recorded as Buddy-only: it runs that person's
// Buddies and nothing else, and no reader but its host learns it is there. Nothing records one now (buddyConversion.ts):
// these are the records already stored.
import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type AgentStart } from './model.js'
import { servedLocalModels, type ContributedMachine } from './machines.js'
import { BUDDY_PEAK_BYTES, BUDDY_REQUIREMENTS, openSwarmBuddyChat } from './buddies.js'
import { LEAD_CAPABILITY } from './leadStart.js'
import { hostTab } from './read/hostRows.js'
import { leaderboard } from './leaderboard/stats.js'
import { reassemble, split } from './parts/index.js'
import { giveOwnBuddy } from './ownBuddy.test-support.js'


const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const reading = (receivedAt: number, os: string | null = null): NonNullable<ContributedMachine['observation']> => ({ generation: 'g1', receivedAt,
  resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null,
    projectDiskFreeBytes: null, deviceType: null, chip: null, os, gpuPercent: null }, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] })
/** The grant the store reads from the machine's account row (store.ts contribution) for an own machine off the list. */
const own = (userId: string) => ({ machineOwnerId: userId, contributorId: userId, hostGrant: null })

/** A Swarm of two public projects, each with its Lead on the owner's Swarm machine, and peer, who has added no machine. */
function setup() {
  let state = createSuperTab('swarm', 'Team', { id: 'owner', email: owner.email }, 'test')
  state.people.push({ id: 'peer', email: peer.email, role: 'collaborator', generation: 'first' })
  let next = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1000,
      contribution: own(actor.kind === 'person' ? actor.userId : 'owner'), ...context })
    state = effects.state
    return effects
  }
  state.machines = [{ machineId: 'owner-mac', name: 'Owner Mac', contributorId: 'owner', membershipGeneration: 'owner-gen', generation: 'g0',
    cwd: '/swarm', scope: 'swarm', engines: ['claude', 'codex'], maxAgents: 4, paused: false, observation: reading(1000) }]
  state.people.find(p => p.id === 'owner')!.generation = 'owner-gen'
  const app = run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
  const web = run({ type: 'project.create', name: 'Web', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
  const lead = (conversationId: string, harnessId: string) => run({ type: 'agent.add', conversationId, harnessId, machineId: 'owner-mac',
    name: harnessId, configuration, lead: true }).result.agentId as string
  const pm = lead(app.conversationId, 'app-pm')
  lead(web.conversationId, 'web-pm')
  const group = run({ type: 'conversation.create', projectId: app.projectId, title: 'Offline', brief: 'Save edits.', checks: [] }).result.conversationId as string
  return { run, app, web, pm, group, get state() { return state } }
}
type Swarm = ReturnType<typeof setup>
const pmActor = (f: Swarm): Actor => ({ kind: 'agent', agentId: f.pm, machineOwnerId: 'owner' })
const buddyOnly = (f: Swarm, machineId = 'peer-laptop') => f.state.machines?.find(m => m.machineId === machineId)
/** [personId]'s own laptop, recorded Buddy-only as buddy.create left it: its own folder and engines, one slot. */
function storedMachine(f: Swarm, personId = 'peer', machineId = `${personId}-laptop`) {
  const member = f.state.people.find(p => p.id === personId)!
  ;(f.state.machines ??= []).push({ machineId, name: personId === 'peer' ? 'Peer Laptop' : 'Owner Laptop', contributorId: personId,
    membershipGeneration: member.generation, generation: `${machineId}-g`, cwd: `/home/${personId}/harness-swarm`, scope: 'swarm',
    engines: ['claude', 'codex'], maxAgents: 1, paused: false, buddyOnly: true })
}
/** [personId]'s Buddy running on their Buddy-only laptop, stored as buddy.create and its start left them. */
function running(f: Swarm, personId = 'peer', machineId = `${personId}-laptop`) {
  storedMachine(f, personId, machineId)
  const buddy = giveOwnBuddy(f.state, personId)
  Object.assign(buddy, { machineId, harnessId: `native-${machineId}` })
  return { agentId: buddy.id }
}
/** peer's Buddy still starting on their Buddy-only laptop, as buddy.create left it before Buddies became agents. */
function starting(f: Swarm): AgentStart {
  storedMachine(f)
  const chat = openSwarmBuddyChat(f.state, f.state.people.find(p => p.id === 'peer')!)
  const start = { id: 'buddy-start', creationId: 'super-buddy-start', actorKey: 'person:peer', contributorId: 'peer', membershipGeneration: 'first',
    machineOwnerId: 'peer', hostGrant: null, poolGeneration: 'peer-laptop-g', harnessId: null, dispatched: false, error: null, requestedAt: 1000,
    request: { conversationId: chat.id, machineId: 'peer-laptop', engine: 'claude', name: 'Moss', cwd: '/home/peer/harness-swarm/.buddy-peer',
      worktree: false, requirements: BUDDY_REQUIREMENTS, buddyOf: { personId: 'peer', generation: 'first' }, buddyScope: 'swarm' } } as AgentStart
  ;(f.state.starts ??= []).push(start)
  return start
}

describe('a Buddy on its person\'s own machine outside the Swarm', () => {
  // A Lead's worker goes through its route first, where the pick is refused (below); a person may start by hand.
  it('takes no other start: a person\'s start by hand or a Product Manager is refused there', () => {
    const f = setup()
    running(f)
    const request = { conversationId: f.group, machineId: 'peer-laptop', engine: 'claude' as const, name: 'Builder',
      cwd: `/home/peer/harness-swarm/${f.app.projectId}`, worktree: true, requirements: { memoryBytes: 1, diskBytes: 1, maxCpuPercent: 85, tools: [], devices: [], quotaRequired: false } }
    expect(() => f.run({ type: 'agent.start', request }, peer, { contribution: own('peer') })).toThrow('This machine is not one of the Swarm\'s machines')
    expect(() => f.run({ type: 'lead.start', projectId: f.app.projectId, machineId: 'peer-laptop', engine: 'claude' } as Command, peer))
      .toThrow()
    expect(f.state.starts ?? []).toEqual([])
  })

  // Its person names the machine a Product Manager runs on (main's leadStart.ts, Ken 10-29); a private one is refused.
  it('takes no Product Manager its person names onto it, even for their own project with room to spare', () => {
    const f = setup()
    running(f)
    Object.assign(buddyOnly(f)!, { observation: { ...reading(1000), capabilities: [LEAD_CAPABILITY] }, maxAgents: 4 })
    const docs = f.run({ type: 'project.create', name: 'Docs', visibility: 'public', brief: '' }, peer).result as { projectId: string }
    expect(() => f.run({ type: 'lead.start', projectId: docs.projectId, machineId: 'peer-laptop', engine: 'claude',
      repositoryUrl: 'https://github.com/example/docs' } as Command, peer)).toThrow('This machine is not one of the Swarm\'s machines')
    expect((f.state.starts ?? []).filter(s => s.request.leadFor)).toEqual([])
  })

  it('is no route candidate: a pick there is left out with why, and the rest kept with no pick (task #4194)', () => {
    const f = setup()
    running(f)
    const candidate = (id: string, machineId: string) => ({ id, kind: 'new', machineId, engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3,
      title: `Title ${id}`, label: `Label ${id}` })
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Fix a typo.' }, candidates: [candidate('c0', 'peer-laptop'), candidate('c1', 'owner-mac')],
      excluded: [], floor: 3, notes: false, pick: 'c0', via: 'jev', p: 0.8, belowFloor: false, why: 'Free machine.' }
    const [created] = f.run({ type: 'route.record', conversationId: f.group, decision } as unknown as Command, pmActor(f)).routeDecisions as Array<{ record: Record<string, unknown> }>
    expect(created!.record).toMatchObject({ candidates: [{ id: 'c1' }], excluded: [{ title: 'Title c0', reason: expect.stringContaining('not one of the Swarm\'s machines') }] })
    expect(created!.record.pick).toBeUndefined()
  })

  it('is in nobody\'s Swarm read, its own person\'s included: Machines, status and the leaderboard\'s lent hours', () => {
    const f = setup()
    running(f)
    buddyOnly(f)!.observation = reading(1000)
    buddyOnly(f)!.lent = [{ week: 0, busyMs: 10 * 3_600_000 }]
    for (const reader of [owner, peer, pmActor(f)]) {
      const machines = visibleState(f.state, reader, 1000).machines ?? []
      expect(machines.map(m => m.machineId)).toEqual(['owner-mac'])
      const board = leaderboard({ state: f.state, groups: f.state.conversations, machines, projectId: f.app.projectId, week: 0, now: 1000 })
      expect(board.people.find(p => p.personId === 'peer')?.lent ?? { machines: 0, agentMs: 0 }).toEqual({ machines: 0, agentMs: 0 })
    }
  })

  it('keeps a machine\'s daily Lent rows out of every Swarm read: only the leaderboard read uses them', () => {
    const f = setup()
    f.state.machines!.find(m => m.machineId === 'owner-mac')!.lentDays = [{ day: 0, projectId: 'lead', busyMs: 1 }]
    for (const reader of [owner, peer, pmActor(f)]) {
      expect(visibleState(f.state, reader, 1000).machines!.find(m => m.machineId === 'owner-mac')).not.toHaveProperty('lentDays')
    }
    expect(f.state.machines!.find(m => m.machineId === 'owner-mac')!.lentDays).toEqual([{ day: 0, projectId: 'lead', busyMs: 1 }])
  })

  it('never serves the Swarm\'s local models, and its host is not told the Swarm\'s grid', async () => {
    const f = setup()
    f.state.localModels = { grid: 'swarm-grid', enabled: true, ready: true }
    running(f)
    buddyOnly(f)!.observation = { ...reading(1000), localModels: [{ grid: 'swarm-grid', model: 'qwen', kind: 'served', starting: false }] } as never
    expect(servedLocalModels(f.state, 1000)).toEqual([])
    const lookups = { people: [], confidential: new Set<string>(), agentGrant: async () => {} }
    const user = { sub: 'peer', email: peer.email, role: 'user', autonomousEnv: 'test' } as never
    const rows = await hostTab('swarm', f.state, 'peer-laptop', user, null, lookups)
    expect(rows.pool!.starts).toEqual([])
    expect(rows.pool).not.toHaveProperty('localGrid')
  })

  it('keeps its record through storage', () => {
    const f = setup()
    running(f)
    const parts = split(f.state, { tabId: 'swarm', version: 1, now: 1000 })
    expect(reassemble(parts).machines!.find(m => m.machineId === 'peer-laptop')!.buddyOnly).toBe(true)
  })
})

describe('a Buddy-only machine\'s end', () => {
  it('comes when the Swarm owner\'s host adds that machine by itself, as for the machine its Lead runs on', () => {
    const f = setup()
    running(f, 'owner')
    f.run({ type: 'machine.contribute', machineId: 'owner-laptop', name: 'Owner Laptop', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 2,
      ifMissing: true } as Command)
    expect(buddyOnly(f, 'owner-laptop')).toMatchObject({ maxAgents: 2, cwd: '/swarm' })
    expect(buddyOnly(f, 'owner-laptop')!.buddyOnly).toBeUndefined()
  })

  it('comes when its person removes their Buddy: its host cleans up, and no chat hears of the machine', () => {
    const f = setup()
    const { agentId } = running(f)
    const removed = f.run({ type: 'agent.remove', agentId }, peer)
    expect(buddyOnly(f)).toBeUndefined()
    expect(f.state.machineCleanups).toEqual([expect.objectContaining({ machineId: 'peer-laptop', machineOwnerId: 'peer', buddyOnly: true })])
    expect(removed.messages.filter(m => m.text.includes('Peer Laptop'))).toEqual([])
  })

  it('comes when its only Buddy\'s start fails', () => {
    const f = setup()
    const start = starting(f)
    f.run({ type: 'agent.startFailed', startId: start.id, error: 'No engine.' }, peer)
    expect(buddyOnly(f)).toBeUndefined()
    expect(f.state.machineCleanups).toEqual([expect.objectContaining({ machineId: 'peer-laptop', machineOwnerId: 'peer', buddyOnly: true })])
  })

  it('comes when its person leaves the Swarm, silently, as their Buddies go', () => {
    const f = setup()
    const { agentId } = running(f)
    const left = f.run({ type: 'member.remove', userId: 'peer' })
    expect(f.state.agents.map(a => a.id)).not.toContain(agentId)
    expect(buddyOnly(f)).toBeUndefined()
    expect(left.messages.filter(m => m.text.includes('Peer Laptop'))).toEqual([])
  })

  it('is not removed from Machines, where nobody sees it', () => {
    const f = setup()
    running(f)
    expect(() => f.run({ type: 'machine.remove', machineId: 'peer-laptop' }, peer)).toThrow('This machine is not in the Swarm')
    expect(buddyOnly(f)?.buddyOnly).toBe(true)
  })

  it('becomes an ordinary Swarm machine when its person adds it with Add machine, its Buddy kept', () => {
    const f = setup()
    const { agentId } = running(f)
    f.run({ type: 'machine.contribute', machineId: 'peer-laptop', name: 'Peer Laptop', cwd: '/home/peer/harness-swarm', scope: 'swarm',
      engines: ['claude'], maxAgents: 3 }, peer)
    expect(buddyOnly(f)).toMatchObject({ machineId: 'peer-laptop', maxAgents: 3 })
    expect(buddyOnly(f)!.buddyOnly).toBeUndefined()
    expect(f.state.agents.map(a => a.id)).toContain(agentId)
    expect(visibleState(f.state, owner, 1000).machines!.map(m => m.machineId)).toContain('peer-laptop')
  })
})

// Security reviews 1 and 2 of #2234.
describe('a Buddy-only machine after its reviews', () => {
  const hostUser = (sub: string) => ({ sub, email: `${sub}@example.com`, role: 'user', autonomousEnv: 'test' }) as never
  const lookups = { people: [], confidential: new Set<string>(), agentGrant: async () => {}, teams: [] }

  it('ends when its person leaves while their Buddy is still starting (review 2)', () => {
    const f = setup()
    const { id } = starting(f)
    f.run({ type: 'member.remove', userId: 'peer' })
    expect(f.state.starts!.find(s => s.id === id)!.error).toBe('Its person left the Swarm before it started.')
    expect(buddyOnly(f)).toBeUndefined()
  })

  // A Swarm-wide Buddy is read by its person and itself alone (projects.ts canReadAgent), so nobody else sees it, nor its machine.
  it('hides a Buddy, and where it runs, from everyone but its person; their other agents show theirs as today', () => {
    const f = setup()
    const { agentId } = running(f)
    const pane = f.run({ type: 'agent.add', conversationId: f.group, harnessId: 'pane', machineId: 'peer-laptop', name: 'Pane', configuration, lead: false }, peer,
      { contribution: own('peer') }).result.agentId as string
    const where = (reader: Actor) => Object.fromEntries(visibleState(f.state, reader, 1000).agents.filter(a => [agentId, pane].includes(a.id)).map(a => [a.id, a.machineId]))
    expect(where(owner)).toEqual({ [pane]: 'peer-laptop' })
    expect(where(pmActor(f))).toEqual({ [pane]: 'peer-laptop' })
    expect(where(peer)).toEqual({ [agentId]: 'peer-laptop', [pane]: 'peer-laptop' })
    // A Buddy reads no machine ids at all, its own included (review 1 of #2115).
    expect(where({ kind: 'agent', agentId, machineOwnerId: 'peer' })[agentId]).toBe('')
  })

  it('takes an agent its person adds there as today, still refusing new starts, and ends only once no agent is left (review 2, ruling)', () => {
    const f = setup()
    const { agentId } = running(f)
    const pane = f.run({ type: 'agent.add', conversationId: f.group, harnessId: 'pane', machineId: 'peer-laptop', name: 'Pane', configuration, lead: false }, peer,
      { contribution: own('peer') }).result.agentId as string
    expect(buddyOnly(f)?.buddyOnly).toBe(true)
    const request = { conversationId: f.group, machineId: 'peer-laptop', engine: 'claude' as const, name: 'Builder',
      cwd: `/home/peer/harness-swarm/${f.app.projectId}`, worktree: true, requirements: { memoryBytes: 1, diskBytes: 1, maxCpuPercent: 85, tools: [], devices: [], quotaRequired: false } }
    expect(() => f.run({ type: 'agent.start', request }, peer)).toThrow('This machine is not one of the Swarm\'s machines')
    f.run({ type: 'agent.remove', agentId }, peer)
    expect(buddyOnly(f)?.buddyOnly).toBe(true)
    f.run({ type: 'agent.remove', agentId: pane }, peer)
    expect(buddyOnly(f)).toBeUndefined()
  })

  it('lets the Swarm owner\'s Lead there join the machine to the Swarm by itself, as before (review 2, ruling)', async () => {
    const f = setup()
    storedMachine(f, 'owner')
    const docs = f.run({ type: 'project.create', name: 'Docs', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
    const lead = f.run({ type: 'agent.add', conversationId: docs.conversationId, harnessId: 'docs-pm', machineId: 'owner-laptop', name: 'Lead', configuration,
      lead: true }, owner, { contribution: own('owner') }).result.agentId as string
    // The owner's Buddy session there, in a live chat too: never it, as its record is not the machine in the Swarm.
    const person = f.state.people.find(p => p.id === 'owner')!
    f.state.agents.push({ ...f.state.agents.find(a => a.id === lead)!, id: 'owner-buddy', harnessId: 'buddy-session', buddyOf: { personId: person.id, generation: person.generation } })
    f.state.conversations.find(c => c.id === docs.conversationId)!.agentIds.push('owner-buddy')
    const rows = await hostTab('swarm', f.state, 'owner-laptop', hostUser('owner'), null, lookups)
    expect(rows.roster.find(r => 'agent' in r && r.agent.id === lead)).toMatchObject({ joinSwarm: true })
    expect(rows.roster.find(r => 'agent' in r && r.agent.id === 'owner-buddy')).toMatchObject({ joinSwarm: false })
  })

  it('makes a Buddy-only record an ordinary machine for its owner at 20, since it is already counted (#2637)', () => {
    const f = setup()
    running(f, 'owner')
    f.state.machines!.push(...Array.from({ length: 18 }, (_, i) => ({ ...f.state.machines![0]!, machineId: `owner-${i}` })))
    expect(f.state.machines!.filter(m => m.contributorId === 'owner')).toHaveLength(20)
    f.run({ type: 'machine.contribute', machineId: 'owner-laptop', name: 'Owner Laptop', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 2,
      ifMissing: true } as Command, owner, { contribution: own('owner') })
    expect(buddyOnly(f, 'owner-laptop')).toMatchObject({ contributorId: 'owner' })
    expect(buddyOnly(f, 'owner-laptop')).not.toHaveProperty('buddyOnly')
  })

  // Security re-check 1 of #2234: a pane its person added to someone else's public project made the private Mac take that
  // project's work once Team account enforcement was off.
  describe('an agent its person added there', () => {
    const candidate = (id: string, patch: Record<string, unknown>) => ({ id, kind: 'new', machineId: 'owner-mac', engine: 'claude', model: 'opus',
      effort: 'high', quality: 3, cost: 3, title: `Title ${id}`, label: `Label ${id}`, ...patch })
    const decision = (pane: string) => ({ assessment: { difficulty: 'low', risk: 'low', why: 'Fix a typo.' },
      candidates: [candidate('c0', { kind: 'member', agentId: pane, machineId: 'peer-laptop' }), candidate('c1', {})], excluded: [], floor: 3,
      notes: false, pick: 'c0', via: 'jev', p: 0.8, belowFloor: false, why: 'Idle agent.' })
    const paneIn = (f: Swarm, conversationId: string) => f.run({ type: 'agent.add', conversationId, harnessId: `pane-${conversationId}`,
      machineId: 'peer-laptop', name: 'Pane', configuration, lead: false }, peer, { contribution: own('peer') }).result.agentId as string
    const withSwitch = (value: string | undefined, act: () => void) => {
      const before = process.env.SWARM_TEAM_ACCOUNT_REQUIRED
      if (value === undefined) delete process.env.SWARM_TEAM_ACCOUNT_REQUIRED
      else process.env.SWARM_TEAM_ACCOUNT_REQUIRED = value
      try { act() } finally {
        if (before === undefined) delete process.env.SWARM_TEAM_ACCOUNT_REQUIRED
        else process.env.SWARM_TEAM_ACCOUNT_REQUIRED = before
      }
    }

    for (const value of [undefined, '1']) {
      it(`takes no work of another person's project, Team account enforcement ${value ? 'on' : 'off'}`, () => withSwitch(value, () => {
        const f = setup()
        running(f)
        const pane = paneIn(f, f.group)
        const [created] = f.run({ type: 'route.record', conversationId: f.group, decision: decision(pane) } as unknown as Command, pmActor(f))
          .routeDecisions as Array<{ record: { candidates: Array<{ id: string }>; pick?: string } }>
        expect(created!.record.candidates.map(c => c.id)).toEqual(['c1'])
        expect(created!.record.pick).toBeUndefined()
      }))
    }

    it('takes its own person\'s project work, routed', () => {
      const f = setup()
      running(f)
      const own = f.run({ type: 'project.create', name: 'Peer work', visibility: 'public', brief: '' }, peer).result as { projectId: string; conversationId: string }
      const lead = f.run({ type: 'agent.add', conversationId: own.conversationId, harnessId: 'peer-pm', machineId: 'owner-mac', name: 'PM', configuration,
        lead: true }, peer, { contribution: { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null } }).result.agentId as string
      const work = f.run({ type: 'conversation.create', projectId: own.projectId, title: 'Notes', brief: 'Tidy notes.',
        checks: [{ description: 'Notes are tidy.', independent: false }] }, peer).result.conversationId as string
      const pane = paneIn(f, work)
      const routed = f.run({ type: 'route.record', conversationId: work, decision: decision(pane) } as unknown as Command,
        { kind: 'agent', agentId: lead, machineOwnerId: 'owner' })
      expect(routed.result.routeDecisionId).toBeTruthy()
      expect((routed.routeDecisions as Array<{ record: { pick?: string } }>)[0]!.record.pick).toBe('c0')
    })
  })
})

// Task #3738 (tuan.dev, 11-06): some people run Windows PCs with 16 GB and often under 2 GB free, and could not add a Buddy. A Buddy is
// one Claude session that reads and talks: what it asks of its machine comes from a measured peak, with a margin, not a round 2 GB.
describe('the memory a Buddy asks of its machine (#3738)', () => {
  const GIB = 1024 ** 3
  it('comes from a measured peak with a margin above it, and is under the 2 GiB a Buddy asked before', () => {
    expect(BUDDY_REQUIREMENTS.memoryBytes).toBeGreaterThanOrEqual(BUDDY_PEAK_BYTES * 1.5)
    expect(BUDDY_REQUIREMENTS.memoryBytes).toBeLessThan(2 * GIB)
    // Swarm agents' requirements stay as they were: this is a Buddy's alone.
    expect(BUDDY_REQUIREMENTS.diskBytes).toBe(GIB)
  })
})
