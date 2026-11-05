// A computer is signed in as one account at a time (Scholes, #3122: MacBooks-MacBook-Pro-7 showed as kelvin's, as
// ttkhoahcmus's and as kelvin's Team account at once). When another account signs in there, the store finds the computer's
// entry of the old account in each Swarm (store.ts computerSignedIn) and moves it: one entry, the new account's.
import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor } from './model.js'
import { swarmBuddyChatId } from './buddies.js'
import { joiningTeamMacs, machineTeamWork, type ContributedMachine } from './machines.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const kelvin: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'kelvin', email: 'kelvin@example.com' }
const tt: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'tt', email: 'ttkhoahcmus@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const NOW = 10_000_000
const reading = (receivedAt: number): NonNullable<ContributedMachine['observation']> => ({ generation: 'g1', receivedAt, sessionKind: 'computer',
  resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null,
    deviceType: null, chip: null, os: null, gpuPercent: null }, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] })
const own = (userId: string) => ({ machineOwnerId: userId, contributorId: userId, hostGrant: null })
/** What the store read from the account rows: ttkhoahcmus's machine on the computer kelvin's entry is on. */
const moveTo = (to = { machineId: 'tt-mac', ownerId: 'tt', name: 'MacBooks-MacBook-Pro-7' }): Partial<CommandContext> => ({ computerMove: { to } })
const MOVED: Command = { type: 'machine.moved', machineId: 'kelvin-mac' }

/** A Swarm where kelvin's Mac is in, offline since he signed out of it, with its Team account live, and ttkhoahcmus a member. */
function setup({ ttMember = true, kelvinOnline = false } = {}) {
  let state = createSuperTab('swarm', 'Team', { id: 'owner', email: owner.email }, 'test')
  state.people.push({ id: 'kelvin', email: kelvin.email, role: 'collaborator', generation: 'kelvin-gen' })
  if (ttMember) state.people.push({ id: 'tt', email: tt.email, role: 'collaborator', generation: 'tt-gen' })
  let next = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { operationId: `op${next++}`, now: NOW,
      contribution: own(actor.kind === 'person' ? actor.userId : 'owner'), ...context })
    state = effects.state
    return effects
  }
  const kelvinMac: ContributedMachine = { machineId: 'kelvin-mac', name: 'MacBooks-MacBook-Pro-7', contributorId: 'kelvin', membershipGeneration: 'kelvin-gen',
    generation: 'g0', cwd: '/Users/mac/harness-swarm', scope: 'swarm', engines: ['claude', 'codex'], maxAgents: 3, agents: 'atMost', paused: true,
    observation: reading(kelvinOnline ? NOW - 1000 : NOW - 3_000_000), teamAccountOnly: true, projects: ['lead'],
    ownAccountChoice: { allowed: true, by: 'kelvin', at: '2026-11-04T00:00:00.000Z' }, othersToldWeek: 1,
    lent: [{ week: 1, ms: 5000 }] as unknown as ContributedMachine['lent'], engineFailures: { codex: 1 } }
  const kelvinTeam: ContributedMachine = { machineId: 'kelvin-team', name: 'MacBooks-MacBook-Pro-7', contributorId: 'kelvin', membershipGeneration: 'kelvin-gen',
    generation: 'g0', cwd: '/Users/harness-team/harness-swarm', scope: 'swarm', engines: ['claude'], maxAgents: 3, paused: true,
    observation: { ...reading(NOW - 1000), sessionKind: 'team' }, hostMachineId: 'kelvin-mac' }
  state.machines = [kelvinMac, kelvinTeam]
  const group = run({ type: 'conversation.create', projectId: 'lead', title: 'Offline edits', brief: 'Save edits.', checks: [] }).result.conversationId as string
  const builder = run({ type: 'agent.add', conversationId: group, harnessId: 'h-builder', machineId: 'kelvin-mac', name: 'Birch3', configuration, lead: false },
    kelvin, { contribution: own('kelvin') }).result.agentId as string
  const teamAgent = run({ type: 'agent.add', conversationId: group, harnessId: 'h-team', machineId: 'kelvin-team', name: 'Fern', configuration, lead: false },
    kelvin, { contribution: { ...own('kelvin'), hostMachineId: 'kelvin-mac' } }).result.agentId as string
  return { run, group, builder, teamAgent, get state() { return state } }
}
const entries = (f: ReturnType<typeof setup>) => f.state.machines!.filter(m => !m.removal).map(m => m.machineId)

