import assert from 'node:assert/strict'
import { test } from 'node:test'
import { yearlyReport } from '../../src/reports/yearly.js'
import { smallLedger, yearOfLedger } from '../fixtures.js'

test('nets the year', () => {
  assert.deepEqual(yearlyReport(smallLedger), ['2025  $350.00'])
})

test('puts a year of entries on one line', () => {
  assert.match(yearlyReport(yearOfLedger()).join('\n'), /^2025 {2}\$\d+\.\d\d$/)
})
