import assert from 'node:assert/strict'
import { test } from 'node:test'
import { weeklyReport } from '../../src/reports/weekly.js'
import { smallLedger, yearOfLedger } from '../fixtures.js'

test('nets each week from its Monday', () => {
  assert.deepEqual(weeklyReport(smallLedger), [
    'week of 2025-01-06  $150.00',
    'week of 2025-02-10  $99.99',
    'week of 2025-03-31  $100.01',
  ])
})

test('covers the 53 weeks a year touches', () => {
  assert.equal(weeklyReport(yearOfLedger()).length, 53)
})
