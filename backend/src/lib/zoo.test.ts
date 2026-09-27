import { describe, expect, it } from 'vitest'
import {
  applyZooOps, drawWeights, easterHash, emptyZoo, parseZoo, zooOpSchema, zooOpsBodySchema, zooShownChanged,
  ZOO_MAX_DAEMONS, ZOO_MAX_EGGS, type Rng, type Zoo, type ZooDaemon, type ZooOp,
} from './zoo.js'
import { DAEMON_ROSTER } from './daemonRoster.g.js'

const NOW = new Date('2026-09-27T12:00:00.000Z')
const UNIT = 1_000_000
const ALL = DAEMON_ROSTER.daemons.map((d) => d.id)
/** The drops out at NOW: drop 1 (init) only, released that day (unix and tty are on hold, with no dates). */
const OUT = new Set(DAEMON_ROSTER.drops.filter((d) => 'release' in d && Date.parse(`${d.release}T00:00:00.000Z`) <= NOW.getTime()).map((d) => d.id))
/** Drop 1's nine regulars: the numbered set. beastie is its secret, outside the set. */
const REGULARS = DAEMON_ROSTER.daemons.filter((d) => OUT.has(d.drop) && d.rarity !== 'secret').map((d) => d.id)
const HABITS = [...DAEMON_ROSTER.rules.firstEgg.habits]
const XYZZY = '184858a00fd7971f810848266ebcecee5e8b69972c5ffaed622f5ee078671aed'

/** A small seeded generator: realistic ids, reproducible runs. */
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
/** Answers `values` in order, then falls back to a seeded generator. */
function scripted(values: number[], rest: Rng = seeded(7)): Rng & { calls: number[] } {
  const queue = [...values]
  const calls: number[] = []
  const rng = ((n: number) => { calls.push(n); return queue.length ? queue.shift()! : rest(n) }) as Rng & { calls: number[] }
  rng.calls = calls
  return rng
}
/** The random index that lands a draw from `kind` on `id`. */
function indexOf(zoo: Zoo, kind: string, id: string): number {
  let at = 0
  for (const w of drawWeights(zoo, kind, NOW)) {
    if (w.id === id) { expect(w.weight).toBeGreaterThan(0); return at }
    at += w.weight
  }
  throw new Error(`${id} cannot come out of ${kind}`)
}
const daemon = (id: string, extra: Partial<ZooDaemon> = {}): ZooDaemon =>
  ({ id, hatchedAt: '2026-09-01T00:00:00.000Z', egg: 'first', shiny: false, bond: 0, xp: 0, version: '0.1', ...extra })
const zooOf = (patch: Partial<Zoo>): Zoo => ({ ...emptyZoo(), ...patch })
const egg = (id: string, kind = 'first') => ({ id, kind, grantedAt: '2026-09-02T00:00:00.000Z' })
const apply = (zoo: Zoo, ops: ZooOp[], rng: Rng = seeded()) => applyZooOps(zoo, ops, rng, NOW)
const weightOf = (zoo: Zoo, kind: string) => Object.fromEntries(drawWeights(zoo, kind, NOW).map((w) => [w.id, w.weight / UNIT]))
const habits = (...keys: string[]): ZooOp[] => keys.map((key) => ({ op: 'zoo.habit', key }))
const kinds = (zoo: Zoo) => zoo.eggs.map((e) => e.kind)

