import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slug } from '../src/slug.js'

test('lowercases and joins words with dashes', () => {
  assert.equal(slug('Hello, World!'), 'hello-world')
})

test('drops accents', () => {
  assert.equal(slug('Crème brûlée'), 'creme-brulee')
})
