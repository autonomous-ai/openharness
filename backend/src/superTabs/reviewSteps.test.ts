import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'
import { stepsOf } from './steps.js'
import { SEED_RULES } from './policy.js'

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
  const add = (harnessId: string, group: string, roleName?: string, machineId = 'host') => run({ type: 'agent.add', conversationId: group, machineId, harnessId,
    name: harnessId, configuration: opus, lead: false, ...roleName ? { roleName } : {} } as Command, owner, contribution).result.agentId as string
  const lead = run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'pm', name: 'pm', configuration: opus, lead: true }, owner, contribution).result.agentId as string
  const task = run({ type: 'conversation.create', title: 'Fix login', brief: 'Sign in works offline.', checks: [{ description: 'Signs in offline', independent: true }], priority: 'P2', requesterId: 'owner' }, as(lead)).result.conversationId as string
  const dev = add('dev', task, 'Engineer')
  run({ type: 'work.assign', conversationId: task, agentId: dev }, as(lead))
  const group = (id: string) => state.conversations.find(c => c.id === id)!
  const ready = (files: string[] | null, head = 'abc1234', fileContext = true, extra: Partial<CommandContext> = {}) => run({ type: 'work.status', conversationId: task,
    assignmentId: group(task).assignment!.id, status: 'review', result: `Ready: ${PR}` } as Command, as(dev),
    fileContext ? { pullRequestFiles: { urls: [PR], head, files }, ...extra } : extra)
  const steps = () => stepsOf(state, task).map(step => ({ name: step.step, agent: step.assignment?.agentId ?? null, status: step.assignment?.status ?? null }))
  return { run, as, add, lead, task, dev, group, ready, steps, tick: (ms: number) => { now += ms }, get state() { return state } }
}

