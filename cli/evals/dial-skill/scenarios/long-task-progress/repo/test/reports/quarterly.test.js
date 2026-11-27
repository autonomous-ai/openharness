import assert from 'node:assert/strict'
import { test } from 'node:test'
import { quarterlyReport } from '../../src/reports/quarterly.js'
import { smallLedger, yearOfLedger } from '../fixtures.js'

test('nets each quarter', () => {
  assert.deepEqual(quarterlyReport(smallLedger), ['2025 Q1  $249.99', '2025 Q2  $100.01'])
})

test('covers every quarter of a year', () => {
  assert.equal(quarterlyReport(yearOfLedger()).length, 4)
})
