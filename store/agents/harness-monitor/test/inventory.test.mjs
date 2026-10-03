import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collect, mergeRows, parseModel, resolveRef, rowId, tilde } from '../lib/inventory.mjs'
import { frame, HOME, HOUR } from './fixtures.mjs'
const now = Date.now(), machine = { machineId: 'm1', name: 'Office' }
const agent = extra => frame({ resumeMode: 'conversation', monitor: { activity: 'idle', activityKnown: true }, ...extra })
const merge = (extra = {}, options = {}) => mergeRows([agent(extra)], { machine, now, ...options })[0]

test('machine and agent form the identity, including stopped work', () => {
  const a = merge({ status: 'stopped' }), b = merge({}, { machine: { machineId: 'm2' } })
  assert.equal(a.id, rowId('m1', 'a1')); assert.notEqual(a.id, b.id)
  assert.equal(a.state, 'stopped'); assert.equal(a.activity, 'stopped'); assert.equal(a.canStop, false); assert.equal(a.canOpen, true)
  assert.equal(a.engine, 'claude'); assert.equal(a.sessionId, 's1')
})
test('activity and last active use owning daemon facts, not process guesses', () => {
  const row = merge({ updatedAt: now - 2 * HOUR, monitor: { activity: 'needsInput', activityKnown: true, cpu: 0 } })
  assert.equal(row.needsInput, true); assert.equal(row.activity, 'needsInput'); assert.equal(row.idleMs, 2 * HOUR)
  assert.equal(merge({ monitor: undefined }).activity, 'unknown')
})
test('unknown is not zero, offline retains metadata and disables actions', () => {
  const unknown = merge(); assert.equal(unknown.cpu, null); assert.equal(unknown.rssBytes, null); assert.equal(unknown.tokens, null)
  const zero = merge({ monitor: { activity: 'idle', activityKnown: true, cpu: 0, rssBytes: 0 }, tokenUsage: { totalTokens: 0 } })
  assert.equal(zero.cpu, 0); assert.equal(zero.tokens, 0)
  const offline = merge({}, { online: false }); assert.equal(offline.activity, 'offline'); assert.equal(offline.canOpen, false); assert.equal(offline.canStop, false)
})
test('monitor cannot stop itself, and starts/failures outrank activity', () => {
  assert.equal(merge({ dsh: 'autonomous/harness-monitor' }).canStop, false)
  assert.equal(merge({ launch: { state: 'starting' } }).activity, 'starting')
  assert.equal(merge({ launch: { state: 'failed', error: 'RESUME_UNCONFIRMED' } }).activity, 'needsInput')
})
test('starting harnesses stay live before their terminal becomes available', () => {
  const starting = merge({ terminal: { available: false }, launch: { state: 'starting' } })
  assert.equal(starting.state, 'starting')
  assert.equal(starting.live, true)
  assert.equal(starting.canStop, false)
  const exited = merge({ terminal: { available: false }, launch: { state: 'failed' } })
  assert.equal(exited.state, 'gone')
  assert.equal(exited.live, false)
})
test('cached remote rows survive disconnect; reconnection refreshes and unlinked machines disappear', async () => {
  const remote = { at: 0, answers: new Map() }; let online = true, linked = true, reads = 0
  const options = { remote, remoteIntervalMs: 0, reportMachines: async () => ({ machines: linked ? [{ machineId: 'm1', name: 'Office', online }] : [] }),
    agentsFor: async () => { reads++; return [agent()] } }
  assert.equal((await collect(options)).rows[0].canOpen, true)
  online = false
  assert.equal((await collect(options)).rows[0].activity, 'offline'); assert.equal(reads, 1)
  online = true; await collect(options); assert.equal(reads, 2)
  linked = false; assert.equal((await collect(options)).rows.length, 0)
})
test('remote read failures keep rows but never leave enabled controls', async () => {
  const remote = { at: 0, answers: new Map([['m1', [agent()]]]) }
  const result = await collect({ remote, remoteIntervalMs: 0, reportMachines: async () => ({ machines: [{ ...machine, online: true }] }), agentsFor: async () => { throw Error('Disconnected') } })
  assert.equal(result.rows[0].activity, 'offline'); assert.equal(result.degraded, true)
})
test('reconnect and failed reads refresh before the regular remote interval', async () => {
  const remote = { at: 0, answers: new Map() }; let now = 1000, online = true, fail = false, reads = 0
  const options = { remote, remoteIntervalMs: 15_000, reportMachines: async () => ({ machines: [{ ...machine, online }] }),
    agentsFor: async () => { reads++; if (fail) throw Error('Disconnected'); return [agent()] } }
  const read = () => collect({ ...options, now: now++ })
  await read(); await read(); assert.equal(reads, 1)
  online = false; assert.equal((await read()).rows[0].activity, 'offline')
  online = true; fail = true; assert.equal((await read()).rows[0].canOpen, false); assert.equal(reads, 2)
  fail = false; assert.equal((await read()).rows[0].canOpen, true); assert.equal(reads, 3)
})
test('ambiguous IDs and pane numbers cannot choose another machine', () => {
  const a = merge(), b = merge({}, { machine: { machineId: 'm2' } })
  assert.match(resolveRef('a1', [a, b]).error, /matches 2/)
  assert.match(resolveRef('%1', [a, b]).error, /matches 2/)
  assert.equal(resolveRef(a.id, [a, b]).row, a)
  assert.equal(resolveRef('1', [a, b]).row, a)
})
test('model and home parsing preserve provider IDs and directory boundaries', () => {
  assert.deepEqual(parseModel('runtime-v1:a1:opencode:opencode/muse-spark-1.3-contributor-free@auto'), { model: 'opencode/muse-spark-1.3-contributor-free', effort: 'auto' })
  assert.equal(tilde(HOME + 'other/x', HOME), HOME + 'other/x'); assert.equal(tilde(HOME + '/x', HOME), '~/x')
})