describe("another account's sign-in on a computer", () => {
  it('leaves exactly one entry, under the new account, with a note of who it was before', () => {
    const f = setup()
    f.run(MOVED, kelvin, moveTo())
    expect(entries(f)).toEqual(['tt-mac'])
    const moved = f.state.machines!.find(m => m.machineId === 'tt-mac')!
    expect(moved).toMatchObject({ contributorId: 'tt', membershipGeneration: 'tt-gen', name: 'MacBooks-MacBook-Pro-7',
      cwd: '/Users/mac/harness-swarm', engines: ['claude', 'codex'], maxAgents: 3, agents: 'atMost', paused: true, scope: 'swarm',
      teamAccountOnly: true, previousOwner: { personId: 'kelvin', until: new Date(NOW).toISOString() } })
  })

  it("carries none of the old owner's grants or records", () => {
    const f = setup()
    f.run(MOVED, kelvin, moveTo())
    const moved = f.state.machines!.find(m => m.machineId === 'tt-mac')!
    for (const key of ['projects', 'ownAccountChoice', 'othersToldWeek', 'lent', 'lentDays', 'engineFailures', 'engineSuspensions', 'observation', 'hostMachineId']) {
      expect(moved, key).not.toHaveProperty(key)
    }
  })

  it("stops the old account's agents first, there and on its Team account, and tells their groups and the old owner", () => {
    const f = setup()
    const effects = f.run(MOVED, kelvin, moveTo())
    expect(f.state.agents.map(a => a.id)).not.toContain(f.builder)
    expect(f.state.agents.map(a => a.id)).not.toContain(f.teamAgent)
    expect(effects.cancelledAgents).toEqual(expect.arrayContaining([f.builder, f.teamAgent]))
    expect(effects.messages.find(m => m.conversationId === f.group)?.text).toContain('MacBooks-MacBook-Pro-7 is signed in to another account now')
    const told = effects.messages.filter(m => m.conversationId === swarmBuddyChatId(f.state.people.find(p => p.id === 'kelvin')!))
    expect(told).toHaveLength(1)
    expect(told[0]!.text).toBe('Your MacBooks-MacBook-Pro-7 is signed in as ttkhoahcmus now, so it left this Swarm under your account, and Birch3 and Fern with it.')
  })

  it('cleans up after the Team account, whose host still runs, and leaves the computer\'s folders to the new account', () => {
    const f = setup()
    f.run(MOVED, kelvin, moveTo())
    expect(f.state.machineCleanups?.map(c => c.machineId)).toEqual(['kelvin-team'])
    expect(f.state.removedMachines ?? []).toEqual([])
  })

  it('fails the starts still waiting on the old account\'s machine', () => {
    const f = setup()
    f.state.starts = [{ id: 's1', request: { machineId: 'kelvin-mac', conversationId: f.group, name: 'Holly' }, dispatched: true } as never]
    f.run(MOVED, kelvin, moveTo())
    expect(f.state.starts![0]!.error).toBeTruthy()
  })

  it('keeps the new account\'s own entry and settings when it is already in the Swarm, adding only the note', () => {
    const f = setup()
    f.state.machines!.push({ machineId: 'tt-mac', name: 'MacBooks-MacBook-Pro-7', contributorId: 'tt', membershipGeneration: 'tt-gen', generation: 'g1',
      cwd: '/Users/mac/harness-swarm', engines: ['claude'], maxAgents: 1, paused: false, observation: reading(NOW - 1000) })
    f.run(MOVED, kelvin, moveTo())
    expect(entries(f)).toEqual(['tt-mac'])
    expect(f.state.machines!.find(m => m.machineId === 'tt-mac')).toMatchObject({ maxAgents: 1, paused: false, previousOwner: { personId: 'kelvin' } })
  })

  it('only takes the old entry out when the new account is not in the Swarm, and names no one to the old owner', () => {
    const f = setup({ ttMember: false })
    const effects = f.run(MOVED, kelvin, moveTo())
    expect(entries(f)).toEqual([])
    const told = effects.messages.filter(m => m.conversationId === swarmBuddyChatId(f.state.people.find(p => p.id === 'kelvin')!))
    expect(told[0]!.text).toBe('Your MacBooks-MacBook-Pro-7 is signed in to another account now, so it left this Swarm under your account, and Birch3 and Fern with it.')
  })

  it('does not add the new account\'s machine where its person took it out', () => {
    const f = setup()
    f.state.removedMachines = [{ machineId: 'tt-mac', contributorId: 'tt' }]
    f.run(MOVED, kelvin, moveTo())
    expect(entries(f)).toEqual([])
  })

  it('moves nothing while the old entry still reports: two live accounts on one computer id are no switch', () => {
    const f = setup({ kelvinOnline: true })
    const before = structuredClone(f.state.machines)
    f.run(MOVED, kelvin, moveTo())
    expect(f.state.machines).toEqual(before)
    expect(f.state.agents.map(a => a.id)).toContain(f.builder)
  })

  it('is refused unless the store read the move itself', () => {
    const f = setup()
    expect(() => f.run(MOVED, kelvin)).toThrow()
    expect(() => f.run(MOVED, tt)).toThrow()
    expect(entries(f)).toEqual(['kelvin-mac', 'kelvin-team'])
  })

  it('changes nothing the second time', () => {
    const f = setup()
    f.run(MOVED, kelvin, moveTo())
    const after = structuredClone(f.state)
    const again = f.run(MOVED, kelvin, moveTo())
    expect(f.state.machines).toEqual(after.machines)
    expect(again.messages).toEqual([])
  })
})

