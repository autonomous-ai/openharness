import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stop, open, previewDelete, deleteHarness, worktreeAction, inspectWorkspace } from '../lib/actions.mjs'
import { mergeRows } from '../lib/inventory.mjs'
import { frame } from './fixtures.mjs'
const observed = Date.now()
const agent = extra => frame({ createdAt: new Date(observed - 1000).toISOString(), updatedAt: observed, resumeMode: 'conversation', monitor: { activity: 'idle', activityKnown: true }, ...extra })
const row = extra => mergeRows([agent(extra)], { machine: { machineId: 'remote', name: 'Office' }, local: false })[0]
const intent = async () => ({ creationId: 'same-operation', path: '/fixture', existing: false })
const clearIntent = async () => {}

test('deletion binds the review to the owning daemon and never retries a lost response', async () => {
  const selected = row(), calls = []
  const rpc = async (...args) => { calls.push(args); return { reviewId: 'reviewed', sessionBytes: 4096, choices: { sessionData: { available: true }, worktreeData: { available: false } } } }
  assert.equal((await previewDelete(selected, { list: async () => [agent()], rpc })).reviewId, 'reviewed')
  assert.deepEqual(calls[0], ['remote', 'agent_purge', { agentId: selected.agentId, sessionId: selected.sessionId, createdAt: selected.createdAt, mode: 'inspect', includeWorktree: true }])
  const lost = async (...args) => { calls.push(args); throw new Error('connection lost') }
  assert.equal((await deleteHarness(selected, { rpc: lost })).ok, false)
  assert.equal(calls.length, 1)
  const result = await deleteHarness(selected, { reviewId: 'reviewed', choices: { sessionData: true, worktreeData: false }, rpc: lost })
  assert.equal(result.ok, false); assert.match(result.detail, /never retried/)
  assert.equal(calls.length, 2)
  assert.equal(calls[1][2].reviewId, 'reviewed')
  await worktreeAction(selected, { reviewId: 'tree', path: '/exact/path', discardChanges: true, rpc: lost })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[2], ['remote', 'agent_worktree_delete', { agentId: selected.agentId, sessionId: selected.sessionId, createdAt: selected.createdAt, mode: 'delete', reviewId: 'tree', path: '/exact/path', discardChanges: true }])
})

