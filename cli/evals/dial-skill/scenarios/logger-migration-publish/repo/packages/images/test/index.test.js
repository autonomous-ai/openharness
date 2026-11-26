import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fit } from '../src/index.js'

test('scales a wide image down to the box', () => {
  assert.deepEqual(fit(1000, 500, 200), { width: 200, height: 100 })
})

test('leaves a small image as it is', () => {
  assert.deepEqual(fit(50, 40, 200), { width: 50, height: 40 })
})
