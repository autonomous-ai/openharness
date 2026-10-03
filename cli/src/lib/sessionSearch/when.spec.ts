import { describe, expect, it } from 'vitest'

import { parseSearchWhen } from './when.js'

// Saturday 26 September 2026, 14:30 local — the same cases as desktop/test/search_when_test.dart.
const now = new Date(2026, 8, 26, 14, 30)
const day = (d: number) => new Date(2026, 8, d).getTime()
const read = (query: string) => {
  const { words, when } = parseSearchWhen(query, now)
  return { words, from: when?.from, to: when?.to }
}

describe('parseSearchWhen', () => {
  it('reads the common ways of saying when, and takes them out of the words', () => {
    expect(read('dial today')).toEqual({ words: 'dial', from: day(26), to: now.getTime() })
    expect(read('yesterday dial')).toEqual({ words: 'dial', from: day(25), to: day(26) })
    expect(read('dial this week')).toEqual({ words: 'dial', from: day(21), to: now.getTime() })
    expect(read('dial LAST WEEK scroll')).toEqual({ words: 'dial scroll', from: day(14), to: day(21) })
    expect(read('cohorts last month')).toEqual({ words: 'cohorts', from: new Date(2026, 7).getTime(), to: new Date(2026, 8).getTime() })
  })

  it('keeps "ago" loose, the way memory is', () => {
    expect(read('dial 3 days ago')).toEqual({ words: 'dial', from: day(22), to: day(25) })
    expect(read('a few days ago mobile')).toEqual({ words: 'mobile', from: day(20), to: day(25) })
    expect(read('two weeks ago')).toEqual({ words: '', from: day(8), to: day(17) })
    expect(read('a week ago dial')).toEqual({ words: 'dial', from: day(15), to: day(24) })
  })

  it('a weekday is its most recent one; "last" skips today', () => {
    expect(read('dial on monday')).toEqual({ words: 'dial', from: day(21), to: day(22) })
    expect(read('on friday')).toEqual({ words: '', from: day(25), to: day(26) })
    expect(read('dial on saturday')).toEqual({ words: 'dial', from: day(26), to: now.getTime() })
    expect(read('dial last saturday')).toEqual({ words: 'dial', from: day(19), to: day(20) })
  })

  it('leaves words alone that only look like time', () => {
    expect(read('dial 0 days ago')).toEqual({ words: 'dial', from: day(25), to: now.getTime() })
    for (const query of ['dial', 'todays menu', 'sundays', 'weekday parser', 'lastweek', 'sun mon', 'days ago', 'friday deploy']) {
      expect(parseSearchWhen(query, now)).toEqual({ words: query, when: null })
    }
  })
})
