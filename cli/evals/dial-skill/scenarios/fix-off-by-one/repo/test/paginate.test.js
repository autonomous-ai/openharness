import assert from 'node:assert/strict'
import { test } from 'node:test'
import { paginate } from '../src/paginate.js'

const items = [1, 2, 3, 4, 5, 6, 7]

test('the first page holds the first items', () => {
  assert.deepEqual(paginate(items, 1, 3).items, [1, 2, 3])
})

test('the last page holds the rest', () => {
  assert.deepEqual(paginate(items, 3, 3).items, [7])
})

test('counts the pages', () => {
  assert.equal(paginate(items, 1, 3).totalPages, 3)
})
