import { describe, it, expect } from 'vitest'
import { DEFAULT_ROUTING_POLICY as policy } from './routingPolicy.js'
import { agentTarget, broken, reviewRefusal, startTarget, targetQuality } from './rules.js'
import { effectivePolicy } from './routingPolicy.js'
import { cheapAttempt } from './stepUp.js'
import { recordRun } from './leaderboard/record.js'
const builder = { id: 'builder', machineId: 'allowed', harnessId: 'hb', configuration: { engine: 'claude', model: 'opus', effort: 'high' } }
const stateOf = (reviewer: any) => ({ agents: [builder, reviewer], conversations: [{ id: 'work', projectId: 'p', assignment: { agentId: 'builder', configuration: builder.configuration } }], machines: [], starts: [{ harnessId: reviewer.harnessId, request: { machineId: reviewer.machineId, engine: reviewer.configuration.engine, model: 'default' } }] } as any)
// The Reviewer's probes of ee4ee6c9a (PR #2137): who may review, and when a verdict steps a task up.
describe('reviews and step-ups by what each attempt runs on', () => {
  it('refuses a reported mini model even when its old start requested default', () => {
    const mini = { id: 'reviewer', machineId: 'allowed', harnessId: 'hr', configuration: { engine: 'codex', model: 'gpt-5.5-mini', effort: 'high' } }
    const state = stateOf(mini), target = agentTarget(state, mini as any)
    const server = targetQuality(policy, target)
    expect(reviewRefusal(state, 'work', target, policy), 'A known small reported model must never review').not.toBeNull()
  })
  it('does not block a permitted top-tier same-engine review for an alternative forbidden by the owner', () => {
    const opus = { id: 'reviewer', machineId: 'allowed', harnessId: 'hr', configuration: { engine: 'claude', model: 'opus', effort: 'high' } }
    const state = stateOf(opus)
    state.machines = [{ machineId: 'forbidden', engines: ['codex'] }]
    state.rules = [{ projectId: 'p', rule: { kind: 'machines', machineIds: ['allowed'] }, text: 'Only the approved machine.' }]
    const target = agentTarget(state, opus as any)
    const other = { machineId: 'forbidden', engine: 'codex', model: 'default', effort: 'default' }
    expect(broken(state.rules, other)).not.toBeNull()
    expect(broken(state.rules, target)).toBeNull()
    expect(reviewRefusal(state, 'work', target, policy), 'No alternative engine may run under the owner hard rule').toBeNull()
  })
  it('does not step up a top-tier Codex attempt merely because its ledger retains the reported slug', () => {
    const worker = { id: 'codex', machineId: 'allowed', harnessId: 'hc', configuration: { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' } }
    const state = stateOf(worker)
    const group = { id: 'work', assignment: { id: 'attempt-2', agentId: worker.id, configuration: worker.configuration }, stepUp: { attempt: 2, floor: 2, reason: 'Grid failed', at: 1, carry: '' } } as any
    expect(targetQuality(policy, agentTarget(state, worker as any))).toBe(3)
    recordRun(state, group, group.assignment, worker as any, 100)
    expect(cheapAttempt(group, policy), 'The attempt was admitted at quality 3 and must not step to the same tier again').toBe(false)
  })
})

// Ken, 2026-10-30: drop the rule that a review runs on another engine than its Builder's. Nearly every Builder is Claude, so
// reviews went to Codex and waited all morning while Codex was out of quota. A Reviewer is a session of its own with fresh
// context, so a strong model is what counts: any engine reviews any build, at once, with no note.
describe('a review on any strong engine', () => {
  const NOW = Date.parse('2026-10-30T09:00:00Z')
  const opus = { id: 'reviewer', machineId: 'allowed', harnessId: 'hr', contributorId: 'owner', configuration: { engine: 'claude', model: 'opus', effort: 'high' } }
  // A Codex machine with quota now: before, it made a Claude build's Claude review wait for it.
  const codexBox = { machineId: 'codex-box', contributorId: 'tony', engines: ['codex'],
    observation: { receivedAt: NOW - 1000, readiness: { engines: [{ engine: 'codex', installed: true, signedIn: true }] },
      quotas: [{ engine: 'codex', known: true, windows: [{ name: 'weekly', usedPercent: 10, resetsAt: null }] }] } }

  it('lets Claude Opus review a Claude build at once while a Codex Reviewer could start', () => {
    const state = stateOf(opus)
    state.machines = [codexBox]
    expect(reviewRefusal(state, 'work', agentTarget(state, opus as any), policy)).toBeNull()
    // A new Claude Reviewer the route would start, too.
    expect(reviewRefusal(state, 'work', startTarget({ machineId: 'allowed', engine: 'claude', model: 'opus', effort: 'high' }), policy)).toBeNull()
  })

  it('lets Codex review a Claude build, and Claude a Codex build', () => {
    const codex = { id: 'reviewer', machineId: 'allowed', harnessId: 'hr', configuration: { engine: 'codex', model: 'default', effort: 'high' } }
    expect(reviewRefusal(stateOf(codex), 'work', agentTarget(stateOf(codex), codex as any), policy)).toBeNull()
    // A Codex Builder, without touching the shared Claude one.
    const state = stateOf(opus), codexBuild = { engine: 'codex', model: 'default', effort: 'high' }
    state.agents[0] = { ...builder, configuration: codexBuild }
    state.conversations[0].assignment = { agentId: 'builder', configuration: codexBuild }
    expect(reviewRefusal(state, 'work', agentTarget(state, opus as any), policy)).toBeNull()
  })

  it('still never reviews on a grid model or one rated below 2, whatever the Builder ran', () => {
    const state = stateOf(opus)
    expect(reviewRefusal(state, 'work', { ...startTarget({ machineId: 'allowed', engine: 'claude', model: 'opus', effort: 'high' }), gridModel: 'kimi-k3' }, policy))
      .toBe('A review never runs on a model served on the Swarm\'s grid.')
    expect(reviewRefusal(state, 'work', startTarget({ machineId: 'allowed', engine: 'claude', model: 'haiku', effort: 'high' }), policy))
      .toBe('A review needs a model of quality 2 or more, and Claude haiku is 1.')
  })

  it('never lets the agent that built the work review it', () => {
    const state = stateOf(opus)
    expect(reviewRefusal(state, 'work', agentTarget(state, state.agents[0]), policy)).toBe('A Reviewer never reviews work it built.')
    // Another agent on the same engine, model and machine may.
    expect(reviewRefusal(state, 'work', agentTarget(state, opus as any), policy)).toBeNull()
  })
})

// A Codex Reviewer started on a model named for it (Lead, 10-30: a gpt-6.1-sol Reviewer was refused as quality 1, and on a Mac
// whose Codex default is a local model no review could run).
describe('a Codex Reviewer on a named model', () => {
  const codexOn = (model: string) => startTarget({ machineId: 'allowed', engine: 'codex', model, effort: 'high' })
  it('accepts gpt-6.1-sol at quality 3', () => {
    const state = stateOf({ id: 'other', machineId: 'allowed', harnessId: 'ho', configuration: { engine: 'claude', model: 'opus', effort: 'high' } })
    expect(targetQuality(policy, codexOn('gpt-6.1-sol'))).toBe(3)
    expect(reviewRefusal(state, 'work', codexOn('gpt-6.1-sol'), policy)).toBeNull()
  })
  it('still refuses a Codex model the policy does not name', () => {
    const state = stateOf({ id: 'other', machineId: 'allowed', harnessId: 'ho', configuration: { engine: 'claude', model: 'opus', effort: 'high' } })
    expect(targetQuality(policy, codexOn('gpt-7-unknown'))).toBe(1)
    expect(reviewRefusal(state, 'work', codexOn('gpt-7-unknown'), policy)).toBe('A review needs a model of quality 2 or more, and Codex gpt-7-unknown is 1.')
  })
  it('rates gpt-6.1-sol in a policy saved before its row, and keeps an owner\'s own row for it', () => {
    const saved = { ...policy, models: policy.models.filter(m => m.model !== 'gpt-6.1-sol') }
    expect(targetQuality(effectivePolicy(saved, null).policy, codexOn('gpt-6.1-sol'))).toBe(3)
    const owned = { ...policy, models: [...saved.models, { engine: 'codex' as const, model: 'gpt-6.1-sol', effort: 'high', quality: 2, cost: 2, enabled: false }] }
    expect(targetQuality(effectivePolicy(owned, null).policy, codexOn('gpt-6.1-sol'))).toBe(2)
  })
})
