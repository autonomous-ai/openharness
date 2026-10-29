import { afterEach, describe, expect, it } from 'vitest'
import { createQueryStats, enterWork, filterShape, runWork, workKind, type QueryStatsOptions } from './queryStats.js'

type Logged = { message: string; context: Record<string, unknown> }

function stats(options: Partial<QueryStatsOptions> = {}) {
  const infos: Logged[] = [], warns: Logged[] = []
  const s = createQueryStats({ pod: 'pod-1', log: (message, context) => infos.push({ message, context }),
    warn: (message, context) => warns.push({ message, context }), ...options })
  return { s, infos, warns }
}

type Row = { op: string; shape: string; route: string; n: number; ms: number; docs: number; bytes: number; errors: number; maxMs: number }
const rows = (logged: Logged) => logged.context.top as Row[]

describe('filterShape', () => {
  it('keeps the keys of a Prisma filter and replaces every value with ?', () => {
    const shape = filterShape('findMany', { where: { tabId: 'tab-secret-1', OR: [{ status: { in: ['open', 'held'] } }, { owner: { email: 'alice@example.com' } }] },
      select: { id: true }, take: 5 })
    expect(shape).toBe('{"OR":[{"status":{"in":"?"}},{"owner":{"email":"?"}}],"tabId":"?"}')
    expect(shape).not.toContain('tab-secret-1')
    expect(shape).not.toContain('alice')
  })

  it('never shows a value, even an object under a value operator or a string that looks like a field path', () => {
    const shape = filterShape('findFirst', { where: { meta: { equals: { private: 'note' } }, label: { not: '$secret' }, at: { gt: new Date(0) } } })
    expect(shape).toBe('{"at":{"gt":"?"},"label":{"not":"?"},"meta":{"equals":"?"}}')
  })

  it('hides keys that carry ids, emails or anything else that is not a plain name', () => {
    const shape = filterShape('$runCommandRaw', { update: 'SwarmGroup', updates: [{ q: { 'parts.a5e7c91b0462f5fa1a4a7f1b': 1, 'alice@example.com': 2, 'state.ok': 3, 'agent 7': 4 } }] })
    expect(shape).toBe('{"*":"?","parts.*":"?","state.ok":"?"}')
  })

  it('names the stages of a raw pipeline and the keys of its $match', () => {
    expect(filterShape('aggregateRaw', { pipeline: [{ $match: { tabId: 't1', archived: false } }, { $sort: { at: -1 } }, { $limit: 5 }] }))
      .toBe('[{"$match":{"archived":"?","tabId":"?"}},"$sort","$limit"]')
    expect(filterShape('findRaw', { filter: { machineIds: 'm1' } })).toBe('{"machineIds":"?"}')
    expect(filterShape('$runCommandRaw', { find: 'users', filter: { email: 'a@b.c' } })).toBe('{"email":"?"}')
    expect(filterShape('$runCommandRaw', { aggregate: 'SwarmGroup', pipeline: [{ $match: { tabId: 'x' } }], cursor: {} })).toBe('[{"$match":{"tabId":"?"}}]')
    expect(filterShape('$runCommandRaw', { ping: 1 })).toBe('')
  })

  it('has an empty shape for writes without a filter', () => {
    expect(filterShape('create', { data: { email: 'secret@example.com' } })).toBe('')
    expect(filterShape('findMany', undefined)).toBe('')
  })

  it('stays bounded for deep or wide filters', () => {
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 20; i++) deep = { AND: deep }
    expect(filterShape('findMany', { where: deep })).toContain('…')
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`field${String.fromCharCode(97 + (i % 26))}${'x'.repeat(i % 7)}`, i]))
    expect(filterShape('findMany', { where: wide }).length).toBeLessThanOrEqual(301)
  })
})

