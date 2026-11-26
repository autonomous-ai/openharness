import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accept } from '../src/index.js'

test('accepts a small image', () => {
  assert.equal(accept({ name: 'cat.PNG', size: 2048 }), true)
})

test('rejects a file too large', () => {
  assert.equal(accept({ name: 'scan.pdf', size: 6 * 1024 * 1024 }), false)
})

test('rejects a type not allowed', () => {
  assert.equal(accept({ name: 'run.exe', size: 2048 }), false)
})
