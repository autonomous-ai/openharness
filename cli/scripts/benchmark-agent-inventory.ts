/** Run with node --expose-gc --import tsx scripts/benchmark-agent-inventory.ts.
 * Synthetic stopped-heavy inventory: no user pane names, paths, or histories.
 * Measures projection-independent sync/serialization/encryption/decode cost;
 * the list's Git and archive projection still runs for every request. */
import { performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'
import { createAgentInventory } from '../src/core/agents/inventory.js'
import type { AgentFrame } from '../src/lib/agentFrame.js'
import { wrapPayload, unwrapPayload } from '../src/lib/e2ee/core.js'

const agents = Array.from({ length: 380 }, (_, i) => {
  const project = { cwd: `/synthetic/workspace-${i % 20}`, root: `/synthetic/workspace-${i % 20}`, remote: 'github.com/example/project', branch: `work-${i % 30}`, name: 'project' }
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Synthetic pane ${i}`, engine: 'claude',
    status: i < 22 ? 'active' : 'stopped', createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z',
    sessionId: `conversation-${i}`, terminal: { available: i < 22, primary: '', runtimes: [] }, project,
    gitContext: { state: 'workspace', current: project, checkouts: [project],
      locations: [{ cwd: project.cwd, at: '2026-10-07T00:00:00.000Z' }],
      history: { branches: Array.from({ length: 3 }, (_, j) => ({ ...project, branch: `history-${j}`, at: '2026-10-07T00:00:00.000Z' })),
        pullRequests: Array.from({ length: 3 }, (_, j) => ({ url: `https://github.com/example/project/pull/${i * 3 + j + 1}`, cwd: project.cwd,
          at: '2026-10-07T00:00:00.000Z', checkedAt: '2026-10-07T00:00:00.000Z',
          result: { status: 'found', state: 'Merged', title: `Synthetic pull request ${j}`, headBranch: `history-${j}`, baseBranch: 'main' } })), truncated: false },
      version: { epoch: 'synthetic-daemon-epoch', revision: i + 1 } },
  } as unknown as AgentFrame
})
const key = randomBytes(32)
let counter = 0
function roundTrip(payload: Record<string, unknown>) {
  const json = JSON.stringify(payload)
  const wrapped = wrapPayload(key, 's', ++counter, 'agents_list_result', 'benchmark', payload)
  const wire = JSON.stringify(wrapped)
  const envelope = JSON.parse(wire).__e2e
  const clear = unwrapPayload(key, envelope, 'agents_list_result', 'benchmark')
  if (!clear) throw new Error('benchmark round trip failed')
  return { payloadBytes: Buffer.byteLength(json), encryptedJsonBytes: Buffer.byteLength(wire) }
}
function measure(name: string, run: () => Record<string, unknown>) {
  for (let i = 0; i < 5; i++) roundTrip(run())
  global.gc?.()
  const cpu = process.cpuUsage(), start = performance.now(), samples: number[] = []
  let sizes = { payloadBytes: 0, encryptedJsonBytes: 0 }
  for (let i = 0; i < 40; i++) {
    const at = performance.now(); sizes = roundTrip(run()); samples.push(performance.now() - at)
  }
  const elapsed = performance.now() - start, used = process.cpuUsage(cpu)
  samples.sort((a, b) => a - b)
  return { name, iterations: 40, ...sizes, elapsedMs: elapsed, cpuMs: (used.user + used.system) / 1000,
    medianMs: samples[20], p95Ms: samples[38] }
}
const legacy = measure('full inventory each poll', () => ({ agents }))
const sync = createAgentInventory()
const first = sync(agents, { sync: { version: 1 } }, 'web:stopped')
let revision = (first.sync as { revision: string }).revision
const unchanged = measure('unchanged inventory', () => sync(agents, { sync: { version: 1, since: revision } }, 'web:stopped'))
let flip = false
const changed = measure('one changed pane', () => {
  agents[0] = { ...agents[0], name: (flip = !flip) ? 'Changed A' : 'Changed B' }
  const reply = sync(agents, { sync: { version: 1, since: revision } }, 'web:stopped')
  revision = (reply.sync as { revision: string }).revision
  return reply
})
global.gc?.()
const before = process.memoryUsage().heapUsed
const cache = createAgentInventory()
for (let i = 0; i < 20; i++) {
  agents[0] = { ...agents[0], name: `Cache generation ${i}` }
  cache(agents, { sync: { version: 1 } }, 'web:stopped')
}
global.gc?.()
const retainedHeapDeltaBytes = process.memoryUsage().heapUsed - before
console.log(JSON.stringify({ node: process.version, rows: 380, stopped: 358,
  scope: 'Synthetic projection-independent protocol round trip; unchanged Git/archive projection cost excluded',
  firstSyncPayloadBytes: Buffer.byteLength(JSON.stringify(first)), results: [legacy, unchanged, changed],
  retainedHeapDeltaBytes, cacheCaps: { snapshots: 8, rows: 8192, accountedBytes: 1048576 } }, null, 2))
