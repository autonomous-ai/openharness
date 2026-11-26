import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMailerClient } from '../../src/clients/mailer.js'
import { fakeRequest } from '../fake.js'

const MESSAGE = { to: 'ada@example.invalid', subject: 'Your order shipped', text: 'It is on its way.' }

test('send goes through after a 429', async () => {
  const request = fakeRequest(429, 429, { id: 'msg-1' })
  assert.deepEqual(await createMailerClient(request).send(MESSAGE), { id: 'msg-1' })
  assert.deepEqual(request.calls[2].body, MESSAGE)
  assert.equal(request.calls.length, 3)
})

test('send throws a 422 without trying again', async () => {
  const request = fakeRequest(422)
  await assert.rejects(createMailerClient(request).send(MESSAGE), { status: 422 })
  assert.equal(request.calls.length, 1)
})