describe('first egg — habits', () => {
  it('asks for 3 habits, one of them a finished turn', () => {
    expect(DAEMON_ROSTER.rules.firstEgg).toMatchObject({ need: 3, require: ['turn'] })
    expect(DAEMON_ROSTER.rules.setupEgg).toEqual({ need: 6 })
  })

  it('grants the first egg on the third habit when a turn is one of them', () => {
    const two = apply(emptyZoo(), habits('turn', 'split'))
    expect(two.zoo.eggs).toEqual([])
    const third = apply(two.zoo, habits('find'))
    expect(third.changed).toBe(true)
    expect(third.zoo.eggs).toEqual([{ id: expect.stringMatching(/^[a-z2-9]{10}$/), kind: 'first', grantedAt: NOW.toISOString() }])
    expect(third.grants).toEqual([{ kind: 'first', eggId: third.zoo.eggs[0].id }])
    expect(third.zoo.firstEgg).toBe(true)
  })

  it('waits for a finished turn however many other habits are done', () => {
    const five = apply(emptyZoo(), habits('split', 'find', 'elsewhere', 'machine', 'store'))
    expect(five.zoo).toMatchObject({ eggs: [], firstEgg: false })
    const turn = apply(five.zoo, habits('turn'))
    // Six habits: the first egg, then the setup egg too, since the first has come.
    expect(kinds(turn.zoo)).toEqual(['first', 'setup'])
    expect(turn.grants.map((g) => g.kind)).toEqual(['first', 'setup'])
    expect(turn.zoo).toMatchObject({ firstEgg: true, setupEgg: true })
  })

  it('grants the setup egg at the sixth habit, once, after the first egg', () => {
    let zoo = apply(emptyZoo(), habits('turn', 'split', 'find', 'elsewhere', 'machine')).zoo
    expect(kinds(zoo)).toEqual(['first'])
    expect(zoo.setupEgg).toBe(false)
    const sixth = apply(zoo, habits('store'))
    expect(sixth.grants).toEqual([{ kind: 'setup', eggId: expect.any(String) }])
    expect(kinds(sixth.zoo)).toEqual(['first', 'setup'])
    expect(sixth.zoo.setupEgg).toBe(true)
    zoo = apply(sixth.zoo, habits('resume', 'days')).zoo
    expect(zoo.habits).toEqual(['turn', 'split', 'find', 'elsewhere', 'machine', 'store', 'resume', 'days'])
    expect(kinds(zoo)).toEqual(['first', 'setup'])
    // Hatched and gone, every habit again: no second first or setup egg.
    const hatched = apply(zoo, zoo.eggs.map((e) => ({ op: 'zoo.hatch' as const, eggId: e.id }))).zoo
    const again = apply(hatched, habits(...HABITS))
    expect(again.changed).toBe(false)
    expect(again.zoo.eggs).toEqual([])
  })

  it('draws the setup egg from the usual pool', () => {
    expect(DAEMON_ROSTER.rules.eggs.setup.weights).toEqual(DAEMON_ROSTER.rules.eggs.turn.weights)
    expect(weightOf(emptyZoo(), 'setup')).toEqual(weightOf(emptyZoo(), 'turn'))
  })

  it('grants the setup egg on the next habit when the nest was full', () => {
    const full = zooOf({ habits: HABITS.slice(0, 5), firstEgg: true, eggs: Array.from({ length: ZOO_MAX_EGGS }, (_, i) => egg(`e${i}`, 'turn')) })
    const blocked = apply(full, habits(HABITS[5]))
    expect(blocked.zoo.setupEgg).toBe(false)
    const roomy = apply(blocked.zoo, [{ op: 'zoo.hatch', eggId: 'e0' }]).zoo
    const granted = apply(roomy, habits(HABITS[5]))
    expect(granted.zoo.setupEgg).toBe(true)
    expect(kinds(granted.zoo).filter((k) => k === 'setup')).toHaveLength(1)
  })

  it('drops a habit it does not know, without refusing the batch', () => {
    const op = { op: 'zoo.habit', key: 'teleport' }
    expect(zooOpSchema.safeParse(op).success).toBe(true)
    const r = apply(emptyZoo(), [op as ZooOp, { op: 'zoo.habit', key: 'turn' }])
    expect(r.zoo.habits).toEqual(['turn'])
    expect(apply(emptyZoo(), [op as ZooOp]).changed).toBe(false)
    expect(zooOpSchema.safeParse({ op: 'zoo.habit', key: 'not a key' }).success).toBe(false)
  })

  it('grants the first egg on the next habit when the nest was full', () => {
    const full = zooOf({ habits: HABITS.slice(0, 4), eggs: Array.from({ length: ZOO_MAX_EGGS }, (_, i) => egg(`e${i}`, 'turn')) })
    const blocked = apply(full, [{ op: 'zoo.habit', key: HABITS[4] }])
    expect(blocked.zoo.firstEgg).toBe(false)
    expect(blocked.zoo.eggs).toHaveLength(ZOO_MAX_EGGS)
    const roomy = apply(blocked.zoo, [{ op: 'zoo.hatch', eggId: 'e0' }]).zoo
    const granted = apply(roomy, [{ op: 'zoo.habit', key: HABITS[4] }])        // already counted: the grant still lands
    expect(granted.changed).toBe(true)
    expect(granted.zoo.firstEgg).toBe(true)
    expect(granted.zoo.eggs.filter((e) => e.kind === 'first')).toHaveLength(1)
  })
})

