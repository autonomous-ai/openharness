import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countWords } from '../src/count.js'

test('counts words split by any whitespace', () => {
  assert.equal(countWords('one two\nthree\tfour'), 4)
})

test('an empty text has no words', () => {
  assert.equal(countWords('  \n'), 0)
})