test('remote stop uses daemon identity, never a signal or tmux command', async () => {
  const calls = []
  const result = await stop(row(), { list: async () => [agent()], rpc: async (...args) => { calls.push(args); return { deleted: true } } })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [['remote', 'agent_delete', { agentId: 'a1', expectedSessionId: 's1' }]])
})
test('cleanup rechecks live questions, working and unknown activity', async () => {
  for (const activity of ['needsInput', 'working', null]) {
    let wrote = false
    const result = await stop(row(), { list: async () => [agent({ monitor: activity ? { activity, activityKnown: true } : null })], rpc: async () => { wrote = true } })
    assert.equal(result.ok, false); assert.equal(wrote, false)
  }
})
test('explicit single stop can stop work; self and rotated sessions remain protected', async () => {
  assert.equal((await stop(row(), { force: true, list: async () => [agent({ monitor: { activity: 'working', activityKnown: true } })], rpc: async () => ({ deleted: true }) })).ok, true)
  for (const changed of [{ sessionId: 'another-conversation' }, { dsh: 'autonomous/harness-monitor' }]) {
    let wrote = false
    assert.equal((await stop(row(), { force: true, list: async () => [agent(changed)], rpc: async () => { wrote = true } })).ok, false)
    assert.equal(wrote, false)
  }
})
test('a lost stop reply is uncertain, not retried', async () => {
  let writes = 0
  const result = await stop(row(), { list: async () => [agent()], rpc: async () => { writes++; throw Error('Reply lost') } })
  assert.equal(writes, 1); assert.equal(result.ok, false)
})
test('open checks the same durable receipt after a lost reply', async () => {
  const calls = []
  const result = await open(row({ status: 'stopped' }), { intent, clearIntent, list: async () => [agent({ status: 'stopped' })], rpc: async (machine, type, payload) => {
    calls.push([machine, type, payload]); if (type === 'agent_resume') throw Error('Disconnected')
    return { state: 'created', agent: { id: 'a1' } }
  } })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.map(c => c[1]), ['agent_resume', 'agent_create_status'])
  assert.equal(calls[0][2].creationId, calls[1][2].creationId)
})
test('unconfirmed saved intent is only checked, never launched again', async () => {
  const calls = []
  const result = await open(row({ status: 'stopped' }), { intent: async () => ({ ...await intent(), existing: true }), clearIntent,
    list: async () => [agent({ status: 'stopped' })], rpc: async (_, type) => { calls.push(type); return { state: 'unconfirmed' } } })
  assert.equal(result.unconfirmed, true); assert.deepEqual(calls, ['agent_create_status'])
})
test('a reservation that never reached the daemon retries with the same receipt', async () => {
  const calls = []
  const result = await open(row({ status: 'stopped' }), { intent: async () => ({ ...await intent(), existing: true }), clearIntent,
    list: async () => [agent({ status: 'stopped' })], rpc: async (_, type, payload) => {
      calls.push([type, payload.creationId]); return type === 'agent_create_status' ? { state: 'missing' } : { state: 'created', agent: { id: 'a1' } }
    } })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [['agent_create_status', 'same-operation'], ['agent_resume', 'same-operation']])
})
test('completed receipts are cleared, including old resumes followed by another stop', async () => {
  for (const reply of [{ state: 'failed', failure: { code: 'NO_ENGINE', detail: 'Install OpenCode first.' } },
    { state: 'created', agent: { id: 'a1', terminal: { available: false } } }]) {
    let cleared = false
    const result = await open(row({ status: 'stopped' }), { intent: async () => ({ ...await intent(), existing: true }),
      clearIntent: async () => { cleared = true }, list: async () => [agent({ status: 'stopped' })], rpc: async () => reply })
    assert.equal(result.ok, false); assert.equal(cleared, true)
    if (reply.failure) assert.equal(result.detail, reply.failure.detail)
  }
})
test('cleanup refuses a session with activity after the reviewed snapshot', async () => {
  const result = await stop(row(), { list: async () => [agent({ updatedAt: observed + 1 })], rpc: async () => { throw Error('Must not stop') } })
  assert.match(result.detail, /Activity changed/)
})
test('concurrent open calls share one operation; running sessions need no launch', async () => {
  let writes = 0
  const target = row({ status: 'stopped' }), options = { intent, clearIntent, list: async () => [agent({ status: 'stopped' })], rpc: async () => { writes++; return { state: 'created', agent: { id: 'a1' } } } }
  const [a,b] = await Promise.all([open(target, options), open(target, options)])
  assert.equal(a.ok, true); assert.equal(b.ok, true); assert.equal(writes, 1)
  assert.equal((await open(row(), { list: async () => [agent()], rpc: async () => { throw Error('Must not send') } })).ok, true)
})


test('workspace inspection targets the owner in read-only mode and handles older daemons', async () => {
  const selected = row(), calls = []
  const workspace = { kind: 'main', path: '/project', mainPath: '/project', canDelete: false }
  assert.deepEqual((await inspectWorkspace(selected, { rpc: async (...args) => { calls.push(args); return { workspace } } })).workspace, workspace)
  assert.deepEqual(calls, [['remote', 'agent_worktree_delete', { agentId: selected.agentId, sessionId: selected.sessionId, createdAt: selected.createdAt, mode: 'describe' }]])
  const old = await inspectWorkspace(selected, { rpc: async () => { throw Object.assign(new Error('Invalid'), { code: 'INVALID_DELETE_REQUEST' }) } })
  assert.match(old.detail, /Update Harness/)
  const legacy = await previewDelete(selected, { list: async () => [agent()], rpc: async () => ({ reviewId: 'legacy' }) })
  assert.equal(legacy.ok, false)
  assert.match(legacy.detail, /Update Harness/)
})

test('worktree-only deletion forwards explicit choices and exact reviewed path', async () => {
  const selected = row(), calls = []
  const options = { reviewId: 'combined', choices: { sessionData: false, worktreeData: true }, path: '/full/worktree', discardChanges: true,
    rpc: async (...args) => { calls.push(args); return { deleted: true, sessionDeleted: false, worktreeDeleted: true } } }
  assert.equal((await deleteHarness(selected, options)).sessionDeleted, false)
  assert.deepEqual(calls[0][2], { agentId: selected.agentId, sessionId: selected.sessionId, createdAt: selected.createdAt, mode: 'delete', reviewId: 'combined', choices: options.choices, path: options.path, discardChanges: true })
  assert.equal((await deleteHarness(selected, { ...options, choices: { sessionData: false, worktreeData: false } })).ok, false)
  assert.equal(calls.length, 1)
})
