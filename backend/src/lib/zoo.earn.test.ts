import { describe, expect, it } from 'vitest'
import {
  applyZooOps, drawWeights, emptyProgress, emptyZoo, historyDaemon, historyDatesOpen, isLocalDay, isoWeek, levelFor, nightOf, parseZoo, versionFor,
  zooOpSchema, zooOpsBodySchema, ZOO_BATCH_MEMORY, ZOO_MAX_EGGS, ZOO_MAX_HELD, ZOO_TURN_MAX_MINUTES,
  type Grant, type LevelUp, type Rng, type Zoo, type ZooContext, type ZooDaemon, type ZooOp, type ZooProgress,
} from './zoo.js'
import { DAEMON_ROSTER } from './daemonRoster.g.js'

/** Earning eggs from work and growing a daemon (daemons/README.md, "Earning eggs and growing"). */

const RULES = DAEMON_ROSTER.rules
/** Drop 1's (init) regulars: the only ones out on the days these tests draw (unix and tty are on hold). */
const REGULARS = DAEMON_ROSTER.daemons.filter((d) => d.drop === 'init' && d.rarity !== 'secret').map((d) => d.id)

function seeded(seed = 1): Rng {
  let a = seed >>> 0
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
  }
}

let batchSeq = 0
/** What a batch says besides its count: agent-minutes, and turns that finished while the person was away. */
type Extra = { minutes?: number; away?: number }
const turn = (day: string, n: number, hour = 12, machineId = 'm1', batchId = `b${++batchSeq}`, extra: Extra = {}): ZooOp =>
  ({ op: 'zoo.turn', batchId, n, day, hour, machineId, ...extra })
/** Noon UTC of a day: the server's clock while that day is being worked. */
const noonOf = (day: string) => new Date(`${day}T12:00:00.000Z`)
/** A readable uid for a test individual: its label in hex, padded to 24. */
const uid = (label: string) => Buffer.from(label).toString('hex').padEnd(24, '0').slice(0, 24)
const daemon = (id: string, extra: Partial<ZooDaemon> = {}): ZooDaemon =>
  ({ uid: uid(id), id, seed: 0, shiny: false, xp: 0, bond: 0, version: '0.1', hatched: '2026-09-01T00:00:00.000Z', egg: 'first', ...extra })
const egg = (id: string, kind = 'turn') => ({ id, kind, grantedAt: '2026-09-02T00:00:00.000Z' })
const fullNest = () => Array.from({ length: ZOO_MAX_EGGS }, (_, i) => egg(`e${i}`))
const zooOf = (patch: Partial<Zoo>, progress: Partial<ZooProgress> = {}): Zoo =>
  ({ ...emptyZoo(), ...patch, progress: { ...emptyProgress(), ...progress } })
const paired = (extra: Partial<ZooDaemon> = {}) => zooOf({ daemons: [daemon('tim', extra)], paired: uid('tim') })

type Report = [day: string, n: number, hour?: number, machineId?: string, extra?: Extra]
/** Report turns one batch at a time, each on its own day's clock; collect what came of them. */
function play(start: Zoo, reports: Report[], ctx: ZooContext = {}) {
  let zoo = start
  const grants: Grant[] = []
  const levelUps: LevelUp[] = []
  const changed: boolean[] = []
  for (const [i, [day, n, hour = 12, machineId = 'm1', extra = {}]] of reports.entries()) {
    const r = applyZooOps(zoo, [turn(day, n, hour, machineId, undefined, extra)], seeded(i + 1), noonOf(day), ctx)
    zoo = r.zoo
    grants.push(...r.grants)
    levelUps.push(...r.levelUps)
    changed.push(r.changed)
  }
  return { zoo, grants, levelUps, changed }
}
const kinds = (grants: Grant[]) => grants.map((g) => g.kind)
/** 20 counted turns on each of `days` consecutive days from `from`. */
function fullDays(from: string, days: number, hour = 12): Report[] {
  const start = noonOf(from).getTime()
  return Array.from({ length: days }, (_, i) => [new Date(start + i * 86_400_000).toISOString().slice(0, 10), 20, hour])
}

describe('the rules the server grants by', () => {
  it('are the ones the roster sets', () => {
    expect(RULES.earn).toEqual({
      turn: { every: 40, dailyCap: 20, minutesPerTurn: 10 },
      week: { days: 3 },
      marathon: { turns: 500, machines: 2 },
      night: { nights: 3, fromHour: 22, toHour: 6, awayMinutes: 30 },
      history: { days: 7 },
    })
    expect(RULES.bond).toEqual({ xpPerTurn: 1, xpPerDay: 5, levels: [0, 50, 150, 300, 600] })
    // (`duplicateXp` is no longer the server's: a species hatched again is an individual of its own.)
    expect({ overflowXp: RULES.overflowXp, lessonXp: RULES.lessonXp }).toEqual({ overflowXp: 50, lessonXp: 25 })
    expect(RULES.historyDates).toEqual({ '04-01': 'teapot', '08-25': 'tux', '09-09': 'bug', '09-27': 'gnu', '10-31': 'zombie' })
    expect(Object.keys(RULES.eggs)).toEqual(expect.arrayContaining(['turn', 'week', 'marathon', 'night', 'history']))
  })
})

