import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatDate, formatMoney, formatPercent } from '../src/format/index.js'

test('formats cents as dollars', () => {
  assert.equal(formatMoney(12345), '$123.45')
  assert.equal(formatMoney(5), '$0.05')
  assert.equal(formatMoney(-1550), '-$15.50')
})

test('formats a date as its UTC day', () => {
  assert.equal(formatDate(new Date('2025-03-09T23:30:00Z')), '2025-03-09')
})

test('formats a ratio as a percentage', () => {
  assert.equal(formatPercent(0.02741), '2.7%')
})
