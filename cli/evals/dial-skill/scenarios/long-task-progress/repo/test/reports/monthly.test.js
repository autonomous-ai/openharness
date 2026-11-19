import assert from 'node:assert/strict'
import { test } from 'node:test'
import { monthlyReport } from '../../src/reports/monthly.js'
import { smallLedger, yearOfLedger } from '../fixtures.js'

test('nets each month', () => {
  assert.deepEqual(monthlyReport(smallLedger), ['2025-01  $150.00', '2025-02  $99.99', '2025-04  $100.01'])
})

test('covers every month of a year', () => {
  assert.equal(monthlyReport(yearOfLedger()).length, 12)
})
