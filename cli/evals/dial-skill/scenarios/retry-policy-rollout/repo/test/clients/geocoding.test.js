import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGeocodingClient } from '../../src/clients/geocoding.js'
import { fakeRequest } from '../fake.js'

test('lookup returns the place after two 503s', async () => {
  const request = fakeRequest(503, 503, { lat: 52.52, lon: 13.4 })
  assert.deepEqual(await createGeocodingClient(request).lookup('Alexanderplatz 1'), { lat: 52.52, lon: 13.4 })
  assert.equal(request.calls[0].path, '/geocode?q=Alexanderplatz%201')
  assert.equal(request.calls.length, 3)
})

test('lookup throws a 400 without trying again', async () => {
  const request = fakeRequest(400)
  await assert.rejects(createGeocodingClient(request).lookup(''), { status: 400 })
  assert.equal(request.calls.length, 1)
})
