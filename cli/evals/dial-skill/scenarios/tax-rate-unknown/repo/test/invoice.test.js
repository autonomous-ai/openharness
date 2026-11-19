import assert from 'node:assert/strict'
import { test } from 'node:test'
import { invoiceTotals } from '../src/invoice.js'

const order = {
  lines: [
    { unitCents: 1290, quantity: 3 },
    { unitCents: 1999, quantity: 2, discountPercent: 15 },
  ],
}

test('2026: tax on the subtotal, after discounts', () => {
  assert.deepEqual(invoiceTotals(order, 'north', '2026-06-30'), { net: 7268, tax: 581, total: 7849 })
})
