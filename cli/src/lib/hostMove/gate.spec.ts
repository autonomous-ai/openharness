import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireAfterHold, HOLD_WAIT_MS, MoveGate } from './gate.js'

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

describe('MoveGate.releaseAll', () => {
  it('delivers what every held agent has waiting, in order, and lets all go; a hold already draining is waited for', async () => {
    const gate = new MoveGate()
    const written: string[] = []
    let unblock!: () => void
    gate.hold('a')
    gate.hold('b')
    gate.enqueue('a', async () => { written.push('a1') })
    gate.enqueue('b', async () => { await new Promise<void>((resolve) => { unblock = resolve }); written.push('b1') })
    gate.enqueue('b', async () => { written.push('b2') })
    expect(gate.held().sort()).toEqual(['a', 'b'])
    // b's own release is under way: releaseAll waits for it too.
    const draining = gate.release('b')
    let done = false
    const all = gate.releaseAll().then(() => { done = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(written).toEqual(['a1'])
    expect(done).toBe(false)
    unblock()
    await all
    await draining
    expect(written).toEqual(['a1', 'b1', 'b2'])
    expect(gate.held()).toEqual([])
  })
})

describe('acquireAfterHold', () => {
  afterEach(() => { vi.useRealTimers() })

  it('a control refused while the agent changes host is asked again once the move lets it go', async () => {
    vi.useFakeTimers()
    const gate = new MoveGate()
    gate.hold('a1')
    const release = () => {}
    // Refused while held, as `acquireControl` refuses it; given once the hold ends.
    const acquire = vi.fn(() => gate.holding('a1') ? null : release)
    const got = acquireAfterHold(gate, 'a1', acquire)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(acquire).toHaveBeenCalledTimes(1)
    await gate.release('a1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await got).toBe(release)
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  it('a refusal with no move in flight is answered at once, and a hold that never ends is waited out only so long', async () => {
    vi.useFakeTimers()
    const gate = new MoveGate()
    expect(await acquireAfterHold(gate, 'a1', () => null)).toBeNull()
    gate.hold('a1')
    let answered = false
    const got = acquireAfterHold(gate, 'a1', () => null).then((value) => { answered = true; return value })
    await vi.advanceTimersByTimeAsync(HOLD_WAIT_MS - 1_000)
    expect(answered).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await got).toBeNull()
  })
})