describe('hatching', () => {
  it('removes the egg, adds the daemon at 0.1 with no bond, and pairs the first one', () => {
    const zoo = zooOf({ eggs: [egg('a'), egg('b', 'turn')] })
    const rng = scripted([indexOf(zoo, 'first', 'yak'), 5])
    const r = apply(zoo, [{ op: 'zoo.hatch', eggId: 'a' }], rng)
    expect(r.hatched).toEqual([{ eggId: 'a', daemonId: 'yak', shiny: false }])
    expect(r.zoo.eggs.map((e) => e.id)).toEqual(['b'])
    expect(r.zoo.daemons).toEqual([{ id: 'yak', hatchedAt: NOW.toISOString(), egg: 'first', shiny: false, bond: 0, xp: 0, version: '0.1' }])
    expect(r.zoo.pair).toBe('yak')
    const second = apply(r.zoo, [{ op: 'zoo.hatch', eggId: 'b' }], scripted([indexOf(r.zoo, 'turn', 'tim'), 9]))
    expect(second.zoo.daemons.map((d) => d.id)).toEqual(['yak', 'tim'])
    expect(second.zoo.daemons[1].egg).toBe('turn')
    expect(second.zoo.pair).toBe('yak')                                         // a pair is never replaced by a hatch
  })

  it('drops a hatch of an egg that is not there', () => {
    const r = apply(zooOf({ eggs: [egg('a')] }), [{ op: 'zoo.hatch', eggId: 'gone' }])
    expect(r).toMatchObject({ changed: false, hatched: [] })
    expect(r.zoo.eggs).toHaveLength(1)
  })

  it('never draws a regular you own until you own every regular', () => {
    const two = zooOf({ daemons: REGULARS.filter((id) => id !== 'tim' && id !== 'yak').map((id) => daemon(id)), eggs: [egg('a')] })
    expect(Object.keys(weightOf(two, 'turn'))).toEqual(['tim', 'yak'])
    for (let seed = 1; seed <= 40; seed++) {
      expect(['tim', 'yak']).toContain(apply(two, [{ op: 'zoo.hatch', eggId: 'a' }], seeded(seed)).hatched[0].daemonId)
    }
  })

  it('keeps the secret outside the set: the regulars complete without it, and only a night or easter egg holds it', () => {
    const eggsWithSecret = Object.entries(DAEMON_ROSTER.rules.eggs).filter(([, e]) => e.weights.secret > 0).map(([k]) => k)
    expect(eggsWithSecret.sort()).toEqual(['easter', 'night'])
    // Every regular owned, beastie not: the set is complete, so ordinary eggs give duplicates of regulars...
    const regulars = zooOf({ daemons: REGULARS.map((id) => daemon(id)), eggs: [egg('a')] })
    for (const kind of ['first', 'setup', 'turn', 'week', 'marathon', 'history']) {
      expect(Object.keys(weightOf(regulars, kind)), kind).toEqual(REGULARS)
    }
    for (let seed = 1; seed <= 40; seed++) {
      const r = apply(regulars, [{ op: 'zoo.hatch', eggId: 'a' }], seeded(seed))
      expect(r.hatched[0]).toMatchObject({ duplicate: true })
      expect(r.hatched[0].daemonId).not.toBe('beastie')
    }
    // ...while a night egg can still hold beastie, beside the duplicates.
    expect(weightOf(regulars, 'night')).toMatchObject({ beastie: 8, tim: 12.5, bug: 40 })
    // Not owning beastie never holds back duplicates, and owning it never counts toward the set.
    const withBeastie = zooOf({ daemons: ['beastie', 'tim'].map((id) => daemon(id)) })
    expect(Object.keys(weightOf(withBeastie, 'turn'))).toEqual(REGULARS.filter((id) => id !== 'tim'))
  })

  it('merges a duplicate into the one you have: xp and levels, shiny, and a count', () => {
    const everyone = zooOf({ daemons: ALL.map((id) => daemon(id)), eggs: [egg('a'), egg('b'), egg('c')], pair: 'tux' })
    expect(weightOf(everyone, 'first')).toEqual({ tim: 60, gnu: 15, lynx: 15, mutt: 15, yak: 9, gopher: 9, bug: 9, tux: 6, auk: 6 })
    const xp = DAEMON_ROSTER.rules.duplicateXp
    expect(xp).toBe(150)
    const one = apply(everyone, [{ op: 'zoo.hatch', eggId: 'a' }], scripted([indexOf(everyone, 'first', 'tim'), 1]))
    expect(one.hatched).toEqual([{ eggId: 'a', daemonId: 'tim', shiny: false, duplicate: true, xp }])
    expect(one.zoo.daemons).toHaveLength(ALL.length)                         // merged, not added
    expect(one.zoo.daemons.find((d) => d.id === 'tim')).toEqual({ ...daemon('tim'), xp: 150, bond: 2, version: '1.0', dupes: 1 })
    expect(one.levelUps).toEqual([{ id: 'tim', level: 2, version: '1.0' }])
    expect(one.zoo.eggs.map((e) => e.id)).toEqual(['b', 'c'])
    // A shiny duplicate makes the one you have shiny, and keeps counting.
    const two = apply(one.zoo, [{ op: 'zoo.hatch', eggId: 'b' }], scripted([indexOf(one.zoo, 'first', 'tim'), 0]))
    expect(two.hatched).toEqual([{ eggId: 'b', daemonId: 'tim', shiny: true, duplicate: true, xp }])
    expect(two.zoo.daemons.find((d) => d.id === 'tim')).toMatchObject({ shiny: true, dupes: 2, xp: 300, bond: 3, version: '1.0' })
    expect(two.levelUps).toEqual([{ id: 'tim', level: 3, version: '1.0' }])
    // A plain duplicate never takes a shine away, and a duplicate at 2.0 gives xp but no level.
    const top = zooOf({ daemons: ALL.map((id) => daemon(id, id === 'yak' ? { xp: 900, bond: 4, version: '2.0', shiny: true } : {})), eggs: [egg('x')] })
    const three = apply(top, [{ op: 'zoo.hatch', eggId: 'x' }], scripted([indexOf(top, 'first', 'yak'), 1]))
    expect(three.zoo.daemons.find((d) => d.id === 'yak')).toMatchObject({ shiny: true, dupes: 1, xp: 1050, bond: 4 })
    expect(three.levelUps).toEqual([])
    expect(three.zoo.pair).toBeNull()                                        // a duplicate never pairs
    expect(two.zoo.pair).toBe('tux')
  })

  it('merges into the one you have even at the 64-daemon limit', () => {
    const many = [...ALL, ...Array.from({ length: ZOO_MAX_DAEMONS - ALL.length }, (_, i) => `old-${i}`)]
    const full = zooOf({ daemons: many.map((id) => daemon(id)), eggs: [egg('a')] })
    const r = apply(full, [{ op: 'zoo.hatch', eggId: 'a' }], scripted([indexOf(full, 'first', 'tim'), 1]))
    expect(r.hatched[0]).toMatchObject({ daemonId: 'tim', duplicate: true })
    expect(r.zoo.daemons).toHaveLength(ZOO_MAX_DAEMONS)
  })

  it('weighs a rarity by how many of it are left, and gives an empty rarity to nobody', () => {
    expect(weightOf(emptyZoo(), 'turn')).toEqual({ tim: 15, gnu: 15, lynx: 15, mutt: 15, yak: 9, gopher: 9, bug: 9, tux: 6, auk: 6 })
    expect(weightOf(zooOf({ daemons: [daemon('tim')] }), 'turn')).toMatchObject({ gnu: 20, lynx: 20, mutt: 20, yak: 9 })
    const noCommons = zooOf({ daemons: ['tim', 'gnu', 'lynx', 'mutt'].map((id) => daemon(id)) })
    const w = weightOf(noCommons, 'turn')
    expect(w).toEqual({ yak: 9, gopher: 9, bug: 9, tux: 6, auk: 6 })         // 39 in all: the commons' 60 went nowhere
  })

  it('makes tim the likely first hatch', () => {
    expect(DAEMON_ROSTER.rules.eggs.first.boost).toEqual({ tim: 4 })
    const w = weightOf(emptyZoo(), 'first')
    expect(w).toEqual({ tim: 60, gnu: 15, lynx: 15, mutt: 15, yak: 9, gopher: 9, bug: 9, tux: 6, auk: 6 })
    const total = Object.values(w).reduce((a, b) => a + b, 0)
    expect(w.tim / total).toBeCloseTo(60 / 144, 5)                           // about 42%, 4 times any other common
    let tims = 0
    for (let seed = 1; seed <= 400; seed++) {
      if (apply(zooOf({ eggs: [egg('a')] }), [{ op: 'zoo.hatch', eggId: 'a' }], seeded(seed)).hatched[0].daemonId === 'tim') tims++
    }
    expect(tims).toBeGreaterThan(120)
    expect(tims).toBeLessThan(220)
    // The boost is the first egg's: a turn egg weighs tim like any common.
    expect(weightOf(emptyZoo(), 'turn').tim).toBe(15)
  })

  it('counts pity only on eggs that can hold a secret, adds it to the secret, and resets it on one', () => {
    const zoo = zooOf({ eggs: [egg('f'), egg('n1', 'night'), egg('n2', 'night')], pity: 3 })
    expect(weightOf(zoo, 'night').beastie).toBe(8 + 3 * DAEMON_ROSTER.rules.pityPerMiss)
    expect(weightOf(zoo, 'first')).not.toHaveProperty('beastie')             // the pity never opens a first egg to it
    const first = apply(zoo, [{ op: 'zoo.hatch', eggId: 'f' }], scripted([indexOf(zoo, 'first', 'tim'), 1]))
    expect(first.zoo.pity).toBe(3)
    const miss = apply(first.zoo, [{ op: 'zoo.hatch', eggId: 'n1' }], scripted([indexOf(first.zoo, 'night', 'bug'), 1]))
    expect(miss.zoo.pity).toBe(4)
    const hit = apply(miss.zoo, [{ op: 'zoo.hatch', eggId: 'n2' }], scripted([indexOf(miss.zoo, 'night', 'beastie'), 1]))
    expect(hit.hatched[0].daemonId).toBe('beastie')
    expect(hit.zoo.pity).toBe(0)
  })

  it('gives the secret on the 8th hatch of an egg that can hold one, when you do not have it', () => {
    expect(DAEMON_ROSTER.rules.secretGuaranteeAt).toBe(8)
    let zoo = zooOf({ eggs: Array.from({ length: 8 }, (_, i) => egg(`n${i}`, 'night')) })
    // Ordinary eggs in between never move the count.
    zoo = { ...zoo, eggs: [...zoo.eggs, egg('t1', 'turn'), egg('t2', 'turn')] }
    zoo = apply(zoo, [{ op: 'zoo.hatch', eggId: 't1' }, { op: 'zoo.hatch', eggId: 't2' }], scripted([0, 1, 0, 1])).zoo
    expect(zoo.pity).toBe(0)
    for (let i = 0; i < 7; i++) {
      // A roll of 0 lands on the first regular with any weight: seven misses in a row.
      const r = apply(zoo, [{ op: 'zoo.hatch', eggId: `n${i}` }], scripted([0, 1]))
      expect(r.hatched[0].daemonId).not.toBe('beastie')
      zoo = r.zoo
    }
    expect(zoo.pity).toBe(7)
    expect(drawWeights(zoo, 'night', NOW).map((w) => w.id)).toEqual(['beastie'])
    expect(drawWeights(zoo, 'turn', NOW).map((w) => w.id)).not.toContain('beastie')
    const eighth = apply(zoo, [{ op: 'zoo.hatch', eggId: 'n7' }], scripted([0, 1]))
    expect(eighth.hatched[0].daemonId).toBe('beastie')
    expect(eighth.zoo.pity).toBe(0)
    // Owning beastie already, the count guarantees nothing: a night egg draws as usual.
    const owned = zooOf({ daemons: [daemon('beastie')], pity: 7 })
    expect(Object.keys(weightOf(owned, 'night'))).toEqual(REGULARS)
  })

  it('boosts a night egg toward bug', () => {
    expect(DAEMON_ROSTER.rules.eggs.night.boost).toEqual({ bug: 4 })
    const w = weightOf(emptyZoo(), 'night')
    expect(w.bug).toBe((30 / 3) * 4)
    expect(w.yak).toBe(30 / 3)                                               // the other rares are not boosted
    expect(w.tim).toBe(50 / 4)
    expect(w.beastie).toBe(8)
    const zoo = zooOf({ eggs: [egg('n', 'night')] })
    const r = apply(zoo, [{ op: 'zoo.hatch', eggId: 'n' }], scripted([indexOf(zoo, 'night', 'bug') + Math.floor(w.bug * UNIT) - 1, 1]))
    expect(r.hatched[0].daemonId).toBe('bug')
  })

  it('makes a daemon shiny on a 1-in-shinyOneIn roll, independent of who hatched', () => {
    const zoo = zooOf({ eggs: [egg('a')] })
    const lucky = scripted([indexOf(zoo, 'first', 'tim'), 0])
    const r = apply(zoo, [{ op: 'zoo.hatch', eggId: 'a' }], lucky)
    expect(lucky.calls[1]).toBe(DAEMON_ROSTER.rules.shinyOneIn)
    expect(r.hatched[0]).toEqual({ eggId: 'a', daemonId: 'tim', shiny: true })
    expect(r.zoo.daemons[0].shiny).toBe(true)
    const plain = apply(zoo, [{ op: 'zoo.hatch', eggId: 'a' }], scripted([indexOf(zoo, 'first', 'tim'), DAEMON_ROSTER.rules.shinyOneIn - 1]))
    expect(plain.hatched[0].shiny).toBe(false)
  })

  it('draws an easter egg that has nothing new to give as a duplicate rather than as nobody', () => {
    const zoo = zooOf({ daemons: ['tux', 'auk', 'beastie'].map((id) => daemon(id)), eggs: [egg('x', 'easter')] })
    expect(Object.fromEntries(Object.entries(weightOf(emptyZoo(), 'easter')).filter(([, w]) => w > 0))).toEqual({ tux: 45, auk: 45, beastie: 10 })
    const w = drawWeights(zoo, 'easter', NOW)
    expect(w.filter((x) => x.weight > 0).map((x) => x.id)).toEqual(['tux', 'auk', 'beastie'])
    const r = apply(zoo, [{ op: 'zoo.hatch', eggId: 'x' }])
    expect(['tux', 'auk', 'beastie']).toContain(r.hatched[0].daemonId)
  })

  it('leaves an egg of a kind the roster cannot draw where it is', () => {
    const zoo = zooOf({ eggs: [egg('q', 'comet'), egg('c', 'constructor')] })
    expect(drawWeights(zoo, 'constructor', NOW)).toEqual([])
    expect(apply(zoo, [{ op: 'zoo.hatch', eggId: 'q' }, { op: 'zoo.hatch', eggId: 'c' }]).changed).toBe(false)
  })

  it('stops hatching at 64 daemons', () => {
    const full = zooOf({ daemons: Array.from({ length: ZOO_MAX_DAEMONS }, () => daemon('tim')), eggs: [egg('a')] })
    expect(apply(full, [{ op: 'zoo.hatch', eggId: 'a' }]).changed).toBe(false)
  })

  it('uses crypto by default', () => {
    const r = applyZooOps(zooOf({ eggs: [egg('a')] }), [{ op: 'zoo.hatch', eggId: 'a' }])
    expect(ALL).toContain(r.hatched[0].daemonId)
  })
})

