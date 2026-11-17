import assert from 'node:assert/strict'
import { test } from 'node:test'
import { orderTotal } from '../../src/orders.js'

test('sums lines, applies the discount, adds shipping', () => {
  const order = {
    lines: [
      { unitCents: 1200, quantity: 2 },
      { unitCents: 500, quantity: 1 },
    ],
    discountPercent: 10,
    shippingCents: 499,
  }
  assert.equal(orderTotal(order), 2900 - 290 + 499)
})
