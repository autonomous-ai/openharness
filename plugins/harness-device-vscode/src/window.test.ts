import { describe, expect, it } from 'vitest'
import { windowState } from './window'

describe('windowState', () => {
  it('lists the shells whose pid is known, in order, and the active one', () => {
    expect(windowState([101, undefined, 303], 303, true)).toEqual({ terminals: [101, 303], active: 303, focused: true })
  })

  it('an active terminal whose pid is not known yet, or is not listed, is null', () => {
    expect(windowState([101], undefined, false).active).toBeNull()
    expect(windowState([101], 999, false).active).toBeNull()
  })

  it('keeps the first 32, and an active one past them is null', () => {
    const many = Array.from({ length: 40 }, (_, at) => 1000 + at)
    expect(windowState(many, 1039, true)).toEqual({ terminals: many.slice(0, 32), active: null, focused: true })
  })

  it('leaves out what is no pid, and a pid twice', () => {
    expect(windowState([1, 0, -5, 2.5, 2 ** 31, 77, 77], 77, true).terminals).toEqual([77])
  })
})
