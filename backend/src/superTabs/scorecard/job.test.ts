import { describe, expect, it } from 'vitest'
import { dueDays, pruneCache, scorecardCache } from './job.js'

const HOUR = 3_600_000
/** 2026-11-06 00:31 in Vietnam. */
const AFTER_MIDNIGHT = Date.UTC(2026, 10, 5, 17, 31)

describe('the nightly scorecard pass', () => {
  it('computes yesterday and the day before once yesterday has settled', () => {
    expect(dueDays({ timeZone: 'Asia/Ho_Chi_Minh' }, AFTER_MIDNIGHT)).toEqual(['2026-11-05', '2026-11-04'])
    // 00:10: yesterday's late rows may still land, so only the day before is due.
    expect(dueDays({ timeZone: 'Asia/Ho_Chi_Minh' }, AFTER_MIDNIGHT - 21 * 60_000)).toEqual(['2026-11-04'])
  })

  it('forgets the days no pass can be due for, so a long-lived worker keeps a few keys', () => {
    const cache = scorecardCache()
    for (const on of ['2026-11-01', '2026-11-03', '2026-11-04', '2026-11-05']) {
      cache.settled.add(JSON.stringify(['tab', 'p', on]))
      cache.tries.set(JSON.stringify(['tab', 'p', on]), 1)
    }
    // 11-08 00:31 in Vietnam is 11-07 in UTC: a zone up to 14 hours either side is due for 11-04 at the earliest.
    pruneCache(cache, AFTER_MIDNIGHT + 48 * HOUR)
    expect([...cache.settled].map(k => JSON.parse(k)[2])).toEqual(['2026-11-04', '2026-11-05'])
    expect([...cache.tries.keys()].map(k => JSON.parse(k)[2])).toEqual(['2026-11-04', '2026-11-05'])
  })
})
