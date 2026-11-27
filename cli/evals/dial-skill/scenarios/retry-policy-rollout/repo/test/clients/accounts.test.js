import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAccountsClient } from '../../src/clients/accounts.js'
import { fakeRequest } from '../fake.js'

test('getAccount returns the account after a 503', async () => {
  const request = fakeRequest(503, { id: 'a1', name: 'Ada' })
  assert.deepEqual(await createAccountsClient(request).getAccount('a1'), { id: 'a1', name: 'Ada' })
  assert.deepEqual(request.calls.map((c) => c.path), ['/accounts/a1', '/accounts/a1'])
})

test('getProfile throws a 404 without trying again', async () => {
  const request = fakeRequest(404)
  await assert.rejects(createAccountsClient(request).getProfile('a9'), { status: 404 })
  assert.equal(request.calls.length, 1)
})

test('getAccount gives up when the service stays down', async () => {
  const request = fakeRequest(502)
  await assert.rejects(createAccountsClient(request).getAccount('a1'), { status: 502 })
  assert.ok(request.calls.length > 1)
})
