import { describe, expect, it } from 'vitest'
import { lstartGeneration, lstartMs } from './lstart.js'

describe('lstart', () => {
  const START = 'Tue Nov 25 10:00:00 2026'

  it('a C-locale start is its ms, and its generation ps:<ms>', () => {
    expect(lstartMs(START)).toBe(Date.parse(START))
    expect(lstartGeneration(START)).toBe(`ps:${Date.parse(START)}`)
    // A day under 10 is padded with a space.
    expect(lstartGeneration('Wed Nov  5 09:05:03 2026')).toBe(`ps:${Date.parse('Wed Nov  5 09:05:03 2026')}`)
  })

  // Date.parse alone reads the German one as a date: a start read under the person's own LC_TIME never equals the C one.
  it('nothing, garbage and a start in another locale are none', () => {
    for (const lstart of ['', 'garbage', 'Di. 25 Nov. 10:00:00 2026']) {
      expect(lstartMs(lstart), lstart).toBeUndefined()
      expect(lstartGeneration(lstart), lstart).toBeUndefined()
    }
  })
})
