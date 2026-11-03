import { describe, expect, it } from 'vitest'
import { readRecord, routeRecordSchema, storedRecord, type RouteRecord } from './routeRecord.js'

const candidate = (i: number) => ({ id: `c${i}`, kind: 'new', machineId: `m${i}`, engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3,
  title: `New agent · Claude opus high · m${i}`, label: `New agent · Claude opus high · m${i}` })
const record = (count: number) => ({ assessment: { difficulty: 'medium', risk: 'low', why: 'Endpoint.' },
  candidates: Array.from({ length: count }, (_, i) => candidate(i)), excluded: [], floor: 1, notes: false, pick: 'c0', via: 'order', p: null,
  belowFloor: false, why: 'First by strength, then price and quota fit.' })

describe('route.record', () => {
  // The route shows every engine on every machine (Ken, 2026-11-03): a Swarm of a dozen Macs with two engines, a new agent and an
  // idle member on each, is 48 rows, and the agent choosing may pick any of them by its id.
  it('keeps up to 64 candidates, and refuses more', () => {
    expect(routeRecordSchema.safeParse(record(64)).success).toBe(true)
    expect(routeRecordSchema.safeParse(record(65)).success).toBe(false)
  })
})

describe('a route decision as stored (task #2488: ~20 KB a row since every engine on every machine)', () => {
  const routed = () => {
    const r = record(3) as unknown as RouteRecord
    r.pick = 'c1'
    r.candidates = r.candidates.map(c => ({ ...c, label: `${c.title} · strength 3, cost 3 · fits: weekly 4% of 69%`,
      fit: { status: 'fits' as const, coverage: 2, effectiveCost: 3, expiring: 0, spend: { weekly: 1 } } }))
    r.excluded = [['a', 'offline'], ['b', 'suspended'], ['c', 'offline'], ['d', 'offline'], ['e', 'suspended'], ['f', 'offline']]
      .map(([machine, reason]) => ({ title: `New agent · Codex default default · ${machine}`, reason: reason === 'offline' ? 'Machine is offline or unreachable.' : 'Codex is suspended on this machine.' }))
    return r
  }

  it('keeps the label of the pick only, and every other candidate field', () => {
    const r = routed(), stored = storedRecord(r)
    expect(stored.candidates.map(c => c.label)).toEqual([undefined, r.candidates[1]!.label, undefined])
    expect(stored.candidates.map(({ label: _label, ...c }) => c)).toEqual(r.candidates.map(({ label: _label, ...c }) => c))
  })

  it('keeps each exclusion reason once, with its titles in order', () => {
    const stored = storedRecord(routed())
    expect(stored.excluded).toBeUndefined()
    expect(stored.unavailable).toEqual([
      { reason: 'Machine is offline or unreachable.', titles: ['a', 'c', 'd', 'f'].map(m => `New agent · Codex default default · ${m}`) },
      { reason: 'Codex is suspended on this machine.', titles: ['b', 'e'].map(m => `New agent · Codex default default · ${m}`) },
    ])
  })

  it('reads back as the record readers get, its exclusions grouped by reason', () => {
    const r = routed()
    const back = readRecord(storedRecord(r))
    expect(back.candidates).toEqual(storedRecord(r).candidates)
    expect(back.excluded.map(e => e.title.slice(-1))).toEqual(['a', 'c', 'd', 'f', 'b', 'e'])
    expect(new Set(back.excluded.map(e => JSON.stringify(e)))).toEqual(new Set(r.excluded.map(e => JSON.stringify(e))))
    expect(back).not.toHaveProperty('unavailable')
  })

  it('reads a record written before as it is, and stores a record with no exclusions with none', () => {
    const old = routed()
    expect(readRecord(old)).toEqual(old)
    const none = { ...routed(), excluded: [] }
    expect(storedRecord(none)).not.toHaveProperty('unavailable')
    expect(storedRecord(none).excluded).toEqual([])
    expect(readRecord(storedRecord(none)).excluded).toEqual([])
  })

  it('stores a record that lacks candidates or exclusions as it is (routeDecisions.test.ts writes one)', () => {
    expect(storedRecord({} as RouteRecord)).toEqual({})
    const bare = { ...routed() } as Partial<RouteRecord>
    delete bare.excluded
    expect(storedRecord(bare as RouteRecord)).not.toHaveProperty('unavailable')
  })
})
