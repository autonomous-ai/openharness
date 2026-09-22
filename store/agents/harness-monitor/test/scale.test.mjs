import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CEIL, FLOOR, PAUSE_STEPS, HIDE_STEPS, bytes, humanIdle as pageIdle, idleOfX, parseDuration, snap, xOf } from '../viewer/scale.js'
import { humanIdle as cliIdle } from '../lib/policy.mjs'
import { DAY, HOUR } from './fixtures.mjs'

test('now is the right edge and a month ago is the left', () => {
  assert.equal(xOf(0), 1)
  assert.equal(xOf(FLOOR), 1)
  assert.equal(xOf(CEIL), 0)
  assert.equal(xOf(CEIL * 10), 0)
})

test('the scale is monotonic and its inverse round-trips', () => {
  let previous = 1
  for (const idle of [FLOOR, 10 * 60_000, HOUR, 6 * HOUR, DAY, 7 * DAY, 30 * DAY]) {
    const x = xOf(idle)
    assert.ok(x <= previous, `${idle} should sit left of the one before it`)
    previous = x
    assert.ok(Math.abs(idleOfX(x) - idle) / idle < 1e-9)
  }
})

test('a dragged rule lands on a threshold a person would type', () => {
  assert.equal(snap(4.2 * HOUR, PAUSE_STEPS), '4h')
  assert.equal(snap(70 * 60_000, PAUSE_STEPS), '1h')
  assert.equal(snap(13 * DAY, HIDE_STEPS), '14d')
  assert.equal(snap(1, PAUSE_STEPS), '15m')
  assert.equal(snap(99 * DAY, HIDE_STEPS), '30d')
})

test('the pane and the terminal say the same thing about an idle time', () => {
  for (const ms of [0, 30_000, 5 * 60_000, HOUR, 5 * HOUR, DAY, 3 * DAY, 15 * DAY, 400 * DAY]) {
    assert.equal(pageIdle(ms), cliIdle(ms), `disagreed at ${ms}ms`)
  }
})

test('durations and bytes read the way the columns need them', () => {
  assert.equal(parseDuration('4h'), 4 * HOUR)
  assert.equal(parseDuration('nonsense'), 0)
  assert.equal(bytes(0), '—')
  assert.equal(bytes(400 * 1024 * 1024), '400M')
  assert.equal(bytes(2 * 1024 ** 3), '2.0G')
})
