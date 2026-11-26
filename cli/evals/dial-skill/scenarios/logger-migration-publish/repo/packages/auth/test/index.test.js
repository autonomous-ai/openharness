import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isExpired, parseClaims } from '../src/index.js'

const token = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

test('reads the claims of a token', () => {
  assert.deepEqual(parseClaims(token({ sub: 'u1', exp: 100 })), { sub: 'u1', exp: 100 })
})

test('returns null for a token it cannot read', () => {
  assert.equal(parseClaims('not-a-token'), null)
})

test('tells an expired token from a live one', () => {
  assert.equal(isExpired({ sub: 'u1', exp: 100 }, 200_000), true)
  assert.equal(isExpired({ sub: 'u1', exp: 300 }, 200_000), false)
})
