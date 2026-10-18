import { describe, expect, it, vi } from 'vitest'
import { TAB_RELAY_OFF, type TabRelay } from '../core/api.js'
import { answerTabRelay, askTabRelay, TAB_RELAY_METHODS, tabFrameOf } from './tabRelayWire.js'

const TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6'

describe('shared tabs\' relay across a process boundary', () => {
  it('carries each of the three methods to the relay and its answer back', async () => {
    const relay = { open: vi.fn(async () => {}), send: vi.fn(async () => true), close: vi.fn() } satisfies TabRelay
    const asker = askTabRelay((payload) => answerTabRelay(relay, payload))
    await asker.open(TAB)
    expect(relay.open).toHaveBeenCalledWith(TAB)
    expect(await asker.send(TAB, 'alice-mac', { sealed: 1 })).toBe(true)
    expect(relay.send).toHaveBeenCalledWith(TAB, 'alice-mac', { sealed: 1 })
    asker.close(TAB)
    await Promise.resolve()
    expect(relay.close).toHaveBeenCalledWith(TAB)
    expect([...TAB_RELAY_METHODS]).toEqual(['open', 'send', 'close'])
  })

  it('answers only the three methods, takes ids as strings, and answers a failure as an error', async () => {
    const relay = { open: vi.fn(async () => { throw new Error('no') }), send: vi.fn(async () => { throw 'odd' }), close: vi.fn() } satisfies TabRelay
    for (const method of ['constructor', 'closeAll', '__proto__', 'toString', undefined]) {
      expect(await answerTabRelay(relay, { method, args: [TAB] })).toEqual({ error: 'UNKNOWN_METHOD' })
    }
    expect(await answerTabRelay(relay, { method: 'open', args: [TAB] })).toEqual({ error: 'no' })
    expect(await answerTabRelay(relay, { method: 'send', args: [TAB, 'm', {}] })).toEqual({ error: 'odd' })
    expect(await answerTabRelay(relay, { method: 'close', args: 'nope' })).toEqual({})
    expect(relay.close).toHaveBeenCalledWith('')
    expect(await answerTabRelay(TAB_RELAY_OFF, { method: 'send', args: [3, null, 'x'] })).toEqual({ result: false })
    expect(await answerTabRelay(TAB_RELAY_OFF, { method: 'open', args: [TAB] })).toEqual({})
  })

  it('falls back to TAB_RELAY_OFF\'s answers when nobody can answer', async () => {
    for (const call of [async () => ({ error: 'SERVICE_UNAVAILABLE' }), async () => ({}), () => Promise.reject(new Error('not connected')), async () => ({ result: 'yes' })]) {
      const asker = askTabRelay(call)
      await expect(asker.open(TAB)).resolves.toBeUndefined()
      expect(await asker.send(TAB, 'm', {})).toBe(false)
      expect(asker.close(TAB)).toBeUndefined()
    }
  })

  it('reads what the relay said as the shape it must be', () => {
    expect(tabFrameOf({ sharedTabId: TAB, from: { machineId: 'alice-mac', userId: 'u' }, payload: { a: 1 } }))
      .toEqual({ sharedTabId: TAB, from: { machineId: 'alice-mac', userId: 'u' }, payload: { a: 1 } })
    expect(tabFrameOf({ sharedTabId: TAB, undeliverable: 'carol-pc' })).toEqual({ sharedTabId: TAB, undeliverable: 'carol-pc' })
    expect(tabFrameOf({ sharedTabId: TAB, closed: { code: 4403, reason: 'gone' } })).toEqual({ sharedTabId: TAB, closed: { code: 4403, reason: 'gone' } })
    expect(tabFrameOf({ sharedTabId: TAB, closed: { code: 4409 } })).toEqual({ sharedTabId: TAB, closed: { code: 4409, reason: '' } })
    expect(tabFrameOf({ sharedTabId: TAB, ready: true })).toEqual({ sharedTabId: TAB, ready: true })
    expect(tabFrameOf({ sharedTabId: TAB, from: { machineId: 'x' }, payload: [], undeliverable: 3, closed: { code: '4403' }, ready: 'yes' })).toEqual({ sharedTabId: TAB })
    for (const odd of [null, [], 'x', {}, { sharedTabId: '' }, { sharedTabId: 3 }]) expect(tabFrameOf(odd)).toBeNull()
  })
})