describe('pair, nickname, easter', () => {
  it('pairs only a daemon you own', () => {
    const zoo = zooOf({ daemons: [daemon('tim'), daemon('yak')], pair: 'tim' })
    expect(apply(zoo, [{ op: 'zoo.pair', id: 'yak' }]).zoo.pair).toBe('yak')
    expect(apply(zoo, [{ op: 'zoo.pair', id: 'tim' }]).changed).toBe(false)
    expect(apply(zoo, [{ op: 'zoo.pair', id: 'beastie' }]).changed).toBe(false)
  })

  it('sets a 1-24 character printable nickname, clears it with null, and refuses anything else', () => {
    const zoo = zooOf({ daemons: [daemon('tim'), daemon('tim')] })
    const named = apply(zoo, [{ op: 'zoo.nickname', id: 'tim', nickname: 'timothy' }])
    expect(named.zoo.daemons.map((d) => d.nickname)).toEqual(['timothy', undefined])   // the first one hatched
    expect(apply(named.zoo, [{ op: 'zoo.nickname', id: 'tim', nickname: 'timothy' }]).changed).toBe(false)
    const cleared = apply(named.zoo, [{ op: 'zoo.nickname', id: 'tim', nickname: null }])
    expect(cleared.zoo.daemons[0]).not.toHaveProperty('nickname')
    expect(apply(cleared.zoo, [{ op: 'zoo.nickname', id: 'tim', nickname: null }]).changed).toBe(false)
    expect(apply(zoo, [{ op: 'zoo.nickname', id: 'yak', nickname: 'nope' }]).changed).toBe(false)
    const parse = (nickname: unknown) => zooOpSchema.safeParse({ op: 'zoo.nickname', id: 'tim', nickname })
    expect(parse('x'.repeat(24)).success).toBe(true)
    expect(parse('  tim  ').data).toMatchObject({ nickname: 'tim' })
    for (const bad of ['', '   ', 'x'.repeat(25), 'tïm', 'tab\there', 'emoji 🐱']) expect(parse(bad).success, bad).toBe(false)
  })

  it('grants one easter egg per word, once, and only for a word it knows', () => {
    const r = apply(emptyZoo(), [{ op: 'zoo.easter', word: 'xyzzy' }])
    expect(r.zoo.eggs).toEqual([expect.objectContaining({ kind: 'easter' })])
    expect(r.zoo.easter).toEqual([XYZZY])                                    // the hash, never the word
    expect(apply(r.zoo, [{ op: 'zoo.easter', word: 'xyzzy' }]).changed).toBe(false)
    expect(apply(r.zoo, [{ op: 'zoo.easter', word: ' XYZZY ' }]).changed).toBe(false)   // the same word, spent
    expect(apply(emptyZoo(), [{ op: 'zoo.easter', word: 'XyZzY' }]).zoo.easter).toEqual([XYZZY])
    expect(apply(emptyZoo(), [{ op: 'zoo.easter', word: 'plugh' }]).changed).toBe(false)
    expect(apply(emptyZoo(), [{ op: 'zoo.easter', word: XYZZY }]).changed).toBe(false)  // the hash is not the word
    // A full nest leaves the word unspent.
    const full = zooOf({ eggs: Array.from({ length: ZOO_MAX_EGGS }, (_, i) => egg(`e${i}`)) })
    const blocked = apply(full, [{ op: 'zoo.easter', word: 'xyzzy' }])
    expect(blocked.changed).toBe(false)
    expect(blocked.zoo.easter).toEqual([])
  })
})

