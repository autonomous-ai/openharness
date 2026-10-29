import { describe, it, expect } from 'vitest'
import { DEFAULT_ROUTING_POLICY as policy } from './routingPolicy.js'
import { agentTarget, broken, reviewRefusal, targetQuality } from './rules.js'
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

