import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getUser } from '../src/users/index.js'

test('getUser returns the user', async () => {
  assert.equal((await getUser('u1')).name, 'Ada')
})

test('getUser returns a copy', async () => {
  const user = await getUser('u1')
  user.name = 'changed'
  assert.equal((await getUser('u1')).name, 'Ada')
})

test('getUser throws for an unknown id', async () => {
  await assert.rejects(getUser('nobody'), /no user nobody/)
})
