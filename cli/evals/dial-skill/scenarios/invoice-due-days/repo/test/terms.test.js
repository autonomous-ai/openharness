import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PLANS } from '../src/plans.js'
import { dueDate, netDays } from '../src/terms.js'

test('a team invoice is due thirty days after it is issued', () => {
  assert.equal(dueDate('team', '2026-11-30'), '2026-12-30')
})

for (const { id } of PLANS) {
  test(`${id}: has payment terms of a whole number of days`, () => {
    const days = netDays(id)
    assert.ok(Number.isInteger(days) && days > 0)
  })
}
