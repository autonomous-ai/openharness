import { describe, expect, it, vi } from 'vitest'
import type { TurnDelivery, TurnEnd } from '../core/api.js'
import { deliveryIn, endIn, turnsLink } from './turnsLink.js'

const flush = () => new Promise((settle) => setTimeout(settle, 0))
const PROMPT = 'a'.repeat(32)
const END = { agentId: 'agent-1', sessionId: 's1', aborted: false, prompt: PROMPT, turnId: 7 }

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

  it('sends answersQuestion and personsOwn with the delivery', async () => {
    const query = vi.fn(async () => ({}))
    const link = turnsLink(query)
    link.turns.deliver('agent-1', 'hello', 'd1', { answersQuestion: true, writtenAt: 42 })
    link.turns.deliver('agent-1', 'hello', 'd2')
    link.turns.deliver('agent-1', 'hello', 'd3', { answersQuestion: true })
    link.turns.deliver('agent-1', 'hello', 'd4', { answersQuestion: true, personsOwn: true })
    await flush()
    expect(query.mock.calls).toEqual([
      ['deliver', { agentId: 'agent-1', text: 'hello', deliveryId: 'd1', answersQuestion: true, writtenAt: 42 }],
      ['deliver', { agentId: 'agent-1', text: 'hello', deliveryId: 'd2' }],
      ['deliver', { agentId: 'agent-1', text: 'hello', deliveryId: 'd3', answersQuestion: true, writtenAt: undefined }],
      ['deliver', { agentId: 'agent-1', text: 'hello', deliveryId: 'd4', answersQuestion: true, writtenAt: undefined, personsOwn: true }],
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
    const other = { agentId: 'agent-2', sessionId: 's2', aborted: true, prompt: 'b'.repeat(32), turnId: 8 }
    expect(link.heard({ kind: 'turn_end', event: END })).toBe(true)
    expect(link.heard({ kind: 'turn_end', event: other })).toBe(true)
    stop()
    expect(link.heard({ kind: 'turn_end', event: END })).toBe(true)
    expect(heard).toEqual([END, other])
  })

  it('costs a turn-end listener that throws that end alone', () => {
    const log = vi.fn()
    const link = turnsLink(async () => ({}), log)
    const after = vi.fn()
    link.turns.onEnd(() => { throw new Error('boom') })
    link.turns.onEnd(() => { throw 'not an error' })
    link.turns.onEnd(after)
    link.heard({ kind: 'turn_end', event: END })
    expect(after).toHaveBeenCalledOnce()
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '[turns] a turn-end listener failed on agent-1 · boom',
      '[turns] a turn-end listener failed on agent-1 · not an error',
    ])
  })

  // Swarm plan, step 1, item 2: an end says its agent's context was compacted (core/turns/ends.ts), and the Swarm's host types
  // it what waits for it. Only true is taken: anything else is an end that says nothing of it.
  it('keeps that a turn\'s context was compacted, and nothing else in its place', () => {
    const whole = { ...END, agentId: 'a', sessionId: 's' }
    expect(endIn({ kind: 'turn_end', event: { ...whole, compacted: true } })).toEqual({ ...whole, compacted: true })
    for (const compacted of [false, 'yes', 1, null]) expect(endIn({ kind: 'turn_end', event: { ...whole, compacted } })).toEqual(whole)
  })

  it('takes nothing else for a turn end', () => {
    const heard = vi.fn()
    const link = turnsLink(async () => ({}), vi.fn())
    link.turns.onEnd(heard)
    const whole = { ...END, agentId: 'a', sessionId: 's' }
    for (const event of [undefined, null, 'end', {}, { ...whole, sessionId: 4 }, { ...whole, agentId: 3 }, { ...whole, aborted: undefined }, { ...whole, aborted: 'no' },
      // An end that says no turn, or none by a hash and a number: from a core that does not say which turn ended.
      { ...whole, prompt: undefined }, { ...whole, prompt: 'Ship it.' }, { ...whole, prompt: 4 }, { ...whole, prompt: 'A'.repeat(32) }, { ...whole, prompt: `${PROMPT}0` },
      { ...whole, turnId: undefined }, { ...whole, turnId: 0 }, { ...whole, turnId: -2 }, { ...whole, turnId: 1.5 }, { ...whole, turnId: '7' }, { ...whole, turnId: 2 ** 53 }]) {
      expect(link.heard({ kind: 'turn_end', event }), JSON.stringify(event)).toBe(false)
    }
    expect(link.heard({ kind: 'turn_end' })).toBe(false)
    expect(heard).not.toHaveBeenCalled()
    expect(endIn({ kind: 'delivery', event: whole })).toBeNull()
  })

  // The answer of the turn an end names is the core's to give (core/experimentQueries.ts `turn_answer`).
  it('asks the core for the answer of the turn an end names, and says no answer when the core has none', async () => {
    const query = vi.fn(async (_q: string, payload: Record<string, unknown>) => ({ answer: payload.sessionId === 's1' ? 'Shipped.' : null }))
    const link = turnsLink(query)
    expect(await link.turns.answerOf(END)).toBe('Shipped.')
    expect(await link.turns.answerOf({ ...END, sessionId: 's2' })).toBeNull()
    expect(query.mock.calls).toEqual([['turn_answer', { sessionId: 's1', prompt: PROMPT, turnId: 7 }], ['turn_answer', { sessionId: 's2', prompt: PROMPT, turnId: 7 }]])
  })

  it('fails by a name when the core answers with an error or with no answer at all, and when it cannot be asked', async () => {
    const asked = (answer: Record<string, unknown>) => turnsLink(async () => answer).turns.answerOf(END)
    // Read as no answer, a core without the question (an older one), or that will not answer this process, would leave every reply
    // owed and none ever posted, with nothing in the log.
    for (const code of ['UNKNOWN_QUERY', 'NOT_SUPER_TABS', 'INVALID_REQUEST']) await expect(asked({ error: code }), code).rejects.toMatchObject({ name: code })
    for (const answer of [{}, { answer: 4 }, { answer: undefined }, { answer: { text: 'Shipped.' } }]) await expect(asked(answer), JSON.stringify(answer)).rejects.toMatchObject({ name: 'INVALID_ANSWER' })
    await expect(turnsLink(async () => { throw new Error('not connected to the core') }).turns.answerOf(END)).rejects.toThrow('not connected to the core')
  })

  it('says once that a turn end names no turn, which a core older than this process tells, and again after a core that names its turns was heard', () => {
    const log = vi.fn()
    const link = turnsLink(async () => ({}), log)
    const old = { agentId: 'agent-1', sessionId: 's1', aborted: false }
    const said = '[turns] a turn end named no turn: the core is older than this process, or sent it wrong, so no reply is posted for a turn like it until the core is restarted'
    expect(link.heard({ kind: 'turn_end', event: old })).toBe(false)
    expect(link.heard({ kind: 'turn_end', event: old })).toBe(false)
    expect(link.heard({ kind: 'turn_end', event: 'end' })).toBe(false)
    expect(log.mock.calls).toEqual([[said]])
    // The core was restarted into one that names its turns, and later into one that does not: that is said too, once.
    expect(link.heard({ kind: 'turn_end', event: { ...old, prompt: PROMPT, turnId: 1 } })).toBe(true)
    expect(link.heard({ kind: 'turn_end', event: old })).toBe(false)
    expect(link.heard({ kind: 'turn_end', event: old })).toBe(false)
    expect(log.mock.calls).toEqual([[said], [said]])
    // What is no turn end at all is not said.
    const quiet = vi.fn()
    expect(turnsLink(async () => ({}), quiet).heard({ kind: 'event', event: {} })).toBe(false)
    expect(quiet).not.toHaveBeenCalled()
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
