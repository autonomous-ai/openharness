/**
 * Which window was shown which line (pair/shown.ts): a key counts only from the connection that received
 * the line and acknowledged it as displayed, ARM_MS before the key.
 */
import { describe, expect, it } from 'vitest'
import { ARM_MS, keyedIds, ShownLines } from './shown.js'

describe('shown lines', () => {
  it('reads the keyed ids of every pair frame that carries them', () => {
    expect(keyedIds({ type: 'daemon_say', payload: { id: 'need:1' } })).toEqual(['need:1'])
    expect(keyedIds({ type: 'daemon_state', payload: { needs: [{ id: 'need:2' }, { requestId: 'q' }], asks: [{ id: 'ask:1' }], confirms: [{ id: 'confirm:autonomy:n' }] } }))
      .toEqual(['need:2', 'ask:1', 'confirm:autonomy:n'])
    expect(keyedIds({ type: 'daemon_brief', payload: { items: [{ id: 'brief:1' }, { kind: 'done' }] } })).toEqual(['brief:1'])
    expect(keyedIds({ type: 'daemon_unsay', payload: { id: 'x' } })).toEqual([])
  })

  it('a line can be acknowledged only on a connection it reached, and arms ARM_MS later', () => {
    let now = 0
    const shown = new ShownLines(() => now)
    const sent: unknown[] = []
    const send = shown.sender((f) => sent.push(f), () => ['a'])
    send({ type: 'daemon_say', payload: { id: 'need:1' } })
    expect(sent).toHaveLength(1)
    expect(shown.shown('b', 'need:1')).toBe(false)          // never reached b
    expect(shown.check('b', 'need:1')).toBe('NOT_SHOWN')
    expect(shown.check('a', 'need:1')).toBe('NOT_SHOWN')    // reached a, not yet drawn
    expect(shown.shown('a', 'need:1')).toBe(true)
    expect(shown.check('a', 'need:1')).toBe('TOO_SOON')
    now += ARM_MS
    expect(shown.check('a', 'need:1')).toBeNull()
    // A second acknowledgement does not restart the clock; a detached window loses all of it.
    expect(shown.shown('a', 'need:1')).toBe(true)
    expect(shown.check('a', 'need:1')).toBeNull()
    shown.detach('a')
    expect(shown.check('a', 'need:1')).toBe('NOT_SHOWN')
    shown.senderTo(() => true)('c', { type: 'daemon_say', payload: { id: 'need:2' } })
    expect(shown.shown('c', 'need:2')).toBe(true)
  })
})
