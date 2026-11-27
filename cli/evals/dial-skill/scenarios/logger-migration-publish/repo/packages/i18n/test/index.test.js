import assert from 'node:assert/strict'
import { test } from 'node:test'
import { translate } from '../src/index.js'

const messages = { en: { hello: 'Hello', bye: 'Bye' }, vi: { hello: 'Xin chào' } }

test('uses the locale own message', () => {
  assert.equal(translate(messages, 'vi', 'hello'), 'Xin chào')
})

test('falls back to English', () => {
  assert.equal(translate(messages, 'vi', 'bye'), 'Bye')
})

test('returns the key when no locale has it', () => {
  assert.equal(translate(messages, 'vi', 'thanks'), 'thanks')
})
