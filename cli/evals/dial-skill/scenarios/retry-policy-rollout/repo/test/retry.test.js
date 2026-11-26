import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HttpError } from '../src/http.js'
import { withRetry } from '../src/retry.js'

function failing(...statuses) {
  let calls = 0
  const fn = async () => {
    const status = statuses[calls++]
    if (status === undefined) return 'ok'
    throw new HttpError(status, `status ${status}`)
  }
  fn.calls = () => calls
  return fn
}

test('returns once a transient failure passes', async () => {
  const fn = failing(503, 429)
  assert.equal(await withRetry(fn), 'ok')
  assert.equal(fn.calls(), 3)
})

test('throws a client error at once', async () => {
  const fn = failing(404)
  await assert.rejects(withRetry(fn), { status: 404 })
  assert.equal(fn.calls(), 1)
})

test('gives up after its attempts', async () => {
  const fn = failing(500, 500, 500, 500)
  await assert.rejects(withRetry(fn, { attempts: 2, baseMs: 1 }), { status: 500 })
  assert.equal(fn.calls(), 2)
})

test('retries what retryOn allows', async () => {
  const fn = failing(404)
  assert.equal(await withRetry(fn, { retryOn: () => true, baseMs: 1 }), 'ok')
})
