import { describe, expect, it } from 'vitest'
import { noticeReason, WAITING_NOTICE_AFTER_MS, WithheldDeliveries } from './withheld.js'

describe('WithheldDeliveries', () => {
  it('reports a reason once, then again only when it changes', () => {
    const waits = new WithheldDeliveries()
    expect(waits.record('d', 'team_waiting_draft', 1_000)).toMatchObject({ changed: true, waitedMs: 0 })
    expect(waits.record('d', 'team_waiting_draft', 2_000)).toMatchObject({ changed: false, waitedMs: 1_000 })
    expect(waits.record('d', 'team_waiting_idle', 3_000)).toMatchObject({ changed: true, waitedMs: 2_000 })
  })

  it('owes the one notice after 30 seconds, and asks again only after a failed attempt has aged', () => {
    const waits = new WithheldDeliveries()
    waits.record('d', 'team_waiting_idle', 0)
    expect(waits.record('d', 'team_waiting_idle', WAITING_NOTICE_AFTER_MS - 1).noticeDue).toBe(false)
    expect(waits.record('d', 'team_waiting_idle', WAITING_NOTICE_AFTER_MS).noticeDue).toBe(true)
    waits.noticeStarted('d', WAITING_NOTICE_AFTER_MS)
    expect(waits.record('d', 'team_waiting_idle', WAITING_NOTICE_AFTER_MS + 1).noticeDue).toBe(false)
    expect(waits.record('d', 'team_waiting_idle', 2 * WAITING_NOTICE_AFTER_MS).noticeDue).toBe(true)
    waits.noticed('d')
    expect(waits.record('d', 'team_waiting_idle', 9 * WAITING_NOTICE_AFTER_MS).noticeDue).toBe(false)
  })

  it('starts counting again for a delivery that was cleared, and ignores ones it never saw', () => {
    const waits = new WithheldDeliveries()
    waits.noticed('nobody'); waits.noticeStarted('nobody', 0)
    waits.record('d', 'team_waiting_idle', 0)
    waits.clear('d')
    expect(waits.record('d', 'team_waiting_idle', 90_000)).toMatchObject({ changed: true, waitedMs: 0, noticeDue: false })
  })

  it('passes known reasons and says any other as unavailable', () => {
    expect(noticeReason('team_waiting_user')).toBe('team_waiting_user')
    expect(noticeReason('team_waiting_busy')).toBe('team_waiting_unavailable')
  })
})
