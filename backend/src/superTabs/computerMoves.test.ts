// A computer is signed in as one account at a time (Scholes, #3122: MacBooks-MacBook-Pro-7 showed as kelvin's and as
// ttkhoahcmus's at once). When another account signs in there, the store finds the computer's
// entry of the old account in each Swarm (store.ts computerSignedIn) and moves it: one entry, the new account's.
import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor } from './model.js'
import type { ContributedMachine } from './machines.js'
import { storedTask } from './storedWork.test-support.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const kelvin: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'kelvin', email: 'kelvin@example.com' }
const tt: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'tt', email: 'ttkhoahcmus@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const NOW = 10_000_000
const reading = (receivedAt: number): NonNullable<ContributedMachine['observation']> => ({ generation: 'g1', receivedAt,
  resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null,
    deviceType: null, chip: null, os: null, gpuPercent: null }, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] })
const own = (userId: string) => ({ machineOwnerId: userId, contributorId: userId, hostGrant: null })
/** What the store read from the account rows: ttkhoahcmus's machine on the computer kelvin's entry is on. */
const moveTo = (to = { machineId: 'tt-mac', ownerId: 'tt', name: 'MacBooks-MacBook-Pro-7' }): Partial<CommandContext> => ({ computerMove: { to } })
const MOVED: Command = { type: 'machine.moved', machineId: 'kelvin-mac' }

/** A Swarm where kelvin's Mac is in, offline since he signed out of it, and ttkhoahcmus a member. */
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
  /** What an older release recorded on a machine (machine.projects, machine.ownAccountWork and the others-work notice), still stored. */
  const LEGACY_RECORDS = { projects: ['lead'], ownAccountChoice: { allowed: true, by: 'kelvin', at: '2026-11-04T00:00:00.000Z' }, othersToldWeek: 1 } as object
  const kelvinMac: ContributedMachine = { machineId: 'kelvin-mac', name: 'MacBooks-MacBook-Pro-7', contributorId: 'kelvin', membershipGeneration: 'kelvin-gen',
    generation: 'g0', cwd: '/Users/mac/harness-swarm', scope: 'swarm', engines: ['claude', 'codex'], maxAgents: 3, agents: 'atMost', paused: true,
    observation: reading(kelvinOnline ? NOW - 1000 : NOW - 3_000_000), teamAccountOnly: true, ...LEGACY_RECORDS,
    lent: [{ week: 1, ms: 5000 }] as unknown as ContributedMachine['lent'], engineFailures: { codex: 1 } }
  state.machines = [kelvinMac]
  const group = storedTask(state, { projectId: 'lead', title: 'Offline edits', brief: 'Save edits.', requesterId: 'owner' })
  const builder = run({ type: 'agent.add', conversationId: group, harnessId: 'h-builder', machineId: 'kelvin-mac', name: 'Birch3', configuration, lead: false },
    kelvin, { contribution: own('kelvin') }).result.agentId as string
  return { run, group, builder, get state() { return state } }
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
    for (const key of ['projects', 'ownAccountChoice', 'othersToldWeek', 'lent', 'lentDays', 'engineFailures', 'engineSuspensions', 'observation']) {
      expect(moved, key).not.toHaveProperty(key)
    }
  })

  it("stops the old account's agents first, and tells their groups", () => {
    const f = setup()
    const effects = f.run(MOVED, kelvin, moveTo())
    expect(f.state.agents.map(a => a.id)).not.toContain(f.builder)
    expect(effects.cancelledAgents).toEqual(expect.arrayContaining([f.builder]))
    expect(effects.messages.find(m => m.conversationId === f.group)?.text).toContain('MacBooks-MacBook-Pro-7 is signed in to another account now')
  })

  it('leaves the computer\'s folders to the new account', () => {
    const f = setup()
    f.run(MOVED, kelvin, moveTo())
    expect(f.state.machineCleanups ?? []).toEqual([])
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

  it('only takes the old entry out when the new account is not in the Swarm', () => {
    const f = setup({ ttMember: false })
    f.run(MOVED, kelvin, moveTo())
    expect(entries(f)).toEqual([])
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
    expect(entries(f)).toEqual(['kelvin-mac'])
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