describe('a handed task opens its review steps', () => {
  // Task #3964 (review of PR #3436): the Ready that hands out review steps follows the project's machine rules too.
  it('hands no review step to a Reviewer on a machine where no Reviewer runs, and gives it to one elsewhere', () => {
    const rules = { projectRules: { revision: 1, rules: { ...SEED_RULES, machines: [{ machineIds: ['host'], why: 'Its Codex defaults to a local model', noReviews: true as const }] } } }
    const alone = fixture()
    alone.add('rev-local', alone.task, 'Reviewer')
    alone.ready(['docs/a.md'], 'abc1234', true, rules)
    expect(alone.steps()).toEqual([{ name: 'Review', agent: null, status: null }])
    const f = fixture()
    f.add('rev-local', f.task, 'Reviewer')
    const elsewhere = f.run({ type: 'agent.add', conversationId: f.task, machineId: 'other', harnessId: 'rev-other', name: 'rev-other', configuration: opus,
      lead: false, roleName: 'Reviewer' } as Command, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
    f.ready(['docs/a.md'], 'abc1234', true, rules)
    expect(f.steps()).toEqual([{ name: 'Review', agent: elsewhere, status: 'working' }])
  })

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
    // Task #3540: the verdict it asks for counts only at the head and base it names (#3394).
    expect(step.brief).toContain('at the pull request head (whole commit id) and base branch you read')
    expect(step.checks).toHaveLength(1)
  })

  it('puts each PR history result in both security briefs and refreshes active and finished steps', () => {
    const f = fixture()
    f.add('rev-a', f.task, 'Reviewer'); f.add('rev-b', f.task, 'Reviewer')
    const head = 'a'.repeat(40), next = 'b'.repeat(40)
    const history = (head: string, productionLines: number) => ({ head, planFirst: 'pass' as const, testBeforeCode: 'pass' as const,
      productionLines, totalLines: productionLines + 7, commits: 3, merges: 0, missingTests: [] })
    const ready = (at: string, lines: number) => f.ready(['backend/src/routes/auth.ts'], at, true, { pullRequestFiles: {
      urls: [PR], head: at, files: ['backend/src/routes/auth.ts'], heads: [{ url: PR, head: at, base: 'main', history: history(at, lines) }] } })
    ready(head, 12)
    const [first, second] = stepsOf(f.state, f.task)
    for (const step of [first!, second!]) {
      expect(step.brief).toContain('Plan first: pass')
      expect(step.brief).toContain('Test before code: pass')
      expect(step.brief).toContain('12 production lines')
      expect(step.brief).toContain('does not prove a test failed')
    }
    first!.brief += '\nKeep this manual instruction.'
    f.run({ type: 'work.status', conversationId: first!.id, assignmentId: first!.assignment!.id, status: 'done', result: 'No' } as Command, f.as(first!.assignment!.agentId))
    f.run({ type: 'work.status', conversationId: f.task, assignmentId: f.group(f.task).assignment!.id, status: 'working', result: 'Fixing' } as Command, f.as(f.dev))
    ready(next, 30)
    expect(stepsOf(f.state, f.task).find(s => s.id === first!.id)!.brief).toContain('Keep this manual instruction.')
    for (const step of stepsOf(f.state, f.task)) {
      expect(step.brief).toContain('30 production lines')
      expect(step.brief).not.toContain('12 production lines')
      expect(step.brief).toContain(next)
      expect(step.brief).not.toContain(head)
      expect(step.brief!.match(/PR history checks/g)).toHaveLength(1)
    }
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
    // A Desktop test runs on a Mac: its Tester's machine says it is one (task #3602; an unlisted machine takes no OS step).
    f.state.machines = [{ machineId: 'host', name: 'host', contributorId: 'owner', membershipGeneration: 'g', generation: 'g1', cwd: '/swarm', scope: 'swarm',
      engines: ['claude'], maxAgents: 8, paused: false, observation: { generation: 'g1', receivedAt: 1_000_000 - 1000, sessionKind: 'computer', resources: { os: 'macOS' },
        tools: {}, runningHarnessIds: [], stoppedHarnessIds: [], readiness: { engines: [{ engine: 'claude', installed: true, signedIn: true }] },
        quotas: [{ engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent: 10, resetsAt: null }] }] } }] as never
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

  // Review of #3227 (Digest): a second Ready at the same head re-assigned a review that had passed there, and cleared its verdict.
  it('a repeated Ready at the same head keeps a review that passed at that head', () => {
    const f = fixture()
    f.add('rev-a', f.task, 'Reviewer'); f.add('rev-b', f.task, 'Reviewer')
    const head = 'abc1234'.padEnd(40, '0')
    f.ready(['docs/a.md'], head)
    const step = stepsOf(f.state, f.task)[0]!, reviewer = step.assignment!.agentId
    f.group(step.id).checks[0]!.passedBy = `agent:${reviewer}`
    f.group(step.id).checks[0]!.verdicts = [{ by: `agent:${reviewer}`, passed: true, evidence: 'Yes', at: 1, head } as never]
    f.run({ type: 'work.status', conversationId: step.id, assignmentId: step.assignment!.id, status: 'done', result: 'Ready to merge: Yes' } as Command, f.as(reviewer))
    f.run({ type: 'work.status', conversationId: f.task, assignmentId: f.group(f.task).assignment!.id, status: 'working', result: 'CI rerun' } as Command, f.as(f.dev))
    f.ready(['docs/a.md'], head)
    expect(f.group(step.id).assignment).toMatchObject({ agentId: reviewer, status: 'done' })
    expect(f.group(step.id).checks[0]!.passedBy).toBe(`agent:${reviewer}`)
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

  // Task #3602: #3561 got Security review 1, 2 and Test from the server, then review, review and test from its Engineer.
  it('refuses an agent\'s step of a kind the server already opened, or of a name already open, naming the open one', () => {
    const f = fixture()
    f.add('rev-a', f.task, 'Reviewer'); f.add('rev-b', f.task, 'Reviewer'); f.add('tst', f.task, 'Tester')
    f.ready(['backend/src/routes/auth.ts', 'desktop/lib/a.dart'])
    expect(f.steps().map(s => s.name)).toEqual(['Security review 1', 'Security review 2', 'Test'])
    const open = (step: string) => () => f.run({ type: 'conversation.create', title: step, reviewOf: f.task, step, brief: 'Read it.', checks: [] } as Command, f.as(f.dev))
    for (const step of ['Security review', 'Test']) {
      expect(open(step), step).toThrow(expect.objectContaining({ code: 'STEP_OPEN' }))
    }
    expect(open('Test')).toThrow(/Test/)
    expect(f.steps()).toHaveLength(3)
  })

  it('refuses an agent\'s step of a name it already has open, and opens its own second step of a kind under another name', () => {
    const f = fixture()
    const open = (step: string) => f.run({ type: 'conversation.create', title: step, reviewOf: f.task, step, brief: 'Read it.', checks: [] } as Command, f.as(f.dev))
    open('Review')
    expect(() => open('Review')).toThrow(expect.objectContaining({ code: 'STEP_OPEN' }))
    open('Security review 1')
    expect(() => open('Security review 2')).not.toThrow()
    expect(f.steps().map(s => s.name)).toEqual(['Review', 'Security review 1', 'Security review 2'])
  })

  // ReviewLinnea's review of #3312: the PM and the Integrator open merge, combination and row checks after a main merge, once
  // the server's review is done. Only the task's own Engineer is refused, and only for a step whose work is still open.
  it('lets the PM or another agent open a later check after a done server step, and refuses only the Engineer while it is open', () => {
    const f = fixture()
    const rev = f.add('rev', f.task, 'Reviewer')
    f.ready(['docs/a.md'])
    const open = (step: string, by: string) => () => f.run({ type: 'conversation.create', title: step, reviewOf: f.task, step, brief: 'Read it.', checks: [] } as Command, f.as(by))
    // While the server's Review is working, a PM's own check still opens; the Engineer's double does not.
    expect(open('Review: main merge check', f.lead)).not.toThrow()
    expect(open('Review', f.dev)).toThrow(expect.objectContaining({ code: 'STEP_OPEN' }))
    // Done, it blocks nobody: the Engineer may open another review step of its own.
    const review = stepsOf(f.state, f.task).find(s => s.step === 'Review')!
    f.run({ type: 'work.status', conversationId: review.id, assignmentId: review.assignment!.id, status: 'done', result: 'Ready to merge: Yes' } as Command, f.as(rev))
    expect(open('Review: combination read', f.dev)).not.toThrow()
  })

  // #3576's Test went to a Mac only when its check needed a Mac and a Linux machine.
  it('opens one test step per machine its check names, each to a Tester on that OS', () => {
    const f = fixture()
    f.add('rev', f.task, 'Reviewer')
    const tester = (name: string, machineId: string) => f.run({ type: 'agent.add', conversationId: f.task, machineId, harnessId: name, name, configuration: opus,
      lead: false, roleName: 'Tester' } as Command, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
    const mac = tester('mac-tst', 'mac1'), linux = tester('linux-tst', 'linux1')
    const machine = (machineId: string, os: string) => ({ machineId, name: machineId, contributorId: 'owner', membershipGeneration: 'g', generation: 'g1', cwd: '/swarm',
      scope: 'swarm', engines: ['claude'], maxAgents: 4, paused: false,
      observation: { generation: 'g1', receivedAt: 1_000_000 - 1000, sessionKind: 'computer', resources: { os }, tools: {}, runningHarnessIds: [], stoppedHarnessIds: [],
        readiness: { engines: [{ engine: 'claude', installed: true, signedIn: true }] },
        quotas: [{ engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent: 10, resetsAt: null }] }] } })
    f.state.machines = [machine('mac1', 'macOS'), machine('linux1', 'Linux')] as never
    // A Tester on a machine the Swarm does not list says no OS, so it takes neither (review of #3312, Minor 1).
    tester('unlisted-tst', 'unlisted')
    f.ready(['cli/src/superTabs/host.ts'])
    expect(f.steps()).toEqual([{ name: 'Review', agent: expect.any(String), status: 'working' },
      { name: 'Test on a Mac', agent: mac, status: 'working' }, { name: 'Test on a Linux machine', agent: linux, status: 'working' }])
    expect(stepsOf(f.state, f.task).find(s => s.step === 'Test on a Linux machine')!.brief).toContain('a Linux machine')
  })


  const machine = (machineId: string, os: string) => ({ machineId, name: machineId, contributorId: 'owner', membershipGeneration: 'g', generation: 'g1', cwd: '/swarm',
    scope: 'swarm', engines: ['claude'], maxAgents: 8, paused: false,
    observation: { generation: 'g1', receivedAt: 999_000, sessionKind: 'computer', resources: { os }, tools: {}, runningHarnessIds: [], stoppedHarnessIds: [],
      readiness: { engines: [{ engine: 'claude', installed: true, signedIn: true }] },
      quotas: [{ engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent: 10, resetsAt: null }] }] } })

  it.each(['desktop/lib/super_tabs/view.dart', 'cli/src/services/process.ts'])('routes %s to an independent Windows Tester on Ready', file => {
    const f = fixture()
    f.add('rev', f.task, 'Reviewer')
    f.add('mac-tst', f.task, 'Tester')
    const win = f.add('win-tst', f.task, 'Tester', 'win')
    const prior = f.add('prior-builder', f.task, 'Tester', 'win')
    // A former builder with the Tester role must still be excluded.
    f.group(f.task).ledger!.runs!.push({ agentId: prior } as never)
    f.state.machines = [machine('host', 'macOS'), machine('win', 'Windows')] as never
    f.ready([file])
    const step = stepsOf(f.state, f.task).find(s => s.step === 'Test on Windows')
    expect(step?.assignment).toMatchObject({ agentId: win, status: 'working' })
    expect(step?.checks[0]?.independent).toBe(true)
    expect(step?.brief).toContain('docs/windows-rules.md')
    expect(step?.brief).toMatch(/no .*window.*(?:flash|moment)/i)
    expect(step?.brief).toMatch(/recording/i)
    expect(step?.brief).toContain('signed build')
    expect(step?.brief).toContain("person's Windows session")
    // A second Ready must not duplicate or move the active Windows step.
    f.run({ type: 'work.status', conversationId: f.task, assignmentId: f.group(f.task).assignment!.id, status: 'working', result: 'CI rerun' }, f.as(f.dev))
    f.ready([file])
    expect(stepsOf(f.state, f.task).filter(s => s.step === 'Test on Windows').map(s => [s.id, s.assignment?.agentId])).toEqual([[step!.id, win]])
  })

  it('leaves Windows open when its only Windows Tester built the task', () => {
    const f = fixture()
    f.add('rev', f.task, 'Reviewer'); f.add('mac-tst', f.task, 'Tester'); f.add('unknown-tst', f.task, 'Tester', 'unknown')
    const prior = f.add('prior-builder', f.task, 'Tester', 'win')
    f.group(f.task).ledger!.runs!.push({ agentId: prior } as never)
    f.state.machines = [machine('host', 'macOS'), machine('win', 'Windows')] as never
    const effects = f.ready(['desktop/lib/view.dart'])
    expect(f.steps().find(s => s.name === 'Test on Windows')).toEqual({ name: 'Test on Windows', agent: null, status: null })
    expect(effects.messages.some(m => m.recipients.includes(f.lead) && m.text.includes('Test on Windows'))).toBe(true)
    expect(f.group(f.task).assignment?.status).toBe('review')
  })

  it.each(['docs/windows-rules.md', 'backend/src/superTabs/steps.ts', 'cli/src/team/script.ts'])('does not open Windows for %s', file => {
    const f = fixture()
    f.add('win-tst', f.task, 'Tester', 'win')
    f.state.machines = [machine('win', 'Windows')] as never
    f.ready([file])
    expect(f.steps().some(s => s.name === 'Test on Windows')).toBe(false)
  })

  it('keeps an existing Windows step when a later Ready adds a Mac test', () => {
    const f = fixture()
    const win = f.add('win-tst', f.task, 'Tester', 'win'), mac = f.add('mac-tst', f.task, 'Tester')
    f.state.machines = [machine('host', 'macOS'), machine('win', 'Windows')] as never
    const onlyWindows = { ...SEED_RULES, reviews: { ...SEED_RULES.reviews, test: [{ where: 'Desktop on Windows', paths: ['desktop/**'] }] } }
    f.ready(['desktop/lib/view.dart'], 'abc1234', true, { projectRules: { revision: 1, rules: onlyWindows } })
    const step = stepsOf(f.state, f.task).find(s => s.step === 'Test on Windows')
    expect(step?.assignment?.agentId).toBe(win)
    f.run({ type: 'work.status', conversationId: f.task, assignmentId: f.group(f.task).assignment!.id, status: 'working', result: 'More changes' }, f.as(f.dev))
    f.ready(['desktop/lib/view.dart'], 'def5678')
    expect(stepsOf(f.state, f.task).filter(s => s.step === 'Test on Windows').map(s => s.id)).toEqual([step!.id])
    expect(f.steps().find(s => s.name === 'Test')?.agent).toBe(mac)
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

  it('plans by the project\'s saved rules, read with the files', () => {
    const f = fixture()
    f.add('rev-a', f.task, 'Reviewer'); f.add('rev-b', f.task, 'Reviewer')
    f.ready(['docs/a.md'], 'abc1234', true, { projectRules: { revision: 1, rules: { ...SEED_RULES, reviews: { ...SEED_RULES.reviews, defaultReads: 2 } } } })
    expect(f.steps().map(s => s.name)).toEqual(['Review 1', 'Review 2'])
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

// Task #3774 (Ken's routing rule, restored 11-06: "A Tester runs where the change runs: the machine comes before the model, and a
// mid-strength model is enough for most testing"). On 11-06 four Linux test steps waited for an Opus Tester while Sonnet Testers
// sat idle on the same machine.
describe('a test step\'s Tester runs a mid-strength model or stronger, whatever the engineer runs', () => {
  const sonnet: AgentConfiguration = { ...opus, model: 'sonnet' }
  function linux() {
    const f = fixture()
    const join = (name: string, roleName: string, configuration: AgentConfiguration) => f.run({ type: 'agent.add', conversationId: f.task, machineId: 'linux1',
      harnessId: name, name, configuration, lead: false, roleName } as Command, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
    /** The Linux machine as its report lists it, once its agents joined. */
    const listed = () => { f.state.machines = [{ machineId: 'linux1', name: 'linux1', contributorId: 'owner', membershipGeneration: 'g', generation: 'g1', cwd: '/swarm',
      scope: 'swarm', engines: ['claude'], maxAgents: 4, paused: false,
      observation: { generation: 'g1', receivedAt: 1_000_000 - 1000, sessionKind: 'computer', resources: { os: 'Linux' }, tools: {}, runningHarnessIds: [], stoppedHarnessIds: [],
        readiness: { engines: [{ engine: 'claude', installed: true, signedIn: true }] },
        quotas: [{ engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent: 10, resetsAt: null }] }] } }] as never }
    return Object.assign(f, { join, listed })
  }

  it('gives an Opus-built task\'s Linux test step to an idle Sonnet Tester; its review still refuses a Sonnet Reviewer', () => {
    const f = linux()
    const tester = f.join('sonnet-tst', 'Tester', sonnet)
    f.join('sonnet-rev', 'Reviewer', sonnet)
    f.listed()
    const effects = f.ready(['cli/src/superTabs/host.ts'])
    expect(f.steps()).toEqual(expect.arrayContaining([{ name: 'Review', agent: null, status: null },
      { name: 'Test on a Linux machine', agent: tester, status: 'working' }]))
    // The notice names the rule it applied to the step left open.
    const told = effects.messages.find(m => m.recipients.includes(f.lead) && /no free reviewer/i.test(m.text))!
    expect(told.text).toContain('Review')
    expect(told.text).toContain('at least as strong as its engineer')
  })

  it('never gives a test step to a grid model or a weaker one, and says the rule it applied', () => {
    const f = linux()
    const grid = f.join('grid-tst', 'Tester', sonnet)
    f.state.agents.find(a => a.id === grid)!.gridModel = 'kimi k3'
    f.join('haiku-tst', 'Tester', { ...opus, model: 'haiku', effort: 'auto' })
    f.listed()
    const effects = f.ready(['cli/src/superTabs/host.ts'])
    expect(f.steps().find(s => s.name === 'Test on a Linux machine')).toMatchObject({ agent: null })
    const told = effects.messages.find(m => m.recipients.includes(f.lead) && /no free reviewer/i.test(m.text))!
    expect(told.text).toMatch(/Test on a Linux machine.*mid-strength model or stronger/s)
  })
})
