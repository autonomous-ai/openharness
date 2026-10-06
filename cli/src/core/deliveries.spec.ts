import { describe, expect, it, vi } from 'vitest'
import type { TurnDelivery } from './api.js'
import { createDeliveries, KEPT_DELIVERERS, type DeliveriesDeps } from './deliveries.js'

const setup = (over: Partial<Pick<DeliveriesDeps, 'submit' | 'cancel' | 'deliverers'>> = {}) => {
  const deps = {
    submit: over.submit ?? vi.fn(),
    cancel: over.cancel ?? vi.fn(() => true),
    tell: vi.fn(),
    deliverers: over.deliverers ?? new Set(['orchestrator']),
    log: vi.fn(),
  }
  return { deps, deliveries: createDeliveries(deps) }
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
    const { deps, deliveries } = setup({ deliverers: new Set(['orchestrator', 'teams']) })
    deliveries.answer('orchestrator', 'deliver', { agentId: 'a', text: 't', deliveryId: 'first' })
    deliveries.answer('teams', 'deliver', { agentId: 'a', text: 't', deliveryId: 'second' })
    // Made again: the newest now, and by its new maker.
    deliveries.answer('teams', 'deliver', { agentId: 'a', text: 't', deliveryId: 'first' })
    for (let i = 0; i < KEPT_DELIVERERS - 1; i++) deliveries.answer('orchestrator', 'deliver', { agentId: 'a', text: 't', deliveryId: `d${i}` })
    deps.tell.mockClear()
    deliveries.settled(event('second'))
    deliveries.settled(event('first'))
    expect(deps.tell.mock.calls).toEqual([['teams', event('first')]])
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
