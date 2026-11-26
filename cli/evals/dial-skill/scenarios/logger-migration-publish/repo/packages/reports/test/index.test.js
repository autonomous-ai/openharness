import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toCsv } from '../src/index.js'

test('writes a header and one line per row', () => {
  assert.equal(toCsv([{ id: 1, name: 'Ana' }, { id: 2 }]), 'id,name\n1,"Ana"\n2,""')
})

test('writes nothing for no rows', () => {
  assert.equal(toCsv([]), '')
})
