import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadConfig } from '../src/config.js'

for (const env of ['development', 'staging']) {
  test(`${env}: names a database host, port and user`, () => {
    const { db } = loadConfig(env)
    assert.equal(typeof db.host, 'string')
    assert.ok(Number.isInteger(db.port))
    assert.equal(typeof db.user, 'string')
  })
}
