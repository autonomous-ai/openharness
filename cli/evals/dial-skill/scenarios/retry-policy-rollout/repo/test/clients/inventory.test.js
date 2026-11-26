import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createInventoryClient } from '../../src/clients/inventory.js'
import { fakeRequest } from '../fake.js'

test('stockOf returns what is available after a 500', async () => {
  const request = fakeRequest(500, { sku: 'mug-1', available: 14 })
  assert.equal(await createInventoryClient(request).stockOf('mug-1'), 14)
  assert.equal(request.calls.length, 2)
})

test('warehouses throws a 403 without trying again', async () => {
  const request = fakeRequest(403)
  await assert.rejects(createInventoryClient(request).warehouses(), { status: 403 })
  assert.equal(request.calls.length, 1)
})

test('stockOf gives up when the service stays down', async () => {
  const request = fakeRequest(503)
  await assert.rejects(createInventoryClient(request).stockOf('mug-1'), { status: 503 })
  assert.ok(request.calls.length > 1)
})
