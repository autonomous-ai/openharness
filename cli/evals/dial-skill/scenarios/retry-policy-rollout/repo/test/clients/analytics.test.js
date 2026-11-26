import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAnalyticsClient } from '../../src/clients/analytics.js'
import { fakeRequest } from '../fake.js'

const RANGE = { from: '2026-11-01', to: '2026-11-07' }

test('getReport returns the report once the rebuild is over', async () => {
  const request = fakeRequest(404, 503, { rows: [3, 5] })
  assert.deepEqual(await createAnalyticsClient(request).getReport('weekly sales', RANGE), { rows: [3, 5] })
  assert.equal(request.calls[0].path, '/reports/weekly%20sales?from=2026-11-01&to=2026-11-07')
  assert.equal(request.calls.length, 3)
})

test('getReport gives up when the service stays down', async () => {
  const request = fakeRequest(500)
  await assert.rejects(createAnalyticsClient(request).getReport('weekly', RANGE), { status: 500 })
  assert.ok(request.calls.length > 1)
})
