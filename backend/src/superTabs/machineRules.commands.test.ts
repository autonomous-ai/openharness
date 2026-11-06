import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { DISPATCH_RULES, dispatchPlan, dispatchRules } from './dispatch.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'
import { SEED_RULES, type MachineRule, type ProjectRules } from './policy.js'

// Task #3964: starts, assignments and the lane dispatch follow the project's machine rules. Generic machines and hours.
const RULES: MachineRule[] = [
  { machineIds: ['travels'], why: 'Away while its owner travels', away: { days: [1, 2, 3, 4, 5], windows: [['07:30', '09:30']], timeZone: 'Asia/Ho_Chi_Minh' } },
  { machineIds: ['phone-mac'], why: 'The phone setup is there', first: { lanes: ['mobile'] } },
  { machineIds: ['no-codex'], why: 'No Codex there', noEngines: ['codex'] },
  { machineIds: ['local-codex'], why: 'Its Codex defaults to a local model', noReviews: true },
]
const RECORD: ProjectRules = { ...structuredClone(SEED_RULES), machines: RULES }
// Monday 2026-11-09 08:00 in Vietnam, inside the away window; 10:00 there, outside it.
const AWAY = Date.parse('2026-11-09T01:00:00Z'), BACK = Date.parse('2026-11-09T03:00:00Z')
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const config = (engine = 'claude'): AgentConfiguration => ({ engine, model: 'test-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' })
const contribution = { machineOwnerId: 'host-owner', contributorId: 'owner' }

function swarm() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, commandSchema.parse(command), { now: BACK, operationId: `op-${++sequence}`, contribution,
      projectRules: { revision: 1, rules: RECORD }, ...context })
    state = effects.state
    return effects
  }
  const add = (name: string, machineId: string, engine = 'claude', lead = false) => run({ type: 'agent.add', conversationId: 'lead', machineId,
    harnessId: name, name, configuration: config(engine), lead }).result.agentId as string
  const pm = add('PM', 'host', 'claude', true)
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const task = (title: string, owns: string[]) => run({ type: 'conversation.create', title,
    task: { goal: `${title}.`, changes: 'The change.', constraints: 'None.', owns }, checks: [] } as Command).result.conversationId as string
  const review = (of: string) => run({ type: 'conversation.create', title: 'Review', brief: 'Review it.', reviewOf: of, step: 'Review', checks: [] }).result.conversationId as string
  return { run, add, pm, as, task, review, get state() { return state } }
}
const refusal = (run: () => unknown) => { try { run(); return null } catch (error) { return { code: (error as { code?: string }).code, message: (error as Error).message } } }

describe('a start follows the machine rules', () => {
  const start = (s: ReturnType<typeof swarm>, group: string, machineId: string, engine: string, now = BACK) => s.run({ type: 'agent.start',
    request: { conversationId: group, machineId, engine, name: 'Worker', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: [], devices: [], quotaRequired: false } } }, s.as(s.pm), { now })

  it('refuses an engine a machine refuses, a Reviewer where none runs, and anything while the machine is away, with the why', () => {
    const s = swarm()
    for (const [name, machine] of [['A', 'no-codex'], ['B', 'local-codex'], ['C', 'travels']]) s.add(name!, machine!)
    const work = s.task('Server', ['backend/src/a.ts']), step = s.review(work)
    expect(refusal(() => start(s, work, 'no-codex', 'codex'))).toEqual({ code: 'MACHINE_RULE', message: 'No Codex there' })
    expect(refusal(() => start(s, work, 'no-codex', 'claude'))).toBeNull()
    expect(refusal(() => start(s, step, 'local-codex', 'codex'))).toEqual({ code: 'MACHINE_RULE', message: 'Its Codex defaults to a local model' })
    expect(refusal(() => start(s, work, 'local-codex', 'codex'))).toBeNull()
    expect(refusal(() => start(s, work, 'travels', 'claude', AWAY))).toEqual({ code: 'MACHINE_RULE', message: 'Away while its owner travels' })
    expect(refusal(() => start(s, work, 'travels', 'claude', BACK))).toBeNull()
  })

  it('refuses nothing in a project whose record has no machine rules', () => {
    const s = swarm()
    s.add('A', 'no-codex')
    const work = s.task('Server', ['backend/src/a.ts'])
    expect(refusal(() => s.run({ type: 'agent.start', request: { conversationId: work, machineId: 'no-codex', engine: 'codex', name: 'Worker', cwd: '/repo',
      worktree: true, requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: [], devices: [], quotaRequired: false } } },
    s.as(s.pm), { projectRules: { revision: 0, rules: SEED_RULES } }))).toBeNull()
  })
})

