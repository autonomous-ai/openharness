import { describe, expect, it, vi } from 'vitest'

// Drops 2 and 3 (unix, tty) are on hold: kept in the roster with `hold: true` and no dates, never
// announced, drawn, seeded or hatched (daemons/README.md, "The zoo" > Drops). The shipped roster names no
// held daemon on a history date, so this file gives two dates one each (a held secret, a held regular) to
// pin that such an egg draws from the usual pool. Drops and daemons are the shipped ones.
vi.mock('./daemonRoster.g.js', async (original) => {
  const { DAEMON_ROSTER } = await original<typeof import('./daemonRoster.g.js')>()
  const historyDates = { ...DAEMON_ROSTER.rules.historyDates, '06-01': 'grue', '07-01': 'xeyes' }
  return { DAEMON_ROSTER: { ...DAEMON_ROSTER, rules: { ...DAEMON_ROSTER.rules, historyDates } } }
})
const { DAEMON_ROSTER } = await import('./daemonRoster.g.js')
const { applyZooOps, draw, drawWeights, dropReleased, emptyZoo, historyDaemon, historyDatesOpen, releasedDaemons } = await import('./zoo.js')

const INIT_RELEASE = Date.parse('2026-09-27T00:00:00.000Z')
const NOW = new Date('2026-10-01T12:00:00.000Z')
const HELD = DAEMON_ROSTER.drops.filter((d) => 'hold' in d && d.hold).map((d) => d.id)
const HELD_IDS: string[] = DAEMON_ROSTER.daemons.filter((d) => (HELD as string[]).includes(d.drop)).map((d) => d.id)
const INIT = DAEMON_ROSTER.daemons.filter((d) => d.drop === 'init').map((d) => d.id)
const INIT_REGULARS = DAEMON_ROSTER.daemons.filter((d) => d.drop === 'init' && d.rarity !== 'secret').map((d) => d.id)
/** From long before any drop to the last day the zoo reads, either side of init's release. */
const TIMES = [
  '2000-01-01T00:00:00.000Z', '2026-09-13T00:00:00.000Z', '2026-09-26T23:59:59.999Z', '2026-09-27T00:00:00.000Z',
  '2026-10-11T00:00:00.000Z', '2027-09-27T12:00:00.000Z', '2999-12-31T23:59:59.999Z',
]
const uid = (label: string) => Buffer.from(label).toString('hex').padEnd(24, '0').slice(0, 24)
const daemon = (id: string) => ({ uid: uid(id), id, seed: 0, shiny: false, xp: 0, bond: 0, version: '0.1', hatched: '2026-09-27T00:00:00.000Z', egg: 'first' })
/** A small seeded generator, so a run is reproducible. */
function seeded(seed: number) {
  let a = seed >>> 0
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
  }
}

