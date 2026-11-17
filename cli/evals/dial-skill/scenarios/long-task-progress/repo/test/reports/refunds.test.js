import assert from 'node:assert/strict'
import { test } from 'node:test'
import { refundsReport } from '../../src/reports/refunds.js'
import { smallLedger, yearOfLedger } from '../fixtures.js'

test('totals the refunds against what was invoiced', () => {
  assert.equal(refundsReport(smallLedger), '1 refund, -$15.50, 2.7% of invoiced')
})

test('summarizes a year of refunds', () => {
  assert.match(refundsReport(yearOfLedger()), /^\d+ refunds, -\$\d+\.\d\d, \d+\.\d% of invoiced$/)
})
