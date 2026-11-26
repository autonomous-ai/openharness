import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slugify } from '../src/slug.js'

test('lowercases and joins words with dashes', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world')
})

test('drops accents', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee')
})
