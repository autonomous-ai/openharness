import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { buildReport, renderReport } from '../src/report.js'

function cli(...args) {
  return spawnSync(process.execPath, ['src/cli.js', ...args], { encoding: 'utf8' })
}

test('the report sums orders and revenue per region', () => {
  assert.deepEqual(buildReport(), [
    { region: 'North', orders: 2, cents: 173050 },
    { region: 'South', orders: 1, cents: 99900 },
    { region: 'East', orders: 3, cents: 253075 },
    { region: 'West', orders: 1, cents: 61200 },
  ])
})

test('--region keeps one region', () => {
  assert.deepEqual(buildReport({ region: 'East' }), [{ region: 'East', orders: 3, cents: 253075 }])
})

test('the table aligns numbers right', () => {
  assert.equal(
    renderReport(buildReport({ region: 'North' })),
    ['Region  Orders  Revenue', '------  ------  -------', 'North        2  1730.50'].join('\n'),
  )
})

test('report prints the table', () => {
  const run = cli('report', '--region', 'West')
  assert.equal(run.status, 0)
  assert.match(run.stdout, /^West\s+1\s+612\.00$/m)
})

test('report refuses an unknown option', () => {
  const run = cli('report', '--csv')
  assert.equal(run.status, 2)
  assert.match(run.stderr, /unknown option --csv/)
})
