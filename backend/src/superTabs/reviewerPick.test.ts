import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'
import { builtBy, reviewerCandidates, strengthOf } from './reviewerPick.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const opus: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const sonnet: AgentConfiguration = { ...opus, model: 'sonnet' }
const sol: AgentConfiguration = { ...opus, engine: 'codex', model: 'gpt-6.1-sol' }

function fixture(engineer: AgentConfiguration = opus) {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const now = 1_000_000
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const add = (harnessId: string, group: string, configuration = opus, extra: Record<string, unknown> = {}) => run({ type: 'agent.add', conversationId: group,
    machineId: 'host', harnessId, name: harnessId, configuration, lead: false, ...extra } as Command, owner,
    { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  const lead = run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'pm', name: 'pm', configuration: opus, lead: true }, owner,
    { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  const task = run({ type: 'conversation.create', title: 'Fix login', brief: 'Sign in works offline.' }, as(lead)).result.conversationId as string
  const dev = add('dev', task, engineer)
  run({ type: 'work.assign', conversationId: task, agentId: dev }, as(lead))
  const group = (id: string) => state.conversations.find(c => c.id === id)!
  const pick = (kind: 'review' | 'security' | 'test' = 'review', head: string | null = 'abc1234', readyAt = 0) =>
    reviewerCandidates(state, group(task), kind, head, readyAt).map(a => a.name)
  return { run, as, add, lead, task, dev, group, pick, get state() { return state } }
}

describe('strengthOf', () => {
  it('reads the catalog by engine, model and effort; a grid model or an unknown one has none', () => {
    const f = fixture()
    const agent = (name: string) => f.state.agents.find(a => a.name === name)!
    f.add('o', 'lead', opus); f.add('s', 'lead', sonnet); f.add('x', 'lead', { ...opus, model: 'mystery' })
    expect(strengthOf(f.state, agent('o'))).toBe(3)
    expect(strengthOf(f.state, agent('s'))).toBe(2)
    expect(strengthOf(f.state, agent('x'))).toBeNull()
    const grid = agent('o')
    grid.gridModel = 'kimi k3'
    expect(strengthOf(f.state, grid)).toBeNull()
  })
})

describe('builtBy', () => {
  it('names the assignee and every agent that ran the task', () => {
    const f = fixture()
    expect([...builtBy(f.group(f.task))]).toEqual([f.dev])
  })
})

describe('reviewerCandidates', () => {
  it('is never the engineer, nor an agent that built the task before', () => {
    const f = fixture()
    const before = f.add('before', f.task)
    f.group(f.task).ledger!.runs!.push({ ...f.group(f.task).ledger!.runs![0]!, agentId: before })
    f.add('rev', f.task, opus, { roleName: 'Reviewer' })
    expect(f.pick()).toEqual(['rev'])
  })

  it('is never a grid model, nor weaker than the engineer, nor of unknown strength', () => {
    const f = fixture()
    f.add('weak', f.task, sonnet, { roleName: 'Reviewer' })
    f.add('mystery', f.task, { ...opus, model: 'mystery' }, { roleName: 'Reviewer' })
    const grid = f.add('grid', f.task, opus, { roleName: 'Reviewer' })
    f.state.agents.find(a => a.id === grid)!.gridModel = 'kimi k3'
    f.add('strong', f.task, sol, { roleName: 'Reviewer' })
    expect(f.pick()).toEqual(['strong'])
  })

  it('takes a weaker engineer\'s reviewer at its own strength or more', () => {
    const f = fixture(sonnet)
    f.add('s', f.task, sonnet, { roleName: 'Reviewer' })
    f.add('o', f.task, opus, { roleName: 'Reviewer' })
    expect(f.pick().sort()).toEqual(['o', 's'])
  })

  it('is never an agent with a verdict at this head; one at an older head may review again', () => {
    const f = fixture()
    const read = f.add('read', f.task, opus, { roleName: 'Reviewer' })
    const older = f.add('older', f.task, opus, { roleName: 'Reviewer' })
    f.group(f.task).checks = [{ id: 'c', description: 'Reviewed', independent: true, evidence: null, passedBy: null, verdicts: [
      { by: `agent:${read}`, passed: true, evidence: 'Yes', at: 5, head: 'abc1234' },
      { by: `agent:${older}`, passed: true, evidence: 'Yes', at: 5, head: 'fff0000' },
    ] } as never]
    expect(f.pick('security', 'abc1234')).toEqual(['older'])
  })

  it('counts a verdict without a head as at this head when given since the task was handed', () => {
    const f = fixture()
    const since = f.add('since', f.task, opus, { roleName: 'Reviewer' })
    const before = f.add('before', f.task, opus, { roleName: 'Reviewer' })
    f.group(f.task).checks = [{ id: 'c', description: 'Reviewed', independent: true, evidence: null, passedBy: null, verdicts: [
      { by: `agent:${since}`, passed: true, evidence: 'Yes', at: 50 },
      { by: `agent:${before}`, passed: true, evidence: 'Yes', at: 5 },
    ] }]
    expect(f.pick('security', 'abc1234', 10)).toEqual(['before'])
  })

  it('is never busy, a PM, a Buddy, or holding another step of this task', () => {
    const f = fixture()
    const busy = f.add('busy', f.task, opus, { roleName: 'Reviewer' })
    const other = f.run({ type: 'conversation.create', title: 'Other' }, f.as(f.lead)).result.conversationId as string
    f.run({ type: 'work.assign', conversationId: other, agentId: busy }, f.as(f.lead))
    const buddy = f.add('buddy', f.task, opus, { roleName: 'Reviewer' })
    f.state.agents.find(a => a.id === buddy)!.buddyOf = { personId: 'owner', generation: 'g' }
    const holder = f.add('holder', f.task, opus, { roleName: 'Reviewer' })
    const step = f.run({ type: 'conversation.create', title: 'Security review 1', reviewOf: f.task, step: 'Security review 1' } as Command, f.as(f.dev)).result.conversationId as string
    f.run({ type: 'work.assign', conversationId: step, agentId: holder }, f.as(f.dev))
    f.add('free', f.task, opus, { roleName: 'Reviewer' })
    expect(f.pick('security')).toEqual(['free'])
  })

  it('takes the step\'s role first, then any other free agent; never a Guide or an Integrator', () => {
    const f = fixture()
    f.add('eng', f.task, opus, { roleName: 'Engineer' })
    f.add('guide', f.task, opus, { roleName: 'Guide' })
    f.add('integrator', f.task, opus, { roleName: 'Integrator' })
    f.add('tester', f.task, opus, { roleName: 'Tester' })
    f.add('rev', f.task, opus, { roleName: 'Reviewer' })
    expect(f.pick('review')).toEqual(['rev', 'eng', 'tester'])
    expect(f.pick('test')).toEqual(['tester', 'eng', 'rev'])
  })

  it('is never an agent of another project', () => {
    const f = fixture()
    f.run({ type: 'project.create', name: 'Other', visibility: 'public' } as Command)
    const otherLead = f.state.projects!.find(p => p.name === 'Other')!.leadConversationId
    f.add('away', otherLead, opus, { roleName: 'Reviewer' })
    expect(f.pick()).toEqual([])
  })
})
