import { describe, expect, it } from 'vitest'
import { deriveTurnSummary, extendShortRecap } from './deviceRecap.js'

describe('device recap minimum', () => {
  it.each(['Yes.', 'No.', 'Done.', 'Tests pass.', "It isn't external."])(
    'extends %s with the following explanation', opening => {
      const source = `${opening} The remaining explanation is much longer than the space available below the companion on this display.`
      const recap = deriveTurnSummary(source)!.split('\n\n')[0]
      expect(recap.startsWith(opening + ' ')).toBe(true)
      expect(recap.length).toBeGreaterThanOrEqual(20)
      expect(recap.length).toBeLessThanOrEqual(180)
    })
  it('keeps complete sentences once their combined length is at least 20', () => {
    const opening = 'Fixed. All tests pass.'
    expect(deriveTurnSummary(opening + ' ' + 'Additional explanation '.repeat(8))!.split('\n\n')[0]).toBe(opening)
  })
  it('does not invent text when the entire answer is short', () => {
    expect(deriveTurnSummary('Yes.')!.split('\n\n')[0]).toBe('Yes.')
  })
  it('uses the larger reading area without cutting a complete sentence', () => {
    const source = 'The update is installed. Voice input now sends to the selected agent. The new layout keeps the result in the center.'
    expect(source.length).toBeGreaterThan(80)
    expect(deriveTurnSummary(source)!.split('\n\n')[0]).toBe(source)
    expect(extendShortRecap('The update is installed. Voice input now sends to the selected agent.', source)).toBe(source)
    expect(extendShortRecap('The update is installed. Voice input now sends to the +', source)).toBe(source)
    expect(extendShortRecap('The update is installed.', 'An unrelated update is installed.')).toBe('The update is installed.')
  })
  it('repairs a cached short recap only from its own matching body', () => {
    expect(extendShortRecap('Yes.', 'Yes. The fix is installed.')).toBe('Yes. The fix is installed.')
    expect(extendShortRecap('No.', 'Yes. The fix is installed.')).toBe('No.')
    expect(extendShortRecap('The fix is installed.', 'The fix is installed. All checks passed.')).toBe('The fix is installed. All checks passed.')
  })
})
