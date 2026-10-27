import { afterEach, expect, it } from 'vitest'
import { markCpuKind, startSelfProfile, topSelfTime } from './selfProfile.js'

let stop = () => {}
afterEach(() => stop())

it('ranks files and functions by self time, with dependencies by package and no absolute paths', () => {
  const at = (id: number, functionName: string, url: string, lineNumber = 0) => ({ id, callFrame: { functionName, url, lineNumber } })
  const top = topSelfTime({
    nodes: [at(1, '(root)', ''), at(2, 'readChanges', `file://${process.cwd()}/dist/read/changes.js`, 9), at(3, 'deserialize', 'file:///app/node_modules/bson/lib/bson.cjs', 41)],
    samples: [2, 3, 3, 3, 2], timeDeltas: [0, 1000, 2000, 3000, 4000],
  })
  expect(top).toEqual({ sampledMs: 10, files: { 'node_modules/bson/lib/bson.cjs': 9, 'dist/read/changes.js': 1 },
    functions: { 'deserialize node_modules/bson/lib/bson.cjs:42': 9, 'readChanges dist/read/changes.js:10': 1 } })
})

it('counts the busy time of a named piece of work, and of what it awaits, under its name', async () => {
  const logs: Record<string, unknown>[] = []
  stop = startSelfProfile({ everyMs: 3_600_000, reportMs: 200, log: (_m, c) => logs.push(c) })
  await new Promise<void>(resolve => setImmediate(() => {
    markCpuKind('http GET /api/x')
    void Promise.resolve().then(() => { const end = performance.now() + 40; while (performance.now() < end) { /* spin */ } }).then(() => resolve())
  }))
  await new Promise(resolve => setTimeout(resolve, 250))
  const busy = logs[0]!.busyMs as Record<string, number>
  expect(busy['http GET /api/x']).toBeGreaterThanOrEqual(35)
})
