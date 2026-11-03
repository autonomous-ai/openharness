import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'
import { SHIP_KIND } from './ship.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'dee@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const PR = 'https://github.com/example/app/pull/7'

function fixture() {
  let state = createSuperTab('tab', 'Office', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: 1000, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const add = (name: string, group: string, lead = false) => run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId: name,
    name, configuration: config, lead }, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  const lead = add('River', 'lead', true)
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const group = (title = 'Avatars', extra: Record<string, unknown> = {}) => run({ type: 'conversation.create', title, brief: 'Add avatars.',
    checks: [{ description: 'Tests pass', independent: false }], ...extra } as Command).result.conversationId as string
  /** Passes the task's first check as [passer] (its worker by default), then marks it Done as its worker. */
  const finish = (id: string, worker: string, result = `Merged ${PR}`, passer = worker) => {
    const work = state.conversations.find(c => c.id === id)!
    const assignment = work.assignment!.id
    run({ type: 'work.check', conversationId: id, assignmentId: assignment, checkId: work.checks[0]!.id, passed: true, evidence: 'npm test: 12 passed' }, as(passer))
    return run({ type: 'work.status', conversationId: id, assignmentId: assignment, status: 'done', result }, as(worker))
  }
  const ships = (effects: ReturnType<typeof run>) => effects.messages.filter(m => m.source?.kind === SHIP_KIND)
  return { run, add, as, group, finish, ships, lead, get state() { return state } }
}

describe('the ship moment', () => {
  it('posts one celebration in the project chat naming the requester, builder and reviewers', () => {
    const f = fixture()
    const id = f.group()
    const builder = f.add('Kai', id)
    const reviewer = f.add('Ivy', id)
    f.state.agents.find(a => a.id === reviewer)!.role = 'reviewer'
    f.run({ type: 'work.assign', conversationId: id, agentId: builder }, owner)
    const [line, ...more] = f.ships(f.finish(id, builder, undefined, reviewer))
    expect(more).toEqual([])
    expect(line).toMatchObject({ conversationId: 'lead', recipients: [],
      source: { kind: SHIP_KIND, conversationId: id, title: 'Avatars', pullRequests: [PR], requesterId: 'owner', builderIds: [builder], reviewerIds: [reviewer] } })
    expect(line!.text).toBe(`🎉 Shipped: Avatars, requested by dee, built by Kai, reviewed by Ivy. ${PR}`)
  })

  it('leaves out who asked when nobody is recorded, and counts who passed a linked task\'s check', () => {
    const f = fixture()
    const id = f.group()
    delete f.state.conversations.find(c => c.id === id)!.requesterId
    const builder = f.add('Kai', id)
    const review = f.run({ type: 'conversation.create', title: 'Review avatars', brief: 'Review.', reviewOf: id, checks: [{ description: 'Verdict', independent: false }] })
      .result.conversationId as string
    const reviewer = f.add('Ivy', review)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder }, owner)
    f.run({ type: 'work.assign', conversationId: review, agentId: reviewer }, owner)
    const verdict = f.state.conversations.find(c => c.id === review)!
    f.run({ type: 'work.check', conversationId: review, assignmentId: verdict.assignment!.id, checkId: verdict.checks[0]!.id, passed: true, evidence: 'Ready: yes' }, f.as(reviewer))
    const [line] = f.ships(f.finish(id, builder))
    expect(line!.source).not.toHaveProperty('requesterId')
    expect(line!.text).toBe(`🎉 Shipped: Avatars, built by Kai, reviewed by Ivy. ${PR}`)
  })

  // Review credit goes to whoever passed a check on another agent's task (project instructions, phase 4), never by role.
  it('names who passed its checks as reviewers, whatever their role', () => {
    const f = fixture()
    const id = f.group('Avatars', { checks: [{ description: 'Tests pass', independent: false }, { description: 'Reviewed', independent: false }] })
    const builder = f.add('Kai', id), checker = f.add('Max', id), bystander = f.add('Lee', id)
    f.state.agents.find(a => a.id === bystander)!.role = 'reviewer'
    const review = f.run({ type: 'conversation.create', title: 'Test avatars', brief: 'Test.', reviewOf: id, checks: [{ description: 'Tested', independent: false }] })
      .result.conversationId as string
    const tester = f.add('Ivy', review)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder }, owner)
    f.run({ type: 'work.assign', conversationId: review, agentId: tester }, owner)
    const linked = f.state.conversations.find(c => c.id === review)!
    f.run({ type: 'work.check', conversationId: review, assignmentId: linked.assignment!.id, checkId: linked.checks[0]!.id, passed: true, evidence: 'Tested' }, f.as(tester))
    const work = f.state.conversations.find(c => c.id === id)!
    f.run({ type: 'work.check', conversationId: id, assignmentId: work.assignment!.id, checkId: work.checks[1]!.id, passed: true, evidence: 'Looks right' }, f.as(checker))
    // The assignee passes its own first check: never its own reviewer.
    const [line] = f.ships(f.finish(id, builder))
    expect(line!.source).toMatchObject({ builderIds: [builder], reviewerIds: [checker, tester] })
    expect(line!.text).toBe(`🎉 Shipped: Avatars, requested by dee, built by Kai, reviewed by Max and Ivy. ${PR}`)
  })

  it('celebrates a group once: reassigned and Done again, it stays quiet', () => {
    const f = fixture()
    const id = f.group()
    const builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder }, owner)
    expect(f.ships(f.finish(id, builder))).toHaveLength(1)
    const again = f.add('Ivy', id)
    f.run({ type: 'agent.release', agentId: builder, decision: 'keep' }, f.as(f.lead))
    f.run({ type: 'work.assign', conversationId: id, agentId: again }, owner)
    expect(f.ships(f.finish(id, again, 'Follow-up merged https://github.com/example/app/pull/8'))).toEqual([])
  })

  it('stays quiet without a linked pull request, for a review group, and for other statuses', () => {
    const f = fixture()
    const id = f.group()
    const builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder }, owner)
    const assignment = f.state.conversations.find(c => c.id === id)!.assignment!.id
    expect(f.ships(f.run({ type: 'work.status', conversationId: id, assignmentId: assignment, status: 'review', result: PR }, f.as(builder)))).toEqual([])
    expect(f.ships(f.finish(id, builder, 'Done, nothing to merge.'))).toEqual([])
  })

  it('never names a private conversation, its words or its link', () => {
    const f = fixture()
    const id = f.group('Secret plan')
    const builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder }, owner)
    const work = f.state.conversations.find(c => c.id === id)!
    f.run({ type: 'work.check', conversationId: id, assignmentId: work.assignment!.id, checkId: work.checks[0]!.id, passed: true, evidence: 'ok' }, f.as(builder))
    // A private conversation (a Buddy chat) is chat only today; were one ever to carry work, its celebration still says nothing of it.
    Object.assign(f.state.conversations.find(c => c.id === id)!, { kind: 'buddy', audience: { people: [{ id: 'owner', generation: 'tab' }] } })
    const done = f.run({ type: 'work.status', conversationId: id, assignmentId: work.assignment!.id, status: 'done', result: `Merged ${PR}` })
    expect(f.ships(done)).toEqual([])
    expect(JSON.stringify(done.messages.filter(m => m.conversationId !== id))).not.toContain('Secret plan')
  })
})
