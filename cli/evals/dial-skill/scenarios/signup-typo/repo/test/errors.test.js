import assert from 'node:assert/strict'
import { test } from 'node:test'
import { errorFor, errors } from '../src/errors.js'

test('every message is a full sentence', () => {
  for (const message of Object.values(errors)) assert.match(message, /^[A-Z].*\.$/)
})

test('an unknown page gets the generic message', () => {
  assert.equal(errorFor('billing'), 'Something went wrong. Please try again.')
})
