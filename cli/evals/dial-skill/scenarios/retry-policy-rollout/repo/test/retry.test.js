import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withRetry } from '../src/retry.js'
import { fakeRequest } from './fake.js'

test('returns once a transient failure passes', async () => {
  const request = fakeRequest(503, 429, { ok: true })
  assert.deepEqual(await withRetry(request)('GET', '/status'), { ok: true })
  assert.equal(request.calls.length, 3)
})

test('throws a client error at once', async () => {
  const request = fakeRequest(404)
  await assert.rejects(withRetry(request)('GET', '/status'), { status: 404 })
  assert.equal(request.calls.length, 1)
})

test('gives up after its attempts', async () => {
  const request = fakeRequest(500)
  await assert.rejects(withRetry(request, { attempts: 2, baseMs: 1 })('GET', '/status'), { status: 500 })
  assert.equal(request.calls.length, 2)
})

test('retries what retryOn allows', async () => {
  const request = fakeRequest(404, { ok: true })
  assert.deepEqual(await withRetry(request, { retryOn: () => true, baseMs: 1 })('GET', '/status'), { ok: true })
})

test('retries a POST that carries an Idempotency-Key', async () => {
  const request = fakeRequest(503, { ok: true })
  assert.deepEqual(await withRetry(request, { baseMs: 1 })('POST', '/jobs', {}, { 'Idempotency-Key': 'k-1' }), { ok: true })
  assert.equal(request.calls.length, 2)
})

test('refuses a POST without an Idempotency-Key unless it is sent once', async () => {
  const request = fakeRequest({ ok: true })
  await assert.rejects(withRetry(request)('POST', '/jobs', {}), /Idempotency-Key/)
  assert.deepEqual(await withRetry(request, { attempts: 1 })('POST', '/jobs', {}), { ok: true })
  assert.equal(request.calls.length, 1)
})
