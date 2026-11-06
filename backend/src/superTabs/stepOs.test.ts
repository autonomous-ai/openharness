/**
 * A step named for an OS goes only to an agent on that OS (task #3926: with daniel-pc's Linux Testers down, #3872's "Test on a
 * Linux machine" went to a Windows Tester and #3861's to a Mac one, and both stalled).
 */
import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { candidatesFor, DISPATCH_RULES } from './dispatch.js'
import { sweepLiveness } from './liveness.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'
import { stepsOf } from './steps.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const opus: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const PR = 'https://github.com/acme/app/pull/7'
const NOW = 1_000_000
const contribution = { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }

const machine = (machineId: string, os: string) => ({ machineId, name: machineId, contributorId: 'owner', membershipGeneration: 'g', generation: 'g1',
  cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 4, paused: false,
  observation: { generation: 'g1', receivedAt: NOW - 1000, sessionKind: 'computer', resources: { os }, tools: {}, runningHarnessIds: [], stoppedHarnessIds: [],
    readiness: { engines: [{ engine: 'claude', installed: true, signedIn: true }] },
    quotas: [{ engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent: 10, resetsAt: null }] }] } })

/** A task in review whose CLI change opened "Test on a Mac" and "Test on a Linux machine", each with its Tester, and a second
 *  Mac Tester and a Windows Tester left free. */
function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const add = (name: string, group: string, roleName: string, machineId = 'mac0') => run({ type: 'agent.add', conversationId: group, machineId,
    harnessId: name, name, configuration: opus, lead: false, roleName } as Command, owner, contribution).result.agentId as string
  const lead = run({ type: 'agent.add', conversationId: 'lead', machineId: 'mac0', harnessId: 'pm', name: 'pm', configuration: opus, lead: true }, owner,
    contribution).result.agentId as string
  const task = run({ type: 'conversation.create', title: 'Fix the host', brief: 'The host restarts.', checks: [{ description: 'Restarts', independent: true }],
    priority: 'P2', requesterId: 'owner' }, as(lead)).result.conversationId as string
  const dev = add('dev', task, 'Engineer')
  run({ type: 'work.assign', conversationId: task, agentId: dev }, as(lead))
  add('rev', task, 'Reviewer')
  const linux = add('linux-tst', task, 'Tester', 'linux1')
  const mac = add('mac-tst', task, 'Tester', 'mac1')
  // A second Linux Tester, a second Mac Tester and a Windows Tester, out of reach until the Ready has opened the steps.
  const linux2 = add('linux-tst2', task, 'Tester', 'linux1'), mac2 = add('mac-tst2', task, 'Tester', 'mac1'), win = add('win-tst', task, 'Tester', 'win1')
  const agent = (id: string) => state.agents.find(a => a.id === id)!
  const busy = [linux2, mac2, win].map(id => { const a = agent(id); const was = a.workDecision; a.workDecision = 'stop'; return () => { agent(id).workDecision = was } })
  const generation = state.people.find(p => p.id === 'owner')!.generation
  state.machines = [machine('mac0', 'macOS'), machine('mac1', 'macOS'), machine('linux1', 'Linux'), machine('win1', 'Windows')]
    .map(m => ({ ...m, membershipGeneration: generation })) as never
  run({ type: 'work.status', conversationId: task, assignmentId: state.conversations.find(c => c.id === task)!.assignment!.id, status: 'review',
    result: `Ready: ${PR}` } as Command, as(dev), { pullRequestFiles: { urls: [PR], head: 'abc1234', files: ['cli/src/superTabs/host.ts'] } })
  const step = (name: string) => stepsOf(state, task).find(s => s.step === name)!
  const linuxStep = step('Test on a Linux machine')
  expect(linuxStep.assignment!.agentId).toBe(linux)
  expect(step('Test on a Mac').assignment!.agentId).toBe(mac)
  busy.forEach(free => free())
  const lose = () => {
    const held = linuxStep.assignment!
    held.status = 'lost'
    held.lost = { reason: 'its machine went offline', at: NOW }
    linuxStep.lostAttempt = { id: held.id, agentId: linux, machineId: 'linux1', engine: 'claude' }
  }
  const offered = (agentId: string) => candidatesFor(state, agent(agentId), DISPATCH_RULES, NOW).map(c => c.group.id)
  return { run, as, lead, task, dev, linux, linux2, mac, mac2, win, linuxStep, step, lose, offered, get state() { return state } }
}