describe('drops on hold: unix and tty', () => {
  it('ships unix and tty on hold with no dates, their twenty daemons kept in the roster', async () => {
    const { DAEMON_ROSTER: shipped } = await vi.importActual<typeof import('./daemonRoster.g.js')>('./daemonRoster.g.js')
    expect(DAEMON_ROSTER.drops).toEqual(shipped.drops)
    expect(DAEMON_ROSTER.daemons).toEqual(shipped.daemons)
    expect(HELD).toEqual(['unix', 'tty'])
    for (const id of HELD) expect(DAEMON_ROSTER.drops.find((d) => d.id === id)).toEqual({ id, hold: true })
    expect(HELD_IDS).toHaveLength(20)
    expect(HELD_IDS).toEqual(expect.arrayContaining(['tmux', 'bat', 'vim', 'grue', 'xeyes', 'lp0']))
  })

  it('never releases a drop on hold, at any date, even one that has dates', () => {
    for (const at of TIMES) {
      for (const drop of DAEMON_ROSTER.drops.filter((d) => HELD.includes(d.id))) {
        expect(dropReleased(drop, new Date(at)), `${drop.id} at ${at}`).toBe(false)
      }
      // The hold wins over dates: a held drop that has (or one day gains) a release stays out.
      expect(dropReleased({ id: 'x', announce: '2026-09-13', release: '2026-09-27', hold: true }, new Date(at)), at).toBe(false)
    }
    // A drop with no release is never out either; the same dates without the hold are out from that day.
    expect(dropReleased({ id: 'x', announce: '2026-09-13' }, new Date('2999-12-31T23:59:59.999Z'))).toBe(false)
    expect(dropReleased({ id: 'x', announce: '2026-09-13', release: '2026-09-27' }, new Date('2026-09-27T00:00:00.000Z'))).toBe(true)
    expect(dropReleased({ id: 'x', announce: '2026-09-13', release: '2026-09-27', hold: false }, new Date('2026-09-27T00:00:00.000Z'))).toBe(true)
  })

  it('never lets releasedDaemons include a unix or tty daemon, at any date', () => {
    for (const at of TIMES) {
      const out = releasedDaemons(new Date(at)).map((d) => d.id)
      for (const id of HELD_IDS) expect(out, `${id} at ${at}`).not.toContain(id)
      expect(out, at).toEqual(Date.parse(at) >= INIT_RELEASE ? INIT : [])
    }
  })

  it('never weighs a held daemon in any egg, at any pity, whatever the zoo owns', () => {
    const owners = [emptyZoo(), { ...emptyZoo(), daemons: INIT.map(daemon) }, { ...emptyZoo(), daemons: [...INIT, ...HELD_IDS].map(daemon) }]
    for (const kind of Object.keys(DAEMON_ROSTER.rules.eggs)) {
      for (const pity of [0, DAEMON_ROSTER.rules.secretGuaranteeAt - 1]) {
        for (const zoo of owners) {
          const ids = drawWeights({ ...zoo, pity }, kind, NOW).map((w) => w.id)
          expect(ids.length, kind).toBeGreaterThan(0)
          expect(ids.filter((id) => HELD_IDS.includes(id)), `${kind} at pity ${pity}`).toEqual([])
        }
      }
    }
  })

  it('never seeds a unix or tty daemon, regular or secret, at any date', () => {
    const guest = { daemons: [daemon('tim'), ...HELD_IDS.map(daemon)], eggs: [], paired: uid('vim') }
    for (const at of TIMES) {
      const r = applyZooOps(emptyZoo(), [{ op: 'zoo.seed', zoo: guest }], seeded(1), new Date(at))
      const ids = r.zoo.daemons.map((d) => d.id)
      for (const id of HELD_IDS) expect(ids, `${id} at ${at}`).not.toContain(id)
      if (Date.parse(at) >= INIT_RELEASE) {
        // tim comes along; the pair a guest had on a held daemon falls to the one that did.
        expect(ids, at).toEqual(['tim'])
        expect(r.zoo.paired, at).toBe(r.zoo.daemons[0].uid)
      } else {
        expect(r.changed, at).toBe(false)
      }
    }
    // Held daemons alone are nothing to seed.
    expect(applyZooOps(emptyZoo(), [{ op: 'zoo.seed', zoo: { daemons: HELD_IDS.map(daemon), paired: uid('vim') } }], seeded(1), NOW).changed).toBe(false)
  })

  it('draws a history egg whose date names a held daemon from the usual pool', () => {
    // The dates are history dates like any other: open for a week, earned by a counted turn.
    expect(historyDatesOpen('2027-06-03')).toEqual(['2027-06-01'])
    expect(historyDatesOpen('2027-07-01')).toEqual(['2027-07-01'])
    const earned = applyZooOps(emptyZoo(), [{ op: 'zoo.turn', batchId: 'b1', n: 1, day: '2027-06-01', hour: 10, machineId: 'm1' }], seeded(1), new Date('2027-06-01T12:00:00.000Z'))
    expect(earned.zoo.eggs).toEqual([expect.objectContaining({ kind: 'history', date: '2027-06-01' })])
    for (const [date, id] of [['2027-06-01', 'grue'], ['2027-07-01', 'xeyes']]) {
      expect(HELD_IDS).toContain(id)
      const zoo = { ...emptyZoo(), eggs: [{ id: 'h', kind: 'history', grantedAt: `${date}T12:00:00.000Z`, date }] }
      for (const at of TIMES) expect(historyDaemon(zoo, date, new Date(at)), `${date} at ${at}`).toBeNull()
      // The usual pool of a history egg: init's regulars, no secret.
      expect(drawWeights(zoo, 'history', NOW).filter((w) => w.weight > 0).map((w) => w.id)).toEqual(INIT_REGULARS)
      for (let seed = 1; seed <= 200; seed++) {
        const r = applyZooOps(zoo, [{ op: 'zoo.hatch', eggId: 'h' }], seeded(seed), NOW)
        // Exactly what the usual draw gives with the same dice.
        const usual = draw(zoo, 'history', seeded(seed), NOW)!
        expect(r.hatched).toEqual([expect.objectContaining({ eggId: 'h', daemonId: usual.id, shiny: usual.shiny })])
        expect(INIT_REGULARS).toContain(r.hatched[0].daemonId)
        expect(r.zoo.daemons[0].egg).toBe('history')
      }
    }
    // A date naming a released daemon still gives it: the hold, not the date, is what sends the egg to the pool.
    const gnu = { ...emptyZoo(), eggs: [{ id: 'h', kind: 'history', grantedAt: '2027-09-27T12:00:00.000Z', date: '2027-09-27' }] }
    expect(historyDaemon(gnu, '2027-09-27', NOW)?.id).toBe('gnu')
    expect(applyZooOps(gnu, [{ op: 'zoo.hatch', eggId: 'h' }], () => 1, NOW).hatched).toEqual([expect.objectContaining({ eggId: 'h', daemonId: 'gnu', shiny: false })])
  })
})
