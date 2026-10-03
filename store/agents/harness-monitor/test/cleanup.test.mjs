import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanupReviews, closeHidden, previewCleanup } from '../lib/cleanup.mjs'

const agent = { agentId: 'a', sessionId: 'conversation', createdAt: '2026-09-01T00:00:00.000Z', name: 'Same name', activity: 'unknown' }
const reportMachines = async () => ({ machines: [{ machineId: 'one', name: 'Office', current: true, online: true },
  { machineId: 'two', name: 'Laptop', online: true }, { machineId: 'offline', name: 'Offline', online: false }] })
test('preview only reads; identical IDs on different machines stay distinct, and offline machines are reported', async () => {
  const calls = []
  const plan = await previewCleanup({ reportMachines, rpc: async (machine, type) => {
    calls.push([machine, type]); return { version: 1, agents: [agent], kept: 3 }
  } })
  assert.deepEqual(calls, [['one', 'agents_cleanup_preview'], ['two', 'agents_cleanup_preview']])
  assert.equal(plan.rows.length, 2); assert.notEqual(plan.rows[0].id, plan.rows[1].id)
  assert.equal(plan.kept, 6); assert.match(plan.problems[0].error, /Offline/)
})
test('unsupported, unreadable and malformed previews never become close targets', async () => {
  for (const reply of [{}, { version: 1, agents: [{ ...agent, createdAt: null }] }]) {
    const plan = await previewCleanup({ reportMachines, rpc: async () => reply })
    assert.deepEqual(plan.rows, []); assert.equal(plan.problems.length, 3)
  }
  await assert.rejects(previewCleanup({ reportMachines: async () => ({ error: 'Unavailable' }) }), /Unavailable/)
})
test('close carries the reviewed conversation and requires the owner’s open-tab guard', async () => {
  const row = { ...agent, id: 'one/a', machineId: 'one' }, calls = []
  const result = await closeHidden(row, { rpc: async (...args) => { calls.push(args); return { closed: true } } })
  assert.equal(result.ok, true)
  assert.deepEqual(calls[0].slice(0, 3), ['one', 'agent_close', { agentId: 'a', sessionId: 'conversation',
    createdAt: agent.createdAt, mode: 'now', onlyIfHidden: true }])
})
test('a lost close reply is uncertain and is never automatically retried', async () => {
  let calls = 0
  const result = await closeHidden({ ...agent, machineId: 'one' }, { rpc: async () => { calls++; throw new Error('Connection lost') } })
  assert.equal(calls, 1); assert.equal(result.ok, false); assert.match(result.detail, /Connection lost/)
})
test('only reviewed rows can close; duplicate clicks join, and expired reviews require a new preview', async () => {
  let now = 0, calls = 0
  const reviews = cleanupReviews({ now: () => now, preview: async () => ({ rows: [{ ...agent, id: 'reviewed' }] }),
    close: async row => { calls++; return { ok: true, id: row.id } } })
  const plan = await reviews.preview()
  await assert.rejects(reviews.close(plan.reviewId, 'forged'), /Refresh/)
  const results = await Promise.all([reviews.close(plan.reviewId, 'reviewed'), reviews.close(plan.reviewId, 'reviewed')])
  assert.equal(calls, 1); assert.deepEqual(results[0], results[1])
  now = 31 * 60_000
  await assert.rejects(reviews.close(plan.reviewId, 'reviewed'), /Refresh/)
})
