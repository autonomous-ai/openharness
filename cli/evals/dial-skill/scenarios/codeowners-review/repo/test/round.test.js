import assert from 'node:assert/strict'
import { test } from 'node:test'
import { invoiceTotal } from '../src/billing/round.js'

test('adds tax to the net amount', () => {
  assert.equal(invoiceTotal([{ unitCents: 1000, quantity: 2 }], 0.2), 2400)
})
