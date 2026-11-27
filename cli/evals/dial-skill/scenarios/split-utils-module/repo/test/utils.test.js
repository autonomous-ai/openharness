import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addDays, applyDiscount, daysBetween, formatCents, formatDate, slugify, sumCents, titleCase, truncate } from '../src/utils.js'

test('slugify drops accents and punctuation', () => {
  assert.equal(slugify('  Café Mug, Large! '), 'cafe-mug-large')
})

test('titleCase capitalizes each word', () => {
  assert.equal(titleCase('linen APRON'), 'Linen Apron')
})

test('truncate keeps short text and cuts long text', () => {
  assert.equal(truncate('mug', 5), 'mug')
  assert.equal(truncate('walnut board', 6), 'walnu…')
})

test('dates are UTC days', () => {
  const day = new Date('2026-03-30T12:00:00Z')
  assert.equal(formatDate(addDays(day, 3)), '2026-04-02')
  assert.equal(daysBetween(day, new Date('2026-04-29T12:00:00Z')), 30)
})

test('money is whole cents', () => {
  assert.equal(formatCents(5899), '$58.99')
  assert.equal(formatCents(-5), '-$0.05')
  assert.equal(sumCents([1450, 3200]), 4650)
  assert.equal(applyDiscount(3200, 10), 2880)
})
