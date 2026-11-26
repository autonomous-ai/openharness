import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextRun } from '../src/index.js'

test('runs again after the interval', () => {
  const next = nextRun(15, new Date('2026-01-01T10:00:00Z'))
  assert.equal(next.toISOString(), '2026-01-01T10:15:00.000Z')
})

test('refuses an interval under a minute', () => {
  assert.throws(() => nextRun(0, new Date()), RangeError)
})
