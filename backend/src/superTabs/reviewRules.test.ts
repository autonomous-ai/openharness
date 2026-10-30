import { describe, it, expect } from 'vitest'
import { DEFAULT_ROUTING_POLICY as policy } from './routingPolicy.js'
import { agentTarget, broken, reviewRefusal, SAME_ENGINE, sameEngineReview, targetQuality } from './rules.js'
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

// 2026-10-30: every Codex Reviewer was out of weekly quota for days, yet a Claude build's top-tier Claude review was refused
// because Codex machines existed, and reviews waited all morning (Tony). Another engine counts only where a Reviewer of it
// could start within the start window: on a machine the review may use, online, with quota now or once a window resets
// inside the window.
describe('a review on its Builder\'s own engine when no Reviewer of another engine could start soon', () => {
  const NOW = Date.parse('2026-10-30T09:00:00Z'), MIN = 60_000, DAY = 86_400_000
  const opus = { id: 'reviewer', machineId: 'allowed', harnessId: 'hr', contributorId: 'owner', configuration: { engine: 'claude', model: 'opus', effort: 'high' } }
  const codexBox = (resetsIn: number | null, usedPercent = 100, extra: Record<string, unknown> = {}) => ({ machineId: 'codex-box', contributorId: 'tony', engines: ['codex'],
    observation: { receivedAt: NOW - 1000, readiness: { engines: [{ engine: 'codex', installed: true, signedIn: true }] },
      quotas: [{ engine: 'codex', known: true, windows: [{ name: 'weekly', usedPercent, resetsAt: resetsIn === null ? null : new Date(NOW + resetsIn).toISOString() }] }] }, ...extra })
  const judge = (machines: unknown[], rules: unknown[] = []) => {
    const state = stateOf(opus)
    Object.assign(state, { machines, rules })
    const target = agentTarget(state, opus as any)
    return { refusal: reviewRefusal(state, 'work', target, policy, undefined, NOW), note: sameEngineReview(state, 'work', target, policy, undefined, NOW) }
  }

  it('lets Claude Opus review a Claude build while every Codex machine is out of quota for days, and says why', () => {
    expect(judge([codexBox(3 * DAY)])).toEqual({ refusal: null, note: expect.stringMatching(new RegExp(`^${SAME_ENGINE}`)) })
    expect(SAME_ENGINE).toBe('same-engine review: no Reviewer of another engine has quota')
    // Nor does an exhausted window that never says when it resets count.
    expect(judge([codexBox(null)]).refusal).toBeNull()
  })

  it('still refuses Claude while Codex resets inside the start window, or has quota now', () => {
    expect(judge([codexBox(10 * MIN)])).toEqual({ refusal: 'A review runs on another engine than the reviewed Builder\'s, Claude.', note: null })
    expect(judge([codexBox(3 * DAY, 40)]).refusal).toBe('A review runs on another engine than the reviewed Builder\'s, Claude.')
    // A quota it cannot read stays usable, as a start there is.
    const unread = codexBox(3 * DAY); unread.observation.quotas[0]!.known = false
    expect(judge([unread]).refusal).not.toBeNull()
  })

  it('lets Claude review when Codex runs only on a machine the owner left out, or one that is offline, signed out or suspended', () => {
    const owners = [{ projectId: 'p', rule: { kind: 'machines', machineIds: ['allowed'] }, text: 'Only the approved machine.' }]
    expect(judge([codexBox(3 * DAY, 40)], owners)).toEqual({ refusal: null, note: expect.stringMatching(new RegExp(`^${SAME_ENGINE}`)) })
    const offline = codexBox(3 * DAY, 40); offline.observation.receivedAt = NOW - 10 * MIN
    expect(judge([offline]).refusal).toBeNull()
    const signedOut = codexBox(3 * DAY, 40); signedOut.observation.readiness.engines[0]!.signedIn = false
    expect(judge([signedOut]).refusal).toBeNull()
    expect(judge([codexBox(3 * DAY, 40, { engineSuspensions: { codex: { at: NOW - MIN, fine: true } } })]).refusal).toBeNull()
    // Paused by its owner, as the CLI's route reads it (review of #2275: the route offered Claude, the server refused it).
    expect(judge([codexBox(3 * DAY, 40, { paused: true })])).toEqual({ refusal: null, note: expect.stringMatching(new RegExp(`^${SAME_ENGINE}`)) })
  })

  it('counts a Codex agent on a machine outside the contributions while it is up, and not once a usage limit holds it past the window', () => {
    const codexAgent = { id: 'codex', machineId: 'elsewhere', harnessId: 'hx', contributorId: 'owner', configuration: { engine: 'codex', model: 'default', effort: 'high' } } as any
    const state = stateOf(opus)
    state.agents.push(codexAgent)
    const target = agentTarget(state, opus as any)
    expect(reviewRefusal(state, 'work', target, policy, undefined, NOW)).not.toBeNull()
    codexAgent.limitedUntil = new Date(NOW + 5 * MIN).toISOString()
    expect(reviewRefusal(state, 'work', target, policy, undefined, NOW)).not.toBeNull()
    codexAgent.limitedUntil = new Date(NOW + 2 * DAY).toISOString()
    expect(reviewRefusal(state, 'work', target, policy, undefined, NOW)).toBeNull()
  })
})
