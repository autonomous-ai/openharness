/**
 * Stuck work is flagged at once to the PM and the people on the task (task #3915, Tony 11-06: #3821 sat with red checks and a
 * lost Test step, and nobody told him).
 */
import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type SuperTabState } from './model.js'
import { stuckAlerts, STUCK_DOWN_MS } from './stuck.js'

const PR = 'https://github.com/acme/app/pull/7'
const HEAD = 'abc1234def5678abc1234def5678abc1234def56'
const NOW = 10_000_000
const person = (userId: string): Actor => ({ kind: 'person', userId, email: `${userId}@example.com` })

const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }

/** A public project App with its PM and a worker, and people p (its owner), c and d (as boardRights.test.ts). */
function swarm() {
  let state = createSuperTab('swarm', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
  state.people.push({ id: 'p', email: 'p@example.com', role: 'collaborator', generation: 'p1' },
    { id: 'c', email: 'c@example.com', role: 'collaborator', generation: 'c1' },
    { id: 'd', email: 'd@example.com', role: 'collaborator', generation: 'd1' })
  let next = 0
  const run = (command: Command, actor: Actor = person('p'), context: Partial<CommandContext> = {}) => {
    const effect = applyCommand(state, actor, command, { operationId: `op${next++}`, now: NOW,
      contribution: { machineOwnerId: 'p', contributorId: actor.kind === 'person' ? actor.userId : 'p' }, ...context })
    state = effect.state
    return effect.result as Record<string, unknown>
  }
  const app = run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' } as Command) as { projectId: string; conversationId: string }
  const add = (harnessId: string, lead: boolean) => run({ type: 'agent.add', conversationId: app.conversationId, harnessId, machineId: 'machine',
    name: harnessId, lead, configuration } as Command).agentId as string
  const pm = add('pm', true), worker = add('worker', false)
  const asAgent = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'p' })
  return { run, app, pm, worker, add, asAgent, get state(): SuperTabState { return state } }
}

/** A task in App that d asked for, built by the worker. */
function fixture() {
  const f = swarm()
  const task = f.run({ type: 'conversation.create', projectId: f.app.projectId, title: 'Fix the host', brief: 'The host restarts.',
    checks: [{ description: 'Restarts', independent: true }], priority: 'P2', requesterId: 'd' } as Command, f.asAgent(f.pm)).conversationId as string
  f.run({ type: 'work.assign', conversationId: task, agentId: f.worker } as Command, f.asAgent(f.pm))
  const group = (id = task) => f.state.conversations.find(c => c.id === id)!
  const post = (actor: Actor, text: string, id = task) => f.run({ type: 'message.send', conversationId: id, text } as Command, actor)
  return { ...f, task, group, post }
}

describe('who wrote in a task', () => {
  it('records the people who post there, newest last, at most four, and no agent', () => {
    const f = fixture()
    f.state.people.push({ id: 'e', email: 'e@example.com', role: 'collaborator', generation: 'e1' })
    f.post(person('c'), 'Any news?')
    f.post(person('d'), 'It still fails for me.')
    f.post(person('owner'), 'Looking.')
    f.post(person('e'), 'Same here.')
    f.post(person('c'), 'Still?')
    f.post(person('p'), 'On it.')
    f.post(f.asAgent(f.worker), 'Pushed a fix.')
    expect(f.group().writers).toEqual(['owner', 'e', 'c', 'p'])
  })
})

