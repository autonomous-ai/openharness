import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TurnDelivery } from './api.js'
import { createDeliveries } from './deliveries.js'

const event = (deliveryId: string, state: TurnDelivery['state'], reason?: string): TurnDelivery =>
  ({ deliveryId, sessionId: 'agent-1', state, ...(reason ? { reason } : {}) })

const acked = (cancel: () => boolean = () => true, ids = true) => {
  let clock = 1_000
  const deps = { submit: vi.fn(), cancel: vi.fn(cancel), tell: vi.fn(), deliverers: new Set<string>(), log: vi.fn(),
    ...(ids ? { newId: () => 'n1', now: () => clock } : {}) }
  const ack = createDeliveries(deps)
  ack.ready()
  const answers: Array<Record<string, unknown>> = []
  return { deps, ack, answers, answer: (r: Record<string, unknown>) => { answers.push(r) }, tick: (ms: number) => { clock += ms } }
}

afterEach(() => { vi.useRealTimers() })

describe('acknowledged input (input_ack, #4393)', () => {
  it('answers taken once the turn the words typed has started, and logs how long that took', () => {
    const t = acked()
    t.ack.acknowledged({ agentId: 'agent-1', text: 'turn on the light', ackMs: 5_000 }, t.answer)
    expect(t.deps.submit).toHaveBeenCalledWith('agent-1', 'turn on the light', 'program:n1')
    t.ack.settled(event('program:other', 'started'))
    t.ack.settled(event('program:n1', 'queued'))
    t.ack.settled(event('program:n1', 'delivered'))
    expect(t.answers).toEqual([])
    t.tick(420)
    t.ack.settled(event('program:n1', 'started'))
    expect(t.answers).toEqual([{ inputId: 'program:n1', state: 'taken', takenAt: 1_420 }])
    expect(t.deps.log).toHaveBeenCalledWith('[input-ack] agent-1 taken in 420ms')
    t.ack.settled(event('program:n1', 'rejected'))
    expect(t.answers).toHaveLength(1)
  })

  it('says a refusal and an unconfirmed turn with their reasons', () => {
    const t = acked()
    t.ack.acknowledged({ agentId: 'agent-1', text: 'a' }, t.answer)
    t.ack.settled(event('program:n1', 'rejected', 'agent_gone'))
    t.ack.acknowledged({ agentId: 'agent-1', text: 'b' }, t.answer)
    t.ack.settled(event('program:n1', 'rejected'))
    t.ack.acknowledged({ agentId: 'agent-1', text: 'c' }, t.answer)
    t.ack.settled(event('program:n1', 'unknown', 'dispatch_ambiguous'))
    t.ack.acknowledged({ agentId: 'agent-1', text: 'd' }, t.answer)
    t.ack.settled(event('program:n1', 'unknown'))
    expect(t.answers.map((a) => [a.state, a.reason])).toEqual([['rejected', 'agent_gone'], ['rejected', 'rejected'], ['unknown', 'dispatch_ambiguous'], ['unknown', 'unknown']])
  })

  it('takes the words back at the deadline when nothing was typed, so the program may send them again', () => {
    vi.useFakeTimers()
    const t = acked(() => true)
    t.ack.acknowledged({ agentId: 'agent-1', text: 'a', ackMs: 50 }, t.answer)
    vi.advanceTimersByTime(999)
    expect(t.answers).toEqual([])
    vi.advanceTimersByTime(1)
    expect(t.deps.cancel).toHaveBeenCalledWith('program:n1')
    expect(t.answers).toEqual([{ inputId: 'program:n1', state: 'timeout', cancelled: true, written: false }])
  })

  it('says words already typed at the deadline are written, never taken back, and waits two minutes at most', () => {
    vi.useFakeTimers()
    const t = acked(() => false)
    t.ack.acknowledged({ agentId: 'agent-1', text: 'a', ackMs: 10 * 60_000 }, t.answer)
    t.ack.settled(event('program:n1', 'delivered'))
    vi.advanceTimersByTime(120_000)
    expect(t.answers).toEqual([{ inputId: 'program:n1', state: 'timeout', cancelled: false, written: true }])
    t.ack.acknowledged({ agentId: 'agent-1', text: 'b', ackMs: Number.NaN }, t.answer)
    vi.advanceTimersByTime(10_000)
    expect(t.answers[1]).toMatchObject({ state: 'timeout', written: false })
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
