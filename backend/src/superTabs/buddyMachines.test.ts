// A Buddy on its person's own machine that is not one of the Swarm's machines (Dee, 10-29: "I just wanted to create my
// buddy. I don't want to add my machine to the swarm."). The machine is recorded as Buddy-only: it runs that person's
// Buddies and nothing else, and no reader but its host learns it is there.
import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor } from './model.js'
import { servedLocalModels, type ContributedMachine } from './machines.js'
import { buddyChatId } from './buddies.js'
import { LEAD_CAPABILITY } from './leadStart.js'
import { hostTab } from './read/hostRows.js'
import { leaderboard } from './leaderboard/stats.js'
import { reassemble, split } from './parts/index.js'
import { BUDDY_PICKUP_MS, sweepLiveness } from './liveness.js'


const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const reading = (receivedAt: number, os: string | null = null): NonNullable<ContributedMachine['observation']> => ({ generation: 'g1', receivedAt,
  sessionKind: 'computer', resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null,
    projectDiskFreeBytes: null, deviceType: null, chip: null, os, gpuPercent: null }, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] })
/** What the app sends for a machine it prepared as Add machine does (prepareContribution): never a machine in the Swarm. */
const setupOf = { name: 'Peer Laptop', cwd: '/home/peer/harness-swarm', engines: ['claude', 'codex'] as Array<'claude' | 'codex'> }
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
/** peer adds their Buddy on their own laptop, which is not in the Swarm. */
const addOwn = (f: Swarm, projectId: string, actor: Actor = peer, contribution: CommandContext['contribution'] = own('peer'), machineId = 'peer-laptop') =>
  f.run({ type: 'buddy.create', projectId, machineId, engine: 'claude', setup: setupOf }, actor, { contribution })
/** addOwn, then its host launches it and settles it. */
function running(f: Swarm, projectId: string) {
  const added = addOwn(f, projectId)
  const host = { contribution: own('peer') }
  const agentId = f.run({ type: 'agent.started', startId: added.result.startId as string, harnessId: `native-${projectId}`, configuration }, peer, host).result.agentId as string
  f.run({ type: 'agent.startSettled', startId: added.result.startId as string, warning: null }, peer, host)
  return { agentId, chat: added.result.conversationId as string, startId: added.result.startId as string }
}

