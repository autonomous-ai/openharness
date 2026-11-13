import { describe, expect, it } from 'vitest'
import { backgroundSaid } from './backgroundSaid.js'

describe('backgroundSaid', () => {
  it('says one background command, and any other number of them', () => {
    expect(backgroundSaid(1)).toBe('1 background command running')
    expect(backgroundSaid(2)).toBe('2 background commands running')
  })
})
