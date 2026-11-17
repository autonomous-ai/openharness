import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { connect } from '../../src/db.js'

const config = JSON.parse(readFileSync(new URL('../../config/test.json', import.meta.url), 'utf8'))

test('the orders test database accepts connections', async () => {
  const socket = await connect(config.database)
  socket.end()
})
