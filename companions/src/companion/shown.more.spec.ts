/**
 * More of which window was shown which line (pair/shown.ts): frames that carry no keyed id however they
 * are shaped, a send that reaches nobody, the oldest lines forgotten past the bound, and a connection that
 * goes away taking only its own acknowledgements.
 */
import { describe, expect, it } from 'vitest'
import { ARM_MS, keyedIds, ShownLines } from './shown.js'

describe('keyedIds', () => {
  it('reads nothing from a frame without an object payload, or rows without string ids', () => {
    expect(keyedIds({ type: 'daemon_say' })).toEqual([])
    expect(keyedIds({ type: 'daemon_say', payload: 'need:1' })).toEqual([])
    expect(keyedIds({ type: 'daemon_say', payload: null })).toEqual([])
    expect(keyedIds({ type: 'daemon_say', payload: { id: 7 } })).toEqual([])
    expect(keyedIds({ type: 'daemon_state', payload: { needs: 'need:1', asks: null, confirms: [null, 'x', { id: 1 }, { id: 'c' }] } })).toEqual(['c'])
    expect(keyedIds({ type: 'daemon_brief', payload: {} })).toEqual([])
  })
})

describe('ShownLines', () => {
  it('a send that reaches no connection records nothing', () => {
    const shown = new ShownLines(() => 0)
    const sent: unknown[] = []
    shown.sender((f) => sent.push(f), () => [])({ type: 'daemon_say', payload: { id: 'need:1' } })
    expect(sent).toHaveLength(1)
    expect(shown.shown('a', 'need:1')).toBe(false)
  })

  it('a line sent to one connection is shown only there; a later send to another adds it without resetting the first', () => {
    let now = 0
    const shown = new ShownLines(() => now)
    const to = shown.senderTo((conn) => conn !== 'down')
    expect(to('a', { type: 'daemon_say', payload: { id: 'l' } })).toBe(true)
    expect(shown.shown('a', 'l')).toBe(true)
    now += ARM_MS
    expect(to('down', { type: 'daemon_say', payload: { id: 'l' } })).toBe(false)   // the send's own answer
    expect(to('a', { type: 'daemon_say', payload: { id: 'l' } })).toBe(true)
    expect(shown.check('a', 'l')).toBeNull()                                        // still armed
    expect(shown.check('down', 'l')).toBe('NOT_SHOWN')
    shown.detach('down')
    expect(shown.check('a', 'l')).toBeNull()                                        // a's acknowledgement stays
    shown.detach('a')
    expect(shown.shown('a', 'l')).toBe(false)
  })

  it('an id no connection received cannot be acknowledged or keyed', () => {
    const shown = new ShownLines(() => 0)
    expect(shown.shown('a', 'never')).toBe(false)
    expect(shown.check('a', 'never')).toBe('NOT_SHOWN')
    shown.detach('a')
  })

  it('remembers at most 2,000 lines: the oldest are forgotten first', () => {
    let now = 0
    const shown = new ShownLines(() => now)
    shown.offer(['first'], ['a'])
    expect(shown.shown('a', 'first')).toBe(true)
    for (let i = 0; i < 2_000; i++) shown.offer([`l${i}`], ['a'])
    now += ARM_MS
    expect(shown.check('a', 'first')).toBe('NOT_SHOWN')
    expect(shown.shown('a', 'l0')).toBe(true)
    expect(shown.shown('a', 'l1999')).toBe(true)
  })
})
