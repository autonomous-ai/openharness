import Fastify from 'fastify'
import { afterEach, expect, it } from 'vitest'
import { frameKind, markCpuKind, selfProfileFromEnv, startSelfProfile, topSelfTime } from './selfProfile.js'
import { enterWork, workKind } from './queryStats.js'

let stop = () => {}
afterEach(() => stop())

it('ranks files and functions by self time, with dependencies by package and no absolute paths', () => {
  const at = (id: number, functionName: string, url: string, lineNumber = 0) => ({ id, callFrame: { functionName, url, lineNumber } })
  const top = topSelfTime({
    nodes: [at(1, '(root)', ''), at(2, 'readChanges', `file://${process.cwd()}/dist/read/changes.js`, 9), at(3, 'deserialize', 'file:///app/node_modules/bson/lib/bson.cjs', 41)],
    samples: [2, 3, 3, 3, 2], timeDeltas: [0, 1000, 2000, 3000, 4000],
  })
  expect(top).toEqual({ sampledMs: 10, files: { 'node_modules/bson/lib/bson.cjs': 9, 'dist/read/changes.js': 1 },
    functions: { 'deserialize node_modules/bson/lib/bson.cjs:42': 9, 'readChanges dist/read/changes.js:10': 1 },
    callers: {}, inclusive: { 'readChanges dist/read/changes.js:10': 1 } })
})

it('names the code of ours that a dependency or built-in spends its time for, and the time under each function of ours', () => {
  const app = (path: string) => `file://${process.cwd()}/${path}`
  const at = (id: number, functionName: string, url: string, children: number[] = [], lineNumber = 0) => ({ id, callFrame: { functionName, url, lineNumber }, children })
  const top = topSelfTime({
    nodes: [
      at(1, '(root)', '', [2, 6]),
      at(2, 'changes', app('dist/read/service.js'), [3, 4], 113),
      at(3, 'structuredClone', 'node:internal/worker/js_transferable', [], 111),
      at(4, 'visibleState', app('dist/superTabs/model.js'), [5, 7], 637),
      at(5, 'structuredClone', 'node:internal/worker/js_transferable', [], 111),
      at(6, '(garbage collector)', ''),
      // Recursion counts once per sample under a function of ours.
      at(7, 'visibleState', app('dist/superTabs/model.js'), [8], 637),
      at(8, 'parseEngineResponse', 'file:///app/node_modules/@prisma/client/runtime/library.js', [], 111),
    ],
    samples: [3, 5, 5, 4, 6, 8], timeDeltas: [0, 1000, 2000, 2000, 1000, 1000, 3000],
  })
  expect(top.callers).toEqual({
    'structuredClone node:internal/worker/js_transferable:112 ← visibleState dist/superTabs/model.js:638': 4,
    'parseEngineResponse node_modules/@prisma/client/runtime/library.js:112 ← visibleState dist/superTabs/model.js:638': 3,
    'structuredClone node:internal/worker/js_transferable:112 ← changes dist/read/service.js:114': 1,
  })
  expect(top.inclusive).toEqual({ 'changes dist/read/service.js:114': 9, 'visibleState dist/superTabs/model.js:638': 8 })
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

const spin = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } }
const reported = async (logs: unknown[]) => { while (!logs.length) await new Promise(resolve => setTimeout(resolve, 20)) }

it('logs a WebSocket frame by its type only when the type is known, anything a client invents as other', () => {
  const known = new Set(['terminal_input'])
  expect(frameKind('web-ws', 'terminal_input', known)).toBe('web-ws terminal_input')
  expect(frameKind('web-ws', 'hello from alice@example.com', known)).toBe('web-ws other')
  expect(frameKind('manager-ws', { t: 'up' }, known)).toBe('manager-ws other')
  expect(frameKind('manager-ws', undefined, known)).toBe('manager-ws other')
})

it('keeps at most 50 names in a window; work under any further name counts as other', async () => {
  const logs: Record<string, number>[] = []
  // One window long enough for all 120 names, so the cap is the only limit.
  stop = startSelfProfile({ everyMs: 3_600_000, reportMs: 2_000, log: (_m, c) => logs.push(c.busyMs as Record<string, number>) })
  for (let i = 0; i < 120; i++) {
    await new Promise<void>(resolve => setImmediate(() => { markCpuKind(`job name${i}`); spin(1); resolve() }))
  }
  await reported(logs)
  const busy = logs[0]!
  expect(busy['job name0']).toBeGreaterThan(0)
  expect(busy.other).toBeGreaterThanOrEqual(60)
  expect(Object.keys(busy).filter(k => k.startsWith('job name')).length).toBeLessThanOrEqual(50)
})

it('names HTTP requests when CPU_SELF_PROFILE=1, and adds no request hook when it is off', async () => {
  // Each server has its own route: work the first one started can still run in the second one's window.
  const served = async (env: NodeJS.ProcessEnv, route: string) => {
    const app = Fastify()
    app.get(route, async () => { spin(5); return {} })
    const logs: Record<string, number>[] = []
    const options = { everyMs: 3_600_000, reportMs: 200, log: (_m: string, c: Record<string, unknown>) => logs.push(c.busyMs as Record<string, number>) }
    const fromEnv = selfProfileFromEnv(app, env, options)
    // Off, the profile is started by hand to see whether the request would still be named.
    stop = fromEnv ?? startSelfProfile(options)
    await app.inject({ method: 'GET', url: route })
    await new Promise(resolve => setTimeout(resolve, 250))
    stop(); stop = () => {}
    await app.close()
    return { started: fromEnv !== undefined, kinds: Object.keys(Object.assign({}, ...logs)) }
  }
  const on = await served({ CPU_SELF_PROFILE: '1' }, '/api/on')
  expect(on.started).toBe(true)
  expect(on.kinds).toContain('http GET /api/on')
  const off = await served({}, '/api/off')
  expect(off.started).toBe(false)
  expect(off.kinds).not.toContain('http GET /api/off')
})

it('names the work for the query stats too, with the profile off', async () => {
  const seen = await new Promise<string>(resolve => setImmediate(() => {
    markCpuKind('web-ws swarm_changes')
    void Promise.resolve().then(() => resolve(workKind()))
  }))
  expect(seen).toBe('web-ws swarm_changes')
  enterWork(undefined)
})