describe('a Buddy on its person\'s own machine outside the Swarm', () => {
  it('starts there, recorded as Buddy-only: its own folder and engines, no reading needed yet', () => {
    const f = setup()
    const added = addOwn(f, f.app.projectId)
    expect(buddyOnly(f)).toMatchObject({ machineId: 'peer-laptop', name: 'Peer Laptop', contributorId: 'peer', membershipGeneration: 'first',
      cwd: '/home/peer/harness-swarm', scope: 'swarm', engines: ['claude', 'codex'], paused: false, buddyOnly: true })
    const start = f.state.starts!.find(s => s.id === added.result.startId)!
    expect(start).toMatchObject({ contributorId: 'peer', machineOwnerId: 'peer', poolGeneration: buddyOnly(f)!.generation, error: null })
    expect(start.request).toMatchObject({ machineId: 'peer-laptop', cwd: `/home/peer/harness-swarm/${f.app.projectId}`,
      buddyOf: { personId: 'peer', generation: 'first' }, conversationId: buddyChatId(f.app.projectId, { id: 'peer', generation: 'first' }) })
    expect(added.messages).toEqual([])
  })

  it('is refused without the machine\'s setup, as before: the app prepares it first', () => {
    const f = setup()
    expect(() => f.run({ type: 'buddy.create', projectId: f.app.projectId, machineId: 'peer-laptop', engine: 'claude' }, peer)).toThrow()
    expect([buddyOnly(f), f.state.starts ?? []]).toEqual([undefined, []])
  })

  it('is refused on someone else\'s machine, one shared with the person, and a Harness Team account, changing nothing', () => {
    const f = setup()
    const refused = [
      own('owner'),
      { machineOwnerId: 'owner', contributorId: 'peer', hostGrant: 'share-grant' },
      { ...own('peer'), hostMachineId: 'peer-mac' },
      { ...own('peer'), teamSession: true as const },
    ]
    for (const grant of refused) {
      expect(() => addOwn(f, f.app.projectId, peer, grant)).toThrow('A Buddy runs only on your own machine')
      expect([buddyOnly(f), f.state.starts ?? [], f.state.conversations.filter(c => c.kind === 'buddy')]).toEqual([undefined, [], []])
    }
  })

  it('takes the person\'s Buddy in another project too, and never another person\'s Buddy', () => {
    const f = setup()
    addOwn(f, f.app.projectId)
    expect(addOwn(f, f.web.projectId).result.startId).toBeTruthy()
    expect(f.state.machines!.filter(m => m.machineId === 'peer-laptop')).toHaveLength(1)
    // The owner cannot reach it: the store reads the laptop's row as peer's (store.ts contribution, pooled).
    expect(() => addOwn(f, f.app.projectId, owner, { machineOwnerId: 'peer', contributorId: 'peer', hostGrant: null })).toThrow('A Buddy runs only on your own machine')
  })

  // A Lead's worker goes through its route first, where the pick is refused (below); a person may start by hand.
  it('takes no other start: a person\'s start by hand or a Product Manager is refused there', () => {
    const f = setup()
    addOwn(f, f.app.projectId)
    const request = { conversationId: f.group, machineId: 'peer-laptop', engine: 'claude' as const, name: 'Builder',
      cwd: `/home/peer/harness-swarm/${f.app.projectId}`, worktree: true, requirements: { memoryBytes: 1, diskBytes: 1, maxCpuPercent: 85, tools: [], devices: [], quotaRequired: false } }
    expect(() => f.run({ type: 'agent.start', request }, peer, { contribution: own('peer') })).toThrow('This machine is not one of the Swarm\'s machines')
    expect(() => f.run({ type: 'lead.start', projectId: f.app.projectId, machineId: 'peer-laptop', engine: 'claude' } as Command, peer))
      .toThrow()
    expect((f.state.starts ?? []).filter(s => !s.request.buddyOf)).toEqual([])
  })

  it('is never where a new Product Manager is placed, though no Swarm machine has room', () => {
    const f = setup()
    addOwn(f, f.app.projectId)
    // A current host that can run a Product Manager (leadStart.ts LEAD_CAPABILITY).
    // Spare room too: its slots fit its Buddies alone, which keeps any other start off it as well.
    Object.assign(buddyOnly(f)!, { observation: { ...reading(1000), capabilities: [LEAD_CAPABILITY] }, maxAgents: 4 })
    f.state.machines!.find(m => m.machineId === 'owner-mac')!.paused = true
    // peer's own project: their own machine would be the first tried.
    const docs = f.run({ type: 'project.create', name: 'Docs', visibility: 'public', brief: '' }, peer).result as { projectId: string }
    const placed = f.run({ type: 'lead.start', projectId: docs.projectId, machineId: null, engine: 'claude', repositoryUrl: 'https://github.com/example/docs' } as Command, peer)
    expect(placed.result).toMatchObject({ waiting: true })
    expect((f.state.starts ?? []).filter(s => s.request.leadFor)).toEqual([])
  })

  it('is no route candidate: a pick there is refused', () => {
    const f = setup()
    addOwn(f, f.app.projectId)
    const candidate = (id: string, machineId: string) => ({ id, kind: 'new', machineId, engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3,
      title: `Title ${id}`, label: `Label ${id}` })
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'Fix a typo.' }, candidates: [candidate('c0', 'peer-laptop'), candidate('c1', 'owner-mac')],
      excluded: [], floor: 3, notes: false, pick: 'c0', via: 'jev', p: 0.8, belowFloor: false, why: 'Free machine.' }
    expect(() => f.run({ type: 'route.record', conversationId: f.group, decision } as unknown as Command, pmActor(f))).toThrow('This machine is not one of the Swarm\'s machines')
  })

  it('is in nobody\'s Swarm read, its own person\'s included: Machines, status and the leaderboard\'s lent hours', () => {
    const f = setup()
    addOwn(f, f.app.projectId)
    buddyOnly(f)!.observation = reading(1000)
    buddyOnly(f)!.lent = [{ week: 0, busyMs: 10 * 3_600_000 }]
    for (const reader of [owner, peer, pmActor(f)]) {
      const machines = visibleState(f.state, reader, 1000).machines ?? []
      expect(machines.map(m => m.machineId)).toEqual(['owner-mac'])
      const board = leaderboard({ state: f.state, groups: f.state.conversations, machines, projectId: f.app.projectId, week: 0, now: 1000 })
      expect(board.people.find(p => p.personId === 'peer')?.lent ?? { machines: 0, agentMs: 0 }).toEqual({ machines: 0, agentMs: 0 })
    }
  })

  it('never serves the Swarm\'s local models, and its host is not told the Swarm\'s grid or to join a Team account', async () => {
    const f = setup()
    f.state.localModels = { grid: 'swarm-grid', enabled: true, ready: true }
    const added = addOwn(f, f.app.projectId)
    buddyOnly(f)!.observation = { ...reading(1000), localModels: [{ grid: 'swarm-grid', model: 'qwen', kind: 'served', starting: false }] } as never
    expect(servedLocalModels(f.state, 1000)).toEqual([])
    const lookups = { people: [], confidential: new Set<string>(), agentGrant: async () => {}, teams: [{ machineId: 'peer-team' }], githubApp: false }
    const user = { sub: 'peer', email: peer.email, role: 'user', autonomousEnv: 'test' } as never
    const rows = await hostTab('swarm', f.state, 'peer-laptop', user, null, lookups)
    expect(rows.pool!.buddyStarts!.map(s => s.id)).toEqual([added.result.startId])
    expect(rows.pool!.starts).toEqual([])
    expect(rows.pool).not.toHaveProperty('localGrid')
    expect(rows.roster.filter(r => 'joinTeam' in r)).toEqual([])
  })

  it('refuses its Buddy\'s launch once the machine reads as Windows', () => {
    const f = setup()
    const added = addOwn(f, f.app.projectId)
    buddyOnly(f)!.observation = reading(1000, 'Windows')
    expect(() => f.run({ type: 'agent.startDispatch', startId: added.result.startId as string }, peer)).toThrow('A Buddy cannot run on a Windows machine yet')
  })

  it('keeps its record through storage', () => {
    const f = setup()
    addOwn(f, f.app.projectId)
    const parts = split(f.state, { tabId: 'swarm', version: 1, now: 1000 })
    expect(reassemble(parts).machines!.find(m => m.machineId === 'peer-laptop')!.buddyOnly).toBe(true)
  })
})

