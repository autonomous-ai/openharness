import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TurnDelivery } from './api.js'
import { createDeliveries } from './deliveries.js'

const event = (deliveryId: string, state: TurnDelivery['state'], reason?: string): TurnDelivery =>
  ({ deliveryId, sessionId: 'agent-1', state, ...(reason ? { reason } : {}) })

const acked = (cancel: (deliveryId: string) => boolean = () => true, ids = true) => {
  let clock = 1_000
  let n = 0
  const deps = { submit: vi.fn(), cancel: vi.fn(cancel), tell: vi.fn(), deliverers: new Set<string>(), log: vi.fn(),
    ...(ids ? { newId: () => `n${++n}`, now: () => clock } : {}) }
  const ack = createDeliveries(deps)
  ack.ready()
  const answers: Array<Record<string, unknown>> = []
  return { deps, ack, answers, answer: (r: Record<string, unknown>) => { answers.push(r) }, tick: (ms: number) => { clock += ms } }
}

afterEach(() => { vi.useRealTimers() })

describe('acknowledged input (input_ack, #4393)', () => {
  it('answers taken once the turn the words typed has started, and logs both phases', () => {
    const t = acked()
    t.ack.acknowledged({ agentId: 'agent-1', text: 'turn on the light', ackMs: 5_000 }, t.answer)
    expect(t.deps.submit).toHaveBeenCalledWith('agent-1', 'turn on the light', 'program:n1')
    t.ack.settled(event('program:other', 'started'))
    t.ack.settled(event('program:n1', 'queued'))
    t.tick(300)
    t.ack.settled(event('program:n1', 'delivered'))
    expect(t.answers).toEqual([])
    t.tick(420)
    t.ack.settled(event('program:n1', 'started'))
    expect(t.answers).toEqual([{ inputId: 'program:n1', state: 'taken', takenAt: 1_720 }])
    expect(t.deps.log).toHaveBeenCalledWith('[input-ack] agent-1 taken in 720ms (pre-paste 300ms, paste to taken 420ms)')
    t.ack.settled(event('program:n1', 'rejected'))
    expect(t.answers).toHaveLength(1)
  })

  it('says a refusal and an unconfirmed turn with their reasons', () => {
    const t = acked()
    for (const [text, state, reason] of [['a', 'rejected', 'agent_gone'], ['b', 'rejected', undefined], ['c', 'unknown', 'dispatch_ambiguous'], ['d', 'unknown', undefined]] as const) {
      t.ack.acknowledged({ agentId: 'agent-1', text }, t.answer)
      t.ack.settled(event(`program:n${t.answers.length + 1}`, state, reason))
    }
    expect(t.answers.map((a) => [a.state, a.reason])).toEqual([['rejected', 'agent_gone'], ['rejected', 'rejected'], ['unknown', 'dispatch_ambiguous'], ['unknown', 'unknown']])
    expect(t.deps.log).toHaveBeenCalledWith('[input-ack] agent-1 rejected in 0ms (pre-paste 0ms)')
  })

  it('takes the words back at the pre-paste deadline when nothing was typed, so the program may send them again', () => {
    vi.useFakeTimers()
    const t = acked(() => true)
    // The input says a delivery taken back is rejected, at once: that is the deadline's answer, never a refusal.
    t.deps.cancel.mockImplementation((id: string) => { t.ack.settled(event(id, 'rejected', 'cancelled')); return true })
    t.ack.acknowledged({ agentId: 'agent-1', text: 'a', ackMs: 50 }, t.answer)
    vi.advanceTimersByTime(999)
    expect(t.answers).toEqual([])
    vi.advanceTimersByTime(1)
    expect(t.deps.cancel).toHaveBeenCalledWith('program:n1')
    expect(t.answers).toEqual([{ inputId: 'program:n1', state: 'timeout', cancelled: true, written: false }])
  })

  it('waits on words being pasted at the pre-paste deadline, and counts the taken window from the paste', () => {
    vi.useFakeTimers()
    const t = acked(() => false)
    t.ack.acknowledged({ agentId: 'agent-1', text: 'a', ackMs: 5_000, takenMs: 5_000 }, t.answer)
    // The daemon checked the runtime and waited for the pane past the first deadline: still being written.
    vi.advanceTimersByTime(5_000)
    expect(t.deps.cancel).toHaveBeenCalledWith('program:n1')
    expect(t.answers).toEqual([])
    vi.advanceTimersByTime(3_000)
    t.ack.settled(event('program:n1', 'delivered'))
    vi.advanceTimersByTime(4_000)
    t.ack.settled(event('program:n1', 'started'))
    expect(t.answers).toEqual([{ inputId: 'program:n1', state: 'taken', takenAt: 1_000 }])
  })

  it('says words pasted but never seen to start written, never taken back, and waits two minutes a phase at most', () => {
    vi.useFakeTimers()
    const t = acked(() => false)
    t.ack.acknowledged({ agentId: 'agent-1', text: 'a', ackMs: 10 * 60_000, takenMs: 10 * 60_000 }, t.answer)
    t.ack.settled(event('program:n1', 'delivered'))
    vi.advanceTimersByTime(120_000)
    expect(t.answers).toEqual([{ inputId: 'program:n1', state: 'timeout', cancelled: false, written: true }])
    // Neither pasted nor taken back: answered at the end of the taken window all the same.
    t.ack.acknowledged({ agentId: 'agent-1', text: 'b', ackMs: Number.NaN }, t.answer)
    vi.advanceTimersByTime(30_000)
    expect(t.answers).toHaveLength(1)
    vi.advanceTimersByTime(30_000)
    expect(t.answers[1]).toMatchObject({ state: 'timeout', cancelled: false, written: false })
  })

  it('answers by ackMs + takenMs at the latest, however late the paste, so the caller hears it before giving up', () => {
    vi.useFakeTimers()
    const t = acked(() => false)
    t.ack.acknowledged({ agentId: 'agent-1', text: 'a', ackMs: 5_000, takenMs: 5_000 }, t.answer)
    vi.advanceTimersByTime(8_000)
    t.tick(8_000)
    t.ack.settled(event('program:n1', 'delivered'))
    vi.advanceTimersByTime(1_999)
    expect(t.answers).toEqual([])
    vi.advanceTimersByTime(1)
    expect(t.answers).toEqual([{ inputId: 'program:n1', state: 'timeout', cancelled: false, written: true }])
    // Pasted later still: answered at once.
    t.ack.acknowledged({ agentId: 'agent-1', text: 'b', ackMs: 1_000, takenMs: 1_000 }, t.answer)
    vi.advanceTimersByTime(1_000)
    t.tick(5_000)
    t.ack.settled(event('program:n2', 'delivered'))
    vi.advanceTimersByTime(0)
    expect(t.answers[1]).toMatchObject({ inputId: 'program:n2', state: 'timeout', written: true })
  })

  it('answers once, and arms nothing after its answer', () => {
    vi.useFakeTimers()
    const t = acked(() => false)
    // The input settles the delivery while it is asked to take it back: that answer is the one.
    t.deps.cancel.mockImplementation((id: string) => { t.ack.settled(event(id, 'unknown', 'dispatch_ambiguous')); return false })
    t.ack.acknowledged({ agentId: 'agent-1', text: 'a', ackMs: 1_000 }, t.answer)
    vi.advanceTimersByTime(200_000)
    t.deps.cancel.mockImplementation((id: string) => { t.ack.settled(event(id, 'unknown', 'dispatch_ambiguous')); return true })
    t.ack.acknowledged({ agentId: 'agent-1', text: 'b', ackMs: 1_000 }, t.answer)
    vi.advanceTimersByTime(200_000)
    expect(t.answers).toEqual([{ inputId: 'program:n1', state: 'unknown', reason: 'dispatch_ambiguous' }, { inputId: 'program:n2', state: 'unknown', reason: 'dispatch_ambiguous' }])
  })

  it('names the input by the program\'s own id when it gave one, and by its own otherwise', () => {
    const t = acked()
    const own = 'program:0f8fad5b-d9cb-469f-a165-70867728950e'
    t.ack.acknowledged({ agentId: 'agent-1', text: 'a', inputId: own }, t.answer)
    t.ack.acknowledged({ agentId: 'agent-1', text: 'b', inputId: 'team:x' }, t.answer)
    expect(t.deps.submit.mock.calls.map((c) => c[2])).toEqual([own, 'program:n1'])
  })

  it('takes ten replies in a row into one session, each pasted after a slow runtime check', () => {
    vi.useFakeTimers()
    const t = acked(() => false)
    for (let i = 1; i <= 10; i++) {
      t.ack.acknowledged({ agentId: 'agent-1', text: `task ${i}` }, t.answer)
      // 8.6 to 15.7 s from the request to the paste on a loaded lamp, then 1.2 to 1.8 s to the turn's start.
      vi.advanceTimersByTime(15_700)
      t.ack.settled(event(`program:n${i}`, 'delivered'))
      vi.advanceTimersByTime(1_800)
      t.ack.settled(event(`program:n${i}`, 'started'))
    }
    expect(t.answers.map((a) => [a.inputId, a.state])).toEqual(Array.from({ length: 10 }, (_, i) => [`program:n${i + 1}`, 'taken']))
  })

  it('refuses words with no harness or nothing to say, and names an input by a random id by default', () => {
    const t = acked(() => true, false)
    t.ack.acknowledged({ text: 'a' }, t.answer)
    t.ack.acknowledged({ agentId: 'agent-1', text: '  ' }, t.answer)
    t.ack.acknowledged({ agentId: 'agent-1', text: 7 }, t.answer)
    expect(t.answers).toEqual([{ error: 'INVALID_INPUT' }, { error: 'INVALID_INPUT' }, { error: 'INVALID_INPUT' }])
    t.ack.acknowledged({ agentId: 'agent-1', text: 'a' }, t.answer)
    const id = String(t.deps.submit.mock.calls[0][2])
    expect(id).toMatch(/^program:[0-9a-f-]{36}$/)
    t.ack.settled(event(id, 'started'))
    expect(t.answers[3]).toMatchObject({ inputId: id, state: 'taken' })
  })
})
