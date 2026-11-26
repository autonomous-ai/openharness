import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNotificationsClient } from '../../src/clients/notifications.js'
import { fakeRequest } from '../fake.js'

test('preferences returns them after a 502', async () => {
  const request = fakeRequest(502, { email: true, push: false })
  assert.deepEqual(await createNotificationsClient(request).preferences('u1'), { email: true, push: false })
  assert.equal(request.calls[0].path, '/users/u1/notification-preferences')
  assert.equal(request.calls.length, 2)
})

test('devices throws a 401 without trying again', async () => {
  const request = fakeRequest(401)
  await assert.rejects(createNotificationsClient(request).devices('u1'), { status: 401 })
  assert.equal(request.calls.length, 1)
})

test('devices gives up when the service stays down', async () => {
  const request = fakeRequest(503)
  await assert.rejects(createNotificationsClient(request).devices('u1'), { status: 503 })
  assert.ok(request.calls.length > 1)
})
