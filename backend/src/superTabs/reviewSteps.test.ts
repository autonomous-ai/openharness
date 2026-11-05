import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'
import { stepsOf } from './steps.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const opus: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const PR = 'https://github.com/acme/app/pull/7'

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0, now = 1_000_000
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const contribution = { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }
  const add = (harnessId: string, group: string, roleName?: string) => run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId,
    name: harnessId, configuration: opus, lead: false, ...roleName ? { roleName } : {} } as Command, owner, contribution).result.agentId as string
  const lead = run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'pm', name: 'pm', configuration: opus, lead: true }, owner, contribution).result.agentId as string
  const task = run({ type: 'conversation.create', title: 'Fix login', brief: 'Sign in works offline.', checks: [] }, as(lead)).result.conversationId as string
  const dev = add('dev', task, 'Engineer')
  run({ type: 'work.assign', conversationId: task, agentId: dev }, as(lead))
  const group = (id: string) => state.conversations.find(c => c.id === id)!
  const ready = (files: string[] | null, head = 'abc1234', fileContext = true) => run({ type: 'work.status', conversationId: task,
    assignmentId: group(task).assignment!.id, status: 'review', result: `Ready: ${PR}` } as Command, as(dev),
    fileContext ? { pullRequestFiles: { urls: [PR], head, files } } : {})
  const steps = () => stepsOf(state, task).map(step => ({ name: step.step, agent: step.assignment?.agentId ?? null, status: step.assignment?.status ?? null }))
  return { run, as, add, lead, task, dev, group, ready, steps, tick: (ms: number) => { now += ms }, get state() { return state } }
}

