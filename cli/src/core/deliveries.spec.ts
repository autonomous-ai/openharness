import { describe, expect, it, vi } from 'vitest'
import type { TurnDelivery } from './api.js'
import { createDeliveries, HELD_DELIVERIES, KEPT_DELIVERERS, type DeliveriesDeps } from './deliveries.js'

const setup = (over: Partial<Pick<DeliveriesDeps, 'submit' | 'cancel' | 'deliverers'>> = {}, ready = true) => {
  const deps = {
    submit: over.submit ?? vi.fn(),
    cancel: over.cancel ?? vi.fn(() => true),
    tell: vi.fn(),
    deliverers: over.deliverers ?? new Set(['orchestrator']),
    log: vi.fn(),
    quietStarted: vi.fn<(agentId: string) => void>(),
  }
  const deliveries = createDeliveries(deps)
  if (ready) deliveries.ready()
  return { deps, deliveries }
}
const event = (deliveryId: string, state: TurnDelivery['state'] = 'queued'): TurnDelivery => ({ deliveryId, sessionId: 'agent-1', state })

describe('delivered turns', () => {
  it('writes a delivery from the core\'s own process into the agent, and takes one back at once', () => {
    const { deps, deliveries } = setup({ cancel: vi.fn(() => false) })
    deliveries.turns.deliver('agent-1', 'hello', 'd1')
    expect(deps.submit).toHaveBeenCalledWith('agent-1', 'hello', 'd1')
    expect(deliveries.turns.cancelDelivery('d1')).toBe(false)
    expect(deps.cancel).toHaveBeenCalledWith('d1')
  })

  it('tells every listener in the core\'s process what became of each delivery, until it stops listening', () => {
    const { deliveries } = setup()
    const heard: TurnDelivery[] = []
    const stop = deliveries.turns.onDelivery((e) => heard.push(e))
    deliveries.settled(event('d1'))
    stop()
    deliveries.settled(event('d1', 'started'))
    expect(heard).toEqual([event('d1')])
  })

  it('costs a listener that throws that event alone: the next listener hears it, and nothing is thrown back', () => {
    const { deps, deliveries } = setup()
    const after = vi.fn()
    deliveries.turns.onDelivery(() => { throw new Error('a full disk') })
    deliveries.turns.onDelivery(() => { throw 'not an error' })
    deliveries.turns.onDelivery(after)
    expect(() => deliveries.settled(event('d1'))).not.toThrow()
    expect(after).toHaveBeenCalledWith(event('d1'))
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('a full disk'))
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('not an error'))
  })

  it('writes a process\'s delivery and tells that process alone what became of it, its first word included', () => {
    const { deps, deliveries } = setup({
      submit: vi.fn((_agentId: string, _text: string, deliveryId: string) => deliveries.settled(event(deliveryId))),
    })
    expect(deliveries.answer('orchestrator', 'deliver', { agentId: 'agent-1', text: 'hello', deliveryId: 'd1' })).toEqual({})
    expect(deps.submit).toHaveBeenCalledWith('agent-1', 'hello', 'd1')
    deliveries.settled(event('d1', 'started'))
    deliveries.settled(event('someone-else'))
    expect(deps.tell.mock.calls).toEqual([['orchestrator', event('d1')], ['orchestrator', event('d1', 'started')]])
  })

  it('takes a process\'s delivery back and says whether it could', () => {
    const { deps, deliveries } = setup()
    expect(deliveries.answer('orchestrator', 'cancel_delivery', { deliveryId: 'd1' })).toEqual({ cancelled: true })
    expect(deps.cancel).toHaveBeenCalledWith('d1')
  })

  it('refuses a process that is not a deliverer, and a delivery without its id, agent or text', () => {
    const { deps, deliveries } = setup()
    expect(deliveries.answer('search', 'deliver', { agentId: 'agent-1', text: 'hello', deliveryId: 'd1' })).toEqual({ error: 'NOT_A_DELIVERER' })
    expect(deliveries.answer('orchestrator', 'deliver', { agentId: 'agent-1', text: 'hello' })).toEqual({ error: 'INVALID_DELIVERY' })
    expect(deliveries.answer('orchestrator', 'deliver', { text: 'hello', deliveryId: 'd1' })).toEqual({ error: 'INVALID_DELIVERY' })
    expect(deliveries.answer('orchestrator', 'deliver', { agentId: 'agent-1', text: 7, deliveryId: 'd1' })).toEqual({ error: 'INVALID_DELIVERY' })
    expect(deliveries.answer('orchestrator', 'cancel_delivery', {})).toEqual({ error: 'INVALID_DELIVERY' })
    expect(deps.submit).not.toHaveBeenCalled()
    expect(deps.cancel).not.toHaveBeenCalled()
  })

  it('leaves the other queries to whoever answers them', () => {
    expect(setup().deliveries.answer('orchestrator', 'live', {})).toBeNull()
  })

  it('remembers the makers of the last deliveries only, a delivery made again as the newest', () => {
    const { deps, deliveries } = setup({ deliverers: new Set(['orchestrator', 'messages']) })
    deliveries.answer('orchestrator', 'deliver', { agentId: 'a', text: 't', deliveryId: 'first' })
    deliveries.answer('messages', 'deliver', { agentId: 'a', text: 't', deliveryId: 'second' })
    // Made again: the newest now, and by its new maker.
    deliveries.answer('messages', 'deliver', { agentId: 'a', text: 't', deliveryId: 'first' })
    for (let i = 0; i < KEPT_DELIVERERS - 1; i++) deliveries.answer('orchestrator', 'deliver', { agentId: 'a', text: 't', deliveryId: `d${i}` })
    deps.tell.mockClear()
    deliveries.settled(event('second'))
    deliveries.settled(event('first'))
    expect(deps.tell.mock.calls).toEqual([['messages', event('first')]])
  })

  it('holds what is delivered before the core\'s input is wired, writes it in order once it is, and the rest as it comes', () => {
    const { deps, deliveries } = setup({}, false)
    deliveries.turns.deliver('agent-1', 'first', 'd1')
    expect(deliveries.answer('orchestrator', 'deliver', { agentId: 'agent-2', text: 'second', deliveryId: 'd2' })).toEqual({})
    expect(deps.submit).not.toHaveBeenCalled()
    deliveries.ready()
    deliveries.turns.deliver('agent-1', 'third', 'd3')
    expect(vi.mocked(deps.submit).mock.calls).toEqual([['agent-1', 'first', 'd1'], ['agent-2', 'second', 'd2'], ['agent-1', 'third', 'd3']])
    // Ready twice holds nothing back and writes nothing twice.
    deliveries.ready()
    expect(deps.submit).toHaveBeenCalledTimes(3)
  })

  it('takes back one still held as the input would a queued one, and asks the input of any other', () => {
    const { deps, deliveries } = setup({ cancel: vi.fn(() => false) }, false)
    const heard: TurnDelivery[] = []
    deliveries.turns.onDelivery((event) => heard.push(event))
    deliveries.answer('orchestrator', 'deliver', { agentId: 'agent-1', text: 'hello', deliveryId: 'd1' })
    expect(deliveries.turns.cancelDelivery('d1')).toBe(true)
    expect(heard).toEqual([{ deliveryId: 'd1', sessionId: 'agent-1', state: 'rejected', reason: 'cancelled' }])
    expect(deps.tell).toHaveBeenCalledWith('orchestrator', heard[0])
    expect(deliveries.answer('orchestrator', 'cancel_delivery', { deliveryId: 'd2' })).toEqual({ cancelled: false })
    expect(deps.cancel).toHaveBeenCalledWith('d2')
    deliveries.ready()
    expect(deps.submit).not.toHaveBeenCalled()
    expect(deliveries.turns.cancelDelivery('d1')).toBe(false)
  })

  it('refuses the oldest held when too many wait, as a full queue does', () => {
    const { deps, deliveries } = setup({}, false)
    const heard: TurnDelivery[] = []
    deliveries.turns.onDelivery((event) => heard.push(event))
    for (let i = 0; i <= HELD_DELIVERIES; i++) deliveries.turns.deliver('agent-1', `turn ${i}`, `d${i}`)
    expect(heard).toEqual([{ deliveryId: 'd0', sessionId: 'agent-1', state: 'rejected', reason: 'queue_full' }])
    deliveries.ready()
    expect(deps.submit).toHaveBeenCalledTimes(HELD_DELIVERIES)
    expect(vi.mocked(deps.submit).mock.calls[0]).toEqual(['agent-1', 'turn 1', 'd1'])
  })

  describe('a quiet delivery', () => {
    const started = (deliveryId: string, sessionId = 'agent-1'): TurnDelivery => ({ deliveryId, sessionId, state: 'started' })

    it('says once that a quiet delivery\'s turn started, delivered from the core\'s process and from a service\'s own, and never for a delivery that is not quiet', () => {
      const { deps, deliveries } = setup()
      deliveries.turns.deliver('agent-1', 'ready', 'in-core', { quiet: true })
      expect(deliveries.answer('orchestrator', 'deliver', { agentId: 'agent-2', text: 'ready', deliveryId: 'in-process', quiet: true })).toEqual({})
      deliveries.turns.deliver('agent-1', 'hello', 'plain')
      deliveries.answer('orchestrator', 'deliver', { agentId: 'agent-2', text: 'hello', deliveryId: 'plain-process' })
      // Only `true` marks it: a payload that says anything else is a delivery like any.
      deliveries.answer('orchestrator', 'deliver', { agentId: 'agent-2', text: 'hello', deliveryId: 'said-yes', quiet: 'yes' })
      for (const id of ['plain', 'plain-process', 'said-yes']) deliveries.settled(started(id))
      expect(deps.quietStarted).not.toHaveBeenCalled()
      deliveries.settled(started('in-core'))
      deliveries.settled(started('in-process', 'agent-2'))
      // A second `started` for the same delivery is not a second turn.
      deliveries.settled(started('in-core'))
      expect(deps.quietStarted.mock.calls).toEqual([['agent-1'], ['agent-2']])
    })

    it('forgets a quiet delivery that is rejected or past knowing, and keeps one that is queued or only written', () => {
      const { deps, deliveries } = setup()
      for (const id of ['refused', 'unknown', 'written']) deliveries.turns.deliver('agent-1', 'ready', id, { quiet: true })
      deliveries.settled({ deliveryId: 'refused', sessionId: 'agent-1', state: 'rejected', reason: 'cancelled' })
      deliveries.settled({ deliveryId: 'unknown', sessionId: 'agent-1', state: 'unknown', reason: 'prompt_mismatch' })
      deliveries.settled(event('written', 'queued'))
      deliveries.settled(event('written', 'delivered'))
      for (const id of ['refused', 'unknown', 'written']) deliveries.settled(started(id))
      // No turn is made quiet on a guess: only the one the input tied to the line.
      expect(deps.quietStarted.mock.calls).toEqual([['agent-1']])
    })

    it('keeps the last quiet deliveries only', () => {
      const { deps, deliveries } = setup()
      for (let i = 0; i < KEPT_DELIVERERS; i++) deliveries.turns.deliver('agent-1', 'ready', `q${i}`, { quiet: true })
      // Marked again, one moves to the newest end; past the limit, the oldest is forgotten.
      deliveries.turns.deliver('agent-1', 'ready', 'q0', { quiet: true })
      deliveries.turns.deliver('agent-1', 'ready', 'last', { quiet: true })
      for (const id of ['q0', 'q1', 'q2', 'last']) deliveries.settled(started(id, id))
      expect(deps.quietStarted.mock.calls).toEqual([['q0'], ['q2'], ['last']])
    })

    it('says nothing where nobody listens for it', () => {
      const deliveries = createDeliveries({ submit: vi.fn(), cancel: vi.fn(() => false), tell: vi.fn(), deliverers: new Set(['orchestrator']) })
      deliveries.ready()
      const heard: TurnDelivery[] = []
      deliveries.turns.onDelivery((e) => heard.push(e))
      deliveries.turns.deliver('agent-1', 'ready', 'd1', { quiet: true })
      expect(() => deliveries.settled(started('d1'))).not.toThrow()
      expect(heard).toEqual([started('d1')])
    })
  })

  it('logs to the console when given no log of its own', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const deliveries = createDeliveries({ submit: vi.fn(), cancel: vi.fn(() => false), tell: vi.fn(), deliverers: new Set() })
      deliveries.turns.onDelivery(() => { throw new Error('boom') })
      deliveries.settled(event('d1'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
    } finally {
      warn.mockRestore()
    }
  })
})
