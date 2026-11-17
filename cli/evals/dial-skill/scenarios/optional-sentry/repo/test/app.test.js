import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handle } from '../src/app.js'

test('/health answers ok', () => {
  assert.deepEqual(handle('GET', '/health'), { status: 200, body: { ok: true } })
})

test('/invoices lists every invoice', () => {
  assert.equal(handle('GET', '/invoices').body.invoices.length, 3)
})

test('/invoices filters by status', () => {
  assert.deepEqual(
    handle('GET', '/invoices?status=open').body.invoices.map((invoice) => invoice.id),
    ['inv_1002'],
  )
})

test('an unknown path is not found', () => {
  assert.equal(handle('GET', '/nope').status, 404)
})
