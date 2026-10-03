import { describe, expect, it } from 'vitest'
import { advertisedNow, withSpellings, type LocalRecord } from './gridPicture.js'

const record = (over: Partial<LocalRecord>): LocalRecord => ({ name: 'mac', ids: [], pid: 4242, alive: true, ...over })

describe('model spellings', () => {
  it('keeps an upper-case spelling over the lower-case one the overview shows', () => {
    const remembered = withSpellings({}, ['Qwen3.6-35B-A3B'])
    expect(withSpellings(remembered, ['qwen3.6-35b-a3b'])).toEqual({ 'qwen3.6-35b-a3b': 'Qwen3.6-35B-A3B' })
  })

  it('takes the name as it is served now over a remembered one, whatever its case', () => {
    // Advertised as `Gemma-4-E2B` once, `gemma-4-e2b` now: the relay matches exactly, so the old spelling
    // would send an agent to a name nothing serves.
    const remembered = withSpellings({}, ['Gemma-4-E2B'])
    expect(withSpellings(remembered, ['gemma-4-e2b'], true)).toEqual({ 'gemma-4-e2b': 'gemma-4-e2b' })
    expect(withSpellings(remembered, ['Gemma-4-E2B'], true)).toBe(remembered)
  })

  it("reads what this computer serves now from its live records' own aliases only", () => {
    expect(advertisedNow([
      record({ ids: ['gemma-4-e2b'], advertised: true }),
      // A name derived from a file is not an alias anybody gave; it keeps the old rule.
      record({ ids: ['Small-Q4'], advertised: false }),
      record({ ids: ['old-alias'], advertised: true, alive: false, pid: null }),
    ])).toEqual(['gemma-4-e2b'])
  })
})
