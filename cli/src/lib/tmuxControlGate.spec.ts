import { afterEach, describe, expect, it } from 'vitest'
import { enterTmuxRoom, inTmuxRoom, needsControlGate, tmuxControlGate, TwoRoomGate } from './tmuxControlGate.js'
import { assumeTmuxVersion, resetTmuxVersionCache, tmuxFeaturesOf } from './tmuxVersion.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('TwoRoomGate', () => {
  it('lets any number into one room and none into the other until it is empty', async () => {
    const gate = new TwoRoomGate()
    const pasteOne = await gate.enter('notify')
    const pasteTwo = await gate.enter('notify')
    let attached = false
    const attaching = gate.enter('attach').then((leave) => { attached = true; return leave })
    await tick()
    expect(attached).toBe(false)
    expect(gate.state).toEqual({ room: 'notify', inside: 2, waiting: 1 })
    pasteOne()
    await tick()
    expect(attached).toBe(false)
    pasteTwo()
    const leave = await attaching
    expect(gate.state).toEqual({ room: 'attach', inside: 1, waiting: 0 })
    leave()
    expect(gate.state).toEqual({ room: null, inside: 0, waiting: 0 })
  })

  it('serves in arrival order: one arriving for the open room waits behind one waiting for the other', async () => {
    const gate = new TwoRoomGate()
    const order: string[] = []
    const first = await gate.enter('notify')
    const attaches = [gate.enter('attach'), gate.enter('attach')].map((entered, i) => entered.then((leave) => { order.push(`attach ${i}`); return leave }))
    // The notify room is open, but an attach is waiting: a stream of pastes must not keep it waiting forever.
    const later = gate.enter('notify').then((leave) => { order.push('notify'); return leave })
    await tick()
    expect(order).toEqual([])
    first()
    // Both attaches go in together; the paste after them waits for both to leave.
    const [one, two] = await Promise.all(attaches)
    expect(order).toEqual(['attach 0', 'attach 1'])
    one()
    await tick()
    expect(order).toEqual(['attach 0', 'attach 1'])
    two()
    ;(await later)()
    expect(order).toEqual(['attach 0', 'attach 1', 'notify'])
    expect(gate.state).toEqual({ room: null, inside: 0, waiting: 0 })
  })

  it('takes a second way out as nothing', async () => {
    const gate = new TwoRoomGate()
    const one = await gate.enter('attach')
    const two = await gate.enter('attach')
    one()
    one()
    expect(gate.state).toEqual({ room: 'attach', inside: 1, waiting: 0 })
    two()
    expect(gate.state).toEqual({ room: null, inside: 0, waiting: 0 })
  })
})

describe('the gate, by the tmux it runs on', () => {
  afterEach(() => resetTmuxVersionCache())

  it('is needed before tmux 3.7, and not from it or on a tmux that prints no version', () => {
    expect(needsControlGate(tmuxFeaturesOf({ major: 3, minor: 4 }))).toBe(true)
    expect(needsControlGate(tmuxFeaturesOf({ major: 3, minor: 6 }))).toBe(true)
    expect(needsControlGate(tmuxFeaturesOf({ major: 2, minor: 8 }))).toBe(true)
    expect(needsControlGate(tmuxFeaturesOf({ major: 3, minor: 7 }))).toBe(false)
    expect(needsControlGate(tmuxFeaturesOf(null))).toBe(false)
  })

  it('holds nothing on a tmux that needs no gate', async () => {
    assumeTmuxVersion({ major: 3, minor: 7 })
    const held = await tmuxControlGate.enter('attach')
    try {
      // A paste on 3.7 goes straight through, even while a terminal attaches.
      expect(await inTmuxRoom('notify', async () => 'pasted')).toBe('pasted')
      const leave = await enterTmuxRoom('notify', tmuxFeaturesOf(null))
      expect(tmuxControlGate.state).toEqual({ room: 'attach', inside: 1, waiting: 0 })
      leave()
      expect(tmuxControlGate.state).toEqual({ room: 'attach', inside: 1, waiting: 0 })
    } finally {
      held()
    }
  })

  it('on an older tmux, runs the work in its room and leaves it however the work ends', async () => {
    assumeTmuxVersion({ major: 3, minor: 4 })
    const seen: unknown[] = []
    await expect(inTmuxRoom('notify', async () => {
      seen.push(tmuxControlGate.state)
      throw new Error('tmux refused')
    })).rejects.toThrow('tmux refused')
    expect(seen).toEqual([{ room: 'notify', inside: 1, waiting: 0 }])
    expect(tmuxControlGate.state).toEqual({ room: null, inside: 0, waiting: 0 })

    // And waits while the other room is held.
    const attaching = await enterTmuxRoom('attach')
    let ran = false
    const pasted = inTmuxRoom('notify', async () => { ran = true })
    await tick()
    expect(ran).toBe(false)
    attaching()
    await pasted
    expect(ran).toBe(true)
  })
})
