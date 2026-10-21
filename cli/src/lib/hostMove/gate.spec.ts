import { describe, expect, it } from 'vitest'
import { MoveGate } from './gate.js'

describe('MoveGate', () => {
  it('input during a hold is delivered once, in order, after release', async () => {
    const gate = new MoveGate()
    const delivered: string[] = []
    gate.hold('a1')
    expect(gate.holding('a1')).toBe(true)
    gate.enqueue('a1', async () => { delivered.push('one') })
    gate.enqueue('a1', async () => { await Promise.resolve(); delivered.push('two') })
    gate.enqueue('a1', async () => { delivered.push('three') })
    await Promise.resolve()
    expect(delivered).toEqual([])
    await gate.release('a1')
    expect(delivered).toEqual(['one', 'two', 'three'])
    expect(gate.holding('a1')).toBe(false)
    await gate.release('a1')
    expect(delivered).toEqual(['one', 'two', 'three'])
  })

  it('keeps what arrives while the queue runs behind it, and opens only after the last', async () => {
    const gate = new MoveGate()
    const delivered: string[] = []
    let opened = false
    gate.hold('a1')
    void gate.whenOpen('a1').then(() => { opened = true })
    gate.enqueue('a1', async () => {
      delivered.push('first')
      // Arrives mid-drain: still held, so it queues behind rather than overtaking.
      expect(gate.holding('a1')).toBe(true)
      gate.enqueue('a1', async () => { delivered.push('late') })
    })
    gate.enqueue('a1', async () => { throw new Error('a failed delivery does not stop the rest') })
    gate.enqueue('a1', async () => { expect(opened).toBe(false); delivered.push('second') })
    await gate.release('a1')
    expect(delivered).toEqual(['first', 'second', 'late'])
    expect(opened).toBe(true)
  })

  it('whenOpen resolves at release, and at once for an agent not held', async () => {
    const gate = new MoveGate()
    await gate.whenOpen('free')
    gate.hold('a1')
    let opened = false
    const waiting = gate.whenOpen('a1').then(() => { opened = true })
    await Promise.resolve()
    expect(opened).toBe(false)
    await gate.release('a1')
    await waiting
    expect(opened).toBe(true)
  })

  it('nothing is held for other agents', async () => {
    const gate = new MoveGate()
    const delivered: string[] = []
    gate.hold('a1')
    expect(gate.holding('a2')).toBe(false)
    gate.enqueue('a2', async () => { delivered.push('a2') })
    await gate.whenOpen('a2')
    await Promise.resolve()
    expect(delivered).toEqual(['a2'])
    gate.enqueue('a1', async () => { delivered.push('a1') })
    await Promise.resolve()
    expect(delivered).toEqual(['a2'])
    await gate.release('a1')
    expect(delivered).toEqual(['a2', 'a1'])
  })
})