// Scholes, 11-05: kelvin added his Mac, Set up showed for a couple of seconds and went away. His Harness Team account was on
// that Mac already, and joined the Swarm moments after the Mac did; until then the Mac read "not set up".
describe('a Mac whose own Harness Team account has not joined the Swarm yet', () => {
  const mac = (f: ReturnType<typeof setup>) => {
    f.state.machines = f.state.machines!.filter(m => m.machineId === 'kelvin-mac')
    const pool = f.state.machines[0]!
    pool.observation = reading(NOW - 1000)
    // Teammates' work only through its Team account, as Add machine leaves it.
    delete pool.ownAccountChoice
    return pool
  }
  const row = (userId: string, hostMachineId: string, machineId = 'kelvin-team') => ({ machineId, userId, hostMachineId })

  it('is joining while its owner has a Team account on it that the Swarm does not list', () => {
    const f = setup()
    const pool = mac(f)
    expect(joiningTeamMacs(f.state, [row('kelvin', 'kelvin-mac')])).toEqual(['kelvin-mac'])
    expect(machineTeamWork(f.state, pool, NOW, [], [], ['kelvin-mac'])?.code).toBe('TEAM_ACCOUNT_JOINING')
    expect(machineTeamWork(f.state, pool, NOW, [], [])?.code).toBe('TEAM_ACCOUNT_REQUIRED')
  })

  it("is not joining with another account's Team account on it, one listed already, or no room for it", () => {
    const f = setup()
    mac(f)
    // The Team account of the computer's previous account names that account's machine, never this one.
    expect(joiningTeamMacs(f.state, [row('tt', 'kelvin-mac')])).toEqual([])
    expect(joiningTeamMacs(f.state, [row('kelvin', 'another-mac')])).toEqual([])
    const listed = setup()
    expect(joiningTeamMacs(listed.state, [row('kelvin', 'kelvin-mac')])).toEqual([])
    const cleaning = setup()
    mac(cleaning)
    cleaning.state.machineCleanups = [{ machineId: 'kelvin-team', removalId: 'r', machineOwnerId: 'kelvin' }]
    expect(joiningTeamMacs(cleaning.state, [row('kelvin', 'kelvin-mac')])).toEqual([])
  })
})
