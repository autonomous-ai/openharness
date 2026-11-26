import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOrdersClient } from '../../src/clients/orders.js'
import { fakeRequest } from '../fake.js'

test('getOrder returns the order after two 503s', async () => {
  const request = fakeRequest(503, 503, { id: 'o-17', total: 4200 })
  assert.deepEqual(await createOrdersClient(request).getOrder('o-17'), { id: 'o-17', total: 4200 })
  assert.equal(request.calls.length, 3)
})

test('listOrders returns the items of the page', async () => {
  const request = fakeRequest({ items: [{ id: 'o-17' }] })
  assert.deepEqual(await createOrdersClient(request).listOrders('c3'), [{ id: 'o-17' }])
  assert.equal(request.calls[0].path, '/customers/c3/orders')
})

test('getOrder throws a 404 without trying again', async () => {
  const request = fakeRequest(404)
  await assert.rejects(createOrdersClient(request).getOrder('o-0'), { status: 404 })
  assert.equal(request.calls.length, 1)
})