describe('a step named for an OS', () => {
  it('lost, is never handed on to a Mac or Windows Tester, and a free Linux Tester takes it', () => {
    const f = fixture()
    f.lose()
    expect(f.offered(f.mac2)).not.toContain(f.linuxStep.id)
    expect(f.offered(f.win)).not.toContain(f.linuxStep.id)
    expect(f.offered(f.linux2)).toContain(f.linuxStep.id)
  })

  it('is refused to an agent on another OS when assigned', () => {
    const f = fixture()
    f.lose()
    for (const agentId of [f.mac2, f.win]) {
      expect(() => f.run({ type: 'work.assign', conversationId: f.linuxStep.id, agentId }, f.as(f.lead)))
        .toThrow(expect.objectContaining({ code: 'STEP_OS' }))
    }
    expect(() => f.run({ type: 'work.assign', conversationId: f.linuxStep.id, agentId: f.linux2 }, f.as(f.lead))).not.toThrow()
  })

  it('without an OS in its name, still goes to any free Tester', () => {
    const f = fixture()
    const plain = f.run({ type: 'conversation.create', title: 'Test', brief: 'Test it.', reviewOf: f.task, step: 'Test',
      checks: [{ description: 'Runs.', independent: true }] }, f.as(f.lead)).result.conversationId as string
    expect(() => f.run({ type: 'work.assign', conversationId: plain, agentId: f.win }, f.as(f.lead))).not.toThrow()
  })

  const candidate = (id: string, machineId: string) => ({ id, kind: 'new', machineId, engine: 'claude', model: 'opus', effort: 'high',
    quality: 3, cost: 2, title: `${id} on ${machineId}`, label: `Label ${id}` })
  const record = (candidates: unknown[]) => ({ assessment: { difficulty: 'low', risk: 'low', why: 'A Linux test.' }, candidates, excluded: [],
    floor: 2, notes: false, via: 'instructions', p: null, belowFloor: false, why: 'Instructions.' })
  const requirements = { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }

  it('is routed only to its OS: a Mac or Windows candidate moves to the exclusions with why, and a route with no Linux one is refused', () => {
    const f = fixture()
    f.lose()
    const routed = f.run({ type: 'route.record', conversationId: f.linuxStep.id,
      decision: record([candidate('c0', 'mac1'), candidate('c1', 'linux1'), candidate('c2', 'win1')]) } as Command)
    expect(routed.routeDecisions[0]).toMatchObject({ op: 'create', record: { candidates: [{ id: 'c1' }],
      excluded: [{ title: 'c0 on mac1', reason: expect.stringContaining('runs only on a Linux machine, and mac1 reports macOS') },
        { title: 'c2 on win1', reason: expect.stringContaining('win1 reports Windows') }] } })
    expect(() => f.run({ type: 'route.record', conversationId: f.linuxStep.id, decision: record([candidate('c0', 'mac1')]) } as Command))
      .toThrow(expect.objectContaining({ code: 'STEP_OS' }))
  })

  it('is refused a new agent started on a machine of another OS', () => {
    const f = fixture()
    f.lose()
    const start = (machineId: string) => () => f.run({ type: 'agent.start', request: { conversationId: f.linuxStep.id, machineId, engine: 'claude',
      name: 'Tester', cwd: '/swarm/lead', worktree: true, requirements } } as Command, owner, contribution)
    expect(start('mac1')).toThrow(expect.objectContaining({ code: 'STEP_OS' }))
    expect(start('linux1')).not.toThrow()
  })

  it('with no Linux Tester free, waits and says so in the step, and the PM is told once', () => {
    const f = fixture()
    // daniel-pc goes down: its Linux Testers with it, while the Mac and Windows Testers stay free.
    const linux1 = f.state.machines!.find(m => m.machineId === 'linux1')!
    linux1.observation!.receivedAt = NOW - 60 * 60_000
    const rows = sweepLiveness(f.state, NOW)
    const step = f.step('Test on a Linux machine')
    expect(step.assignment!.status).toBe('lost')
    const toPm = rows.filter(r => r.recipients.includes(f.lead))
    expect(toPm).toHaveLength(1)
    expect(toPm[0]!.text).toContain('No Linux Tester free')
    const said = rows.filter(r => r.conversationId === step.id && r.recipients.length === 0 && /No Linux Tester free/.test(r.text))
    expect(said).toHaveLength(1)
    expect(f.offered(f.mac2)).not.toContain(step.id)
    // The next sweeps say nothing again.
    expect(sweepLiveness(f.state, NOW + 30_000).filter(r => /No Linux Tester free/.test(r.text))).toEqual([])
  })

  it('lost with a Linux Tester free, says nothing of waiting', () => {
    const f = fixture()
    // Only the Tester's own session ends: its machine and the other Linux Tester are up.
    f.state.machines!.find(m => m.machineId === 'linux1')!.observation!.stoppedHarnessIds = ['linux-tst']
    const rows = sweepLiveness(f.state, NOW)
    expect(f.step('Test on a Linux machine').assignment!.status).toBe('lost')
    expect(rows.filter(r => /No Linux Tester free/.test(r.text))).toEqual([])
    expect(f.offered(f.linux2)).toContain(f.step('Test on a Linux machine').id)
  })
})

