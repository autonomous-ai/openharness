import { describe, expect, it, vi } from 'vitest'

// The shipped roster's history daemons in init (tux, bug, gnu) are regulars, and no drop holds teapot or
// zombie. This file gives init's release day to its secret, beastie, to pin what a history egg does once a
// drop brings its daemon (a secret too, which no history egg draws otherwise), and one date in the last
// week of the year, to pin a history week that runs into the next year.
vi.mock('./daemonRoster.g.js', async (original) => {
  const { DAEMON_ROSTER } = await original<typeof import('./daemonRoster.g.js')>()
  const historyDates = { ...DAEMON_ROSTER.rules.historyDates, '09-27': 'beastie', '12-30': null }
  return { DAEMON_ROSTER: { ...DAEMON_ROSTER, rules: { ...DAEMON_ROSTER.rules, historyDates } } }
})
const { applyZooOps, emptyZoo, historyDaemon, historyDatesOpen } = await import('./zoo.js')

const egg = { id: 'h', kind: 'history', grantedAt: '2026-09-27T12:00:00.000Z', date: '2026-09-27' }
const now = new Date('2026-09-27T12:00:00.000Z')

describe('a history egg whose daemon a drop holds', () => {
  it('gives that daemon, rolling only for shiny (then the individual\'s seed and uid)', () => {
    const calls: number[] = []
    const rng = (n: number) => { calls.push(n); return 1 }
    const r = applyZooOps({ ...emptyZoo(), eggs: [egg] }, [{ op: 'zoo.hatch', eggId: 'h' }], rng, now)
    expect(r.hatched).toEqual([expect.objectContaining({ eggId: 'h', daemonId: 'beastie', shiny: false, seed: 2, uid: '000000010000000100000001' })])
    expect(calls).toEqual([256, 2 ** 32 - 1, 2 ** 32, 2 ** 32, 2 ** 32])
    expect(r.zoo.pity).toBe(0)                                             // it is a secret: pity resets
    expect(r.zoo.daemons[0]).toMatchObject({ id: 'beastie', egg: 'history' })
  })

  it('draws from the usual pool once you own it', () => {
    const owned = { ...emptyZoo(), daemons: [{ uid: 'b'.repeat(24), id: 'beastie', seed: 0, shiny: false, xp: 0, bond: 0, version: '0.1', hatched: now.toISOString(), egg: 'night' }], eggs: [egg] }
    expect(historyDaemon(owned, egg.date)).toBeNull()
    const r = applyZooOps(owned, [{ op: 'zoo.hatch', eggId: 'h' }], (n) => n - 1, now)
    expect(r.hatched[0].daemonId).not.toBe('beastie')
  })

  it('earns the egg on that date like any history date', () => {
    const r = applyZooOps(emptyZoo(), [{ op: 'zoo.turn', batchId: 'b1', n: 1, day: '2026-09-27', hour: 10, machineId: 'm1' }], (n) => n - 1, now)
    expect(r.zoo.eggs).toEqual([expect.objectContaining({ kind: 'history', date: '2026-09-27' })])
  })
})

describe('a history date late in December', () => {
  const turn = (batchId: string, day: string) => ({ op: 'zoo.turn' as const, batchId, n: 1, day, hour: 10, machineId: 'm1' })
  const at = (day: string) => new Date(`${day}T12:00:00.000Z`)

  it('stays open into the new year, for a week from its date', () => {
    expect(historyDatesOpen('2026-12-29')).toEqual([])
    expect(historyDatesOpen('2026-12-30')).toEqual(['2026-12-30'])
    expect(historyDatesOpen('2027-01-05')).toEqual(['2026-12-30'])
    expect(historyDatesOpen('2027-01-06')).toEqual([])
  })

  it('grants its egg in January with last year\'s date, once, and again next December', () => {
    let k = 0
    const rng = (n: number) => (k++ * 7) % n                                // egg ids that differ
    const jan = applyZooOps(emptyZoo(), [turn('b1', '2027-01-04')], rng, at('2027-01-04'))
    expect(jan.zoo.eggs).toEqual([expect.objectContaining({ kind: 'history', date: '2026-12-30' })])
    const again = applyZooOps(jan.zoo, [turn('b2', '2027-01-05')], rng, at('2027-01-05'))
    expect(again.grants).toEqual([])
    const next = applyZooOps(again.zoo, [turn('b3', '2027-12-31')], rng, at('2027-12-31'))
    expect(next.grants).toEqual([{ kind: 'history', eggId: expect.any(String) }])
    expect(next.zoo.progress.history).toEqual(['2026-12-30', '2027-12-30'])
  })
})
