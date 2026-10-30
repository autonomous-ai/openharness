import { describe, expect, it } from 'vitest'
import { CLAIM_FAILING_ALARM_MS, claimsFailing } from './deliverySettle.js'

const NOW = 10_000_000
const row = (since: number | null, last: number | null, status = 'queued') => ({ status,
  claimFailingSince: since == null ? null : new Date(NOW - since), claimFailedAt: last == null ? null : new Date(NOW - last) }) as Parameters<typeof claimsFailing>[0]

describe('claimsFailing', () => {
  it('is true at exactly 5 minutes since the first failure and a last failure exactly 5 minutes old', () => {
    expect(claimsFailing(row(CLAIM_FAILING_ALARM_MS, CLAIM_FAILING_ALARM_MS), NOW)).toBe(true)
  })
  it('is false at 4:59 since the first failure', () => {
    expect(claimsFailing(row(CLAIM_FAILING_ALARM_MS - 1_000, 1_000), NOW)).toBe(false)
  })
  it('is false when the last failure is 5:01 old', () => {
    expect(claimsFailing(row(20 * 60_000, CLAIM_FAILING_ALARM_MS + 1_000), NOW)).toBe(false)
  })
  it('is false for a claimed delivery', () => {
    expect(claimsFailing(row(CLAIM_FAILING_ALARM_MS, 1_000, 'claimed'), NOW)).toBe(false)
  })
  it('is false with null fields', () => {
    expect(claimsFailing(row(null, null), NOW)).toBe(false)
    expect(claimsFailing(row(CLAIM_FAILING_ALARM_MS, null), NOW)).toBe(false)
    expect(claimsFailing(row(null, 1_000), NOW)).toBe(false)
  })
})
