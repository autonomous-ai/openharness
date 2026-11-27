import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getUser } from '../src/users.js'

test('getUser returns the user', async () => {
  assert.equal((await getUser('u1')).name, 'Ada Park')
})

test('getUser throws for an unknown id', async () => {
  await assert.rejects(getUser('nope'), /not found/)
})
