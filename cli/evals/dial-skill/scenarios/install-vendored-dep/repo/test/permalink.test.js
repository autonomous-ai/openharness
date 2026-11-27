import assert from 'node:assert/strict'
import { test } from 'node:test'
import { permalink } from '../src/permalink.js'

test('a permalink is the year and the slug of the title', () => {
  assert.equal(permalink({ date: '2026-03-14', title: 'Pi Day, Again!' }), '/2026/pi-day-again')
})

test('accents are dropped from the slug', () => {
  assert.equal(permalink({ date: '2025-12-01', title: 'Crème Brûlée' }), '/2025/creme-brulee')
})
