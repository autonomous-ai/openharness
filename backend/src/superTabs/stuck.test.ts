/**
 * Stuck work is flagged at once to the PM and the people on the task (task #3915, Tony 11-06: #3821 sat with red checks and a
 * lost Test step, and nobody told him).
 */
import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type SuperTabState } from './model.js'
import { STUCK_DOWN_MS } from './stuck.js'

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
  const post = (actor: Actor, text: string, id = task) => f.run({ type: 'message.send', conversationId: id, text, replyTo: null, recipientIds: [] } as Command, actor)
  return { run: f.run, app: f.app, pm: f.pm, worker: f.worker, add: f.add, asAgent: f.asAgent, task, group, post, get state() { return f.state } }
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
