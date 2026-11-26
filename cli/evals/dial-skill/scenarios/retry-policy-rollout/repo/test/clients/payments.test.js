import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPaymentsClient } from '../../src/clients/payments.js'
import { fakeRequest } from '../fake.js'

test('getCharge returns the charge after a 503', async () => {
  const request = fakeRequest(503, { id: 'ch_1', status: 'succeeded' })
  assert.deepEqual(await createPaymentsClient(request).getCharge('ch_1'), { id: 'ch_1', status: 'succeeded' })
  assert.equal(request.calls.length, 2)
})

test('listRefunds returns the items of the page', async () => {
  const request = fakeRequest({ items: [{ id: 're_1', amountCents: 500 }] })
  assert.deepEqual(await createPaymentsClient(request).listRefunds('ch_1'), [{ id: 're_1', amountCents: 500 }])
  assert.equal(request.calls[0].path, '/charges/ch_1/refunds')
})

test('charge posts the amount', async () => {
  const request = fakeRequest({ id: 'ch_2', status: 'succeeded' })
  assert.deepEqual(await createPaymentsClient(request).charge('c3', 4200, 'EUR'), { id: 'ch_2', status: 'succeeded' })
  assert.deepEqual(request.calls, [{ method: 'POST', path: '/charges', body: { customerId: 'c3', amountCents: 4200, currency: 'EUR' } }])
})
