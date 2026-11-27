import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLoyaltyClient } from '../../src/clients/loyalty.js'
import { fakeRequest } from '../fake.js'

test('getPoints returns the points after a restart', async () => {
  const request = fakeRequest(503, { points: 320 })
  assert.equal(await createLoyaltyClient(request).getPoints('m7'), 320)
  assert.equal(request.calls.length, 2)
})

test('getPoints throws a 404 without trying again', async () => {
  const request = fakeRequest(404)
  await assert.rejects(createLoyaltyClient(request).getPoints('m0'), { status: 404 })
  assert.equal(request.calls.length, 1)
})