describe('a stuck task', () => {
  const lines = (rows: ReturnType<typeof stuckAlerts>['rows'], conversationId: string) => rows.filter(r => r.conversationId === conversationId)

  it('with red checks at its head while its Engineer says review, tells the PM and its people once, and clears when green', () => {
    const f = fixture()
    f.post(person('c'), 'Is this ready?')
    f.run({ type: 'work.status', conversationId: f.task, assignmentId: f.group().assignment!.id, status: 'review', result: `Ready: ${PR}` } as Command, f.asAgent(f.worker))
    const g = f.group()
    g.pullRequestHeads = { [PR]: { head: HEAD, patch: null, at: NOW } }
    g.pullRequestChecks = { [PR]: 'red' }
    const first = stuckAlerts(f.state, NOW)
    const told = lines(first.rows, f.task)
    expect(told).toHaveLength(1)
    expect(told[0]!.recipients).toEqual([f.pm])
    expect(told[0]!.author.id).toBe(f.pm)
    expect([...told[0]!.mentions!].sort()).toEqual(['c', 'd'])
    expect(told[0]!.text).toContain('checks are red on PR #7 at abc1234')
    // Every later pass says nothing while it stays red.
    expect(stuckAlerts(f.state, NOW + 60_000).rows).toEqual([])
    f.group().pullRequestChecks = { [PR]: 'green' }
    const fixed = stuckAlerts(f.state, NOW + 120_000)
    expect(lines(fixed.rows, f.task)).toEqual([expect.objectContaining({ text: expect.stringContaining('No longer stuck'), recipients: [f.pm] })])
    expect(lines(fixed.rows, f.task)[0]!.mentions ?? []).toEqual([])
    expect(fixed.resolved).toEqual([{ conversationId: f.task, messageId: told[0]!.id, personIds: told[0]!.mentions }])
    expect(f.group().stuck).toBeUndefined()
    expect(stuckAlerts(f.state, NOW + 180_000).rows).toEqual([])
  })

  it('with red checks while its Engineer is still working, says nothing', () => {
    const f = fixture()
    f.group().pullRequestUrls = [PR]
    f.group().pullRequestChecks = { [PR]: 'red' }
    expect(stuckAlerts(f.state, NOW).rows).toEqual([])
  })

  it('whose step lost its Tester, says so once, and clears when someone takes the step', () => {
    const f = fixture()
    const tester = f.add('tst', false), other = f.add('tst2', false)
    const step = f.run({ type: 'conversation.create', title: 'Test', brief: 'Test it.', reviewOf: f.task, step: 'Test',
      checks: [{ description: 'Runs.', independent: true }] } as Command, f.asAgent(f.pm)).conversationId as string
    f.run({ type: 'work.assign', conversationId: step, agentId: tester } as Command, f.asAgent(f.pm))
    const held = f.group(step).assignment!
    held.status = 'lost'
    held.lost = { reason: 'its machine went offline', at: NOW }
    const told = lines(stuckAlerts(f.state, NOW).rows, f.task)
    expect(told).toHaveLength(1)
    expect(told[0]!.text).toContain('the Test step lost its agent')
    expect(told[0]!.mentions).toEqual(['d'])
    expect(stuckAlerts(f.state, NOW + 60_000).rows).toEqual([])
    f.run({ type: 'work.assign', conversationId: step, agentId: other } as Command, f.asAgent(f.pm))
    const fixed = stuckAlerts(f.state, NOW + 120_000)
    expect(lines(fixed.rows, f.task)).toEqual([expect.objectContaining({ text: expect.stringContaining('No longer stuck') })])
    expect(fixed.resolved).toHaveLength(1)
  })

  it('whose agent went down, says so only once nobody has taken it for 10 minutes, and clears when someone does', () => {
    const f = fixture()
    const held = f.group().assignment!
    held.status = 'lost'
    held.lost = { reason: 'its machine went offline', at: NOW }
    expect(stuckAlerts(f.state, NOW + STUCK_DOWN_MS - 60_000).rows).toEqual([])
    const told = lines(stuckAlerts(f.state, NOW + STUCK_DOWN_MS).rows, f.task)
    expect(told).toHaveLength(1)
    expect(told[0]!.text).toContain('worker went down 10 minutes ago and nobody has taken this task')
    expect(told[0]!.recipients).toEqual([f.pm])
    expect(told[0]!.mentions).toEqual(['d'])
    expect(stuckAlerts(f.state, NOW + STUCK_DOWN_MS + 60_000).rows).toEqual([])
    f.run({ type: 'work.assign', conversationId: f.task, agentId: f.worker } as Command, f.asAgent(f.pm))
    const fixed = stuckAlerts(f.state, NOW + STUCK_DOWN_MS + 120_000)
    expect(lines(fixed.rows, f.task)).toEqual([expect.objectContaining({ text: expect.stringContaining('No longer stuck') })])
  })

  it('that is cancelled while flagged, has its tags resolved and no line', () => {
    const f = fixture()
    const held = f.group().assignment!
    held.status = 'lost'
    held.lost = { reason: 'its machine went offline', at: NOW }
    const told = lines(stuckAlerts(f.state, NOW + STUCK_DOWN_MS).rows, f.task)
    f.group().assignment!.status = 'cancelled'
    const ended = stuckAlerts(f.state, NOW + STUCK_DOWN_MS + 60_000)
    expect(ended.rows).toEqual([])
    expect(ended.resolved).toEqual([{ conversationId: f.task, messageId: told[0]!.id, personIds: ['d'] }])
  })
})