describe('easter words are not in the clear', () => {
  it('lists only sha256 hashes of lowercased words', () => {
    expect(easterHash('xyzzy')).toBe(XYZZY)
    expect(easterHash('XYZZY')).toBe(XYZZY)
    expect(DAEMON_ROSTER.rules.easterHashes).toContain(XYZZY)
    expect(DAEMON_ROSTER.rules).not.toHaveProperty('easterWords')
    expect(JSON.stringify(DAEMON_ROSTER)).not.toContain('xyzzy')
  })

  it('reads a word stored before words were hashed as its hash', () => {
    expect(parseZoo({ easter: ['xyzzy', XYZZY, 'plugh'] }).easter).toEqual([XYZZY, easterHash('plugh')])
    expect(parseZoo({ easter: ['xyzzy', 'plugh'] }, { roster: true }).easter).toEqual([XYZZY])
    const r = apply(parseZoo({ easter: ['xyzzy'] }), [{ op: 'zoo.easter', word: 'xyzzy' }])
    expect(r.changed).toBe(false)
  })
})

describe('autonomy — the pair brain\'s dial', () => {
  it('defaults to watch, and a stored zoo without one reads as watch', () => {
    expect(emptyZoo().autonomy).toBe('watch')
    expect(parseZoo({ daemons: [daemon('tim')], pair: 'tim' }).autonomy).toBe('watch')
    expect(parseZoo({ autonomy: 'act-on-key' }).autonomy).toBe('act-on-key')
    expect(parseZoo({ autonomy: 'yolo' }).autonomy).toBe('watch')
  })

  it('sets each level, is a no-op when unchanged, and drops a level it does not know without refusing the batch', () => {
    let zoo = emptyZoo()
    for (const level of ['watch', 'act-on-key', 'act-within-rules', 'suggest'].slice(1).concat(['watch', 'suggest']) as Array<'watch' | 'suggest' | 'act-on-key' | 'act-within-rules'>) {
      const r = apply(zoo, [{ op: 'zoo.autonomy', level }])
      expect(r.changed).toBe(true)
      expect(r.zoo.autonomy).toBe(level)
      zoo = r.zoo
    }
    expect(apply(zoo, [{ op: 'zoo.autonomy', level: 'suggest' }]).changed).toBe(false)
    const mixed = apply(zoo, [{ op: 'zoo.autonomy', level: 'bypass' }, { op: 'zoo.habit', key: 'turn' }])
    expect(mixed.zoo.autonomy).toBe('suggest')
    expect(mixed.zoo.habits).toEqual(['turn'])
    expect(zooOpSchema.safeParse({ op: 'zoo.autonomy', level: '' }).success).toBe(false)
    expect(zooOpSchema.safeParse({ op: 'zoo.autonomy', level: 'watch', extra: 1 }).success).toBe(false)
  })

  it('a guest seed never brings its dial: the account keeps its own', () => {
    const account = apply(emptyZoo(), [{ op: 'zoo.autonomy', level: 'suggest' }]).zoo
    expect(apply(account, [{ op: 'zoo.seed', zoo: { daemons: [daemon('tim')] } }]).zoo.autonomy).toBe('suggest')
    expect(apply(account, [{ op: 'zoo.seed', zoo: { daemons: [daemon('tim')], autonomy: 'act-within-rules' } }]).zoo.autonomy).toBe('suggest')
  })
})

