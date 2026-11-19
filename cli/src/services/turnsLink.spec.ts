import { describe, expect, it, vi } from 'vitest'
import type { TurnDelivery } from '../core/api.js'
import { deliveryIn, inputIn, turnsLink } from './turnsLink.js'

const flush = () => new Promise((settle) => setTimeout(settle, 0))

describe('delivered turns from a service in its own process', () => {
  it('uses the versioned shared operation for an explicit scheduling request and never falls back on refusal', async () => {
    const query = vi.fn(async () => ({ error: 'UNKNOWN_QUERY' })), heard = vi.fn()
    const link = turnsLink(query)
    link.turns.onDelivery(heard)
    link.turns.deliver('a', 'hello', 'd', { when: 'composer' })
    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith({ deliveryId: 'd', sessionId: 'a', state: 'rejected', reason: 'UNKNOWN_QUERY' }))
    expect(query.mock.calls).toEqual([['input', { agentId: 'a', text: 'hello', deliveryId: 'd', version: 1, when: 'composer' }]])
  })

  it('accepts only bounded, well-formed generic input facts', () => {
    const event = { agentId: 'a', deliveryId: 'd', when: 'composer', phase: 'dispatching', sessionId: 's', duringTurn: true, content: 'hello' }
    expect(inputIn({ kind: 'input', event })).toEqual(event)
    const activity = { epoch: 'core', revision: 8 }
    const copied = inputIn({ kind: 'input', event: { ...event, activity } })
    activity.revision = 9
    expect(copied?.activity).toEqual({ epoch: 'core', revision: 8 })
    for (const activity of [null, [], {}, { epoch: '' }, { epoch: 'x'.repeat(129), revision: 1 },
      { epoch: 'core', revision: -1 }, { epoch: 'core', revision: Infinity }, { epoch: 'core', revision: 0.5 }]) {
      expect(inputIn({ kind: 'input', event: { ...event, activity } })).toBeNull()
    }
    expect(inputIn({ kind: 'input', event: { agentId: 'a', deliveryId: 'd', when: 'turn', phase: 'written' } }))
      .toEqual({ agentId: 'a', deliveryId: 'd', when: 'turn', phase: 'written' })
    for (const payload of [{}, { kind: 'input' }, { kind: 'other', event }]) expect(inputIn(payload)).toBeNull()
    for (const bad of [{ agentId: '' }, { deliveryId: 'x'.repeat(201) }, { when: 'native' }, { phase: 'started' },
      { sessionId: 5 }, { sessionId: 'x'.repeat(201) }, { duringTurn: 'yes' }, { content: 42 }, { content: 'x'.repeat(24 * 1024 + 1) }]) {
      expect(inputIn({ kind: 'input', event: { ...event, ...bad } })).toBeNull()
    }
  })

  it('asks the core to write a delivery and to take one back, and hears whether it could', async () => {
    const query = vi.fn(async (q: string) => (q === 'cancel_delivery' ? { cancelled: true } : {}))
    const link = turnsLink(query)
    const heard: TurnDelivery[] = []
    link.turns.onDelivery((event) => heard.push(event))
    link.turns.deliver('agent-1', 'hello', 'd1')
    // Asked in line, it cannot wait for the core: not known to be taken back yet.
    expect(link.turns.cancelDelivery('d1')).toBe(false)
    expect(await link.cancel('d1')).toBe(true)
    await flush()
    expect(query.mock.calls).toEqual([
      ['deliver', { agentId: 'agent-1', text: 'hello', deliveryId: 'd1' }],
      ['cancel_delivery', { deliveryId: 'd1' }],
      ['cancel_delivery', { deliveryId: 'd1' }],
    ])
    expect(heard).toEqual([])
  })

  it('sends quiet with the delivery', async () => {
    const query = vi.fn(async () => ({}))
    const link = turnsLink(query)
    link.turns.deliver('agent-1', 'hello', 'd1')
    link.turns.deliver('agent-1', 'ready', 'd2', { quiet: true })
    await flush()
    expect(query.mock.calls).toEqual([
      ['deliver', { agentId: 'agent-1', text: 'hello', deliveryId: 'd1' }],
      ['deliver', { agentId: 'agent-1', text: 'ready', deliveryId: 'd2', quiet: true }],
    ])
  })

  it('reads a cancel the core could not make, or never answered, as not taken back', async () => {
    expect(await turnsLink(async () => ({ cancelled: false })).cancel('d1')).toBe(false)
    expect(await turnsLink(async () => { throw new Error('gone') }).cancel('d1')).toBe(false)
  })

  it('says a delivery the core refused was rejected, and one it never confirmed is unknown', async () => {
    const refused = turnsLink(async () => ({ error: 'NOT_A_DELIVERER' }))
    const unconfirmed = turnsLink(async () => { throw new Error('the link went') })
    const heard: TurnDelivery[] = []
    refused.turns.onDelivery((event) => heard.push(event))
    unconfirmed.turns.onDelivery((event) => heard.push(event))
    refused.turns.deliver('agent-1', 'hello', 'd1')
    unconfirmed.turns.deliver('agent-2', 'hello', 'd2')
    await flush()
    expect(heard).toEqual([
      { deliveryId: 'd1', sessionId: 'agent-1', state: 'rejected', reason: 'NOT_A_DELIVERER' },
      { deliveryId: 'd2', sessionId: 'agent-2', state: 'unknown', reason: 'The core did not confirm this delivery.' },
    ])
  })

  it('hands what the core says became of a delivery to each listener, until it stops listening', () => {
    const link = turnsLink(async () => ({}))
    const heard: TurnDelivery[] = []
    const stop = link.turns.onDelivery((event) => heard.push(event))
    expect(link.heard({ kind: 'delivery', event: { deliveryId: 'd1', sessionId: 'agent-1', state: 'rejected', reason: 'cancelled' } })).toBe(true)
    stop()
    expect(link.heard({ kind: 'delivery', event: { deliveryId: 'd1', sessionId: 'agent-1', state: 'started' } })).toBe(true)
    expect(heard).toEqual([{ deliveryId: 'd1', sessionId: 'agent-1', state: 'rejected', reason: 'cancelled' }])
  })

  it('costs a listener that throws that event alone', () => {
    const log = vi.fn()
    const link = turnsLink(async () => ({}), log)
    const after = vi.fn()
    link.turns.onDelivery(() => { throw new Error('boom') })
    link.turns.onDelivery(() => { throw 'not an error' })
    link.turns.onDelivery(after)
    link.heard({ kind: 'delivery', event: { deliveryId: 'd1', sessionId: 'a', state: 'queued' } })
    expect(after).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('[deliveries] a listener failed on d1 · Error')
    expect(log).toHaveBeenCalledWith('[deliveries] a listener failed on d1 · string')
  })

  it('logs to the console when given no log of its own', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const link = turnsLink(async () => ({}))
      link.turns.onDelivery(() => { throw new Error('boom') })
      link.heard({ kind: 'delivery', event: { deliveryId: 'd1', sessionId: 'a', state: 'queued' } })
      expect(warn).toHaveBeenCalledWith('[deliveries] a listener failed on d1 · Error')
    } finally {
      warn.mockRestore()
    }
  })

  it('takes nothing else for a delivery\'s progress', () => {
    expect(turnsLink(async () => ({})).heard({ kind: 'event', event: {} })).toBe(false)
    expect(deliveryIn({ kind: 'delivery' })).toBeNull()
    expect(deliveryIn({ kind: 'delivery', event: { deliveryId: 'd1', sessionId: 'a', state: 'lost' } })).toBeNull()
    expect(deliveryIn({ kind: 'delivery', event: { deliveryId: 1, sessionId: 'a', state: 'queued' } })).toBeNull()
    expect(deliveryIn({ kind: 'delivery', event: { deliveryId: 'd1', state: 'queued' } })).toBeNull()
    expect(deliveryIn({ kind: 'delivery', event: { deliveryId: 'd1', sessionId: 'a', state: 'queued', reason: 3 } }))
      .toEqual({ deliveryId: 'd1', sessionId: 'a', state: 'queued' })
  })
})
