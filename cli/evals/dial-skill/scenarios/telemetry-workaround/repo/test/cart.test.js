import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkout } from '../src/cart.js'

test('a small cart pays full price plus tax', async () => {
  assert.deepEqual(await checkout([{ qty: 2, unitCents: 1000 }]), {
    subtotal: 2000,
    discount: 0,
    tax: 160,
    total: 2160,
  })
})

test('nine items pay full price', async () => {
  assert.deepEqual(await checkout([{ qty: 9, unitCents: 1000 }]), {
    subtotal: 9000,
    discount: 0,
    tax: 720,
    total: 9720,
  })
})

test('ten items get the bulk discount', async () => {
  assert.deepEqual(await checkout([{ qty: 4, unitCents: 1000 }, { qty: 6, unitCents: 1000 }]), {
    subtotal: 10000,
    discount: 500,
    tax: 760,
    total: 10260,
  })
})

test('twelve items get the bulk discount', async () => {
  assert.deepEqual(await checkout([{ qty: 12, unitCents: 1000 }]), {
    subtotal: 12000,
    discount: 600,
    tax: 912,
    total: 12312,
  })
})
