import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memberList } from '../src/routes/admin.js'
import { profile } from '../src/routes/profile.js'

test('a profile shows the name and plan', async () => {
  assert.deepEqual(await profile('u2'), { name: 'Linus', plan: 'free' })
})

test('the member list has every user', async () => {
  assert.deepEqual(await memberList(), ['Ada <ada@example.invalid> pro', 'Linus <linus@example.invalid> free'])
})
