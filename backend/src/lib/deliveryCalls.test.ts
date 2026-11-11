import { afterEach, expect, it, vi } from 'vitest'
import { noteClaim, recordDeliveryCall, startDeliveryCalls } from './deliveryCalls.js'

afterEach(() => vi.useRealTimers())

it('counts re-claims, receipt 403/404 and holds by reason, and logs nothing in an empty window (spec 2026-11-02 poll cost, Part 0)', () => {
  vi.useFakeTimers()
  const log = vi.fn()
  const stop = startDeliveryCalls({ everyMs: 60_000, log })
  vi.advanceTimersByTime(60_000)
  expect(log).not.toHaveBeenCalled()
  recordDeliveryCall('reclaim'); recordDeliveryCall('reclaim')
  recordDeliveryCall('receipt403'); recordDeliveryCall('receipt404')
  recordDeliveryCall('hold', 'team_waiting_user'); recordDeliveryCall('hold', 'team_waiting_user'); recordDeliveryCall('hold', 'dialog')
  vi.advanceTimersByTime(60_000)
  expect(log).toHaveBeenCalledWith('delivery calls', { windowMs: 60_000, reclaims: 2, receipt403: 1, receipt404: 1,
    holds: { team_waiting_user: 2, dialog: 1 } })
  stop()
})

it('a claim of the same delivery within 10 s counts as a re-claim, a later one does not', () => {
  vi.useFakeTimers()
  const log = vi.fn()
  const stop = startDeliveryCalls({ everyMs: 60_000, log })
  noteClaim('d1', 1_000); noteClaim('d1', 2_000); noteClaim('d1', 13_000); noteClaim('d2', 13_500)
  vi.advanceTimersByTime(60_000)
  expect(log.mock.calls[0]![1]).toMatchObject({ reclaims: 1 })
  stop()
})
