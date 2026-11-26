import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCatalogClient } from '../../src/clients/catalog.js'
import { fakeRequest } from '../fake.js'

test('getProduct returns the product after a 503', async () => {
  const request = fakeRequest(503, { sku: 'mug-1', price: 1200 })
  assert.deepEqual(await createCatalogClient(request).getProduct('mug-1'), { sku: 'mug-1', price: 1200 })
  assert.equal(request.calls.length, 2)
})

test('getProduct throws a 404 without trying again', async () => {
  const request = fakeRequest(404)
  await assert.rejects(createCatalogClient(request).getProduct('nope'), { status: 404 })
  assert.equal(request.calls.length, 1)
})

test('search returns the items of the page', async () => {
  const request = fakeRequest({ items: [{ sku: 'mug-1' }] })
  assert.deepEqual(await createCatalogClient(request).search('blue mug'), [{ sku: 'mug-1' }])
  assert.equal(request.calls[0].path, '/products?q=blue%20mug')
})
