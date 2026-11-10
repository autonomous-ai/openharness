import { describe, expect, it, vi } from 'vitest'
import type { TurnDelivery, TurnEnd } from '../core/api.js'
import { deliveryIn, endIn, turnsLink } from './turnsLink.js'

const flush = () => new Promise((settle) => setTimeout(settle, 0))

describe('delivered turns from a service in its own process', () => {
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

  it('sends answersQuestion with the delivery', async () => {
    const query = vi.fn(async () => ({}))
    const link = turnsLink(query)
    link.turns.deliver('agent-1', 'hello', 'd1', { answersQuestion: true, writtenAt: 42 })
    link.turns.deliver('agent-1', 'hello', 'd2')
    link.turns.deliver('agent-1', 'hello', 'd3', { answersQuestion: true })
    await flush()
    expect(query.mock.calls).toEqual([
      ['deliver', { agentId: 'agent-1', text: 'hello', deliveryId: 'd1', answersQuestion: true, writtenAt: 42 }],
      ['deliver', { agentId: 'agent-1', text: 'hello', deliveryId: 'd2' }],
      ['deliver', { agentId: 'agent-1', text: 'hello', deliveryId: 'd3', answersQuestion: true, writtenAt: undefined }],
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
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not an error'))
  })

  it('logs to the console when given no log of its own', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const link = turnsLink(async () => ({}))
      link.turns.onDelivery(() => { throw new Error('boom') })
      link.heard({ kind: 'delivery', event: { deliveryId: 'd1', sessionId: 'a', state: 'queued' } })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
    } finally {
      warn.mockRestore()
    }
  })

  // The Swarm's host posts an agent's answer when its turn ends (core/turns/ends.ts tells it, `service_event` kind `turn_end`).
  it('hands each live turn end the core tells to each listener, until it stops listening', () => {
    const link = turnsLink(async () => ({}))
    const heard: TurnEnd[] = []
    const stop = link.turns.onEnd((event) => heard.push(event))
    expect(link.heard({ kind: 'turn_end', event: { agentId: 'agent-1', sessionId: 's1', aborted: false } })).toBe(true)
    expect(link.heard({ kind: 'turn_end', event: { agentId: 'agent-2', sessionId: 's2', aborted: true } })).toBe(true)
    stop()
    expect(link.heard({ kind: 'turn_end', event: { agentId: 'agent-1', sessionId: 's1', aborted: false } })).toBe(true)
    expect(heard).toEqual([{ agentId: 'agent-1', sessionId: 's1', aborted: false }, { agentId: 'agent-2', sessionId: 's2', aborted: true }])
  })

  it('costs a turn-end listener that throws that end alone', () => {
    const log = vi.fn()
    const link = turnsLink(async () => ({}), log)
    const after = vi.fn()
    link.turns.onEnd(() => { throw new Error('boom') })
    link.turns.onEnd(() => { throw 'not an error' })
    link.turns.onEnd(after)
    link.heard({ kind: 'turn_end', event: { agentId: 'agent-1', sessionId: 's1', aborted: false } })
    expect(after).toHaveBeenCalledOnce()
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '[turns] a turn-end listener failed on agent-1 · boom',
      '[turns] a turn-end listener failed on agent-1 · not an error',
    ])
  })

  it('takes nothing else for a turn end', () => {
    const heard = vi.fn()
    const link = turnsLink(async () => ({}))
    link.turns.onEnd(heard)
    for (const event of [undefined, null, 'end', {}, { agentId: 'a', sessionId: 4, aborted: false }, { agentId: 3, sessionId: 's', aborted: false },
      { agentId: 'a', sessionId: 's' }, { agentId: 'a', sessionId: 's', aborted: 'no' }]) {
      expect(link.heard({ kind: 'turn_end', event })).toBe(false)
    }
    expect(link.heard({ kind: 'turn_end' })).toBe(false)
    expect(heard).not.toHaveBeenCalled()
    expect(endIn({ kind: 'delivery', event: { agentId: 'a', sessionId: 's', aborted: false } })).toBeNull()
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
