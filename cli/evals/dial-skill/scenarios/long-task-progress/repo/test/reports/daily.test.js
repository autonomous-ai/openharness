import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dailyReport } from '../../src/reports/daily.js'
import { smallLedger, yearOfLedger } from '../fixtures.js'

test('nets each day', () => {
  assert.deepEqual(dailyReport(smallLedger), [
    '2025-01-06  $165.50',
    '2025-01-07  -$15.50',
    '2025-02-14  $99.99',
    '2025-04-01  -$200.00',
    '2025-04-02  $300.01',
  ])
})

test('covers every day of a year', () => {
  assert.equal(dailyReport(yearOfLedger()).length, 365)
})
