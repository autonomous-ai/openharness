import assert from 'node:assert/strict'
import { test } from 'node:test'
import { send } from '../src/index.js'

test('sends to an address', () => {
  assert.equal(send('ana@example.invalid', 'Welcome'), true)
})

test('skips what is not an address', () => {
  assert.equal(send('ana', 'Welcome'), false)
})
