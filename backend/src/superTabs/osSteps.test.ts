import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'
import { SEED_RULES, type ProjectRules } from './policy.js'
import { stepsOf } from './steps.js'
import { openWaitingSteps } from './osSteps.js'

// Task #4278: since v3 (#4120) a Tester starts only on its own person's computer, and no own-account Linux machine could take
// harness's Linux test steps, yet every new head opened one and the PM closed it by hand (#4204, #4215, #4216, #4217, #4252,
// #4259 on 11-07). Task #4410: the same for Windows, whose steps #3362 makes more common; there no CI run stands in, so the
// task says a person's Windows check is owed.
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const opus: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const PR = 'https://github.com/acme/app/pull/7'
const NOW = 1_000_000

/** The seed rules with the CLI's changes tested [where]. */
const cliTestedOn = (where: string): ProjectRules => {
  const rules = structuredClone(SEED_RULES) as ProjectRules
  return { ...rules, reviews: { ...rules.reviews, test: rules.reviews.test.map(row => row.paths.includes('cli/**') ? { ...row, where } : row) } }
}
const windowsRules = cliTestedOn('The CLI on a Mac and on a Windows machine')
const bothRules = cliTestedOn('The CLI on a Mac, on a Linux machine and on a Windows machine')

/** Each OS whose test step waits for its machine: what the machine reports, its step, the task's line, its waiting field. */
const OSES = {
  linux: { reports: 'Linux', step: 'Test on a Linux machine', line: 'No Linux machine: CI\'s Linux runs stand in.', field: 'waitingLinuxStep', rules: undefined },
  windows: { reports: 'Windows', step: 'Test on a Windows machine', line: 'No Windows machine: a person\'s Windows check is owed.', field: 'waitingWindowsStep',
    rules: windowsRules },
} as const

/** A machine as its reading lists it: online, signed in, with quota. */
const machine = (machineId: string, os: string, contributorId = 'owner', extra: Record<string, unknown> = {}) => ({ machineId, name: machineId, contributorId,
  membershipGeneration: 'g', generation: 'g1', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 4, paused: false,
  observation: { generation: 'g1', receivedAt: NOW - 1000, sessionKind: 'computer', resources: { os }, tools: {}, runningHarnessIds: [], stoppedHarnessIds: [],
    readiness: { engines: [{ engine: 'claude', installed: true, signedIn: true }] },
    quotas: [{ engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent: 10, resetsAt: null }] }] }, ...extra })

/** The PM's person is `owner`: its PM, Engineer and Mac Tester run on owner's Mac. [rules]: the project's, or the seed's. */
function fixture(rules?: ProjectRules) {
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
    result: `Ready: ${PR}` } as Command, as(dev), { pullRequestFiles: { urls: [PR], head, files: ['cli/src/superTabs/host.ts'] },
    ...rules ? { projectRules: { revision: 1, rules } } : {} })
  const steps = () => stepsOf(state, task).filter(step => !step.archived).map(step => step.step)
  const lines = (line: string) => rows.filter(row => row.conversationId === task && row.text === line)
  const machines = (...list: unknown[]) => { state.machines = [machine('mac1', 'macOS'), ...list] as never }
  return { run, as, add, lead, task, dev, group, ready, steps, lines, machines, get state() { return state } }
}

