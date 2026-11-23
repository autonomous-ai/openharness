import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const CLI = new URL('../src/cli.js', import.meta.url).pathname

function notes(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
}

function lines(stdout) {
  return stdout.split('\n').filter((line) => line.startsWith('#'))
}

test('show prints one note', () => {
  assert.equal(notes('show', '2').stdout, '#2  [ ] Renew passport\n')
})

test('--open leaves out the notes that are done', () => {
  assert.ok(lines(notes('list', '--open').stdout).every((line) => line.includes('[ ]')))
})

test('an unknown option exits 2', () => {
  assert.equal(notes('list', '--all').status, 2)
})
