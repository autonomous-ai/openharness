import assert from 'node:assert/strict'
import { test } from 'node:test'
import { check } from '../src/check.js'

const TARGET = 'https://status.shop.invalid/health'

function answering(status) {
  return async () => ({ status })
}

test('a 200 is up', async () => {
  assert.deepEqual(await check(TARGET, { fetch: answering(200) }), { up: true, status: 200 })
})

test('a 404 is the site answering', async () => {
  assert.equal((await check(TARGET, { fetch: answering(404) })).up, true)
})

test('a 503 is down', async () => {
  assert.deepEqual(await check(TARGET, { fetch: answering(503) }), { up: false, status: 503 })
})

test('a network error is down', async () => {
  const refused = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  }
  assert.deepEqual(await check(TARGET, { fetch: refused }), { up: false, status: null, error: 'ECONNREFUSED' })
})