describe('an assignment follows the machine rules', () => {
  it('refuses a review to an agent where no Reviewer runs, and any work while its machine is away, with the why', () => {
    const s = swarm()
    const local = s.add('Local', 'local-codex', 'codex'), traveller = s.add('Traveller', 'travels')
    const work = s.task('Server', ['backend/src/a.ts']), step = s.review(work)
    expect(refusal(() => s.run({ type: 'work.assign', conversationId: step, agentId: local }, s.as(s.pm))))
      .toEqual({ code: 'MACHINE_RULE', message: 'Its Codex defaults to a local model' })
    expect(refusal(() => s.run({ type: 'work.assign', conversationId: work, agentId: traveller }, s.as(s.pm), { now: AWAY })))
      .toEqual({ code: 'MACHINE_RULE', message: 'Away while its owner travels' })
    expect(refusal(() => s.run({ type: 'work.assign', conversationId: work, agentId: local }, s.as(s.pm)))).toBeNull()
  })

  it('lets a Tester run where no Reviewer runs: a test step is not a review', () => {
    const s = swarm()
    const local = s.add('Local', 'local-codex', 'codex')
    const work = s.task('Server', ['backend/src/a.ts'])
    const test = s.run({ type: 'conversation.create', title: 'Test', brief: 'Test it.', reviewOf: work, step: 'Test', checks: [] }).result.conversationId as string
    expect(refusal(() => s.run({ type: 'work.assign', conversationId: test, agentId: local }, s.as(s.pm)))).toBeNull()
  })
})

describe('the lane dispatch follows the machine rules', () => {
  /** Engineers [names] on their machines, crew with no lane. */
  function crew(members: Array<[string, string, string?]>) {
    const s = swarm()
    const ids = Object.fromEntries(members.map(([name, machine, engine]) => [name, s.add(name, machine, engine)]))
    for (const id of Object.values(ids)) s.state.agents.find(a => a.id === id)!.crew = { role: 'Engineer', at: 1000, by: 'owner' }
    const picks = (now = BACK) => dispatchPlan(s.state, 'lead', dispatchRules(RECORD), now)
      .map(p => [s.state.agents.find(a => a.id === p.agentId)!.name, s.state.conversations.find(c => c.id === p.conversationId)!.title])
    return { ...s, ids, picks }
  }

  it('hands nothing to a member while its machine is away, and work again after', () => {
    const s = crew([['Traveller', 'travels']])
    s.task('Server', ['backend/src/a.ts'])
    expect(s.picks(AWAY)).toEqual([])
    expect(s.picks(BACK)).toEqual([['Traveller', 'Server']])
  })

  it('hands a member no work its machine refuses its engine for', () => {
    const s = crew([['Codex', 'no-codex', 'codex']])
    s.task('Server', ['backend/src/a.ts'])
    expect(s.picks()).toEqual([])
  })

  it('leaves phone work to a free member on the phone machine, and to another only when none is free there', () => {
    const s = crew([['Elsewhere', 'other'], ['Phone', 'phone-mac']])
    s.task('App', ['mobile/lib/a.dart'])
    expect(s.picks()).toEqual([['Phone', 'App']])
    const alone = crew([['Elsewhere', 'other']])
    alone.task('App', ['mobile/lib/a.dart'])
    expect(alone.picks()).toEqual([['Elsewhere', 'App']])
  })

  it('reads no machine rule from a record without them', () => {
    expect(dispatchRules(SEED_RULES).machines).toEqual([])
    expect(DISPATCH_RULES.machines).toEqual([])
  })
})
