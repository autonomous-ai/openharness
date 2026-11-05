import { BSON } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { finalMatches, readRecord, routeRecordSchema, storedRecord, type RouteRecord } from './routeRecord.js'

const candidate = (i: number) => ({ id: `c${i}`, kind: 'new', machineId: `m${i}`, engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3,
  title: `New agent · Claude opus high · m${i}`, label: `New agent · Claude opus high · m${i}` })
/** An older CLI's record, still taken as before: its pick, first by strength (before task #2901). */
const record = (count: number) => ({ assessment: { difficulty: 'medium', risk: 'low', why: 'Endpoint.' },
  candidates: Array.from({ length: count }, (_, i) => candidate(i)), excluded: [], floor: 1, notes: false, pick: 'c0', via: 'order', p: null,
  belowFloor: false, why: 'First by strength, then price and quota fit.' })
/** The route since task #2901 (Ken, 2026-11-04): no pick and no ranking; the project's Routing instructions choose. */
const pickless = (count: number) => {
  const { pick: _pick, ...rest } = record(count)
  return { ...rest, via: count === 1 ? 'only' : 'instructions', why: 'No ranking: the project\'s Routing instructions choose.' }
}

describe('route.record', () => {
  // The route shows every engine on every machine (Ken, 2026-11-03): a Swarm of a dozen Macs with two engines, a new agent and an
  // idle member on each, is 48 rows, and the agent choosing may pick any of them by its id.
  it('keeps up to 64 candidates, and refuses more', () => {
    expect(routeRecordSchema.safeParse(record(64)).success).toBe(true)
    expect(routeRecordSchema.safeParse(record(65)).success).toBe(false)
  })
  // Task #2901 (Ken, 2026-11-04): the route names no pick, so PMs stop taking its top line against the Routing instructions. An
  // older CLI still sends its pick, and that record is held to its candidates as before.
  it('takes a record that names no pick, chosen by the instructions or the only candidate, and an older one with its pick', () => {
    expect(routeRecordSchema.safeParse(pickless(42)).success).toBe(true)
    expect(routeRecordSchema.safeParse(pickless(1)).success).toBe(true)
    expect(routeRecordSchema.safeParse(record(3)).success).toBe(true)
    expect(routeRecordSchema.safeParse({ ...record(3), pick: 'c9' }).success).toBe(false)
    expect(routeRecordSchema.safeParse({ ...pickless(3), via: 'ranked' }).success).toBe(false)
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

  it('keeps the pick whole, and of every other candidate who and where it is and its title', () => {
    const r = routed(), stored = storedRecord(r)
    expect(stored.candidates[1]).toEqual(r.candidates[1])
    const kept = ({ id, kind, machineId, engine, model, effort, title }: RouteRecord['candidates'][number]) => ({ id, kind, machineId, engine, model, effort, title })
    expect([stored.candidates[0], stored.candidates[2]]).toEqual([kept(r.candidates[0]!), kept(r.candidates[2]!)])
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
})

// Ken's prod scan, 11-04 14:30: 12.9 KB a decision on average, rows of 12 candidates mostly. A route lists every engine on every
// machine now (#2723): 42 candidates on 11-04, each with its quota fit, which no reader takes back but the pick's.
describe('a route decision of every engine on every machine, as stored (task #2769)', () => {
  const hex = (n: number, seed: number) => Array.from({ length: n }, (_, i) => ((i * 7 + seed) % 16).toString(16)).join('')
  const routed = (): RouteRecord => {
    const machines = Array.from({ length: 21 }, (_, i) => hex(24, i))
    const candidates = machines.flatMap((machineId, m) => (['claude', 'codex'] as const).map((engine, e) => {
      const i = m * 2 + e
      return { id: `c${i}`, ...(i % 9 === 4 ? { kind: 'member' as const, agentId: hex(24, 50 + i) } : { kind: 'new' as const }), machineId, engine,
        model: engine === 'claude' ? 'opus' : 'default', effort: engine === 'claude' ? 'high' : 'default', quality: 3, cost: 40,
        title: `New agent · ${engine === 'claude' ? 'Claude opus high' : 'Codex default default'} · MacBooks-MacBook-Pro-${m}.local`,
        label: `New agent · Claude opus high · MacBooks-MacBook-Pro-${m}.local · strength 3, cost 40 · fits: weekly 1% of 64% left, resets in 3d4h`,
        fit: { status: 'fits' as const, coverage: 3.21, effectiveCost: 1.2, expiring: 0.4, spend: { '5-hour': 2.5, weekly: 1 }, account: hex(64, i) } }
    }))
    return { assessment: { difficulty: 'medium', risk: 'medium', why: 'Route decision size and index suggestions from Ken scan', size: 'medium', kind: 'backend' },
      candidates, excluded: [], floor: 1, notes: false, pick: 'c2', via: 'order', p: null, belowFloor: false,
      why: 'First by strength, then price and quota fit.', jobKind: 'backend', instructionsRevision: 52 } as RouteRecord
  }
  const size = (value: unknown) => BSON.calculateObjectSize({ record: value })

  it('stores its 42 candidates in under 10 KB: 24.7 KB as routed, 18.9 KB with only the labels left out (task #2488)', () => {
    const r = routed()
    expect(size(r)).toBeGreaterThan(24_000)
    expect(size(storedRecord(r))).toBeLessThan(10_000)
  })

  it('reads back what each reader takes: the pick whole (routeHistory: its account and spend), every title (Desktop Details), and each candidate a start or a person may choose', () => {
    const r = routed(), back = readRecord(storedRecord(r))
    expect(back.candidates.find(c => c.id === r.pick)).toEqual(r.candidates.find(c => c.id === r.pick))
    expect(back.candidates.map(c => c.title)).toEqual(r.candidates.map(c => c.title))
    for (const [i, c] of r.candidates.entries()) {
      const kept = back.candidates[i]!
      expect({ id: kept.id, kind: kept.kind, agentId: kept.agentId, machineId: kept.machineId, engine: kept.engine, model: kept.model, effort: kept.effort })
        .toEqual({ id: c.id, kind: c.kind, agentId: c.agentId, machineId: c.machineId, engine: c.engine, model: c.model, effort: c.effort })
      const final = c.kind === 'member' ? { kind: 'member' as const, agentId: c.agentId!, machineId: c.machineId }
        : { kind: 'new' as const, startId: 's', machineId: c.machineId, engine: c.engine, model: c.model, effort: c.effort }
      expect(finalMatches(kept, final)).toBe(true)
    }
  })

  // Task #2901: with no pick, nobody knows which candidate runs until the start, and the route history needs that one's account
  // and spend (cli service.ts routeHistory). So every candidate keeps those two of its fit, and nothing else of it.
  const pickless = (): RouteRecord => {
    const { pick: _pick, ...rest } = routed()
    return { ...rest, via: 'instructions', why: 'No ranking: the project\'s Routing instructions choose.' } as RouteRecord
  }

  // Measured 11-04: 14,568 bytes, of which the 42 slim fits are 5,376 (128 bytes a candidate, its 64-character account most of it).
  it('stores a record that names no pick, 42 candidates each with its account and spend, in under 15 KB (measured 14,568 bytes)', () => {
    expect(size(storedRecord(pickless()))).toBeLessThan(15_000)
  })

  it('keeps of every candidate of a record that names no pick who and where it is, its title and its account and spend', () => {
    const r = pickless(), back = readRecord(storedRecord(r))
    for (const [i, c] of r.candidates.entries()) {
      const kept = back.candidates[i]!
      expect(kept).toEqual({ id: c.id, kind: c.kind, ...c.agentId ? { agentId: c.agentId } : {}, machineId: c.machineId, engine: c.engine, model: c.model,
        effort: c.effort, title: c.title, fit: { account: c.fit!.account, spend: c.fit!.spend } })
    }
  })

  it('keeps no fit of a candidate that had none, and no account of one that had none', () => {
    const r = pickless()
    delete r.candidates[0]!.fit
    delete r.candidates[1]!.fit!.account
    const [first, second] = storedRecord(r).candidates
    expect(first).not.toHaveProperty('fit')
    expect(second!.fit).toEqual({ spend: { '5-hour': 2.5, weekly: 1 } })
  })

  it('keeps a grid model on a candidate that runs one', () => {
    const r = routed()
    r.candidates[5] = { ...r.candidates[5]!, kind: 'new', agentId: undefined, model: 'default', effort: 'default', gridModel: 'kimi-k3', gridName: 'Kimi K3' }
    delete r.candidates[5]!.agentId
    const kept = storedRecord(r).candidates[5]!
    expect([kept.gridModel, kept.gridName]).toEqual(['kimi-k3', 'Kimi K3'])
  })
})
