import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatBytes } from '../src/format.js'

test('keeps small sizes in bytes', () => {
  assert.equal(formatBytes(512), '512 B')
})

test('uses binary units', () => {
  assert.equal(formatBytes(1536), '1.5 KiB')
  assert.equal(formatBytes(5 * 1024 ** 3), '5 GiB')
})