describe('consent — the first-day question', () => {
  it('starts unasked; agreeing sets it with its time and drops the dial to watch; a repeat is a no-op', () => {
    expect(emptyZoo().consent).toBeNull()
    const account = apply(emptyZoo(), [{ op: 'zoo.autonomy', level: 'act-within-rules' }]).zoo
    const yes = apply(account, [{ op: 'zoo.consent', watching: true }])
    expect(yes.changed).toBe(true)
    expect(yes.zoo).toMatchObject({ consent: { watching: true, at: NOW.toISOString() }, autonomy: 'watch' })
    expect(apply(yes.zoo, [{ op: 'zoo.consent', watching: true }]).changed).toBe(false)
    // The person opts into more afterwards; saying no again keeps it off, and keeps the level they chose.
    const later = apply(yes.zoo, [{ op: 'zoo.autonomy', level: 'suggest' }, { op: 'zoo.consent', watching: false }]).zoo
    expect(later).toMatchObject({ consent: { watching: false }, autonomy: 'suggest' })
    expect(parseZoo(JSON.parse(JSON.stringify(later))).consent).toEqual(later.consent)
    expect(parseZoo({ consent: { watching: 'yes', at: 'x' } }).consent).toBeNull()
    expect(zooOpSchema.safeParse({ op: 'zoo.consent', watching: 'true' }).success).toBe(false)
  })

  it('is never seeded from a guest\'s zoo', () => {
    const r = apply(emptyZoo(), [{ op: 'zoo.seed', zoo: { daemons: [daemon('tim')], consent: { watching: true, at: NOW.toISOString() } } }])
    expect(r.zoo.consent).toBeNull()
  })
})

