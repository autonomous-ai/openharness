import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngineCpu, readEngineCpu, type EngineCpuOptions } from './engineCpu.js'
import { runWork } from './queryStats.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A fake /proc/self/task: each thread's comm, and its schedstat (ns on CPU) or only its stat line (10 ms ticks). */
function procTree(threads: Array<{ tid: number; name: string; ns?: number; ticks?: number }>): string {
  const root = mkdtempSync(join(tmpdir(), 'engine-cpu-'))
  roots.push(root)
  for (const t of threads) {
    const dir = join(root, String(t.tid))
    mkdirSync(dir)
    writeFileSync(join(dir, 'comm'), `${t.name}\n`)
    if (t.ns !== undefined) writeFileSync(join(dir, 'schedstat'), `${t.ns} 5000 12\n`)
    const ticks = t.ticks ?? 0
    writeFileSync(join(dir, 'stat'), `${t.tid} (${t.name}) S 1 1 1 0 -1 0 0 0 0 0 ${ticks} 0 0 0 20 0 1 0 100 0 0`)
  }
  return root
}

describe('the engine threads\' CPU', () => {
  it('sums the Prisma engine threads only, in ns from schedstat', () => {
    const root = procTree([
      { tid: 10, name: 'node', ns: 9_000_000_000 },
      { tid: 11, name: 'tokio-runtime-w', ns: 1_500_000 },
      { tid: 12, name: 'tokio-runtime-w', ns: 2_500_000 },
      { tid: 13, name: 'opentelemetry-e', ns: 1_000 },
      { tid: 14, name: 'libuv-worker', ns: 7_000_000 },
      { tid: 15, name: 'node', ns: 8_000_000 },
    ])
    expect(readEngineCpu(root, 10)).toEqual({ ns: 4_001_000, clock: 'schedstat' })
  })

  it('falls back to stat\'s ticks where the kernel has no schedstat', () => {
    const root = procTree([{ tid: 10, name: 'node', ticks: 99 }, { tid: 11, name: 'tokio-runtime-w', ticks: 3 }])
    expect(readEngineCpu(root, 10)).toEqual({ ns: 30_000_000, clock: 'stat' })
  })

  it('fails loudly when the folder cannot be read', () => {
    expect(() => readEngineCpu('/nonexistent-engine-cpu-root', 1)).toThrow()
  })
})

/** A sampler on a fake clock and a fake engine CPU counter the test moves. */
function sampler(options: Partial<EngineCpuOptions> = {}) {
  let ms = 1_000, ns = 0, reads = 0
  const infos: Array<{ message: string; context: Record<string, unknown> }> = []
  const engine = createEngineCpu({
    pod: 'pod-1', now: () => ms, read: () => { reads++; return { ns, clock: 'schedstat' } },
    log: (message, context) => { infos.push({ message, context }) }, warn: () => {}, ...options,
  })
  return {
    engine, infos,
    advance(byMs: number) { ms += byMs },
    burn(engineMs: number) { ns += engineMs * 1e6 },
    reads: () => reads,
  }
}

type Row = { op: string; route: string; n: number; sampled: number; engineMs: number; usPerQuery: number; docs: number }
const top = (context: Record<string, unknown>) => context.top as Row[]

