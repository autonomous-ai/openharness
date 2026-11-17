import assert from 'node:assert/strict'
import { test } from 'node:test'
import { taxesReport } from '../../src/reports/taxes.js'
import { smallLedger, yearOfLedger } from '../fixtures.js'

test('taxes invoices less refunds, rounded to the cent', () => {
  assert.equal(taxesReport(smallLedger), 'Sales tax at 8.25% of $550.00: $45.38')
})

test('taxes a year of entries', () => {
  assert.match(taxesReport(yearOfLedger()), /^Sales tax at 8\.25% of \$\d+\.\d\d: \$\d+\.\d\d$/)
})