describe('a handed task opens its review steps', () => {
  it('a pull request touching sign-in code opens two security reviews, each to a different free Reviewer, never the Engineer', () => {
    const f = fixture()
    const a = f.add('rev-a', f.task, 'Reviewer'), b = f.add('rev-b', f.task, 'Reviewer')
    f.ready(['backend/src/routes/auth.ts', 'docs/plans/x.md'])
    const steps = f.steps()
    expect(steps.map(s => s.name)).toEqual(['Security review 1', 'Security review 2'])
    expect(steps.map(s => s.agent).sort()).toEqual([a, b].sort())
    expect(steps.every(s => s.status === 'working' && s.agent !== f.dev)).toBe(true)
    // Each Reviewer hears its step's brief, naming the area and the head.
    const step = stepsOf(f.state, f.task)[0]!
    expect(step.brief).toContain('Sign-in')
    expect(step.brief).toContain('abc1234')
    expect(step.checks).toHaveLength(1)
  })

  it('a docs pull request opens one read', () => {
    const f = fixture()
    const a = f.add('rev-a', f.task, 'Reviewer')
    f.add('rev-b', f.task, 'Reviewer')
    f.ready(['docs/a.md'])
    expect(f.steps()).toEqual([{ name: 'Review', agent: expect.any(String), status: 'working' }])
    expect([a, f.state.agents.find(x => x.name === 'rev-b')!.id]).toContain(f.steps()[0]!.agent)
  })

  it('a change that runs somewhere adds a test step for a Tester', () => {
    const f = fixture()
    f.add('rev', f.task, 'Reviewer')
    const tester = f.add('tst', f.task, 'Tester')
    f.ready(['desktop/lib/super_tabs/view.dart'])
    expect(f.steps().map(s => s.name)).toEqual(['Review', 'Test'])
    expect(f.steps()[1]!.agent).toBe(tester)
    expect(stepsOf(f.state, f.task)[1]!.brief).toContain('Desktop on a Mac')
  })

  it('never gives a step to an agent with a verdict at this head', () => {
    const f = fixture()
    const judged = f.add('judged', f.task, 'Reviewer'), fresh = f.add('fresh', f.task, 'Reviewer')
    f.group(f.task).checks = [{ id: 'c', description: 'Reviewed', independent: true, evidence: 'No', passedBy: null,
      verdicts: [{ by: `agent:${judged}`, passed: false, evidence: 'No', at: 1, head: 'abc1234' } as never] }]
    f.ready(['docs/a.md'])
    expect(f.steps()[0]!.agent).toBe(fresh)
  })

  it('a second Ready reuses the steps: a finished one goes back to its Reviewer, a working one is left alone', () => {
    const f = fixture()
    const a = f.add('rev-a', f.task, 'Reviewer'), b = f.add('rev-b', f.task, 'Reviewer')
    f.ready(['backend/src/routes/auth.ts'])
    const [first, second] = stepsOf(f.state, f.task)
    const firstAgent = first!.assignment!.agentId
    f.run({ type: 'work.status', conversationId: first!.id, assignmentId: first!.assignment!.id, status: 'done', result: 'Ready to merge: No' } as Command, f.as(firstAgent))
    f.run({ type: 'work.status', conversationId: f.task, assignmentId: f.group(f.task).assignment!.id, status: 'working', result: 'Fixing' } as Command, f.as(f.dev))
    f.tick(60_000)
    f.ready(['backend/src/routes/auth.ts'], 'def5678')
    expect(stepsOf(f.state, f.task).map(s => s.id)).toEqual([first!.id, second!.id])
    expect(f.group(first!.id).assignment!.agentId).toBe(firstAgent)
    expect(f.group(first!.id).assignment!.status).toBe('working')
    expect(f.group(second!.id).assignment!.agentId).toBe([a, b].find(id => id !== firstAgent))
  })

  it('reuses a step the Engineer opened itself, and adds only what is missing', () => {
    const f = fixture()
    f.add('rev-a', f.task, 'Reviewer'); f.add('rev-b', f.task, 'Reviewer')
    const own = f.run({ type: 'conversation.create', title: 'Security review', reviewOf: f.task, step: 'Security review', brief: 'Read it.', checks: [] } as Command,
      f.as(f.dev)).result.conversationId as string
    f.ready(['backend/src/routes/auth.ts'])
    expect(stepsOf(f.state, f.task).map(s => s.step)).toEqual(['Security review', 'Security review 2'])
    expect(f.group(own).assignment?.status).toBe('working')
  })

  it('with nobody free, the step stays open and the PM is told once; the Ready itself goes through', () => {
    const f = fixture()
    const effects = f.ready(['backend/src/routes/auth.ts'])
    expect(f.group(f.task).assignment!.status).toBe('review')
    expect(f.steps()).toEqual([{ name: 'Security review 1', agent: null, status: null }, { name: 'Security review 2', agent: null, status: null }])
    const told = effects.messages.filter(m => m.recipients.includes(f.lead) && /no free reviewer/i.test(m.text))
    expect(told).toHaveLength(1)
    expect(told[0]!.text).toContain('Security review 1')
  })

  it('plans the strictest reads when the files could not be read, and says so', () => {
    const f = fixture()
    f.add('rev-a', f.task, 'Reviewer'); f.add('rev-b', f.task, 'Reviewer')
    f.ready(null)
    expect(f.steps().map(s => s.name)).toEqual(['Security review 1', 'Security review 2'])
    expect(stepsOf(f.state, f.task)[0]!.brief).toMatch(/could not be read/i)
  })

  it('opens nothing when no pull request files were read, as before', () => {
    const f = fixture()
    f.add('rev-a', f.task, 'Reviewer')
    f.ready(['docs/a.md'], 'abc1234', false)
    expect(f.steps()).toEqual([])
  })

  it('opens nothing on a step\'s own Ready', () => {
    const f = fixture()
    const a = f.add('rev-a', f.task, 'Reviewer')
    f.add('rev-b', f.task, 'Reviewer')
    f.ready(['docs/a.md'])
    const step = stepsOf(f.state, f.task)[0]!
    f.run({ type: 'work.status', conversationId: step.id, assignmentId: step.assignment!.id, status: 'review', result: 'Read' } as Command,
      f.as(step.assignment!.agentId), { pullRequestFiles: { urls: [PR], head: 'abc1234', files: ['docs/a.md'] } })
    expect(stepsOf(f.state, f.task)).toHaveLength(1)
    expect(stepsOf(f.state, step.id)).toHaveLength(0)
    expect(a).toBeTruthy()
  })
})
