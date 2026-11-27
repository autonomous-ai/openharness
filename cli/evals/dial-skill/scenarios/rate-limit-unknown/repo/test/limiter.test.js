import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLimiter } from '../src/limiter.js'

test('allows up to the limit in one minute, then refuses', () => {
  const allow = createLimiter({ globex: { rate_limit: 2 } }, () => 0)
  assert.deepEqual([allow('globex'), allow('globex'), allow('globex')], [true, true, false])
})

test('starts a fresh window each minute', () => {
  let t = 0
  const allow = createLimiter({ globex: { rate_limit: 1 } }, () => t)
  assert.equal(allow('globex'), true)
  t = 60_000
  assert.equal(allow('globex'), true)
})