describe('per-minute totals', () => {
  it('records count, ms, documents and bytes per model.action, shape and route, then starts a new window', () => {
    const { s, infos } = stats({ sampleEvery: 1 })
    runWork('http GET /api/users/:id', () => {
      s.record('User', 'findMany', { where: { email: 'a@b.c' } }, 3, [{ id: '1', email: 'a@b.c' }])
      s.record('User', 'findMany', { where: { email: 'd@e.f' } }, 5, [{ id: '2', email: 'd@e.f' }, { id: '3', email: 'g@h.i' }])
    })
    s.record('User', 'findMany', { where: { email: 'x@y.z' } }, 7, [])
    s.flush()
    expect(infos).toHaveLength(1)
    expect(infos[0]!.message).toBe('db by shape')
    const all = JSON.stringify(infos[0]!.context)
    expect(all).not.toContain('a@b.c')
    const byRoute = Object.fromEntries(rows(infos[0]!).map(r => [r.route, r]))
    expect(byRoute['http GET /api/users/:id']).toEqual({ op: 'User.findMany', shape: '{"email":"?"}', route: 'http GET /api/users/:id', n: 2, ms: 8, docs: 3,
      bytes: JSON.stringify([{ id: '1', email: 'a@b.c' }]).length + JSON.stringify([{ id: '2', email: 'd@e.f' }, { id: '3', email: 'g@h.i' }]).length, errors: 0, maxMs: 5 })
    expect(byRoute.background).toMatchObject({ n: 1, ms: 7, docs: 0, bytes: 2 })
    expect(infos[0]!.context).toMatchObject({ pod: 'pod-1', queries: 3, ms: 15, docs: 3, keys: 2, overflowQueries: 0, slowSuppressed: 0 })
    s.flush()
    expect(infos[1]!.context).toMatchObject({ queries: 0, keys: 0, top: [] })
  })

  it('measures the bytes of every Nth result per key and scales them to the count', () => {
    const { s, infos } = stats({ sampleEvery: 4 })
    const big = [{ blob: 'x'.repeat(100) }], small = [{ blob: '' }]
    // Results 1 and 5 are measured (two bigs), the rest are not even serialized: 2 × big over 2 samples, times 8 queries.
    const results = [big, small, small, small, big, small, small, small]
    for (const r of results) s.record('SwarmGroup', 'findMany', { where: { tabId: 't' } }, 1, r)
    s.flush()
    expect(rows(infos[0]!)[0]!.bytes).toBe(JSON.stringify(big).length * 8)
  })

  it('counts a failed query as an error with its time and no bytes', () => {
    const { s, infos } = stats({ sampleEvery: 1 })
    s.record('Machine', 'update', { where: { machineId: 'm' } }, 4, undefined, true)
    s.flush()
    expect(rows(infos[0]!)[0]).toMatchObject({ op: 'Machine.update', n: 1, ms: 4, errors: 1, bytes: 0, docs: 0 })
  })

  it('counts a single-document result as one document and a raw cursor reply by its batch', () => {
    const { s, infos } = stats({ sampleEvery: 1 })
    s.record('User', 'findUnique', { where: { id: '1' } }, 1, { id: '1' })
    s.record('User', 'findUnique', { where: { id: '2' } }, 1, null)
    s.record(undefined, '$runCommandRaw', { aggregate: 'SwarmGroup', pipeline: [] }, 1, { cursor: { firstBatch: [{}, {}, {}] }, ok: 1 })
    s.flush()
    const byOp = Object.fromEntries(rows(infos[0]!).map(r => [r.op, r]))
    expect(byOp['User.findUnique']!.docs).toBe(1)
    expect(byOp['SwarmGroup.$runCommandRaw aggregate']!.docs).toBe(3)
  })

  it('keeps a bounded number of keys per window and counts the rest under other', () => {
    const { s, infos } = stats({ maxKeys: 3 })
    for (const model of ['A', 'B', 'C', 'D', 'E']) s.record(model, 'findMany', { where: { id: 'x' } }, 1, [])
    s.flush()
    expect(infos[0]!.context).toMatchObject({ queries: 5, keys: 3, overflowQueries: 3 })
    expect(rows(infos[0]!).map(r => r.op).sort()).toEqual(['A.findMany', 'B.findMany', 'other'])
  })

  it('logs the keys a window ranks highest by bytes, by count and by time', () => {
    const { s, infos } = stats({ sampleEvery: 1, top: { bytes: 1, count: 1, ms: 1 } })
    s.record('Big', 'findMany', {}, 1, [{ x: 'x'.repeat(500) }])
    s.record('Often', 'count', {}, 1, 1); s.record('Often', 'count', {}, 1, 1); s.record('Often', 'count', {}, 1, 1)
    s.record('Slow', 'findFirst', {}, 150, null)
    s.record('Quiet', 'findFirst', {}, 1, null)
    s.flush()
    // Ranked by bytes: Big (500+), Slow ("null", 4), Often ("1" three times, 3); Quiet makes no list.
    expect(rows(infos[0]!).map(r => r.op)).toEqual(['Big.findMany', 'Slow.findFirst', 'Often.count'])
  })
})

describe('slow queries', () => {
  it('warns about a query at or over the threshold with its shape and route, never its values', () => {
    const { s, warns } = stats({ slowMs: 200 })
    runWork('web-ws swarm_changes', () => s.record('SwarmGroup', 'findMany', { where: { tabId: 'tab-secret', title: { contains: 'payroll' } } }, 250, [{ title: 'payroll 2026' }]))
    s.record('SwarmGroup', 'findMany', { where: { tabId: 'quick' } }, 199, [])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toEqual({ message: 'slow query', context: { pod: 'pod-1', op: 'SwarmGroup.findMany', shape: '{"tabId":"?","title":{"contains":"?"}}',
      route: 'web-ws swarm_changes', ms: 250, docs: 1, bytes: JSON.stringify([{ title: 'payroll 2026' }]).length, error: false } })
    expect(JSON.stringify(warns)).not.toMatch(/tab-secret|payroll/)
  })

  it('warns at most slowPerWindow times a window and reports how many it held back', () => {
    const { s, warns, infos } = stats({ slowMs: 10, slowPerWindow: 2 })
    for (let i = 0; i < 5; i++) s.record('A', 'findMany', {}, 20, [])
    s.record('A', 'findMany', {}, 9, [])
    s.flush()
    expect(warns).toHaveLength(2)
    // Every slow query's time counts, logged or held back: what an alert on slow seconds a minute sums across pods.
    expect(infos[0]!.context).toMatchObject({ slowSuppressed: 3, slowQueries: 5, slowMs: 100 })
    s.record('A', 'findMany', {}, 20, [])
    expect(warns).toHaveLength(3)
  })
})

describe('work context', () => {
  afterEach(() => enterWork(undefined))

  it('follows awaited work, and is background outside any', async () => {
    expect(workKind()).toBe('background')
    const seen = await runWork('http POST /api/x', async () => {
      await new Promise(resolve => setTimeout(resolve, 1))
      return workKind()
    })
    expect(seen).toBe('http POST /api/x')
    expect(workKind()).toBe('background')
  })

  it('can name the work running now and what it schedules', async () => {
    await new Promise<void>(resolve => setImmediate(() => {
      enterWork('manager-ws up')
      void Promise.resolve().then(() => { expect(workKind()).toBe('manager-ws up'); resolve() })
    }))
  })
})
