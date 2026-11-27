import assert from 'node:assert/strict'
import { test } from 'node:test'
import { invoiceFor } from '../src/services/billing.js'
import { welcomeMail } from '../src/services/notifications.js'

test('a pro member is billed 12.00', async () => {
  assert.deepEqual(await invoiceFor('u1'), { to: 'ada@example.invalid', cents: 1200 })
})

test('the welcome mail greets by name', async () => {
  assert.equal((await welcomeMail('u2')).subject, 'Welcome, Linus')
})
