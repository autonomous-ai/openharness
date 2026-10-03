import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleRows, memory, number, age, storageTotal, sumReading, formatValue } from '../viewer/table.js'
const rows = [
  { id: 'm1/a', name: 'Agent 10', cpu: 5, activity: 'working', live: true, branch: 'fix/hello', machine: 'office' },
  { id: 'm2/a', name: 'Agent 2', cpu: 0, activity: 'idle', live: true, branch: 'main', machine: 'studio' },
  { id: 'm1/b', name: 'Unknown', cpu: null, activity: 'unknown', live: true, branch: 'main', machine: 'office' },
]
test('sort is stable, numeric and keeps unknown measurements last in either direction', () => {
  assert.deepEqual(visibleRows(rows, { filter: 'all', sort: 'cpu', direction: -1 }).map(r => r.cpu), [5, 0, null])
  assert.deepEqual(visibleRows(rows, { filter: 'all', sort: 'cpu', direction: 1 }).map(r => r.cpu), [0, 5, null])
  assert.deepEqual(visibleRows(rows, { filter: 'all', sort: 'name', direction: 1 }).map(r => r.name), ['Agent 2', 'Agent 10', 'Unknown'])
  assert.equal(rows[0].name, 'Agent 10')
})
test('search matches metadata and combines with plain status filters', () => {
  assert.equal(visibleRows(rows, { query: 'HELLO' })[0].id, 'm1/a')
  assert.equal(visibleRows(rows, { query: 'office', filter: 'unknown' })[0].id, 'm1/b')
  assert.equal(visibleRows(rows, { query: 'office', filter: 'idle' }).length, 0)
})
test('formatters distinguish zero from unknown and handle future timestamps', () => {
  assert.equal(memory(null), '—'); assert.equal(memory(0), '0 MB')
  assert.equal(number(null), '—'); assert.equal(number(0), '0')
  assert.equal(age(null), '—'); assert.equal(age(1100, 1000), 'now')
})

test('every filter excludes saved history, exited processes and cached offline sessions', () => {
  const history = { id: 'saved', name: 'Old', state: 'stopped', activity: 'stopped', live: false }
  const closed = [history, { ...rows[0], id: 'offline', online: false },
    { ...rows[1], id: 'exited', state: 'gone', live: false },
    { ...history, id: 'stale-live-flag', live: true },
    { ...rows[0], id: 'offline-state', state: 'offline' }]
  assert.deepEqual(visibleRows([...rows, ...closed]).map(r => r.id).sort(), ['m1/a', 'm1/b', 'm2/a'])
  for (const filter of ['all', 'working', 'idle', 'offline']) {
    assert.equal(visibleRows(closed, { filter }).length, 0)
  }
  assert.equal(visibleRows([...rows, ...closed], { query: 'Old' }).length, 0)
  assert.equal(visibleRows(rows, { machine: 'missing' }).length, 0)
})
test('idle, completed, waiting, failed and starting harnesses remain until they close', () => {
  const open = ['working', 'idle', 'done', 'needsInput', 'failed', 'starting', 'unknown'].map(activity => ({
    id: activity, live: true, state: activity === 'starting' ? 'starting' : 'running', activity, cpu: 0,
  }))
  assert.equal(visibleRows(open).length, open.length)
  for (const row of open) assert.deepEqual(visibleRows(open, { filter: row.activity }), [row])
  open[1] = { ...open[1], state: 'stopped', activity: 'stopped', live: false }
  assert.equal(visibleRows(open).length, open.length - 1)
})
test('shared and nested workspace paths count once on each owning machine', () => {
  const row = (machineId, workspacePath, workspaceBytes) => ({ machineId, workspacePath, workspaceBytes })
  assert.deepEqual(storageTotal([row('m', '/a', 100), row('m', '/a', 100), row('m', '/a/b', 50), row('m', '/abc', 25), row('n', '/a', 100)]), { value: 225, partial: false })
  assert.deepEqual(storageTotal([row('m', '/a', 100), row('m', '/other', null)]), { value: 100, partial: true })
  assert.deepEqual(sumReading([{ cpu: null }, { cpu: 0 }], 'cpu'), { value: 0, partial: true })
  assert.deepEqual(sumReading([{ cpu: null }], 'cpu'), { value: null, partial: true })
  assert.equal(formatValue('rssBytes', 10.4e9), '10 GB')
  assert.equal(formatValue('cpu', 126.4), '126%')
})

test('stopped filter makes saved harnesses available for permanent deletion', () => {
  const saved = { id: 'saved', name: 'History', state: 'stopped', activity: 'stopped', live: false }
  assert.deepEqual(visibleRows([...rows, saved], { filter: 'stopped' }), [saved])
  assert.deepEqual(visibleRows([{ ...saved, online: false }], { filter: 'stopped' }), [])
})