describe('zoo.turn — what the server accepts', () => {
  const parse = (patch: Record<string, unknown>) => zooOpSchema.safeParse({ ...turn('2026-09-26', 3), ...patch }).success

  it('takes 1-50 turns, a real local day, an hour and id-safe batch and machine ids', () => {
    expect(parse({})).toBe(true)
    expect(parse({ minutes: 0, away: 0 })).toBe(true)
    expect(parse({ minutes: ZOO_TURN_MAX_MINUTES, away: 3 })).toBe(true)
    expect(parse({ n: 50, hour: 0, day: '2028-02-29', batchId: 'x'.repeat(64), machineId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' })).toBe(true)
    expect(parse({ hour: 23 })).toBe(true)
  })

  it('refuses absurd values', () => {
    for (const n of [0, -1, 51, 1.5, '3', 1e9, Number.NaN]) expect(parse({ n }), `n=${n}`).toBe(false)
    for (const hour of [-1, 24, 12.5, '12']) expect(parse({ hour }), `hour=${hour}`).toBe(false)
    for (const minutes of [-1, 1.5, '10', ZOO_TURN_MAX_MINUTES + 1]) expect(parse({ minutes }), `minutes=${minutes}`).toBe(false)
    for (const away of [-1, 1.5, 4, 51, '1']) expect(parse({ away }), `away=${away}`).toBe(false)   // n is 3: away is at most n
    for (const day of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-9-1', '26-09-01', '1999-12-31', '3000-01-01', '2026-09-26T00:00', '']) {
      expect(parse({ day }), `day=${day}`).toBe(false)
    }
    for (const id of ['', 'has space', 'x'.repeat(65), 'a/b']) {
      expect(parse({ batchId: id }), `batchId=${id}`).toBe(false)
      expect(parse({ machineId: id }), `machineId=${id}`).toBe(false)
    }
    expect(parse({ eggs: 3 })).toBe(false)                                   // no client-sent results
    expect(zooOpSchema.safeParse({ op: 'zoo.turn', batchId: 'b', n: 1, day: '2026-09-26', hour: 1 }).success).toBe(false)
    expect(zooOpsBodySchema.safeParse({ ops: [turn('2026-09-26', 1), { ...turn('2026-09-26', 1), n: 99 }] }).success).toBe(false)
  })

  it('knows a calendar day', () => {
    expect(['2026-01-01', '2024-02-29', '2026-12-31'].every(isLocalDay)).toBe(true)
    expect(['2025-02-29', '2026-04-31', '2026-00-10', '2026-01-00'].some(isLocalDay)).toBe(false)
  })

  it('drops a day that cannot be today anywhere, allowing one day late', () => {
    const now = new Date('2026-09-26T12:00:00.000Z')
    const accept = (day: string) => applyZooOps(emptyZoo(), [turn(day, 1)], seeded(), now).changed
    expect(['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'].map(accept)).toEqual([true, true, true, true])
    expect(['2026-09-23', '2026-09-28', '2025-09-26', '2027-09-26'].map(accept)).toEqual([false, false, false, false])
    // Just after midnight UTC, a turn at 14:30 in Hawaii is still on yesterday's date.
    expect(applyZooOps(emptyZoo(), [turn('2026-09-25', 1, 14)], seeded(), new Date('2026-09-26T00:30:00.000Z')).changed).toBe(true)
  })
})

describe('the daily cap', () => {
  it('counts at most 20 turns a local day, across batches and machines', () => {
    const r = play(emptyZoo(), [['2026-09-21', 15], ['2026-09-21', 4, 13, 'm2'], ['2026-09-21', 10, 14], ['2026-09-21', 3, 15]])
    expect(r.zoo.progress.days).toEqual({ '2026-09-21': 20 })
    expect(r.zoo.progress.turns).toBe(20)
    expect(r.changed).toEqual([true, true, true, false])                    // the last one found the day full
    expect(r.zoo.progress.batches).toHaveLength(3)                          // and is not remembered
    const next = play(r.zoo, [['2026-09-22', 50]])
    expect(next.zoo.progress.days).toEqual({ '2026-09-21': 20, '2026-09-22': 20 })
    expect(next.zoo.progress.turns).toBe(40)
  })

  it('forgets per-day counts older than two weeks', () => {
    const r = play(emptyZoo(), fullDays('2026-09-01', 30).map(([d]) => [d, 1] as Report))
    expect(Object.keys(r.zoo.progress.days).sort()).toEqual(fullDays('2026-09-17', 14).map(([d]) => d))
    expect(r.zoo.progress.turns).toBe(30)
  })
})

describe('long turns', () => {
  it('count once more for every 10 agent-minutes in the batch', () => {
    const r = play(paired(), [['2026-09-26', 2, 12, 'm1', { minutes: 35 }]])        // 2 turns + 3
    expect(r.zoo.progress).toMatchObject({ turns: 5, days: { '2026-09-26': 5 } })
    expect(r.zoo.daemons[0].xp).toBe(5 + 5)
    expect(play(paired(), [['2026-09-26', 1, 12, 'm1', { minutes: 9 }]]).zoo.progress.turns).toBe(1)
    expect(play(paired(), [['2026-09-26', 1, 12, 'm1', { minutes: 0 }]]).zoo.progress.turns).toBe(1)
  })

  it('stay under the daily cap of 20', () => {
    const r = play(paired(), [['2026-09-26', 10, 12, 'm1', { minutes: 200 }], ['2026-09-26', 1, 13, 'm1', { minutes: 600 }]])
    expect(r.zoo.progress).toMatchObject({ turns: 20, days: { '2026-09-26': 20 } })
    expect(r.changed).toEqual([true, false])
    expect(r.zoo.daemons[0].xp).toBe(20 + 5)
  })

  it('earn turn eggs like any counted turn', () => {
    const r = play(zooOf({}, { turns: 38 }), [['2026-09-26', 1, 12, 'm1', { minutes: 25 }]])
    expect(kinds(r.grants)).toEqual(['turn'])
    expect(r.zoo.progress.turns).toBe(41)
  })
})

describe('turn eggs', () => {
  it('grants one every 40 counted turns', () => {
    const r = play(emptyZoo(), fullDays('2026-09-21', 5))                   // 100 counted turns
    expect(kinds(r.grants).filter((k) => k === 'turn')).toHaveLength(2)
    expect(r.zoo.eggs.filter((e) => e.kind === 'turn')).toHaveLength(2)
    expect(r.grants.map((g) => g.eggId)).toEqual(r.zoo.eggs.map((e) => e.id))
    const edge = play(zooOf({}, { turns: 39 }), [['2026-09-26', 1]])
    expect(kinds(edge.grants)).toEqual(['turn'])
    expect(edge.zoo.eggs[0]).toEqual({ id: expect.stringMatching(/^[a-z2-9]{10}$/), kind: 'turn', grantedAt: '2026-09-26T12:00:00.000Z' })
  })
})

describe('week eggs', () => {
  it('grants one after work on 3 distinct days of an ISO week, once that week', () => {
    // Mon, Tue, Wed of 2026-W39 (Sep 21-27), then Thu and Sun of the same week. (Sun 09-27 is a history
    // date too: its egg is the only other one.)
    const r = play(emptyZoo(), [['2026-09-21', 1], ['2026-09-22', 1], ['2026-09-22', 1], ['2026-09-23', 1], ['2026-09-24', 1], ['2026-09-27', 1]])
    expect(kinds(r.grants)).toEqual(['week', 'history'])
    expect(r.zoo.progress.weeks).toEqual(['2026-W39'])
    // Mon of the next week starts over: Sun + Mon + Tue straddle two weeks and earn nothing.
    const next = play(r.zoo, [['2026-09-28', 1], ['2026-09-29', 1]])
    expect(kinds(next.grants)).toEqual([])
    expect(kinds(play(next.zoo, [['2026-10-04', 1]]).grants)).toEqual(['week'])  // Sunday: third day of W40
  })

  it('does not count a day whose turns all fell past the cap as a new day', () => {
    const r = play(emptyZoo(), [['2026-09-21', 1], ['2026-09-22', 1]])
    expect(kinds(play(r.zoo, [['2026-09-21', 5]]).grants)).toEqual([])
  })

  it('reads weeks the ISO way across the end of a year', () => {
    expect(isoWeek('2026-09-26')).toBe('2026-W39')
    expect(isoWeek('2026-12-28')).toBe('2026-W53')
    expect(isoWeek('2027-01-01')).toBe('2026-W53')
    expect(isoWeek('2027-01-03')).toBe('2026-W53')
    expect(isoWeek('2027-01-04')).toBe('2027-W01')
    expect(isoWeek('2024-12-30')).toBe('2025-W01')
    expect(isoWeek('2021-01-03')).toBe('2020-W53')
    expect(isoWeek('2025-12-29')).toBe('2026-W01')
    // Mon Dec 28, Thu Dec 31, Fri Jan 1: one week, one egg, granted in the new year.
    const r = play(emptyZoo(), [['2026-12-28', 1], ['2026-12-31', 1], ['2027-01-01', 1]])
    expect(kinds(r.grants)).toEqual(['week'])
    expect(r.zoo.progress.weeks).toEqual(['2026-W53'])
    // Sat Jan 2 is still W53 (already earned); Mon Jan 4 to Wed Jan 6 is 2027-W01.
    const next = play(r.zoo, [['2027-01-02', 1], ['2027-01-04', 1], ['2027-01-05', 1], ['2027-01-06', 1]])
    expect(kinds(next.grants)).toEqual(['week'])
    expect(next.zoo.progress.weeks).toEqual(['2026-W53', '2027-W01'])
  })

  it('crosses a year the other way too: late December can be week 1', () => {
    const r = play(emptyZoo(), [['2025-12-29', 1], ['2025-12-31', 1], ['2026-01-02', 1]])
    expect(r.zoo.progress.weeks).toEqual(['2026-W01'])
    expect(kinds(r.grants)).toEqual(['week'])
  })
})

describe('night eggs', () => {
  const away = (n = 1): Extra => ({ away: n })
  const nights = (grants: Grant[]) => kinds(grants).filter((k) => k === 'night')   // (three days also make a week)

  it('names a night by the day it began: 22:00 to 06:59, across midnight and the year', () => {
    expect([21, 22, 23].map((h) => nightOf('2026-09-21', h))).toEqual([null, '2026-09-21', '2026-09-21'])
    expect([0, 3, 6, 7, 12].map((h) => nightOf('2026-09-22', h))).toEqual(['2026-09-21', '2026-09-21', '2026-09-21', null, null])
    expect(nightOf('2027-01-01', 2)).toBe('2026-12-31')
    expect(nightOf('2028-03-01', 1)).toBe('2028-02-29')
  })

  it('grants one after 3 distinct nights with a turn that finished while you were away, then counts again', () => {
    const r = play(emptyZoo(), [
      ['2026-09-21', 1, 23, 'm1', away()], ['2026-09-22', 1, 2, 'm1', away()],   // one night, twice
      ['2026-09-22', 1, 7, 'm1', away()], ['2026-09-22', 1, 21, 'm1', away()],   // 07:00 and 21:00 are not night
      ['2026-09-23', 1, 23],                                                      // at the keyboard: not away
      ['2026-09-24', 1, 6, 'm1', away()],                                         // the night of the 23rd
    ])
    expect(nights(r.grants)).toEqual([])
    expect(r.zoo.progress.nights).toEqual(['2026-09-21', '2026-09-23'])
    const third = play(r.zoo, [['2026-09-25', 1, 22, 'm1', away()]])
    expect(nights(third.grants)).toEqual(['night'])
    expect(third.zoo.progress.nights).toEqual([])
    const again = play(third.zoo, [['2026-09-26', 1, 1, 'm1', away()], ['2026-09-27', 1, 1, 'm1', away()]])
    expect(nights(again.grants)).toEqual([])
    expect(nights(play(again.zoo, [['2026-09-28', 1, 4, 'm1', away()]]).grants)).toEqual(['night'])
  })

  it('never counts a night for turns you were there for, however late', () => {
    const r = play(emptyZoo(), [['2026-09-21', 5, 23], ['2026-09-23', 5, 2], ['2026-09-24', 5, 3, 'm1', { away: 0 }], ['2026-09-26', 5, 0]])
    expect(r.zoo.progress.nights).toEqual([])
  })

  it('needs the night turn to count', () => {
    const capped = play(zooOf({}, { days: { '2026-09-26': 20 }, machines: ['m1'] }), [['2026-09-26', 3, 2, 'm1', away(3)]])
    expect(capped.changed).toEqual([false])
    expect(capped.zoo.progress.nights).toEqual([])
  })
})

describe('history eggs', () => {
  it('grants one on a history date, on its first counted turn, once that year, with its date', () => {
    const r = play(emptyZoo(), [['2026-09-06', 1], ['2026-09-09', 1, 9], ['2026-09-09', 5, 15], ['2026-09-10', 1]])
    expect(kinds(r.grants)).toEqual(['history'])
    expect(r.zoo.eggs).toEqual([expect.objectContaining({ kind: 'history', date: '2026-09-09' })])
    expect(r.zoo.progress.history).toEqual(['2026-09-09'])
    const halloween = play(r.zoo, [['2026-10-31', 2]])
    expect(halloween.zoo.eggs.map((e) => e.date)).toEqual(['2026-09-09', '2026-10-31'])
    const nextYear = play(halloween.zoo, [['2027-04-01', 1], ['2027-09-09', 1], ['2027-09-09', 1]])
    expect(kinds(nextYear.grants)).toEqual(['history', 'history'])
    expect(nextYear.zoo.progress.history).toEqual(['2026-09-09', '2026-10-31', '2027-04-01', '2027-09-09'])
  })

  it('stays open for a week from its date, and is still once per date per year', () => {
    expect(historyDatesOpen('2026-09-08')).toEqual([])
    expect(historyDatesOpen('2026-09-09')).toEqual(['2026-09-09'])
    expect(historyDatesOpen('2026-09-15')).toEqual(['2026-09-09'])
    expect(historyDatesOpen('2026-09-16')).toEqual([])
    expect(historyDatesOpen('2026-11-06')).toEqual(['2026-10-31'])
    expect(historyDatesOpen('2026-11-07')).toEqual([])
    // Late in the week: the egg carries the date it remembers, not the day it was earned.
    const late = play(emptyZoo(), [['2026-09-15', 1]])
    expect(late.zoo.eggs).toEqual([expect.objectContaining({ kind: 'history', date: '2026-09-09' })])
    const early = play(emptyZoo(), [['2026-09-08', 1], ['2026-09-16', 1]])
    expect(kinds(early.grants)).toEqual([])
    const twice = play(emptyZoo(), [['2026-09-10', 1], ['2026-09-12', 1], ['2026-09-14', 1]])
    expect(kinds(twice.grants).filter((k) => k === 'history')).toEqual(['history'])
    expect(kinds(play(twice.zoo, [['2027-09-13', 1]]).grants)).toEqual(['history'])
  })

  it('draws from the usual pool while no drop holds that date\'s daemon', () => {
    expect(DAEMON_ROSTER.daemons.map((d) => d.id)).not.toContain('zombie')
    const zoo = zooOf({ eggs: [{ ...egg('h', 'history'), date: '2026-10-31' }] })
    expect(historyDaemon(zoo, '2026-10-31', noonOf('2026-11-01'))).toBeNull()
    expect(historyDaemon(zoo, '2026-09-26', noonOf('2026-11-01'))).toBeNull()
    expect(historyDaemon(zoo, undefined, noonOf('2026-11-01'))).toBeNull()
    // The usual pool of a history egg holds no secret (only night and easter eggs do).
    expect(drawWeights(zoo, 'history', noonOf('2026-11-01')).filter((w) => w.weight > 0).map((w) => w.id)).toEqual(REGULARS)
    const r = applyZooOps(zoo, [{ op: 'zoo.hatch', eggId: 'h' }], seeded(), noonOf('2026-11-01'))
    expect(REGULARS).toContain(r.hatched[0].daemonId)
    expect(r.zoo.daemons[0].egg).toBe('history')
  })
})

describe('marathon eggs', () => {
  it('grants one at 500 counted turns, once', () => {
    const r = play(zooOf({}, { turns: 495 }), [['2026-09-26', 10], ['2026-09-27', 20]])
    expect(kinds(r.grants)).toEqual(['marathon', 'turn', 'history'])       // 505, then 525 crosses 520 (and 09-27 is a history date)
    expect(r.zoo.progress.marathon).toEqual(['turns'])
    expect(kinds(play(zooOf({}, { turns: 999, marathon: ['turns'] }), [['2026-09-26', 1]]).grants)).toEqual(['turn'])
  })

  it('grants one when a second machine reports, once, and only for the account\'s machines', () => {
    const r = play(emptyZoo(), [['2026-09-26', 1, 12, 'm1'], ['2026-09-26', 1, 13, 'm1'], ['2026-09-26', 1, 14, 'm2'], ['2026-09-26', 1, 15, 'm3']])
    expect(kinds(r.grants)).toEqual(['marathon'])
    expect(r.zoo.progress).toMatchObject({ machines: ['m1', 'm2'], marathon: ['machines'] })
    const mine = new Set(['m1'])
    const strangers = play(emptyZoo(), [['2026-09-26', 1, 12, 'm1'], ['2026-09-26', 1, 13, 'made-up']], { ownsMachine: (id) => mine.has(id) })
    expect(kinds(strangers.grants)).toEqual([])
    expect(strangers.zoo.progress).toMatchObject({ machines: ['m1'], turns: 2 })   // its turn still counted
  })

  it('counts a new machine even on a day already at the cap', () => {
    const r = play(zooOf({}, { days: { '2026-09-26': 20 }, machines: ['m1'] }), [['2026-09-26', 1, 12, 'm2']])
    expect(r.changed).toEqual([true])
    expect(kinds(r.grants)).toEqual(['marathon'])
    expect(r.zoo.progress.turns).toBe(0)
  })
})

describe('a full nest', () => {
  it('holds earned eggs back, keeps count, and lets them in as room appears, oldest first', () => {
    // Fri 09-25 at 02:00 is the 40th turn and, away, the third night; Sun 09-27 is the 80th, the third day of
    // W39 and a history date.
    const start = zooOf({ eggs: fullNest() }, { turns: 39, nights: ['2026-09-22', '2026-09-23'] })
    const r = play(start, [['2026-09-25', 1, 2, 'm1', { away: 1 }], ['2026-09-26', 20], ['2026-09-27', 20], ['2026-10-31', 1]])
    expect(r.grants).toEqual([])
    expect(r.zoo.eggs).toHaveLength(ZOO_MAX_EGGS)
    expect(r.zoo.progress.held).toEqual([
      { kind: 'turn' }, { kind: 'night' }, { kind: 'turn' }, { kind: 'week' }, { kind: 'history', date: '2026-09-27' }, { kind: 'history', date: '2026-10-31' },
    ])
    const one = applyZooOps(r.zoo, [{ op: 'zoo.hatch', eggId: 'e0' }], seeded(), noonOf('2026-11-01'))
    expect(one.hatched).toHaveLength(1)
    expect(one.grants).toEqual([{ kind: 'turn', eggId: expect.any(String) }])
    expect(one.zoo.eggs).toHaveLength(ZOO_MAX_EGGS)
    expect(one.zoo.progress.held.map((h) => h.kind)).toEqual(['night', 'turn', 'week', 'history', 'history'])
    const all = applyZooOps(one.zoo, ['e1', 'e2', 'e3', 'e4', 'e5'].map((eggId) => ({ op: 'zoo.hatch' as const, eggId })), seeded(), noonOf('2026-11-01'))
    expect(kinds(all.grants)).toEqual(['night', 'turn', 'week', 'history', 'history'])
    expect(all.zoo.progress.held).toEqual([])
    expect(all.zoo.eggs.at(-1)).toMatchObject({ kind: 'history', date: '2026-10-31', grantedAt: '2026-11-01T12:00:00.000Z' })
  })

  it('turns each egg earned past 64 held into 50 xp for the pair, answered as a grant', () => {
    const held = Array.from({ length: ZOO_MAX_HELD }, () => ({ kind: 'turn' }))
    const start = zooOf({ daemons: [daemon('tim', { xp: 40 })], paired: uid('tim'), eggs: fullNest() }, { turns: 39, held })
    const r = play(start, [['2026-09-26', 1]])
    expect(r.zoo.progress.held).toHaveLength(ZOO_MAX_HELD)
    expect(r.zoo.progress.turns).toBe(40)
    expect(r.grants).toEqual([{ kind: 'turn', xp: 50 }])
    expect(r.zoo.daemons[0].xp).toBe(40 + 50 + 1 + 5)                     // the egg's 50, then the turn's own xp
    expect(r.levelUps).toEqual([{ uid: uid('tim'), id: 'tim', level: 1, version: '0.1' }])
    // Two at once (a turn egg and a week egg) are two grants.
    const two = play(zooOf({ daemons: [daemon('tim')], paired: uid('tim'), eggs: fullNest() }, { turns: 79, held, days: { '2026-09-21': 1, '2026-09-22': 1 } }), [['2026-09-23', 1]])
    expect(two.grants).toEqual([{ kind: 'turn', xp: 50 }, { kind: 'week', xp: 50 }])
    expect(two.zoo.daemons[0].xp).toBe(100 + 1 + 5)
  })

  it('has nobody to grow past 64 held while nothing has hatched', () => {
    const held = Array.from({ length: ZOO_MAX_HELD }, () => ({ kind: 'turn' }))
    const r = play(zooOf({ eggs: fullNest() }, { turns: 39, held }), [['2026-09-26', 1]])
    expect(r.grants).toEqual([])
    expect(r.zoo.progress.held).toHaveLength(ZOO_MAX_HELD)
  })

  it('lets a held egg in on any write once there is room', () => {
    const zoo = zooOf({ daemons: [daemon('tim')] }, { held: [{ kind: 'week' }] })
    const r = applyZooOps(zoo, [{ op: 'zoo.nickname', uid: uid('tim'), name: 'timothy' }], seeded(), noonOf('2026-09-26'))
    expect(kinds(r.grants)).toEqual(['week'])
    expect(r.zoo.progress.held).toEqual([])
  })
})

describe('bond: xp, levels and versions', () => {
  it('levels at 0, 50, 150, 300, 600 xp; 1.0 at level 2, 2.0 at level 4', () => {
    expect([0, 49, 50, 149, 150, 299, 300, 599, 600, 1e9].map(levelFor)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4])
    expect([0, 1, 2, 3, 4].map(versionFor)).toEqual(['0.1', '0.1', '1.0', '1.0', '2.0'])
  })

  it('gives the paired daemon 1 xp a counted turn and 5 for the first counted turn of a day', () => {
    const r = play(paired(), [['2026-09-26', 3], ['2026-09-26', 2], ['2026-09-27', 1], ['2026-09-27', 30]])
    expect(r.zoo.daemons[0].xp).toBe(5 + 3 + 2 + 5 + 1 + 19)               // the second day's last batch capped at 19
    const capped = play(r.zoo, [['2026-09-27', 5]])
    expect(capped.zoo.daemons[0].xp).toBe(r.zoo.daemons[0].xp)
  })

  it('gives nothing without a pair, and only the paired individual, not others of its species', () => {
    expect(play(zooOf({ daemons: [daemon('tim')] }), [['2026-09-26', 3]]).zoo.daemons[0].xp).toBe(0)
    const tims = [daemon('yak'), daemon('tim'), daemon('tim', { uid: uid('tim2') })]
    const second = play(zooOf({ daemons: tims, paired: uid('tim2') }), [['2026-09-26', 3]])
    expect(second.zoo.daemons.map((d) => d.xp)).toEqual([0, 0, 8])
    expect(play(zooOf({ daemons: tims, paired: uid('tim') }), [['2026-09-26', 3]]).zoo.daemons.map((d) => d.xp)).toEqual([0, 8, 0])
    // A level reached names the individual by its uid.
    const up = play(zooOf({ daemons: tims.map((d) => ({ ...d, xp: 45 })), paired: uid('tim2') }), [['2026-09-26', 3]])
    expect(up.levelUps).toEqual([{ uid: uid('tim2'), id: 'tim', level: 1, version: '0.1' }])
  })

  it('answers each level reached with its version, and bumps bond and version', () => {
    const r = play(paired({ xp: 40 }), [['2026-09-26', 10]])                // 40 + 5 + 10 = 55
    expect(r.levelUps).toEqual([{ uid: uid('tim'), id: 'tim', level: 1, version: '0.1' }])
    expect(r.zoo.daemons[0]).toMatchObject({ xp: 55, bond: 1, version: '0.1' })
    const two = play(paired({ xp: 140, bond: 1 }), [['2026-09-26', 5]])
    expect(two.levelUps).toEqual([{ uid: uid('tim'), id: 'tim', level: 2, version: '1.0' }])
    expect(two.zoo.daemons[0]).toMatchObject({ bond: 2, version: '1.0' })
    const four = play(paired({ xp: 590, bond: 3, version: '1.0' }), [['2026-09-26', 5]])
    expect(four.levelUps).toEqual([{ uid: uid('tim'), id: 'tim', level: 4, version: '2.0' }])
    const past = play(four.zoo, [['2026-09-27', 20]])
    expect(past.levelUps).toEqual([])
    expect(past.zoo.daemons[0]).toMatchObject({ bond: 4, version: '2.0' })
  })

  it('grows from a fresh hatch to 2.0 in about a month of full days', () => {
    const r = play(paired(), fullDays('2026-09-01', 24))                   // 25 xp a full day
    expect(r.levelUps.map((l) => l.level)).toEqual([1, 2, 3, 4])
    expect(r.zoo.daemons[0]).toMatchObject({ xp: 600, bond: 4, version: '2.0' })
  })

  it('reads bond and version from xp, and gives a daemon stored without xp (from before individuals) the xp its bond needs', () => {
    const old = (id: string) => ({ id, hatchedAt: '2026-09-01T00:00:00.000Z', egg: 'first', shiny: false, bond: 0, version: '0.1' })
    const zoo = parseZoo({
      daemons: [
        { ...old('tim'), bond: 2, version: '0.1' },
        { ...daemon('yak'), xp: 700, bond: 0, version: '0.1' },
        { ...daemon('gopher'), xp: 10, bond: 3, version: '2.0' },
        { ...daemon('gnu'), xp: -1 },
        { ...daemon('lynx'), xp: undefined, bond: 2 },                     // an individual always has xp
      ],
    })
    expect(zoo.daemons.map(({ id, xp, bond, version }) => ({ id, xp, bond, version }))).toEqual([
      { id: 'tim', xp: 150, bond: 2, version: '1.0' },
      { id: 'yak', xp: 700, bond: 4, version: '2.0' },
      { id: 'gopher', xp: 10, bond: 0, version: '0.1' },
    ])
  })
})

describe('batches', () => {
  it('drops a replayed batch, whatever it says', () => {
    const op = turn('2026-09-26', 5)
    const once = applyZooOps(paired(), [op], seeded(), noonOf('2026-09-26'))
    const twice = applyZooOps(once.zoo, [op, { ...op, n: 9 } as ZooOp], seeded(), noonOf('2026-09-26'))
    expect(twice).toEqual({ changed: false, zoo: once.zoo, hatched: [], grants: [], levelUps: [] })
    expect(once.zoo.progress).toMatchObject({ turns: 5, batches: [(op as { batchId: string }).batchId] })
  })

  it('remembers the last 64', () => {
    const r = play(emptyZoo(), fullDays('2026-06-01', ZOO_BATCH_MEMORY + 6).map(([day]) => [day, 1] as Report))
    expect(r.changed.every(Boolean)).toBe(true)
    expect(r.zoo.progress.batches).toHaveLength(ZOO_BATCH_MEMORY)
  })

  it('applies a request of several batches in order', () => {
    const away = { away: 1 }
    const r = applyZooOps(paired(), [turn('2026-09-26', 1, 3, 'm1', undefined, away), turn('2026-09-26', 2, 4, 'm1', undefined, away), turn('2026-09-27', 1, 0, 'm1', undefined, away)], seeded(), noonOf('2026-09-26'))
    expect(r.zoo.progress).toMatchObject({ turns: 4, days: { '2026-09-26': 3, '2026-09-27': 1 }, nights: ['2026-09-25', '2026-09-26'] })
    expect(r.zoo.daemons[0].xp).toBe(5 + 3 + 5 + 1)
  })

  it('never changes the zoo it was handed', () => {
    const start = zooOf({ daemons: [daemon('tim')], paired: uid('tim'), eggs: fullNest() }, { turns: 39, held: [{ kind: 'week' }] })
    const copy = structuredClone(start)
    applyZooOps(start, [turn('2026-09-26', 5, 1, 'm2'), { op: 'zoo.hatch', eggId: 'e0' }], seeded(), noonOf('2026-09-26'))
    expect(start).toEqual(copy)
  })
})

describe('every egg that arrives is answered', () => {
  it('answers the first and the easter egg as grants too', () => {
    const habits = [...RULES.firstEgg.habits].slice(0, RULES.firstEgg.need)
    const r = applyZooOps(emptyZoo(), [...habits.map((key) => ({ op: 'zoo.habit' as const, key })), { op: 'zoo.easter', word: 'xyzzy' }], seeded())
    expect(kinds(r.grants)).toEqual(['first', 'easter'])
    expect(r.grants.map((g) => g.eggId)).toEqual(r.zoo.eggs.map((e) => e.id))
  })
})

describe('stored and seeded progress', () => {
  it('reads progress piece by piece, dropping what does not parse and keeping the newest of a memory', () => {
    const zoo = parseZoo({
      progress: {
        turns: 12.5,
        days: { '2026-09-26': 99, '2026-09-25': 3, '2026-02-30': 1, 'yesterday': 2, '2026-09-24': 0 },
        weeks: ['2026-W30', 'W39', ...Array.from({ length: 10 }, (_, i) => `2026-W${String(i + 31).padStart(2, '0')}`)],
        nights: ['2026-09-20', 'nope', '2026-09-21', '2026-09-22'],
        machines: ['m1', 'm2', 'm3'],
        marathon: ['turns', 'turns', 'pr'],
        history: ['2026-09-09', 7],
        held: [{ kind: 'turn' }, { kind: 'history', date: '2026-09-09' }, { kind: 'bad kind' }, { kind: 'week', date: 'soon' }, 'junk'],
        batches: 'b1',
      },
    })
    expect(zoo.progress).toEqual({
      turns: 0,
      days: { '2026-09-26': 20, '2026-09-25': 3 },
      weeks: ['2026-W33', '2026-W34', '2026-W35', '2026-W36', '2026-W37', '2026-W38', '2026-W39', '2026-W40'],
      nights: ['2026-09-21', '2026-09-22'],
      machines: ['m1', 'm2'],
      marathon: ['turns'],
      history: ['2026-09-09'],
      held: [{ kind: 'turn' }, { kind: 'history', date: '2026-09-09' }, { kind: 'week' }],
      batches: [],
      lessons: [],
    })
    expect(parseZoo({}).progress).toEqual(emptyProgress())
  })

  it('never seeds a guest\'s progress: turns, nights and held eggs are self-reported, the account keeps its own', () => {
    const guest = { daemons: [daemon('gnu')], progress: { turns: 30, days: { '2026-09-26': 10 }, nights: ['2026-09-26'], machines: ['guest-computer'], batches: ['g1'], held: [{ kind: 'comet' }, { kind: 'week' }] } }
    const r = applyZooOps(emptyZoo(), [{ op: 'zoo.seed', zoo: guest }], seeded(), noonOf('2026-09-27'))
    expect(r.zoo.daemons.map((d) => d.id)).toEqual(['gnu'])
    expect(r.zoo.progress).toEqual(emptyZoo().progress)
    expect(r.grants).toEqual([])
    // Turns a signed-in harnessd already reported (the day before) are the account's, and stay.
    const reported = play(emptyZoo(), [['2026-09-26', 3]]).zoo
    const seededLate = applyZooOps(reported, [{ op: 'zoo.seed', zoo: guest }], seeded(), noonOf('2026-09-27'))
    expect(seededLate.zoo.daemons.map((d) => d.id)).toEqual(['gnu'])
    expect(seededLate.zoo.progress).toMatchObject({ turns: 3, machines: ['m1'] })
    // A guest with only progress seeds nothing.
    expect(applyZooOps(emptyZoo(), [{ op: 'zoo.seed', zoo: { progress: { turns: 7 } } }], seeded()).changed).toBe(false)
  })
})
