import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'
import { stepsOf } from './steps.js'
import { openWaitingSteps } from './linuxSteps.js'

// Task #4278: since v3 (#4120) a Tester starts only on its own person's computer, and no own-account Linux machine could take
// harness's Linux test steps, yet every new head opened one and the PM closed it by hand (#4204, #4215, #4216, #4217, #4252,
// #4259 on 11-07).
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const opus: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const PR = 'https://github.com/acme/app/pull/7'
const LINE = 'No Linux machine: CI\'s Linux runs stand in.'
const NOW = 1_000_000

/** A machine as its reading lists it: online, signed in, with quota. */
const machine = (machineId: string, os: string, contributorId = 'owner', extra: Record<string, unknown> = {}) => ({ machineId, name: machineId, contributorId,
  membershipGeneration: 'g', generation: 'g1', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 4, paused: false,
  observation: { generation: 'g1', receivedAt: NOW - 1000, sessionKind: 'computer', resources: { os }, tools: {}, runningHarnessIds: [], stoppedHarnessIds: [],
    readiness: { engines: [{ engine: 'claude', installed: true, signedIn: true }] },
    quotas: [{ engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent: 10, resetsAt: null }] }] }, ...extra })

/** The PM's person is `owner`: its PM, Engineer and Mac Tester run on owner's Mac. */
function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const rows: Array<{ conversationId: string; text: string; recipients: string[] }> = []
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    rows.push(...effects.messages)
    return effects
  }
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const add = (harnessId: string, group: string, machineId: string, roleName?: string, lead = false) => run({ type: 'agent.add', conversationId: group, machineId,
    harnessId, name: harnessId, configuration: opus, lead, ...roleName ? { roleName } : {} } as Command, owner,
    { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  const lead = add('pm', 'lead', 'mac1', undefined, true)
  const task = run({ type: 'conversation.create', title: 'Fix the host', brief: 'The host restarts cleanly.', checks: [{ description: 'Restarts', independent: true }],
    priority: 'P2', requesterId: 'owner' }, as(lead)).result.conversationId as string
  const dev = add('dev', task, 'mac1', 'Engineer')
  run({ type: 'work.assign', conversationId: task, agentId: dev }, as(lead))
  add('rev', task, 'mac1', 'Reviewer')
  add('mac-tst', task, 'mac1', 'Tester')
  const group = (id: string) => state.conversations.find(c => c.id === id)!
  const ready = (head: string) => run({ type: 'work.status', conversationId: task, assignmentId: group(task).assignment!.id, status: 'review',
    result: `Ready: ${PR}` } as Command, as(dev), { pullRequestFiles: { urls: [PR], head, files: ['cli/src/superTabs/host.ts'] } })
  const steps = () => stepsOf(state, task).filter(step => !step.archived).map(step => step.step)
  const lines = () => rows.filter(row => row.conversationId === task && row.text === LINE)
  const machines = (...list: unknown[]) => { state.machines = [machine('mac1', 'macOS'), ...list] as never }
  return { run, as, add, lead, task, dev, group, ready, steps, lines, machines, get state() { return state } }
}

describe('a Ready opens a Linux test step only where the project can test on Linux', () => {
  it('with only a Mac, opens the Mac test and no Linux one, and the task says why once', () => {
    const f = fixture()
    f.machines()
    f.ready('a'.repeat(40))
    expect(f.steps()).toEqual(['Review', 'Test on a Mac', 'Test on Windows'])
    expect(f.lines()).toHaveLength(1)
    // A second head opens no Linux step and says it no second time.
    f.ready('b'.repeat(40))
    expect(f.steps()).toEqual(['Review', 'Test on a Mac', 'Test on Windows'])
    expect(f.lines()).toHaveLength(1)
  })

  it('counts no Linux machine that no Tester of the project can reach', () => {
    const cases = {
      'another person\'s, with no agent of the project': machine('linux1', 'Linux', 'dan'),
      'a Team account\'s': machine('linux1', 'Linux', 'owner', { hostMachineId: 'mac1' }),
      'offline': machine('linux1', 'Linux', 'owner', { observation: { ...machine('linux1', 'Linux').observation, receivedAt: NOW - 10 * 60_000 } }),
      'paused': machine('linux1', 'Linux', 'owner', { paused: true }),
      'kept for other projects': machine('linux1', 'Linux', 'owner', { projects: ['other'] }),
    }
    for (const [why, linux] of Object.entries(cases)) {
      const f = fixture()
      f.machines(linux)
      f.ready('a'.repeat(40))
      expect(f.steps(), why).toEqual(['Review', 'Test on a Mac', 'Test on Windows'])
      expect(f.lines(), why).toHaveLength(1)
    }
  })

  it('opens it on the PM\'s person\'s own Linux computer, where the PM may start a Tester', () => {
    const f = fixture()
    f.machines(machine('linux1', 'Linux'))
    f.ready('a'.repeat(40))
    expect(f.steps()).toEqual(['Review', 'Test on a Mac', 'Test on a Linux machine', 'Test on Windows'])
    expect(f.lines()).toHaveLength(0)
  })

  it('opens it on another person\'s Linux machine where their own agent of this project runs', () => {
    const f = fixture()
    const theirs = f.add('dan-tst', f.task, 'linux1', 'Tester')
    const agent = f.state.agents.find(a => a.id === theirs)!
    agent.contributorId = 'dan'
    f.machines(machine('linux1', 'Linux', 'dan'))
    f.ready('a'.repeat(40))
    expect(f.steps()).toEqual(['Review', 'Test on a Mac', 'Test on a Linux machine', 'Test on Windows'])
    expect(f.lines()).toHaveLength(0)
  })

  it('never reopens at a later head a Linux step the PM closed while no Linux machine was there', () => {
    const f = fixture()
    f.machines(machine('linux1', 'Linux'))
    f.ready('a'.repeat(40))
    const linux = stepsOf(f.state, f.task).find(step => step.step === 'Test on a Linux machine')!
    // The machine leaves; nobody can take the step, and the PM closes it.
    f.machines()
    f.run({ type: 'conversation.archive', conversationId: linux.id, archived: true } as Command, f.as(f.lead))
    f.ready('b'.repeat(40))
    expect(f.steps()).toEqual(['Review', 'Test on a Mac', 'Test on Windows'])
    expect(f.lines()).toHaveLength(1)
  })
})

describe('a waiting Linux step opens once a Linux machine is there', () => {
  it('opens nothing while none is, then opens it at the recorded head and tells the PM, once', () => {
    const f = fixture()
    f.machines()
    const head = 'a'.repeat(40)
    f.ready(head)
    const state = f.state
    expect(openWaitingSteps(state, NOW)).toEqual([])
    expect(f.steps()).toEqual(['Review', 'Test on a Mac', 'Test on Windows'])
    // The PM's person's Linux computer reports.
    state.machines = [machine('mac1', 'macOS'), machine('linux1', 'Linux')] as never
    const rows = openWaitingSteps(state, NOW)
    const linux = stepsOf(state, f.task).filter(step => step.step === 'Test on a Linux machine')
    expect(linux).toHaveLength(1)
    expect(linux[0]!.brief).toContain(head)
    expect(rows.find(row => row.conversationId === linux[0]!.id)!.text).toBe(linux[0]!.brief)
    expect(rows.find(row => row.conversationId === f.task)!.recipients).toEqual([f.lead])
    expect(state.conversations.find(c => c.id === f.task)!.waitingLinuxStep).toBeUndefined()
    // A second pass opens nothing more.
    expect(openWaitingSteps(state, NOW)).toEqual([])
    expect(stepsOf(state, f.task).filter(step => step.step === 'Test on a Linux machine')).toHaveLength(1)
  })

  it('keeps waiting on a task that is no longer open', () => {
    const f = fixture()
    f.machines()
    f.ready('a'.repeat(40))
    const state = f.state
    state.conversations.find(c => c.id === f.task)!.assignment!.status = 'done'
    state.machines = [machine('mac1', 'macOS'), machine('linux1', 'Linux')] as never
    expect(openWaitingSteps(state, NOW)).toEqual([])
    expect(stepsOf(state, f.task).some(step => step.step === 'Test on a Linux machine')).toBe(false)
  })
})
