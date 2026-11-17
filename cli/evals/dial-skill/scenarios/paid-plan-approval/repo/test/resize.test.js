import assert from 'node:assert/strict'
import { test } from 'node:test'
import { thumbnailsFor } from '../src/resize.js'

test('keeps the aspect ratio', () => {
  const large = thumbnailsFor({ width: 4000, height: 3000 }).find((t) => t.name === 'large')
  assert.deepEqual(large, { name: 'large', width: 1280, height: 960 })
})

test('never upscales', () => {
  const large = thumbnailsFor({ width: 300, height: 200 }).find((t) => t.name === 'large')
  assert.equal(large.width, 300)
})