for (const [os, { reports, step: osStep, line, field, rules }] of Object.entries(OSES)) {
  describe(`a Ready opens a ${reports} test step only where the project can test on ${reports}`, () => {
    it('with only a Mac, opens the Mac test and no other, and the task says why once', () => {
      const f = fixture(rules)
      f.machines()
      f.ready('a'.repeat(40))
      expect(f.steps()).toEqual(['Review', 'Test on a Mac'])
      expect(f.lines(line)).toHaveLength(1)
      // A second head opens no such step and says it no second time.
      f.ready('b'.repeat(40))
      expect(f.steps()).toEqual(['Review', 'Test on a Mac'])
      expect(f.lines(line)).toHaveLength(1)
    })

    it(`counts no ${reports} machine that no Tester of the project can reach`, () => {
      const cases = {
        'another person\'s, with no agent of the project': machine('box1', reports, 'dan'),
        'a Team account\'s': machine('box1', reports, 'owner', { hostMachineId: 'mac1' }),
        'offline': machine('box1', reports, 'owner', { observation: { ...machine('box1', reports).observation, receivedAt: NOW - 10 * 60_000 } }),
        'paused': machine('box1', reports, 'owner', { paused: true }),
        'kept for other projects': machine('box1', reports, 'owner', { projects: ['other'] }),
      }
      for (const [why, box] of Object.entries(cases)) {
        const f = fixture(rules)
        f.machines(box)
        f.ready('a'.repeat(40))
        expect(f.steps(), why).toEqual(['Review', 'Test on a Mac'])
        expect(f.lines(line), why).toHaveLength(1)
      }
    })

    it(`opens it on the PM's person's own ${reports} computer, where the PM may start a Tester`, () => {
      const f = fixture(rules)
      f.machines(machine('box1', reports))
      f.ready('a'.repeat(40))
      expect(f.steps()).toEqual(['Review', 'Test on a Mac', osStep])
      expect(f.lines(line)).toHaveLength(0)
    })

    it(`opens it on another person's ${reports} machine where their own agent of this project runs`, () => {
      const f = fixture(rules)
      const theirs = f.add('dan-tst', f.task, 'box1', 'Tester')
      const agent = f.state.agents.find(a => a.id === theirs)!
      agent.contributorId = 'dan'
      f.machines(machine('box1', reports, 'dan'))
      f.ready('a'.repeat(40))
      expect(f.steps()).toEqual(['Review', 'Test on a Mac', osStep])
      expect(f.lines(line)).toHaveLength(0)
    })

    it(`never reopens at a later head a ${reports} step the PM closed while no ${reports} machine was there`, () => {
      const f = fixture(rules)
      f.machines(machine('box1', reports))
      f.ready('a'.repeat(40))
      const opened = stepsOf(f.state, f.task).find(step => step.step === osStep)!
      // The machine leaves; nobody can take the step, and the PM closes it.
      f.machines()
      f.run({ type: 'conversation.archive', conversationId: opened.id, archived: true } as Command, f.as(f.lead))
      f.ready('b'.repeat(40))
      expect(f.steps()).toEqual(['Review', 'Test on a Mac'])
      expect(f.lines(line)).toHaveLength(1)
    })
  })

  describe(`a waiting ${reports} step opens once a ${reports} machine is there`, () => {
    it('opens nothing while none is, then opens it at the recorded head and tells the PM, once', () => {
      const f = fixture(rules)
      f.machines()
      const head = 'a'.repeat(40)
      f.ready(head)
      const state = f.state
      expect(openWaitingSteps(state, NOW)).toEqual([])
      expect(f.steps()).toEqual(['Review', 'Test on a Mac'])
      // The PM's person's computer of that OS reports.
      state.machines = [machine('mac1', 'macOS'), machine('box1', reports)] as never
      const rows = openWaitingSteps(state, NOW)
      const opened = stepsOf(state, f.task).filter(step => step.step === osStep)
      expect(opened).toHaveLength(1)
      expect(opened[0]!.brief).toContain(head)
      expect(rows.find(row => row.conversationId === opened[0]!.id)!.text).toBe(opened[0]!.brief)
      expect(rows.find(row => row.conversationId === f.task)!.recipients).toEqual([f.lead])
      expect((state.conversations.find(c => c.id === f.task)! as unknown as Record<string, unknown>)[field], os).toBeUndefined()
      // A second pass opens nothing more.
      expect(openWaitingSteps(state, NOW)).toEqual([])
      expect(stepsOf(state, f.task).filter(step => step.step === osStep)).toHaveLength(1)
    })

    it('keeps waiting on a task that is no longer open', () => {
      const f = fixture(rules)
      f.machines()
      f.ready('a'.repeat(40))
      const state = f.state
      state.conversations.find(c => c.id === f.task)!.assignment!.status = 'done'
      state.machines = [machine('mac1', 'macOS'), machine('box1', reports)] as never
      expect(openWaitingSteps(state, NOW)).toEqual([])
      expect(stepsOf(state, f.task).some(step => step.step === osStep)).toBe(false)
    })
  })
}

describe('a task that needs a Linux and a Windows test, with neither machine there (#4410)', () => {
  it('waits for each, says each line once, and opens each when its own machine is there', () => {
    const f = fixture(bothRules)
    f.machines()
    f.ready('a'.repeat(40))
    f.ready('b'.repeat(40))
    expect(f.steps()).toEqual(['Review', 'Test on a Mac'])
    expect(f.lines(OSES.linux.line)).toHaveLength(1)
    expect(f.lines(OSES.windows.line)).toHaveLength(1)
    const state = f.state
    state.machines = [machine('mac1', 'macOS'), machine('win1', 'Windows')] as never
    openWaitingSteps(state, NOW)
    expect(stepsOf(state, f.task).filter(step => !step.archived).map(step => step.step)).toEqual(['Review', 'Test on a Mac', OSES.windows.step])
    expect(state.conversations.find(c => c.id === f.task)!.waitingLinuxStep).toBeDefined()
    state.machines = [machine('mac1', 'macOS'), machine('win1', 'Windows'), machine('linux1', 'Linux')] as never
    openWaitingSteps(state, NOW)
    expect(stepsOf(state, f.task).filter(step => !step.archived).map(step => step.step))
      .toEqual(['Review', 'Test on a Mac', OSES.windows.step, OSES.linux.step])
  })
})