describe('a Buddy-only machine\'s end', () => {
  it('comes when the Swarm owner\'s host adds that machine by itself, as for the machine its Lead runs on', () => {
    const f = setup()
    f.run({ type: 'buddy.create', projectId: f.app.projectId, machineId: 'owner-laptop', engine: 'claude', setup: { ...setupOf, name: 'Owner Laptop' } }, owner)
    const started = f.state.starts!.find(s => s.request.machineId === 'owner-laptop')!
    f.run({ type: 'agent.started', startId: started.id, harnessId: 'native', configuration }, owner)
    f.run({ type: 'agent.startSettled', startId: started.id, warning: null }, owner)
    f.run({ type: 'machine.contribute', machineId: 'owner-laptop', name: 'Owner Laptop', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 2,
      ifMissing: true } as Command)
    expect(buddyOnly(f, 'owner-laptop')).toMatchObject({ maxAgents: 2, cwd: '/swarm' })
    expect(buddyOnly(f, 'owner-laptop')!.buddyOnly).toBeUndefined()
  })

  it('comes when its last Buddy is removed: its host cleans up, and no chat hears of it', () => {
    const f = setup()
    running(f, f.app.projectId)
    running(f, f.web.projectId)
    f.run({ type: 'buddy.remove', projectId: f.app.projectId }, peer)
    expect(buddyOnly(f)?.buddyOnly).toBe(true)
    const removed = f.run({ type: 'buddy.remove', projectId: f.web.projectId }, peer)
    expect(buddyOnly(f)).toBeUndefined()
    expect(f.state.machineCleanups).toEqual([expect.objectContaining({ machineId: 'peer-laptop', machineOwnerId: 'peer' })])
    expect(removed.messages).toEqual([])
  })

  it('comes when its only Buddy\'s start fails or is removed before it starts', () => {
    const f = setup()
    const added = addOwn(f, f.app.projectId)
    f.run({ type: 'agent.startFailed', startId: added.result.startId as string, error: 'No engine.' }, peer)
    expect(buddyOnly(f)).toBeUndefined()
    // Until its host says it deleted the Swarm's folders there, a new Buddy would lose its own: the person tries again then.
    const { removalId } = f.state.machineCleanups!.find(c => c.machineId === 'peer-laptop')!
    expect(() => addOwn(f, f.app.projectId)).toThrow('still cleaning up after your last Buddy there')
    f.run({ type: 'machine.cleaned', machineId: 'peer-laptop', removalId }, peer)
    addOwn(f, f.app.projectId)
    f.run({ type: 'buddy.remove', projectId: f.app.projectId }, peer)
    expect(buddyOnly(f)).toBeUndefined()
  })

  it('comes when its person leaves the Swarm, silently, as their Buddies go', () => {
    const f = setup()
    const { agentId } = running(f, f.app.projectId)
    const left = f.run({ type: 'member.remove', userId: 'peer' })
    expect(f.state.agents.map(a => a.id)).not.toContain(agentId)
    expect(buddyOnly(f)).toBeUndefined()
    expect(left.messages.filter(m => m.text.includes('Peer Laptop'))).toEqual([])
  })

  it('is not removed from Machines, where nobody sees it', () => {
    const f = setup()
    running(f, f.app.projectId)
    expect(() => f.run({ type: 'machine.remove', machineId: 'peer-laptop' }, peer)).toThrow('This machine is not in the Swarm')
    expect(buddyOnly(f)?.buddyOnly).toBe(true)
  })

  it('becomes an ordinary Swarm machine when its person adds it with Add machine, its Buddy kept', () => {
    const f = setup()
    const { agentId } = running(f, f.app.projectId)
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
  const lookups = { people: [], confidential: new Set<string>(), agentGrant: async () => {}, teams: [], githubApp: false }

  it('ends when its Buddy is never picked up while the machine reports (review 1)', () => {
    const f = setup()
    const added = addOwn(f, f.app.projectId)
    const late = 1000 + BUDDY_PICKUP_MS + 1
    buddyOnly(f)!.observation = reading(late)
    sweepLiveness(f.state, late)
    expect(f.state.starts!.find(s => s.id === added.result.startId)!.error).toContain('did not start this Buddy')
    expect(buddyOnly(f)).toBeUndefined()
    expect(f.state.machineCleanups).toEqual([expect.objectContaining({ machineId: 'peer-laptop', buddyOnly: true })])
  })

  it('ends when its Buddy\'s dispatched start times out (review 1)', () => {
    const f = setup()
    const added = addOwn(f, f.app.projectId)
    const start = f.state.starts!.find(s => s.id === added.result.startId)!
    Object.assign(start, { dispatched: true, dispatchedAt: 2000 })
    const late = 2000 + 3 * 60_000 + 1 // liveness.ts START_RUN_MS
    buddyOnly(f)!.observation = reading(late)
    sweepLiveness(f.state, late)
    expect(start.error).toBeTruthy()
    expect(buddyOnly(f)).toBeUndefined()
  })

  it('ends when its person leaves while their Buddy is still starting (review 2)', () => {
    const f = setup()
    const added = addOwn(f, f.app.projectId)
    f.run({ type: 'member.remove', userId: 'peer' })
    expect(f.state.starts!.find(s => s.id === added.result.startId)!.error).toBe('Its person left the Swarm before it started.')
    expect(buddyOnly(f)).toBeUndefined()
  })

  it('hides where a Buddy runs from everyone but its person; their other agents show theirs as today', () => {
    const f = setup()
    const { agentId } = running(f, f.app.projectId)
    const pane = f.run({ type: 'agent.add', conversationId: f.group, harnessId: 'pane', machineId: 'peer-laptop', name: 'Pane', configuration, lead: false }, peer,
      { contribution: own('peer') }).result.agentId as string
    const where = (reader: Actor) => Object.fromEntries(visibleState(f.state, reader, 1000).agents.filter(a => [agentId, pane].includes(a.id)).map(a => [a.id, a.machineId]))
    expect(where(owner)).toEqual({ [agentId]: '', [pane]: 'peer-laptop' })
    expect(where(pmActor(f))).toEqual({ [agentId]: '', [pane]: 'peer-laptop' })
    expect(where(peer)).toEqual({ [agentId]: 'peer-laptop', [pane]: 'peer-laptop' })
    // A Buddy reads no machine ids at all, its own included (review 1 of #2115).
    expect(where({ kind: 'agent', agentId, machineOwnerId: 'peer' })[agentId]).toBe('')
  })

  it('takes an agent its person adds there as today, still refusing new starts, and ends only once no agent is left (review 2, ruling)', () => {
    const f = setup()
    running(f, f.app.projectId)
    const pane = f.run({ type: 'agent.add', conversationId: f.group, harnessId: 'pane', machineId: 'peer-laptop', name: 'Pane', configuration, lead: false }, peer,
      { contribution: own('peer') }).result.agentId as string
    expect(buddyOnly(f)?.buddyOnly).toBe(true)
    const request = { conversationId: f.group, machineId: 'peer-laptop', engine: 'claude' as const, name: 'Builder',
      cwd: `/home/peer/harness-swarm/${f.app.projectId}`, worktree: true, requirements: { memoryBytes: 1, diskBytes: 1, maxCpuPercent: 85, tools: [], devices: [], quotaRequired: false } }
    expect(() => f.run({ type: 'agent.start', request }, peer)).toThrow('This machine is not one of the Swarm\'s machines')
    f.run({ type: 'buddy.remove', projectId: f.app.projectId }, peer)
    expect(buddyOnly(f)?.buddyOnly).toBe(true)
    f.run({ type: 'agent.remove', agentId: pane }, peer)
    expect(buddyOnly(f)).toBeUndefined()
  })

  it('lets the Swarm owner\'s Lead there join the machine to the Swarm by itself, as before (review 2, ruling)', async () => {
    const f = setup()
    f.run({ type: 'buddy.create', projectId: f.app.projectId, machineId: 'owner-laptop', engine: 'claude', setup: { ...setupOf, name: 'Owner Laptop' } }, owner)
    const docs = f.run({ type: 'project.create', name: 'Docs', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
    const lead = f.run({ type: 'agent.add', conversationId: docs.conversationId, harnessId: 'docs-pm', machineId: 'owner-laptop', name: 'Lead', configuration,
      lead: true }, owner, { contribution: own('owner') }).result.agentId as string
    const rows = await hostTab('swarm', f.state, 'owner-laptop', hostUser('owner'), null, lookups)
    expect(rows.roster.find(r => 'agent' in r && r.agent.id === lead)).toMatchObject({ joinSwarm: true })
  })

  it('never lets a Mac\'s Team account join through it (review 2)', () => {
    const f = setup()
    addOwn(f, f.app.projectId)
    expect(() => f.run({ type: 'machine.contribute', machineId: 'peer-team', name: 'Peer Laptop', cwd: '/team', scope: 'swarm', engines: ['claude'], maxAgents: 2,
      ifMissing: true } as Command, peer, { contribution: { ...own('peer'), hostMachineId: 'peer-laptop' } })).toThrow('This machine is not one of the Swarm\'s machines')
    expect(f.state.machines!.map(m => m.machineId)).toEqual(['owner-mac', 'peer-laptop'])
  })
})