describe('seed — a guest zoo on first sign-in', () => {
  const guest = {
    daemons: [daemon('gnu', { nickname: 'wanda', shiny: true }), daemon('nope'), { id: 'yak' }, daemon('mutt', { egg: 'night' })],
    eggs: [egg('local-1'), egg('local-2', 'comet'), 'junk'],
    pair: 'nope',
    habits: ['turn', 'split', 'teleport'],
    firstEgg: true,
    pity: 2,
    easter: ['xyzzy', 'plugh'],
  }

  it('takes what the roster knows, renames the eggs, marks them local, and pairs a daemon it kept', () => {
    const r = apply(emptyZoo(), [{ op: 'zoo.seed', zoo: guest }])
    expect(r.changed).toBe(true)
    expect(r.zoo.daemons.map((d) => d.id)).toEqual(['gnu', 'mutt'])
    // Self-reported: no shiny comes along; the nickname does.
    expect(r.zoo.daemons[0]).toEqual({ ...daemon('gnu'), nickname: 'wanda', origin: 'local' })
    expect(r.zoo.eggs).toEqual([{ id: expect.stringMatching(/^[a-z2-9]{10}$/), kind: 'first', grantedAt: '2026-09-02T00:00:00.000Z', origin: 'local' }])
    // No pity, no easter words: those are the server's to count.
    expect(r.zoo).toMatchObject({ pair: 'gnu', habits: ['turn', 'split'], firstEgg: true, setupEgg: false, pity: 0, easter: [] })
  })

  it('marks a guest\'s daemons local, with no serial (only the server mints)', () => {
    const r = apply(emptyZoo(), [{ op: 'zoo.seed', zoo: { daemons: [daemon('tim', { serial: 7 } as Partial<ZooDaemon>), daemon('yak')], setupEgg: true } }])
    expect(r.zoo.daemons).toEqual([{ ...daemon('tim'), origin: 'local' }, { ...daemon('yak'), origin: 'local' }])
    expect(r.zoo.setupEgg).toBe(true)
  })

  it('brings only what a client could not have made valuable: no secret, no egg that can hold one, no xp, no level', () => {
    const r = apply(emptyZoo(), [{ op: 'zoo.seed', zoo: {
      daemons: [daemon('beastie', { egg: 'easter' }), daemon('tux', { xp: 900, bond: 4, version: '2.0', shiny: true, dupes: 3 })],
      eggs: [egg('n', 'night'), egg('e', 'easter'), egg('w', 'week'), egg('t', 'turn'), egg('f', 'first')],
      pity: 7, easter: ['xyzzy'], habits: ['turn'], pair: 'beastie',
    } }])
    expect(r.zoo.daemons).toEqual([{ ...daemon('tux'), origin: 'local' }])
    expect(r.zoo.eggs.map((e) => [e.kind, e.origin])).toEqual([['turn', 'local'], ['first', 'local']])
    expect(r.zoo).toMatchObject({ pair: 'tux', pity: 0, easter: [] })
    // A secret alone is nothing to seed.
    expect(apply(emptyZoo(), [{ op: 'zoo.seed', zoo: { daemons: [daemon('beastie')], eggs: [egg('n', 'night')] } }]).changed).toBe(false)
  })

  it('applies only while the account zoo is empty', () => {
    const seeded1 = apply(emptyZoo(), [{ op: 'zoo.seed', zoo: guest }]).zoo
    expect(apply(seeded1, [{ op: 'zoo.seed', zoo: guest }]).changed).toBe(false)          // a second sign-in
    for (const account of [zooOf({ habits: ['turn'] }), zooOf({ eggs: [egg('a')] }), zooOf({ daemons: [daemon('tim')] })]) {
      const r = apply(account, [{ op: 'zoo.seed', zoo: guest }])
      expect(r.changed).toBe(false)
      expect(r.zoo).toEqual(account)
    }
    expect(apply(emptyZoo(), [{ op: 'zoo.seed', zoo: {} }]).changed).toBe(false)
  })

  it('never seeds past the limits, and folds a guest\'s duplicates into one', () => {
    const big = {
      daemons: [...Array.from({ length: ZOO_MAX_DAEMONS + 6 }, () => daemon('tim')), daemon('tim', { shiny: true })],
      eggs: Array.from({ length: ZOO_MAX_EGGS + 6 }, (_, i) => egg(`g${i}`)),
    }
    const r = apply(emptyZoo(), [{ op: 'zoo.seed', zoo: big }])
    expect(r.zoo.daemons).toEqual([{ ...daemon('tim'), origin: 'local' }])
    expect(r.zoo.eggs).toHaveLength(ZOO_MAX_EGGS)
    expect(new Set(r.zoo.eggs.map((e) => e.id)).size).toBe(ZOO_MAX_EGGS)
  })
})

