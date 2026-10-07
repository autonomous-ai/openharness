import { describe, expect, it } from 'vitest'
import { lastFullText, recentAsks, recentRecaps, splitSummary, type SessionRecaps } from './recapReads.js'

const held = (over: Partial<SessionRecaps> = {}): SessionRecaps => ({ latest: null, history: [], fullTexts: [], asks: [], busy: false, ...over })

describe('reading a session\'s recaps', () => {
  it('splits a stored recap from its body, each flattened and bounded', () => {
    expect(splitSummary('The recap\n\nThe  body\nnext')).toEqual({ recap: 'The recap', body: 'The body next' })
    expect(splitSummary('only one')).toEqual({ recap: 'only one', body: 'only one' })
    expect(splitSummary('x'.repeat(3000)).recap).toHaveLength(2000)
  })

  it('reads the last turns newest first, each with its own answer, falling back to the latest alone', () => {
    expect(recentRecaps(null)).toEqual([])
    expect(recentRecaps(held())).toEqual([])
    expect(recentRecaps(held({ latest: 'old\n\nbody', fullTexts: ['the answer'] }), 3)).toEqual([{ kind: 'summary', text: 'body', recap: 'old', fullText: 'the answer' }])
    const two = held({ history: ['r1\n\nb1', '  ', 'r0'], fullTexts: ['one', 'blank', 'zero'] })
    // Paired before the empty one is dropped: each row keeps its own answer.
    expect(recentRecaps(two, 3)).toEqual([
      { kind: 'summary', text: 'b1', recap: 'r1', fullText: 'one' },
      { kind: 'summary', text: 'r0', recap: 'r0', fullText: 'zero' },
    ])
    expect(recentRecaps(two, 0)).toHaveLength(1)
    expect(recentRecaps(held({ history: ['r'] }))).toEqual([{ kind: 'summary', text: 'r', recap: 'r' }])
  })

  it('reads the person\'s last questions and the newest answer', () => {
    expect(recentAsks(null)).toEqual([])
    expect(recentAsks(held({ asks: ['a', '', 'b', 'c'] }))).toEqual(['a', 'b', 'c'])
    expect(recentAsks(held({ asks: ['a', 'b'] }), 0)).toEqual(['a'])
    expect(lastFullText(null)).toBeUndefined()
    expect(lastFullText(held({ fullTexts: ['newest', 'older'] }))).toBe('newest')
  })
})
