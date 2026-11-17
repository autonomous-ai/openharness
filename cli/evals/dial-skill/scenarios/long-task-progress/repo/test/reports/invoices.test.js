import assert from 'node:assert/strict'
import { test } from 'node:test'
import { invoicesReport } from '../../src/reports/invoices.js'
import { smallLedger, yearOfLedger } from '../fixtures.js'

test('counts and totals the invoices', () => {
  assert.equal(invoicesReport(smallLedger), '4 invoices, $565.50, last on 2025-04-02')
})

test('summarizes a year of invoices', () => {
  assert.match(invoicesReport(yearOfLedger()), /^\d+ invoices, \$\d+\.\d\d, last on 2025-12-31$/)
})
