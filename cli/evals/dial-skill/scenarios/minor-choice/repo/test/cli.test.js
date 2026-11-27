import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const LOG = new URL('./fixtures/app.log', import.meta.url).pathname
const CLI = new URL('../src/cli.js', import.meta.url).pathname

function logstat(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
}

test('prints a table by default', () => {
  assert.equal(logstat(LOG).stdout, 'LEVEL  COUNT\nINFO   3\nWARN   1\nERROR  2\n')
})

test('--csv prints CSV', () => {
  assert.equal(logstat('--csv', LOG).stdout, 'level,count\nINFO,3\nWARN,1\nERROR,2\n')
})

test('--no-header leaves out the header', () => {
  assert.equal(logstat('--csv', '--no-header', '--errors-only', LOG).stdout, 'ERROR,2\n')
})

test('an unknown option exits 2', () => {
  assert.equal(logstat('--yaml', LOG).status, 2)
})
