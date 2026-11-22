import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const CLI = new URL('../src/cli.js', import.meta.url).pathname

function contacts(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
}

test('find matches any field, ignoring case', () => {
  assert.equal(contacts('find', 'BOSTON').stdout, 'Margaret Hamilton <margaret@example.invalid>, Boston\n')
})

test('export writes JSON by default', () => {
  assert.equal(JSON.parse(contacts('export').stdout).length, 5)
})

test('export refuses a format it does not know', () => {
  assert.equal(contacts('export', '--format', 'xml').status, 2)
})
