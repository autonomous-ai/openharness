import { describe, expect, it } from 'vitest'
import { opensStep, storedStep } from './steps.test-support.js'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'
import { SEED_RULES, type MachineRule, type ProjectRules } from './policy.js'

// Task #3964: starts follow the project's machine rules. Generic machines and hours.
const RULES: MachineRule[] = [
  { machineIds: ['travels'], why: 'Away while its owner travels', away: { days: [1, 2, 3, 4, 5], windows: [['07:30', '09:30']], timeZone: 'Asia/Ho_Chi_Minh' } },
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
    if (opensStep(command)) return storedStep(state, command, actor)
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
      requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: [], devices: [], quotaRequired: false } } }, s.as(s.pm),
    // The PM's own person's computer (task #4120: a start runs as the machine's own person, through no share).
    { now, contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })

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
    s.as(s.pm), { projectRules: { revision: 0, rules: SEED_RULES }, contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }))).toBeNull()
  })
})
