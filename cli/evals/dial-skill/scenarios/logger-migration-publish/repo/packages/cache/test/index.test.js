import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCache } from '../src/index.js'

test('returns what was set', () => {
  const cache = createCache(2)
  cache.set('a', 1)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('b'), undefined)
})

test('evicts the oldest entry past its limit', () => {
  const cache = createCache(2)
  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('c', 3)
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('c'), 3)
})
