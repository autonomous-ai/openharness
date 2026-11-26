import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loyaltyPrice } from '../src/customers/loyalty.js'
import { receiptSubject, receiptTotal } from '../src/emails/receipt.js'
import { invoiceLines } from '../src/orders/invoice.js'
import { refundQuote } from '../src/orders/refunds.js'
import { estimatedArrival } from '../src/orders/shipping.js'
import { catalogEntries } from '../src/products/catalog.js'
import { searchProducts } from '../src/products/search.js'
import { dailySummary } from '../src/reports/daily.js'
import { exportFileName } from '../src/reports/export.js'

const order = {
  id: 'ord_17',
  placedAt: new Date('2026-05-01T09:30:00Z'),
  shipping: 'express',
  paidCents: 7650,
  items: [
    { name: 'café mug', cents: 1450, quantity: 3 },
    { name: 'linen apron', cents: 3200, quantity: 1 },
  ],
}
const customer = { first: 'ada', last: 'LOVELACE', since: new Date('2025-01-15T00:00:00Z') }

test('the catalog lists slugs and prices', () => {
  assert.deepEqual(catalogEntries()[0], { slug: 'cafe-mug', price: '$14.50' })
})

test('search finds products by name', () => {
  assert.deepEqual(searchProducts('walnut'), ['Walnut Bo…'])
})

test('an invoice lists items and the total', () => {
  assert.deepEqual(invoiceLines(order), [
    'Invoice ord_17 (2026-05-01)',
    '3 x café mug: $43.50',
    '1 x linen apron: $32.00',
    'Total: $75.50',
  ])
})

test('express arrives in two days', () => {
  assert.equal(estimatedArrival(order), '2026-05-03')
})

test('refunds close after 30 days', () => {
  assert.equal(refundQuote(order, new Date('2026-05-20T00:00:00Z')), 'Refund $76.50')
  assert.equal(refundQuote(order, new Date('2026-06-20T00:00:00Z')), 'Past the refund window')
})

test('a customer of a year gets 10 % off', () => {
  assert.equal(loyaltyPrice(customer, 3200, new Date('2026-05-01T00:00:00Z')), 2880)
})

test('the receipt names the customer and the total', () => {
  assert.equal(receiptSubject(customer, order), 'Thanks, Ada Lovelace: Café Mug and more')
  assert.equal(receiptTotal(order), 'You paid $76.50')
})

test('the daily report sums the day', () => {
  assert.equal(dailySummary(order.placedAt, [order, order]), '2026-05-01: 2 orders, $153.00')
  assert.equal(exportFileName(order.placedAt, 'Daily Sales'), '2026-05-01-daily-sales.csv')
})
