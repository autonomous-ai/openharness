import assert from 'node:assert/strict'
import { test } from 'node:test'
import { search } from '../src/index.js'

test('finds items holding the query, ignoring case and spaces', () => {
  assert.deepEqual(search(['Apple pie', 'Banana', 'apple juice'], '  APPLE '), ['Apple pie', 'apple juice'])
})

test('finds nothing for a query no item holds', () => {
  assert.deepEqual(search(['Banana'], 'kiwi'), [])
})
