import assert from 'node:assert/strict'
import { test } from 'node:test'
import { charge } from '../src/index.js'

test('charges a whole number of cents', () => {
  assert.deepEqual(charge('cus_1', 500), { customer: 'cus_1', cents: 500, status: 'charged' })
})

test('refuses a fractional or negative amount', () => {
  assert.throws(() => charge('cus_1', 4.5), RangeError)
  assert.throws(() => charge('cus_1', -1), RangeError)
})