test('resource data and shared servers retain owning machine scope', async () => {
  const result = await collect({ reportMachines: async () => ({ machines: [{ ...machine, online: true }] }),
    inventoryFor: async () => ({ agents: [agent({ monitor: { activity: 'working', activityKnown: true, gpuPercent: 35, gpuMemoryBytes: 900, workspaceBytes: 1200, processCount: 2 } })],
      shared: [{ kind: 'codex', agentIds: ['a1'], memoryBytes: 300, cpuPercent: 4 }] }) })
  assert.equal(result.rows[0].gpuPercent, 35)
  assert.equal(result.rows[0].workspaceBytes, 1200)
  assert.equal(result.rows[0].live, true)
  assert.equal(result.shared[0].machineId, 'm1')
  assert.equal(result.shared[0].rssBytes, 300)
})
test('token velocity uses fresh ledger updates, survives clock skew, and resets on conversation changes', async () => {
  let tokenCount = 100, sourceTime = 9_000_000, sessionId = 's1', now = 100_000
  const remote = { at: 0, answers: new Map() }
  const options = { remote, remoteIntervalMs: 0, reportMachines: async () => ({ machines: [{ ...machine, online: true }] }),
    agentsFor: async () => [agent({ sessionId, tokenUsage: { totalTokens: tokenCount, updatedAt: sourceTime } })] }
  const read = async () => (await collect({ ...options, now })).rows[0].tokensPerMinute
  assert.equal(await read(), null)
  now += 4000; assert.equal(await read(), null)
  now += 6000; sourceTime += 10000; tokenCount += 1000
  assert.equal(await read(), 6000)
  now += 4000; assert.equal(await read(), 6000)
  sessionId = 'new'; assert.equal(await read(), null)
  now += 10000; sourceTime += 10000; tokenCount = 1; assert.equal(await read(), null)
  now += 120000; sourceTime += 120000; tokenCount += 1000; assert.equal(await read(), null)
  now += 10000; sourceTime += 10000; tokenCount += 1000; assert.equal(await read(), 6000)
})