describe('the document', () => {
  it('replays a whole batch as a no-op', () => {
    const start = zooOf({ daemons: [daemon('tim')], eggs: [egg('a')], habits: HABITS.slice(0, 3), pair: 'tim' })
    const ops: ZooOp[] = [
      { op: 'zoo.habit', key: HABITS[3] },
      { op: 'zoo.habit', key: HABITS[4] },
      { op: 'zoo.hatch', eggId: 'a' },
      { op: 'zoo.easter', word: 'xyzzy' },
      { op: 'zoo.nickname', id: 'tim', nickname: 'tim the enchanter' },
      { op: 'zoo.pair', id: 'tim' },
      { op: 'zoo.seed', zoo: { daemons: [daemon('beastie')] } },
    ]
    const once = apply(start, ops)
    expect(once.changed).toBe(true)
    expect(once.hatched).toHaveLength(1)
    const twice = apply(once.zoo, ops)
    expect(twice).toEqual({ changed: false, zoo: once.zoo, hatched: [], grants: [], levelUps: [] })
  })

  it('never changes the zoo it was handed', () => {
    const start = zooOf({ daemons: [daemon('tim')], eggs: [egg('a')], pair: 'tim' })
    const copy = structuredClone(start)
    apply(start, [{ op: 'zoo.hatch', eggId: 'a' }, { op: 'zoo.nickname', id: 'tim', nickname: 'x' }, { op: 'zoo.habit', key: 'turn' }])
    expect(start).toEqual(copy)
  })

  it('reads a stored zoo entry by entry and drops what does not parse', () => {
    expect(parseZoo(null)).toEqual(emptyZoo())
    expect(parseZoo('junk')).toEqual(emptyZoo())
    expect(parseZoo([])).toEqual(emptyZoo())
    const stored = parseZoo({
      daemons: [daemon('tim'), daemon('retired'), { ...daemon('yak'), bond: -1 }, { ...daemon('gopher'), version: '9.9' }, { ...daemon('gnu'), extra: 1 }, daemon('Bad Id'), 'junk'],
      eggs: [egg('a'), egg('a'), { id: 'b' }, egg('c', 'turn'), egg('bad id')],
      pair: 'yak',
      habits: ['turn', 'turn', 7, 'split'],
      firstEgg: 'yes',
      pity: -3,
      easter: ['xyzzy', null],
    })
    // A well-formed id the roster lacks survives a read: a rolled-back roster must not eat a daemon.
    expect(stored.daemons.map((d) => d.id)).toEqual(['tim', 'retired'])
    expect(stored.eggs.map((e) => e.id)).toEqual(['a', 'c'])
    expect(stored).toMatchObject({ pair: null, habits: ['turn', 'split'], firstEgg: false, setupEgg: false, pity: 0, easter: [XYZZY] })
    expect(parseZoo({ pity: 1e12 }).pity).toBe(1_000_000)
    expect(parseZoo({ daemons: Array.from({ length: 80 }, (_, i) => daemon(`d${i}`)) }).daemons).toHaveLength(ZOO_MAX_DAEMONS)
  })

  it('reads a zoo stored with two records of one daemon as one, the first, counting the other', () => {
    const zoo = parseZoo({
      daemons: [daemon('tim', { xp: 60, nickname: 'pip' }), daemon('yak'), daemon('tim', { shiny: true, xp: 400 }), daemon('tim', { dupes: 2 })],
      pair: 'tim',
    })
    expect(zoo.daemons).toEqual([{ ...daemon('tim', { xp: 60, nickname: 'pip' }), bond: 1, shiny: true, dupes: 4 }, daemon('yak')])
    expect(zoo.pair).toBe('tim')
  })

  it('reads serials, origins and duplicate counts, and drops a malformed one', () => {
    const zoo = parseZoo({
      daemons: [
        daemon('tim', { serial: 42, dupes: 3 }), daemon('gnu', { origin: 'local' }),
        { ...daemon('yak'), serial: 0 }, { ...daemon('gopher'), serial: 1.5 }, { ...daemon('mutt'), origin: 'mars' }, { ...daemon('lynx'), dupes: 0 },
      ],
    })
    expect(zoo.daemons).toEqual([daemon('tim', { serial: 42, dupes: 3 }), daemon('gnu', { origin: 'local' })])
  })

  it('takes between 1 and 64 ops, each one of the eight', () => {
    expect(zooOpsBodySchema.safeParse({ ops: [] }).success).toBe(false)
    expect(zooOpsBodySchema.safeParse({ ops: Array.from({ length: 65 }, () => ({ op: 'zoo.habit', key: 'turn' })) }).success).toBe(false)
    expect(zooOpsBodySchema.safeParse({ ops: [{ op: 'zoo.draw', daemonId: 'beastie' }] }).success).toBe(false)
    expect(zooOpsBodySchema.safeParse({ ops: [{ op: 'zoo.hatch', eggId: 'a', daemonId: 'beastie' }] }).success).toBe(false)   // no client-sent results
  })

  it('makes egg ids unlike any egg in the nest', () => {
    // The first ten rolls spell the id of the egg already there; the next try does not.
    const zoo = zooOf({ eggs: [egg('aaaaaaaaaa')] })
    const r = apply(zoo, [{ op: 'zoo.easter', word: 'xyzzy' }], scripted(Array(10).fill(0), seeded(3)))
    expect(r.zoo.eggs).toHaveLength(2)
    expect(r.zoo.eggs[1].id).not.toBe('aaaaaaaaaa')
  })
})

describe('what a client draws (zoo_changed goes out only when it moves)', () => {
  const tim: ZooDaemon = { id: 'tim', hatchedAt: '2026-09-01T00:00:00.000Z', egg: 'first', shiny: false, bond: 0, xp: 5, version: '0.1' }
  const base = (): Zoo => ({ ...emptyZoo(), daemons: [{ ...tim }], pair: 'tim' })

  it('ignores a tally: progress, batch ids, lesson ids, pity, easter hashes, xp short of a level', () => {
    const after = base()
    after.progress = { ...after.progress, turns: 12, days: { '2026-09-26': 12 }, batches: ['b1'], lessons: ['l1'], held: [] }
    after.daemons[0]!.xp = 30
    after.pity = 3
    after.easter = ['abc']
    expect(zooShownChanged(base(), after)).toBe(false)
  })

  it('sees what a window, the phone or hn draws', () => {
    const changes: Array<(z: Zoo) => void> = [
      (z) => { z.daemons[0]!.bond = 1 },
      (z) => { z.daemons[0]!.version = '1.0' },
      (z) => { z.daemons[0]!.nickname = 'timmy' },
      (z) => { z.daemons[0]!.shiny = true },
      (z) => { z.daemons[0]!.dupes = 1 },
      (z) => { z.daemons.push({ ...tim, id: 'yak' }) },
      (z) => { z.eggs.push({ id: 'e1', kind: 'turn', grantedAt: '2026-09-26T00:00:00.000Z' }) },
      (z) => { z.pair = null },
      (z) => { z.autonomy = 'suggest' },
      (z) => { z.consent = { watching: true, at: '2026-09-26T00:00:00.000Z' } },
      (z) => { z.habits = ['split'] },
      (z) => { z.firstEgg = true },
      (z) => { z.setupEgg = true },
    ]
    for (const change of changes) {
      const after = base()
      change(after)
      expect(zooShownChanged(base(), after), change.toString()).toBe(true)
    }
  })
})
