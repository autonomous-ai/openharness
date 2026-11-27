import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { pushBatch } from '../src/gateway.js'

const config = JSON.parse(readFileSync(new URL('../config/test.json', import.meta.url), 'utf8'))

test('the staging gateway accepts a batch', async () => {
  await pushBatch([{ team: 'eval', bytes: 1024, at: '2026-11-17T00:00:00Z' }], config.gateway)
})
