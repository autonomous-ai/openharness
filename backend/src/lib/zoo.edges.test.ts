import { describe, expect, it } from 'vitest'
import { applyZooOps, easterHash, emptyZoo, parseZoo, ZOO_MAX_HELD, type Rng } from './zoo.js'

const NOW = new Date('2026-10-01T12:00:00.000Z')
const rng: Rng = (n) => n - 1

describe('reading a stored zoo past its limits', () => {
  it('keeps the oldest 64 held eggs and drops the rest', () => {
    const held = Array.from({ length: ZOO_MAX_HELD + 10 }, (_, i) => ({ kind: 'turn', ...(i === 0 ? { date: '2026-09-09' } : {}) }))
    const zoo = parseZoo({ ...emptyZoo(), progress: { held } })
    expect(zoo.progress.held.length).toBe(ZOO_MAX_HELD)
    expect(zoo.progress.held[0]).toEqual({ kind: 'turn', date: '2026-09-09' })
  })

  it('keeps at most 64 easter hashes, once each, whatever was stored', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`)
    const zoo = parseZoo({ ...emptyZoo(), easter: [...words, 'word0', easterHash('word1')] })
    expect(zoo.easter.length).toBe(64)
    expect(new Set(zoo.easter).size).toBe(64)
    expect(zoo.easter[0]).toBe(easterHash('word0'))
  })
})

describe('a guest seed with eggs and no daemon', () => {
  it('brings the eggs and pairs nothing', () => {
    const r = applyZooOps(emptyZoo(), [{ op: 'zoo.seed', zoo: { eggs: [{ id: 'g1', kind: 'first', grantedAt: '2026-09-30T00:00:00.000Z' }], pair: 'tim' } }], rng, NOW)
    expect(r.changed).toBe(true)
    expect(r.zoo.pair).toBeNull()
    expect(r.zoo.eggs).toEqual([expect.objectContaining({ kind: 'first', origin: 'local' })])
    expect(r.zoo.eggs[0].id).not.toBe('g1')                                  // egg ids are the server's to give
  })
})