describe('prisma by query', () => {
  it('times a query that runs alone and scales its mean by how often it ran', () => {
    const t = sampler()
    runWork('http GET /api/super-tabs/:tabId/changes', () => {
      const sample = t.engine.start()
      t.burn(4)
      t.engine.end(sample, 'SwarmGroup', 'findMany', {}, [{ a: 1 }, { a: 2 }])
      // Inside the gap: counted, not sampled.
      for (let i = 0; i < 9; i++) t.engine.end(t.engine.start(), 'SwarmGroup', 'findMany', {}, [{ a: 1 }, { a: 2 }])
    })
    t.engine.flush()
    expect(t.infos).toHaveLength(1)
    expect(t.infos[0]!.message).toBe('prisma by query')
    expect(top(t.infos[0]!.context)[0]).toEqual({ op: 'SwarmGroup.findMany', route: 'http GET /api/super-tabs/:tabId/changes', n: 10, sampled: 1,
      engineMs: 40, usPerQuery: 4000, docs: 20 })
    expect(t.infos[0]!.context).toMatchObject({ pod: 'pod-1', clock: 'schedstat', queries: 10, sampled: 1, discarded: 0, engineMs: 40 })
  })

  it('drops a sample another query overlapped, at its start or before its end', () => {
    const t = sampler()
    // Another query starts before the sampled one ends.
    const first = t.engine.start()
    const second = t.engine.start()
    t.burn(10)
    t.engine.end(first, 'Machine', 'findUnique', {}, { id: 'm' })
    t.engine.end(second, 'User', 'findFirst', {}, { id: 'u' })
    t.advance(1_000)
    // One already in flight: the new one is not sampled at all.
    const running = t.engine.start()
    t.advance(1_000)
    const late = t.engine.start()
    t.burn(10)
    t.engine.end(late, 'Machine', 'findUnique', {}, { id: 'm' })
    t.engine.end(running, 'User', 'findFirst', {}, { id: 'u' })
    t.engine.flush()
    const context = t.infos[0]!.context
    // Both samples opened were overlapped: the first by a second start, the one in flight by the late one.
    expect(context).toMatchObject({ queries: 4, sampled: 0, discarded: 2, engineMs: 0 })
  })

  it('reads the engine CPU at most once per gap, so its cost stays bounded at any query rate', () => {
    const t = sampler({ gapMs: 100 })
    for (let i = 0; i < 1_000; i++) {
      t.advance(1)
      t.engine.end(t.engine.start(), 'SwarmHead', 'findUnique', {}, { id: 'h' })
    }
    t.engine.flush()
    // 1,000 solo queries over a second: about 10 samples, each a read before and after.
    expect(t.reads()).toBeLessThanOrEqual(22)
    expect(t.infos[0]!.context).toMatchObject({ queries: 1_000 })
    expect((t.infos[0]!.context.sampled as number)).toBeGreaterThanOrEqual(9)
  })

  it('brings the in-flight count back after every end, so sampling never stops', () => {
    const t = sampler()
    for (let i = 0; i < 5; i++) t.engine.start()
    for (let i = 0; i < 5; i++) t.engine.end(undefined, 'User', 'update', {}, undefined)
    t.advance(1_000)
    const sample = t.engine.start()
    t.burn(2)
    t.engine.end(sample, 'User', 'findFirst', {}, { id: 'u' })
    t.engine.flush()
    expect(t.infos[0]!.context).toMatchObject({ sampled: 1, engineMs: 2 })
  })

  it('ranks by engine ms, names raw commands by collection, sums each op across routes, and starts a new window', () => {
    const t = sampler({ gapMs: 0 })
    const run = (route: string, model: string | undefined, action: string, args: unknown, engineMs: number) => runWork(route, () => {
      const sample = t.engine.start()
      t.burn(engineMs)
      t.engine.end(sample, model, action, args, [])
    })
    run('http GET /api/a', 'SwarmGroup', 'findMany', {}, 1)
    run('http GET /api/b', 'SwarmGroup', 'findMany', {}, 2)
    run('http POST /api/hosts/:id/readings', undefined, '$runCommandRaw', { aggregate: 'SwarmMachine', pipeline: [] }, 5)
    t.engine.flush()
    const context = t.infos[0]!.context
    expect(top(context).map(r => [r.op, r.route, r.engineMs])).toEqual([
      ['SwarmMachine.$runCommandRaw aggregate', 'http POST /api/hosts/:id/readings', 5],
      ['SwarmGroup.findMany', 'http GET /api/b', 2],
      ['SwarmGroup.findMany', 'http GET /api/a', 1],
    ])
    expect(context.byOp).toEqual({ 'SwarmMachine.$runCommandRaw aggregate': 5, 'SwarmGroup.findMany': 3 })
    expect(context.costMs).toEqual(expect.any(Number))
    t.engine.flush()
    expect(t.infos[1]!.context).toMatchObject({ queries: 0, sampled: 0, engineMs: 0, top: [] })
  })

  it('logs unavailable, and still counts queries, where the engine threads cannot be read', () => {
    const t = sampler({ read: () => { throw new Error('ENOENT /proc/self/task') } })
    t.engine.end(t.engine.start(), 'User', 'findFirst', {}, { id: 'u' })
    t.engine.flush()
    expect(t.infos[0]!.context).toMatchObject({ threads: 'unavailable', reason: 'ENOENT /proc/self/task', queries: 1, sampled: 0 })
  })

  it('names no value: ops are model.action and routes are patterns', () => {
    const t = sampler()
    runWork('http GET /api/x', () => t.engine.end(t.engine.start(), 'User', 'findFirst', { where: { email: 'person@example.com' } }, { email: 'person@example.com' }))
    t.engine.flush()
    expect(JSON.stringify(t.infos)).not.toContain('person@example.com')
  })
})
