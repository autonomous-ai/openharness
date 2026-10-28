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
  const finish = (id: string, worker: string, result = `Merged ${PR}`) => {
    const work = state.conversations.find(c => c.id === id)!
    const assignment = work.assignment!.id
    run({ type: 'work.check', conversationId: id, assignmentId: assignment, checkId: work.checks[0]!.id, passed: true, evidence: 'npm test: 12 passed' }, as(worker))
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
    const [line, ...more] = f.ships(f.finish(id, builder))
    expect(more).toEqual([])
    expect(line).toMatchObject({ conversationId: 'lead', recipients: [],
      source: { kind: SHIP_KIND, conversationId: id, title: 'Avatars', pullRequests: [PR], requesterId: 'owner', builderIds: [builder], reviewerIds: [reviewer] } })
    expect(line!.text).toBe(`🎉 Shipped: Avatars, requested by dee, built by Kai, reviewed by Ivy. ${PR}`)
  })

  it('leaves out who asked when nobody is recorded, and counts reviewers of a review group', () => {
    const f = fixture()
    const id = f.group()
    delete f.state.conversations.find(c => c.id === id)!.requesterId
    const builder = f.add('Kai', id)
    const review = f.run({ type: 'conversation.create', title: 'Review avatars', brief: 'Review.', reviewOf: id, checks: [] }).result.conversationId as string
    const reviewer = f.add('Ivy', review)
    f.state.agents.find(a => a.id === reviewer)!.role = 'reviewer'
    f.run({ type: 'work.assign', conversationId: id, agentId: builder }, owner)
    const [line] = f.ships(f.finish(id, builder))
    expect(line!.source).not.toHaveProperty('requesterId')
    expect(line!.text).toBe(`🎉 Shipped: Avatars, built by Kai, reviewed by Ivy. ${PR}`)
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
    // A private conversation is chat only today; were one ever to carry work, its celebration still says nothing of it.
    f.state.conversations.find(c => c.id === id)!.audience = { people: [{ id: 'owner', generation: 'tab' }] }
    const done = f.run({ type: 'work.status', conversationId: id, assignmentId: work.assignment!.id, status: 'done', result: `Merged ${PR}` })
    expect(f.ships(done)).toEqual([])
    expect(JSON.stringify(done.messages.filter(m => m.conversationId !== id))).not.toContain('Secret plan')
  })
})
