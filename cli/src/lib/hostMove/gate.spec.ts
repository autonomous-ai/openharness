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

  it('keeps what arrives while the queue runs behind it, and lets go only after the last', async () => {
    const gate = new MoveGate()
    const delivered: string[] = []
    gate.hold('a1')
    gate.enqueue('a1', async () => {
      delivered.push('first')
      // Arrives mid-drain: still held, so it queues behind rather than overtaking.
      expect(gate.holding('a1')).toBe(true)
      gate.enqueue('a1', async () => { delivered.push('late') })
    })
    gate.enqueue('a1', async () => { throw new Error('a failed delivery does not stop the rest') })
    gate.enqueue('a1', async () => { expect(gate.holding('a1')).toBe(true); delivered.push('second') })
    await gate.release('a1')
    expect(delivered).toEqual(['first', 'second', 'late'])
    expect(gate.holding('a1')).toBe(false)
  })

  it('counts a held agent as touched from its first write or touch, and forgets it at release', async () => {
    const gate = new MoveGate()
    gate.touch('a1')
    expect(gate.touched('a1')).toBe(false)
    gate.hold('a1')
    expect(gate.touched('a1')).toBe(false)
    gate.touch('a1')
    expect(gate.touched('a1')).toBe(true)
    await gate.release('a1')
    expect(gate.touched('a1')).toBe(false)
    gate.hold('a1')
    expect(gate.touched('a1')).toBe(false)
    gate.enqueue('a1', async () => {})
    expect(gate.touched('a1')).toBe(true)
    await gate.release('a1')
  })

  it('nothing is held for other agents', async () => {
    const gate = new MoveGate()
    const delivered: string[] = []
    gate.hold('a1')
    expect(gate.holding('a2')).toBe(false)
    gate.enqueue('a2', async () => { delivered.push('a2') })
    await Promise.resolve()
    expect(delivered).toEqual(['a2'])
    expect(gate.touched('a2')).toBe(false)
    gate.enqueue('a1', async () => { delivered.push('a1') })
    await Promise.resolve()
    expect(delivered).toEqual(['a2'])
    await gate.release('a1')
    expect(delivered).toEqual(['a2', 'a1'])
  })
})
