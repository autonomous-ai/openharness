import assert from 'node:assert/strict'
import { test } from 'node:test'
import { payoutsReport } from '../../src/reports/payouts.js'
import { smallLedger, yearOfLedger } from '../fixtures.js'

test('totals the payouts', () => {
  assert.equal(payoutsReport(smallLedger), '1 payout, -$200.00, last on 2025-04-01')
})

test('summarizes a year of payouts', () => {
  assert.match(payoutsReport(yearOfLedger()), /^\d+ payouts, -\$\d+\.\d\d, last on 2025-12-\d\d$/)
})
