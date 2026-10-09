import { expect, it } from 'vitest'
import { verifiedForegroundJob } from './externalOwnerControl.js'
it('distinguishes verified group leadership from unreadable foreground evidence', async () => {
  for (const [answer, expected] of [[null, 'unknown'], ['', 'unknown'], ['bad', 'unknown'], ['7 0', 'unknown'], ['0 7', 'unknown'],
    ['7 7 extra', 'unknown'], ['7 7', 7], ['8 7', null], ['7 -1', null]] as const) {
    expect(await verifiedForegroundJob(7, async () => answer)).toBe(expected)
  }
})
