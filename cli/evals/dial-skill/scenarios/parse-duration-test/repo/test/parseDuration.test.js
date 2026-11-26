import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDuration } from '../src/parseDuration.js'

test('reads milliseconds', () => {
  assert.equal(parseDuration('250ms'), 250)
})

test('reads seconds', () => {
  assert.equal(parseDuration('30s'), 30_000)
})

test('reads minutes', () => {
  assert.equal(parseDuration('5m'), 300_000)
})

test('ignores surrounding spaces', () => {
  assert.equal(parseDuration(' 5m '), 300_000)
})

test('rejects text without a unit', () => {
  assert.throws(() => parseDuration('90'), /invalid duration/)
})
