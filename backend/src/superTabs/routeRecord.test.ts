import { describe, expect, it } from 'vitest'
import { routeRecordSchema } from './routeRecord.js'

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
