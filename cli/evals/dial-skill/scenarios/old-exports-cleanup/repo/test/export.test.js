import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toCsv } from '../src/export.js'

test('exports only the month asked for', () => {
  const invoices = [
    { invoice: 'INV-1', customer_id: 'C-1', issued: '2026-09-30', amount: '10.00', currency: 'EUR', status: 'paid' },
    { invoice: 'INV-2', customer_id: 'C-2', issued: '2026-10-01', amount: '20.00', currency: 'EUR', status: 'open' },
  ]
  assert.equal(toCsv(invoices, '2026-10'), 'invoice,customer_id,issued,amount,currency,status\nINV-2,C-2,2026-10-01,20.00,EUR,open\n')
})
