import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentNotifications, DONE_QUIET_MS, type AgentNotification } from './agentNotifications.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** Decide a session's ended turn and return what it was told so far. */
function decided(policy: AgentNotifications, sessionId: string, result: string, silent = false): AgentNotification[] {
  const told: AgentNotification[] = []
  policy.decide(sessionId, result, silent, (n) => { told.push(n as AgentNotification) })
  return told
}

describe('shared desktop/device notification policy', () => {
  it('decides done 1.5 s after the turn ended, not before', () => {
    const policy = new AgentNotifications(); const tell = vi.fn()
    policy.started('s'); policy.ended('s'); policy.decide('s', 'Finished.', false, tell)
    vi.advanceTimersByTime(DONE_QUIET_MS - 1); expect(tell).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1); expect(tell).toHaveBeenCalledExactlyOnceWith({ id: expect.any(String), kind: 'done' })
  })

  it('a result that came after the window is decided at once', () => {
    const policy = new AgentNotifications()
    policy.started('s'); policy.ended('s')
    vi.advanceTimersByTime(DONE_QUIET_MS)
    expect(decided(policy, 's', 'Finished.')).toEqual([{ id: expect.any(String), kind: 'done' }])
  })

  it('the next turn opening inside the window drops it: told null at once, and never again', () => {
    const policy = new AgentNotifications(); const tell = vi.fn()
    policy.started('s'); policy.ended('s'); policy.decide('s', 'Pass one done.', false, tell)
    vi.advanceTimersByTime(DONE_QUIET_MS - 1)
    policy.started('s')
    expect(tell).toHaveBeenCalledExactlyOnceWith(null)
    vi.runAllTimers()
    expect(tell).toHaveBeenCalledTimes(1)
  })

  it('a question asked inside the window drops it', () => {
    const policy = new AgentNotifications(); const tell = vi.fn()
    policy.started('s'); policy.ended('s'); policy.decide('s', 'Please choose.', false, tell)
    expect(policy.asked('s', 'q')).toEqual({ id: 'q', kind: 'needsYou' })
    vi.runAllTimers()
    expect(tell).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('a cancelled turn tells null; a forgotten session tells nothing', () => {
    const policy = new AgentNotifications(); const cancelled = vi.fn(); const forgotten = vi.fn()
    for (const id of ['cancelled', 'forgotten']) { policy.started(id); policy.ended(id) }
    policy.decide('cancelled', 'Partial work', false, cancelled)
    policy.decide('forgotten', 'Gone', false, forgotten)
    policy.cancelled('cancelled')
    policy.forget('forgotten')
    expect(cancelled).toHaveBeenCalledExactlyOnceWith(null)
    vi.runAllTimers()
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(forgotten).not.toHaveBeenCalled()
  })

  it("once a live turn; a replay, an empty result and a subagent's tell null", () => {
    const policy = new AgentNotifications()
    expect(decided(policy, 's', 'Old answer')).toEqual([null])
    policy.started('s'); policy.ended('s')
    const first = decided(policy, 's', 'Finished the change.')
    vi.runAllTimers()
    expect(first).toEqual([{ id: expect.any(String), kind: 'done' }])
    expect(decided(policy, 's', 'Finished the change.')).toEqual([null])
    policy.started('s'); policy.ended('s')
    const second = decided(policy, 's', 'Another result')
    vi.runAllTimers()
    expect(second[0]?.id).not.toBe(first[0]?.id)

    policy.started('history', true)
    policy.started('empty')
    policy.started('worker')
    policy.started('aborted')
    policy.cancelled('aborted')
    for (const [id, text, silent] of [
      ['history', 'Historical answer', false], ['empty', '  ', false],
      ['worker', 'Child finished', true], ['aborted', 'Partial work', false],
    ] as const) { policy.ended(id); expect(decided(policy, id, text, silent)).toEqual([null]) }
  })

  it('keeps questions actionable and does not announce their answer as done', () => {
    const policy = new AgentNotifications()
    policy.started('s')
    expect(policy.asked('s', 'q')).toEqual({ id: 'q', kind: 'needsYou' })
    policy.answered('s', 'older-question')
    policy.ended('s')
    const asked = decided(policy, 's', 'Please choose.')
    vi.runAllTimers()
    expect(asked).toEqual([null])
    policy.answered('s', 'q')
    expect(decided(policy, 's', 'Please choose.')).toEqual([null])
    policy.started('s'); policy.ended('s')
    const implemented = decided(policy, 's', 'Implemented your choice.')
    vi.runAllTimers()
    expect(implemented[0]?.kind).toBe('done')
  })
})
