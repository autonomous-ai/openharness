/**
 * An agent whose model keeps failing gets no new work until it answers again (task #4076, found by the PM 11-06: seven Codex
 * Testers on daniel-pc, signed out of ChatGPT, were handed Linux steps over and over; each sat 30 minutes and was lost).
 */
import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { DISPATCH_RULES, dispatchPlan } from './dispatch.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'
import { reviewerCandidates } from './reviewerPick.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const opus: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const NOW = 1_000_000
const contribution = { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }

/** A task whose Engineer was lost, and a free Engineer and a free Tester on one listed machine, whose Claude reads signed in or not.
 *  On daniel-pc the reading still said signed in while every request failed, so a sign-in alone never kept the work away. */
function fixture(signedIn = true) {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: 'owner@example.com' }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const add = (name: string, group: string, roleName: string) => run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId: name,
    name, configuration: opus, lead: false, roleName } as Command, owner, contribution).result.agentId as string
  const lead = run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'pm', name: 'pm', configuration: opus, lead: true }, owner,
    contribution).result.agentId as string
  const task = run({ type: 'conversation.create', title: 'Fix the host', brief: 'The host restarts.', checks: [{ description: 'Restarts', independent: true }],
    priority: 'P2', requesterId: 'owner' }, as(lead)).result.conversationId as string
  const dev = add('dev', task, 'Engineer')
  run({ type: 'work.assign', conversationId: task, agentId: dev }, as(lead))
  const engineer = add('eng', task, 'Engineer'), tester = add('tst', task, 'Tester')
  const generation = state.people.find(p => p.id === 'owner')!.generation
  state.machines = [{ machineId: 'host', name: 'daniel-pc', contributorId: 'owner', membershipGeneration: generation, generation: 'g1', cwd: '/swarm',
    scope: 'swarm', engines: ['claude'], maxAgents: 8, paused: false,
    observation: { generation: 'g1', receivedAt: NOW - 1000, sessionKind: 'computer', resources: { os: 'Linux' }, tools: {}, runningHarnessIds: ['pm', 'dev', 'eng', 'tst'],
      stoppedHarnessIds: [], readiness: { engines: [{ engine: 'claude', installed: true, signedIn }] },
      quotas: [{ engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent: 10, resetsAt: null }] }] } }] as never
  const group = (id = task) => state.conversations.find(c => c.id === id)!
  const held = group().assignment!
  held.status = 'lost'
  held.lost = { reason: 'its machine went offline', at: NOW }
  group().lostAttempt = { id: held.id, agentId: dev, machineId: 'host', engine: 'claude' }
  const alert = (agentId: string, active = true) => run({ type: 'agent.alert', agentId, alert: 'model', active } as Command, as(agentId))
  const picks = () => dispatchPlan(state, 'lead', DISPATCH_RULES, NOW).map(p => p.agentId)
  return { run, as, lead, task, dev, engineer, tester, group, alert, picks, get state() { return state } }
}

describe('an agent whose model keeps failing', () => {
  it('is skipped by the lane dispatch, also once its alert ended, and offered work again after one answer of its own', () => {
    const f = fixture()
    expect(f.picks()).toContain(f.engineer)
    f.alert(f.engineer)
    expect(f.picks()).not.toContain(f.engineer)
    // A quiet screen is no answer.
    f.alert(f.engineer, false)
    expect(f.picks()).not.toContain(f.engineer)
    f.run({ type: 'message.send', conversationId: f.task, text: 'Back: my model answers again.', replyTo: null, recipientIds: [] } as Command, f.as(f.engineer))
    expect(f.picks()).toContain(f.engineer)
  })

  it('is refused by work.assign, never stopped or removed', () => {
    const f = fixture()
    f.alert(f.engineer)
    expect(() => f.run({ type: 'work.assign', conversationId: f.task, agentId: f.engineer }, f.as(f.lead))).toThrow(expect.objectContaining({ code: 'MODEL_FAILING' }))
    expect(f.state.agents.find(a => a.id === f.engineer)).toMatchObject({ id: f.engineer })
    expect(f.state.agents.find(a => a.id === f.engineer)!.workDecision).toBeUndefined()
  })

  it('is never picked for a step', () => {
    const f = fixture()
    expect(reviewerCandidates(f.state, f.group(), 'test', null, NOW).map(a => a.id)).toContain(f.tester)
    f.alert(f.tester)
    expect(reviewerCandidates(f.state, f.group(), 'test', null, NOW).map(a => a.id)).not.toContain(f.tester)
  })

  it('leaves a route\'s candidates for its exclusions, marked model failing', () => {
    const f = fixture()
    f.alert(f.engineer)
    const member = { id: 'c0', kind: 'member', agentId: f.engineer, machineId: 'host', engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 2,
      title: 'eng on daniel-pc', label: 'eng' }
    const fresh = { ...member, id: 'c1', kind: 'new', agentId: undefined, title: 'new on daniel-pc' }
    const decision = { assessment: { difficulty: 'low', risk: 'low', why: 'A test.' }, candidates: [member, fresh], excluded: [], floor: 2, notes: false,
      via: 'instructions', p: null, belowFloor: false, why: 'Instructions.' }
    const routed = f.run({ type: 'route.record', conversationId: f.task, decision } as Command, f.as(f.lead))
    expect(routed.routeDecisions[0]).toMatchObject({ record: { candidates: [{ id: 'c1' }],
      excluded: [{ title: 'eng on daniel-pc', reason: expect.stringContaining('model failing') }] } })
  })

  it('tells its PM and its machine\'s owner once, with what the machine shows', () => {
    const f = fixture(false)
    const first = f.alert(f.tester).messages
    const told = first.filter(m => m.recipients.includes(f.lead))
    expect(told).toHaveLength(1)
    expect(told[0]!.text).toContain('not signed in')
    expect(told[0]!.text).toContain('no new work until it answers')
    expect(first.flatMap(m => m.mentions ?? [])).toContain('owner')
    // A new episode of the same failure tells nobody again.
    f.alert(f.tester, false)
    expect(f.alert(f.tester).messages).toEqual([])
  })
})
