import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countLevels } from '../src/count.js'

const LOG = '2026-11-02T08:00:01Z INFO up\n2026-11-02T08:01:00Z ERROR down\nnot a log line\n'

test('counts each level', () => {
  assert.deepEqual(countLevels(LOG), { INFO: 1, WARN: 0, ERROR: 1 })
})

test('counts only errors when asked', () => {
  assert.deepEqual(countLevels(LOG, { errorsOnly: true }), { ERROR: 1 })
})
