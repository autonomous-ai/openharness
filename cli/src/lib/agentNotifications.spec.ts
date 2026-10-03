import { describe, expect, it } from 'vitest'
import { AgentNotifications } from './agentNotifications.js'

describe('shared desktop/device notification policy', () => {
  it('announces a completed result once per live turn', () => {
    const policy = new AgentNotifications()
    expect(policy.completed('s', 'Old answer', false)).toBeNull()
    policy.started('s')
    const first = policy.completed('s', 'Finished the change.', false)
    expect(first).toEqual({ id: expect.any(String), kind: 'done' })
    expect(policy.completed('s', 'Finished the change.', false)).toBeNull()
    policy.started('s')
    expect(policy.completed('s', 'Another result', false)?.id).not.toBe(first?.id)
  })

  it('ignores replays, empty results, subagents and cancelled turns', () => {
    const policy = new AgentNotifications()
    policy.started('history', true)
    policy.started('empty')
    policy.started('worker')
    policy.started('aborted')
    policy.cancelled('aborted')
    for (const [id, text, silent] of [
      ['history', 'Historical answer', false], ['empty', '  ', false],
      ['worker', 'Child finished', true], ['aborted', 'Partial work', false],
    ] as const) expect(policy.completed(id, text, silent)).toBeNull()
  })

  it('keeps questions actionable and does not announce their answer as done', () => {
    const policy = new AgentNotifications()
    policy.started('s')
    expect(policy.asked('s', 'q')).toEqual({ id: 'q', kind: 'needsYou' })
    policy.answered('s', 'older-question')
    expect(policy.completed('s', 'Please choose.', false)).toBeNull()
    policy.answered('s', 'q')
    expect(policy.completed('s', 'Please choose.', false)).toBeNull()
    policy.started('s')
    expect(policy.completed('s', 'Implemented your choice.', false)?.kind).toBe('done')
  })
})
