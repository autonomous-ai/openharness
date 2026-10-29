import { describe, expect, it } from 'vitest'
import { buddyAvatar } from './buddyAvatar.js'

describe('buddyAvatar', () => {
  it('draws Desktop\'s pattern and dark tone for a Buddy name', () => {
    expect(buddyAvatar("diego's Buddy")).toEqual({ cells: 25513, color: '#d6a79a' })
    expect(buddyAvatar("  KEN's Buddy ")).toEqual({ cells: 30735, color: '#d69abb' })
  })

  it('never draws an empty pattern', () => {
    // FNV-1a of "buddy 535" is 0x99d90000: its low 15 bits are all off, hue 145.
    expect(buddyAvatar('buddy 535')).toEqual({ cells: 1 << 7, color: '#9ad6b3' })
  })
})
