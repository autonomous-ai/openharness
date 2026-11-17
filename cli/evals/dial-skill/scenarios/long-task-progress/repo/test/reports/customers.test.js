import assert from 'node:assert/strict'
import { test } from 'node:test'
import { customersReport } from '../../src/reports/customers.js'
import { smallLedger, yearOfLedger } from '../fixtures.js'

test('ranks the top customers by revenue, with their share', () => {
  assert.deepEqual(customersReport(smallLedger), [
    'Ada  $420.01  (76.4%)',
    'Linus  $99.99  (18.2%)',
    'Grace  $30.00  (5.5%)',
  ])
})

test('keeps three customers out of a year of entries', () => {
  assert.equal(customersReport(yearOfLedger()).length, 3)
})
