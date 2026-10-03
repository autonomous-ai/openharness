import { describe, expect, it } from 'vitest'
import {
  applyZooOps, drawWeights, easterHash, emptyZoo, legacyUid, parseZoo, zooOpSchema, zooOpsBodySchema, zooShownChanged,
  ZOO_FIRST_NEW, ZOO_MAX_DAEMONS, ZOO_MAX_EGGS, ZOO_NEW_AFTER, ZOO_SEED_MAX, type Rng, type Zoo, type ZooDaemon, type ZooOp,
} from './zoo.js'
import { DAEMON_ROSTER } from './daemonRoster.g.js'

const NOW = new Date('2026-09-27T12:00:00.000Z')
const UNIT = 1_000_000
const ALL = DAEMON_ROSTER.daemons.map((d) => d.id)
/** The drops out at NOW: drop 1 (init) only, released that day (unix and tty are on hold, with no dates). */
const OUT = new Set(DAEMON_ROSTER.drops.filter((d) => 'release' in d && Date.parse(`${d.release}T00:00:00.000Z`) <= NOW.getTime()).map((d) => d.id))
/** Drop 1's nine regulars: the numbered set. beastie is its secret, outside the set. */
const REGULARS = DAEMON_ROSTER.daemons.filter((d) => OUT.has(d.drop) && d.rarity !== 'secret').map((d) => d.id)
/** Drop 1, beastie included: every species a draw can give at NOW. */
const INIT = DAEMON_ROSTER.daemons.filter((d) => OUT.has(d.drop)).map((d) => d.id)
const HABITS = [...DAEMON_ROSTER.rules.firstEgg.habits]
const XYZZY = '184858a00fd7971f810848266ebcecee5e8b69972c5ffaed622f5ee078671aed'
const UID = /^[0-9a-f]{24}$/
const WORD = 0x1_0000_0000

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
/** A readable uid for a test individual: its label in hex, padded to 24. */
const uid = (label: string) => Buffer.from(label).toString('hex').padEnd(24, '0').slice(0, 24)
const daemon = (id: string, extra: Partial<ZooDaemon> = {}): ZooDaemon =>
  ({ uid: uid(id), id, seed: 0, shiny: false, xp: 0, bond: 0, version: '0.1', hatched: '2026-09-01T00:00:00.000Z', egg: 'first', ...extra })
/** A daemon as stored before individuals: one record per species. */
const old = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, hatchedAt: '2026-09-01T00:00:00.000Z', egg: 'first', shiny: false, bond: 0, xp: 0, version: '0.1', ...extra })
const zooOf = (patch: Partial<Zoo>): Zoo => ({ ...emptyZoo(), ...patch })
const egg = (id: string, kind = 'first') => ({ id, kind, grantedAt: '2026-09-02T00:00:00.000Z' })
const apply = (zoo: Zoo, ops: ZooOp[], rng: Rng = seeded()) => applyZooOps(zoo, ops, rng, NOW)
const weightOf = (zoo: Zoo, kind: string) => Object.fromEntries(drawWeights(zoo, kind, NOW).map((w) => [w.id, w.weight / UNIT]))
const eligible = (zoo: Zoo, kind: string) => drawWeights(zoo, kind, NOW).filter((w) => w.weight > 0).map((w) => w.id)
const habits = (...keys: string[]): ZooOp[] => keys.map((key) => ({ op: 'zoo.habit', key }))
const kinds = (zoo: Zoo) => zoo.eggs.map((e) => e.kind)
const hatch = (eggId: string): ZooOp => ({ op: 'zoo.hatch', eggId })

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
    const hatched = apply(zoo, zoo.eggs.map((e) => hatch(e.id))).zoo
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
    const roomy = apply(blocked.zoo, [hatch('e0')]).zoo
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
    const roomy = apply(blocked.zoo, [hatch('e0')]).zoo
    const granted = apply(roomy, [{ op: 'zoo.habit', key: HABITS[4] }])        // already counted: the grant still lands
    expect(granted.changed).toBe(true)
    expect(granted.zoo.firstEgg).toBe(true)
    expect(granted.zoo.eggs.filter((e) => e.kind === 'first')).toHaveLength(1)
  })
})

describe('hatching: every hatch is its own individual', () => {
  it('removes the egg, adds an individual at 0.1 with its seed and uid, and pairs the first one', () => {
    const zoo = zooOf({ eggs: [egg('a'), egg('b', 'turn')] })
    // The species, shiny, the seed (1 + the roll), then three 32-bit words of uid, in that order.
    const rng = scripted([indexOf(zoo, 'first', 'yak'), 5, 41, 0xdeadbeef, 1, 0xffffffff])
    const r = apply(zoo, [hatch('a')], rng)
    expect(rng.calls).toEqual([expect.any(Number), DAEMON_ROSTER.rules.shinyOneIn, ZOO_SEED_MAX, WORD, WORD, WORD])
    const yak: ZooDaemon = { uid: 'deadbeef00000001ffffffff', id: 'yak', seed: 42, shiny: false, xp: 0, bond: 0, version: '0.1', hatched: NOW.toISOString(), egg: 'first' }
    expect(r.hatched).toEqual([{ eggId: 'a', daemonId: 'yak', ...yak }])
    expect(r.zoo.eggs.map((e) => e.id)).toEqual(['b'])
    expect(r.zoo.daemons).toEqual([yak])
    expect(r.zoo.paired).toBe(yak.uid)
    const second = apply(r.zoo, [hatch('b')], scripted([indexOf(r.zoo, 'turn', 'tim'), 9]))
    expect(second.zoo.daemons.map((d) => d.id)).toEqual(['yak', 'tim'])
    expect(second.zoo.daemons[1]).toMatchObject({ egg: 'turn', seed: expect.any(Number), uid: expect.stringMatching(UID) })
    expect(second.zoo.daemons[1].uid).not.toBe(yak.uid)
    expect(second.zoo.paired).toBe(yak.uid)                                     // a pair is never replaced by a hatch
  })

  it('draws every seed from 1 to 2^32 - 1: 0 is kept for the default traits', () => {
    const zoo = zooOf({ eggs: [egg('a')] })
    const low = apply(zoo, [hatch('a')], scripted([0, 1, 0]))
    const high = apply(zoo, [hatch('a')], scripted([0, 1, ZOO_SEED_MAX - 1]))
    expect([low.zoo.daemons[0].seed, high.zoo.daemons[0].seed]).toEqual([1, 4_294_967_295])
    expect(ZOO_SEED_MAX).toBe(2 ** 32 - 1)
  })

  it('drops a hatch of an egg that is not there', () => {
    const r = apply(zooOf({ eggs: [egg('a')] }), [hatch('gone')])
    expect(r).toMatchObject({ changed: false, hatched: [] })
    expect(r.zoo.eggs).toHaveLength(1)
  })

  it('hatches a species you own as one more individual: its own uid and seed, never a merge, no xp to the one you have', () => {
    const everyone = zooOf({ daemons: ALL.map((id) => daemon(id)), eggs: [egg('a'), egg('b'), egg('c')], paired: uid('tux') })
    expect(weightOf(everyone, 'first')).toEqual({ tim: 60, gnu: 15, lynx: 15, mutt: 15, yak: 9, gopher: 9, bug: 9, tux: 6, auk: 6 })
    const one = apply(everyone, [hatch('a')], scripted([indexOf(everyone, 'first', 'tim'), 1]))
    expect(one.hatched).toEqual([expect.objectContaining({ eggId: 'a', daemonId: 'tim', id: 'tim', shiny: false, xp: 0, bond: 0, version: '0.1' })])
    expect(one.hatched[0]).not.toHaveProperty('duplicate')
    expect(one.zoo.daemons).toHaveLength(ALL.length + 1)                        // added, not merged
    const tims = one.zoo.daemons.filter((d) => d.id === 'tim')
    expect(tims[0]).toEqual(daemon('tim'))                                      // the one you had: untouched
    expect(tims[1]).toEqual(expect.objectContaining({ uid: one.hatched[0].uid, seed: one.hatched[0].seed, hatched: NOW.toISOString() }))
    expect(one.levelUps).toEqual([])
    expect(one.zoo.paired).toBe(uid('tux'))                                     // a hatch never takes the pair
    // A shiny one is its own shine: yours does not change.
    const two = apply(one.zoo, [hatch('b')], scripted([indexOf(one.zoo, 'first', 'tim'), 0]))
    expect(two.hatched[0]).toMatchObject({ daemonId: 'tim', shiny: true })
    expect(two.zoo.daemons.filter((d) => d.id === 'tim').map((d) => d.shiny)).toEqual([false, false, true])
    expect(new Set(two.zoo.daemons.map((d) => d.uid)).size).toBe(ALL.length + 2)
  })

  it('stops hatching at 256 individuals: the egg waits in the nest', () => {
    expect(ZOO_MAX_DAEMONS).toBe(256)
    const many = Array.from({ length: ZOO_MAX_DAEMONS }, (_, i) => daemon(REGULARS[i % REGULARS.length], { uid: i.toString(16).padStart(24, '0') }))
    const full = zooOf({ daemons: many, eggs: [egg('a')] })
    const rng = scripted([])
    const r = apply(full, [hatch('a')], rng)
    expect(r.changed).toBe(false)
    expect(r.zoo.eggs.map((e) => e.id)).toEqual(['a'])
    expect(rng.calls).toEqual([])                                               // nothing drawn
    // One short of full, it hatches the 256th.
    const room = apply(zooOf({ daemons: many.slice(1), eggs: [egg('a')] }), [hatch('a')])
    expect(room.zoo.daemons).toHaveLength(ZOO_MAX_DAEMONS)
  })

  it('uses crypto by default', () => {
    const r = applyZooOps(zooOf({ eggs: [egg('a')] }), [hatch('a')])
    expect(ALL).toContain(r.hatched[0].daemonId)
    expect(r.hatched[0].uid).toMatch(UID)
    expect(r.hatched[0].seed).toBeGreaterThanOrEqual(1)
    expect(r.hatched[0].seed).toBeLessThanOrEqual(ZOO_SEED_MAX)
  })

  it('makes uids unlike any individual\'s in the zoo', () => {
    // The first three words spell the uid of the one already there; the next try does not.
    const there = daemon('tim', { uid: '000000000000000000000000' })
    const r = apply(zooOf({ daemons: [there], eggs: [egg('a')] }), [hatch('a')], scripted([0, 1, 0, 0, 0, 0], seeded(3)))
    expect(r.zoo.daemons).toHaveLength(2)
    expect(r.zoo.daemons[1].uid).toMatch(UID)
    expect(r.zoo.daemons[1].uid).not.toBe(there.uid)
  })
})

describe('the draw', () => {
  it('gives the first four hatches of an account only species it does not own', () => {
    expect(ZOO_FIRST_NEW).toBe(4)
    for (let n = 0; n < ZOO_FIRST_NEW; n++) {
      const owned: string[] = REGULARS.slice(0, n)
      const zoo = zooOf({ daemons: owned.map((id) => daemon(id)) })
      for (const kind of ['first', 'turn', 'week', 'marathon', 'night']) {
        expect(eligible(zoo, kind).filter((id) => owned.includes(id)), `${kind} with ${n} owned`).toEqual([])
      }
    }
    // Two individuals of one species are two hatches: the next two are still owed new ones.
    const twoTims = zooOf({ daemons: [daemon('tim'), daemon('tim', { uid: uid('tim2') })] })
    expect(eligible(twoTims, 'turn')).toEqual(REGULARS.filter((id) => id !== 'tim'))
    // From the fifth hatch a species you own may come again.
    const four = zooOf({ daemons: REGULARS.slice(0, 4).map((id) => daemon(id)) })
    expect(eligible(four, 'turn')).toEqual(REGULARS)
  })

  it('weighs a rarity by how many of it are left while a new species is owed, and gives an empty rarity to nobody', () => {
    expect(weightOf(emptyZoo(), 'turn')).toEqual({ tim: 15, gnu: 15, lynx: 15, mutt: 15, yak: 9, gopher: 9, bug: 9, tux: 6, auk: 6 })
    expect(weightOf(zooOf({ daemons: [daemon('tim')] }), 'turn')).toMatchObject({ gnu: 20, lynx: 20, mutt: 20, yak: 9 })
    const commons = ['tim', 'gnu', 'lynx', 'mutt'].map((id) => daemon(id))
    // Four hatches in: nothing owed, every regular at its rarity's share, owned or not.
    expect(weightOf(zooOf({ daemons: commons }), 'turn')).toEqual({ tim: 15, gnu: 15, lynx: 15, mutt: 15, yak: 9, gopher: 9, bug: 9, tux: 6, auk: 6 })
    // Owed a new one with no common left: the commons' 60 goes nowhere.
    expect(weightOf(zooOf({ daemons: commons, sinceNew: ZOO_NEW_AFTER }), 'turn')).toEqual({ yak: 9, gopher: 9, bug: 9, tux: 6, auk: 6 })
  })

  it('after 8 hatches in a row with no new species, the next is a new one, while an unowned regular is left', () => {
    expect(ZOO_NEW_AFTER).toBe(8)
    const seven = REGULARS.filter((id) => id !== 'tim' && id !== 'yak').map((id) => daemon(id))
    const dry = (sinceNew: number) => zooOf({ daemons: seven, eggs: [egg('a', 'turn')], sinceNew })
    expect(eligible(dry(ZOO_NEW_AFTER - 1), 'turn')).toEqual(REGULARS)
    expect(eligible(dry(ZOO_NEW_AFTER), 'turn')).toEqual(['tim', 'yak'])
    expect(eligible(dry(ZOO_NEW_AFTER + 40), 'turn')).toEqual(['tim', 'yak'])
    for (let seed = 1; seed <= 60; seed++) {
      const r = apply(dry(ZOO_NEW_AFTER), [hatch('a')], seeded(seed))
      expect(['tim', 'yak']).toContain(r.hatched[0].daemonId)
      expect(r.zoo.sinceNew).toBe(0)                                            // a new species starts the count again
    }
    // The count: one more for each hatch of a species owned, back to 0 on a new one.
    const again = apply(dry(3), [hatch('a')], scripted([indexOf(dry(3), 'turn', 'gnu'), 1]))
    expect(again.zoo.sinceNew).toBe(4)
    const fresh = apply(dry(3), [hatch('a')], scripted([indexOf(dry(3), 'turn', 'tim'), 1]))
    expect(fresh.zoo.sinceNew).toBe(0)
    // Every regular owned: nothing is owed, however long the run, and beastie stays a secret.
    const all = zooOf({ daemons: REGULARS.map((id) => daemon(id)), sinceNew: 50 })
    expect(eligible(all, 'turn')).toEqual(REGULARS)
    expect(eligible(all, 'night')).toEqual([...REGULARS, 'beastie'])
  })

  it('keeps the secret outside the set: only a night or easter egg holds it, and never twice', () => {
    const eggsWithSecret = Object.entries(DAEMON_ROSTER.rules.eggs).filter(([, e]) => e.weights.secret > 0).map(([k]) => k)
    expect(eggsWithSecret.sort()).toEqual(['easter', 'night'])
    // Every regular owned, beastie not: ordinary eggs give regulars again, never beastie...
    const regulars = zooOf({ daemons: REGULARS.map((id) => daemon(id)), eggs: [egg('a')] })
    for (const kind of ['first', 'setup', 'turn', 'week', 'marathon', 'history']) {
      expect(Object.keys(weightOf(regulars, kind)), kind).toEqual(REGULARS)
    }
    for (let seed = 1; seed <= 40; seed++) {
      const r = apply(regulars, [hatch('a')], seeded(seed))
      expect(REGULARS).toContain(r.hatched[0].daemonId)
      expect(r.zoo.daemons).toHaveLength(REGULARS.length + 1)
    }
    // ...while a night egg can still hold beastie, beside the regulars.
    expect(weightOf(regulars, 'night')).toMatchObject({ beastie: 8, tim: 12.5, bug: 40 })
    // Not owning beastie never holds back the rest, and owning it never counts toward the set.
    const withBeastie = zooOf({ daemons: ['beastie', 'tim'].map((id) => daemon(id)) })
    expect(Object.keys(weightOf(withBeastie, 'turn'))).toEqual(REGULARS.filter((id) => id !== 'tim'))
    // Owned, a secret never comes again: a night egg gives the regulars.
    const owned = zooOf({ daemons: INIT.map((id) => daemon(id)) })
    expect(eligible(owned, 'night')).toEqual(REGULARS)
  })

  it('makes tim the likely first hatch', () => {
    expect(DAEMON_ROSTER.rules.eggs.first.boost).toEqual({ tim: 4 })
    const w = weightOf(emptyZoo(), 'first')
    expect(w).toEqual({ tim: 60, gnu: 15, lynx: 15, mutt: 15, yak: 9, gopher: 9, bug: 9, tux: 6, auk: 6 })
    const total = Object.values(w).reduce((a, b) => a + b, 0)
    expect(w.tim / total).toBeCloseTo(60 / 144, 5)                           // about 42%, 4 times any other common
    let tims = 0
    for (let seed = 1; seed <= 400; seed++) {
      if (apply(zooOf({ eggs: [egg('a')] }), [hatch('a')], seeded(seed)).hatched[0].daemonId === 'tim') tims++
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
    const first = apply(zoo, [hatch('f')], scripted([indexOf(zoo, 'first', 'tim'), 1]))
    expect(first.zoo.pity).toBe(3)
    const miss = apply(first.zoo, [hatch('n1')], scripted([indexOf(first.zoo, 'night', 'bug'), 1]))
    expect(miss.zoo.pity).toBe(4)
    const hit = apply(miss.zoo, [hatch('n2')], scripted([indexOf(miss.zoo, 'night', 'beastie'), 1]))
    expect(hit.hatched[0].daemonId).toBe('beastie')
    expect(hit.zoo.pity).toBe(0)
  })

  it('gives the secret on the 8th hatch of an egg that can hold one, when you do not have it', () => {
    expect(DAEMON_ROSTER.rules.secretGuaranteeAt).toBe(8)
    let zoo = zooOf({ eggs: Array.from({ length: 8 }, (_, i) => egg(`n${i}`, 'night')) })
    // Ordinary eggs in between never move the count.
    zoo = { ...zoo, eggs: [...zoo.eggs, egg('t1', 'turn'), egg('t2', 'turn')] }
    zoo = apply(zoo, [hatch('t1'), hatch('t2')], scripted([0, 1, 0, 0, 0, 0, 0, 1])).zoo
    expect(zoo.pity).toBe(0)
    for (let i = 0; i < 7; i++) {
      // A roll of 0 lands on the first species with any weight, never the secret: seven misses in a row.
      const r = apply(zoo, [hatch(`n${i}`)], scripted([0, 1]))
      expect(r.hatched[0].daemonId).not.toBe('beastie')
      zoo = r.zoo
    }
    expect(zoo.pity).toBe(7)
    expect(drawWeights(zoo, 'night', NOW).map((w) => w.id)).toEqual(['beastie'])
    expect(drawWeights(zoo, 'turn', NOW).map((w) => w.id)).not.toContain('beastie')
    const eighth = apply(zoo, [hatch('n7')], scripted([0, 1]))
    expect(eighth.hatched[0].daemonId).toBe('beastie')
    expect(eighth.zoo.pity).toBe(0)
    // Owning beastie already, the count guarantees nothing: a night egg draws as usual.
    const owned = zooOf({ daemons: REGULARS.slice(0, 4).map((id) => daemon(id)).concat(daemon('beastie')), pity: 7 })
    expect(Object.keys(weightOf(owned, 'night'))).toEqual(REGULARS)
  })

  it('puts the pity guarantee before a new species owed', () => {
    const zoo = zooOf({ daemons: REGULARS.slice(0, 7).map((id) => daemon(id)), pity: 7, sinceNew: ZOO_NEW_AFTER })
    expect(eligible(zoo, 'night')).toEqual(['beastie'])
    expect(eligible(zoo, 'turn')).toEqual(REGULARS.slice(7))
  })

  it('boosts a night egg toward bug', () => {
    expect(DAEMON_ROSTER.rules.eggs.night.boost).toEqual({ bug: 4 })
    const w = weightOf(emptyZoo(), 'night')
    expect(w.bug).toBe((30 / 3) * 4)
    expect(w.yak).toBe(30 / 3)                                               // the other rares are not boosted
    expect(w.tim).toBe(50 / 4)
    expect(w.beastie).toBe(8)
    const zoo = zooOf({ eggs: [egg('n', 'night')] })
    const r = apply(zoo, [hatch('n')], scripted([indexOf(zoo, 'night', 'bug') + Math.floor(w.bug * UNIT) - 1, 1]))
    expect(r.hatched[0].daemonId).toBe('bug')
  })

  it('makes an individual shiny on a 1-in-shinyOneIn roll, independent of who hatched', () => {
    const zoo = zooOf({ eggs: [egg('a')] })
    const lucky = scripted([indexOf(zoo, 'first', 'tim'), 0])
    const r = apply(zoo, [hatch('a')], lucky)
    expect(lucky.calls[1]).toBe(DAEMON_ROSTER.rules.shinyOneIn)
    expect(r.hatched[0]).toMatchObject({ eggId: 'a', daemonId: 'tim', shiny: true })
    expect(r.zoo.daemons[0].shiny).toBe(true)
    const plain = apply(zoo, [hatch('a')], scripted([indexOf(zoo, 'first', 'tim'), DAEMON_ROSTER.rules.shinyOneIn - 1]))
    expect(plain.hatched[0].shiny).toBe(false)
  })

  it('draws an easter egg that has nothing new to give from what it can give, and owes the new one to the next hatch', () => {
    // Legendaries and the secret owned, three hatches in: a new species is owed, and an easter egg (only
    // legendaries and secrets) has none to give. It gives a legendary again rather than nobody.
    const zoo = zooOf({ daemons: ['tux', 'auk', 'beastie'].map((id) => daemon(id)), eggs: [egg('x', 'easter'), egg('t', 'turn')] })
    expect(Object.fromEntries(Object.entries(weightOf(emptyZoo(), 'easter')).filter(([, w]) => w > 0))).toEqual({ tux: 45, auk: 45, beastie: 10 })
    expect(eligible(zoo, 'easter')).toEqual(['tux', 'auk'])
    const r = apply(zoo, [hatch('x')])
    expect(['tux', 'auk']).toContain(r.hatched[0].daemonId)
    expect(r.zoo.sinceNew).toBe(1)
    // Four hatches now, so the first-four rule is spent; the count carries on toward the next guarantee.
    expect(eligible(r.zoo, 'turn')).toEqual(REGULARS)
  })

  it('leaves an egg of a kind the roster cannot draw where it is', () => {
    const zoo = zooOf({ eggs: [egg('q', 'comet'), egg('c', 'constructor')] })
    expect(drawWeights(zoo, 'constructor', NOW)).toEqual([])
    expect(apply(zoo, [hatch('q'), hatch('c')]).changed).toBe(false)
  })
})

describe('pair, name, easter', () => {
  const tim1 = daemon('tim')
  const tim2 = daemon('tim', { uid: uid('tim2') })
  const yak = daemon('yak')

  it('pairs only an individual you own, by its uid', () => {
    const zoo = zooOf({ daemons: [tim1, yak, tim2], paired: tim1.uid })
    expect(apply(zoo, [{ op: 'zoo.pair', uid: tim2.uid }]).zoo.paired).toBe(tim2.uid)   // the second tim, not the first
    expect(apply(zoo, [{ op: 'zoo.pair', uid: yak.uid }]).zoo.paired).toBe(yak.uid)
    expect(apply(zoo, [{ op: 'zoo.pair', uid: tim1.uid }]).changed).toBe(false)
    expect(apply(zoo, [{ op: 'zoo.pair', uid: uid('nobody') }]).changed).toBe(false)
    // A uid is 24 lowercase hex; a species id or anything else refuses the request.
    for (const bad of [{ uid: 'tim' }, { uid: tim1.uid.toUpperCase() }, { uid: tim1.uid.slice(1) }, { id: 'tim' }, { uid: tim1.uid, id: 'tim' }]) {
      expect(zooOpSchema.safeParse({ op: 'zoo.pair', ...bad }).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('names the individual its uid names, 1-24 printable characters trimmed; null clears; anything else refuses', () => {
    const zoo = zooOf({ daemons: [tim1, tim2] })
    const named = apply(zoo, [{ op: 'zoo.nickname', uid: tim2.uid, name: 'pip' }])
    expect(named.zoo.daemons.map((d) => d.name)).toEqual([undefined, 'pip'])
    expect(apply(named.zoo, [{ op: 'zoo.nickname', uid: tim2.uid, name: 'pip' }]).changed).toBe(false)
    const cleared = apply(named.zoo, [{ op: 'zoo.nickname', uid: tim2.uid, name: null }])
    expect(cleared.zoo.daemons[1]).not.toHaveProperty('name')
    expect(apply(cleared.zoo, [{ op: 'zoo.nickname', uid: tim2.uid, name: null }]).changed).toBe(false)
    expect(apply(zoo, [{ op: 'zoo.nickname', uid: uid('nobody'), name: 'nope' }]).changed).toBe(false)
    const parse = (name: unknown) => zooOpSchema.safeParse({ op: 'zoo.nickname', uid: tim1.uid, name })
    expect(parse('x'.repeat(24)).success).toBe(true)
    expect(parse('  pip  ').data).toMatchObject({ name: 'pip' })
    for (const bad of ['', '   ', 'x'.repeat(25), 'tïm', 'tab\there', 'emoji 🐱', 7]) expect(parse(bad).success, String(bad)).toBe(false)
    expect(zooOpSchema.safeParse({ op: 'zoo.nickname', id: 'tim', nickname: 'pip' }).success).toBe(false)   // the old shape
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
    expect(parseZoo({ daemons: [daemon('tim')], paired: uid('tim') }).autonomy).toBe('watch')
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
  /** What a guest individual becomes: the account's own uid, the default traits, fresh at 0.1, local. */
  const local = (d: ZooDaemon, uidNow: string): ZooDaemon =>
    ({ uid: uidNow, id: d.id, seed: 0, ...(d.name ? { name: d.name } : {}), shiny: false, xp: 0, bond: 0, version: '0.1', hatched: d.hatched, egg: d.egg, origin: 'local' })

  const gnu = daemon('gnu', { name: 'wanda', shiny: true, seed: 77, xp: 400, bond: 3, version: '1.0', serial: 9 })
  const mutt = daemon('mutt', { egg: 'night', seed: 12 })
  const guest = {
    daemons: [gnu, daemon('nope'), { id: 'yak' }, mutt],
    eggs: [egg('local-1'), egg('local-2', 'comet'), 'junk'],
    paired: mutt.uid,
    habits: ['turn', 'split', 'teleport'],
    firstEgg: true,
    pity: 2,
    sinceNew: 6,
    easter: ['xyzzy', 'plugh'],
  }

  it('takes what the roster knows, makes each individual the account\'s own, marks it local, and keeps the guest\'s pair', () => {
    const r = apply(emptyZoo(), [{ op: 'zoo.seed', zoo: guest }])
    expect(r.changed).toBe(true)
    expect(r.zoo.daemons.map((d) => d.id)).toEqual(['gnu', 'mutt'])
    // Self-reported: no rolled look, shine, xp, level or serial comes along; the name does. The uid is new.
    const [g, m] = r.zoo.daemons
    expect(g).toEqual(local(gnu, g.uid))
    expect(m).toEqual(local(mutt, m.uid))
    for (const d of r.zoo.daemons) expect(d.uid).toMatch(UID)
    expect(g.uid).not.toBe(gnu.uid)
    expect(r.zoo.eggs).toEqual([{ id: expect.stringMatching(/^[a-z2-9]{10}$/), kind: 'first', grantedAt: '2026-09-02T00:00:00.000Z', origin: 'local' }])
    // No pity, no run toward a new species, no easter words: those are the server's to count.
    expect(r.zoo).toMatchObject({ paired: m.uid, habits: ['turn', 'split'], firstEgg: true, setupEgg: false, pity: 0, sinceNew: 0, easter: [] })
  })

  it('reads a guest zoo from before individuals too: one individual per record, the old pair followed', () => {
    const r = apply(emptyZoo(), [{ op: 'zoo.seed', zoo: {
      daemons: [old('tim', { nickname: 'pip', dupes: 2, shiny: true }), old('yak'), old('tim', { hatchedAt: '2026-09-03T00:00:00.000Z' })],
      pair: 'yak',
    } }])
    expect(r.zoo.daemons.map((d) => [d.id, d.name, d.seed, d.shiny, d.origin])).toEqual([
      ['tim', 'pip', 0, false, 'local'], ['yak', undefined, 0, false, 'local'], ['tim', undefined, 0, false, 'local'],
    ])
    expect(r.zoo.daemons[2].hatched).toBe('2026-09-03T00:00:00.000Z')
    expect(r.zoo.paired).toBe(r.zoo.daemons[1].uid)
  })

  it('marks a guest\'s individuals local, with no serial (only the server mints)', () => {
    const r = apply(emptyZoo(), [{ op: 'zoo.seed', zoo: { daemons: [daemon('tim', { serial: 7 }), daemon('yak')], setupEgg: true } }])
    expect(r.zoo.daemons).toEqual([local(daemon('tim'), r.zoo.daemons[0].uid), local(daemon('yak'), r.zoo.daemons[1].uid)])
    expect(r.zoo.daemons[0]).not.toHaveProperty('serial')
    expect(r.zoo.paired).toBe(r.zoo.daemons[0].uid)                             // no pair said: the first
    expect(r.zoo.setupEgg).toBe(true)
  })

  it('brings only what a client could not have made valuable: no secret, no egg that can hold one, no xp, no level', () => {
    const beastie = daemon('beastie', { egg: 'easter' })
    const r = apply(emptyZoo(), [{ op: 'zoo.seed', zoo: {
      daemons: [beastie, daemon('tux', { xp: 900, bond: 4, version: '2.0', shiny: true, seed: 5 })],
      eggs: [egg('n', 'night'), egg('e', 'easter'), egg('w', 'week'), egg('t', 'turn'), egg('f', 'first')],
      pity: 7, easter: ['xyzzy'], habits: ['turn'], paired: beastie.uid,
    } }])
    expect(r.zoo.daemons).toEqual([local(daemon('tux'), r.zoo.daemons[0].uid)])
    expect(r.zoo.eggs.map((e) => [e.kind, e.origin])).toEqual([['turn', 'local'], ['first', 'local']])
    expect(r.zoo).toMatchObject({ paired: r.zoo.daemons[0].uid, pity: 0, easter: [] })
    // A secret alone is nothing to seed.
    expect(apply(emptyZoo(), [{ op: 'zoo.seed', zoo: { daemons: [beastie], eggs: [egg('n', 'night')] } }]).changed).toBe(false)
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

  it('never seeds past the limits: every guest individual one of the account\'s, up to 256', () => {
    const big = {
      daemons: Array.from({ length: ZOO_MAX_DAEMONS + 6 }, (_, i) => daemon('tim', { uid: i.toString(16).padStart(24, '0') })),
      eggs: Array.from({ length: ZOO_MAX_EGGS + 6 }, (_, i) => egg(`g${i}`)),
    }
    const r = apply(emptyZoo(), [{ op: 'zoo.seed', zoo: big }])
    expect(r.zoo.daemons).toHaveLength(ZOO_MAX_DAEMONS)
    expect(new Set(r.zoo.daemons.map((d) => d.uid)).size).toBe(ZOO_MAX_DAEMONS)
    expect(r.zoo.eggs).toHaveLength(ZOO_MAX_EGGS)
    expect(new Set(r.zoo.eggs.map((e) => e.id)).size).toBe(ZOO_MAX_EGGS)
  })
})

describe('the document', () => {
  it('replays a whole batch as a no-op', () => {
    const tim = daemon('tim')
    const start = zooOf({ daemons: [tim], eggs: [egg('a')], habits: HABITS.slice(0, 3), paired: tim.uid })
    const ops: ZooOp[] = [
      { op: 'zoo.habit', key: HABITS[3] },
      { op: 'zoo.habit', key: HABITS[4] },
      hatch('a'),
      { op: 'zoo.easter', word: 'xyzzy' },
      { op: 'zoo.nickname', uid: tim.uid, name: 'tim the enchanter' },
      { op: 'zoo.pair', uid: tim.uid },
      { op: 'zoo.seed', zoo: { daemons: [daemon('beastie')] } },
    ]
    const once = apply(start, ops)
    expect(once.changed).toBe(true)
    expect(once.hatched).toHaveLength(1)
    const twice = apply(once.zoo, ops)
    expect(twice).toEqual({ changed: false, zoo: once.zoo, hatched: [], grants: [], levelUps: [] })
  })

  it('never changes the zoo it was handed', () => {
    const tim = daemon('tim')
    const start = zooOf({ daemons: [tim], eggs: [egg('a')], paired: tim.uid })
    const copy = structuredClone(start)
    apply(start, [hatch('a'), { op: 'zoo.nickname', uid: tim.uid, name: 'x' }, { op: 'zoo.habit', key: 'turn' }])
    expect(start).toEqual(copy)
  })

  it('reads a stored zoo entry by entry and drops what does not parse', () => {
    expect(parseZoo(null)).toEqual(emptyZoo())
    expect(parseZoo('junk')).toEqual(emptyZoo())
    expect(parseZoo([])).toEqual(emptyZoo())
    const yak = { ...daemon('yak'), bond: -1 }
    const stored = parseZoo({
      daemons: [
        daemon('tim'), daemon('retired'), yak, { ...daemon('gopher'), version: '9.9' }, { ...daemon('gnu'), extra: 1 }, daemon('Bad Id'), 'junk',
        daemon('mutt', { uid: uid('tim') }),                                   // a uid already read
        { ...daemon('lynx'), uid: 'ABCDEF000000000000000000' }, { ...daemon('lynx'), seed: -1 }, { ...daemon('lynx'), seed: 2 ** 32 },
        { ...daemon('lynx'), seed: 1.5 }, { ...daemon('lynx'), hatched: 'yesterday' }, { ...daemon('lynx'), name: '' },
        { ...daemon('lynx'), xp: undefined },
      ],
      eggs: [egg('a'), egg('a'), { id: 'b' }, egg('c', 'turn'), egg('bad id')],
      paired: yak.uid,
      habits: ['turn', 'turn', 7, 'split'],
      firstEgg: 'yes',
      pity: -3,
      sinceNew: 'many',
      easter: ['xyzzy', null],
    })
    // A well-formed id the roster lacks survives a read: a rolled-back roster must not eat a daemon.
    expect(stored.daemons.map((d) => d.id)).toEqual(['tim', 'retired'])
    expect(stored.eggs.map((e) => e.id)).toEqual(['a', 'c'])
    expect(stored).toMatchObject({ paired: null, habits: ['turn', 'split'], firstEgg: false, setupEgg: false, pity: 0, sinceNew: 0, easter: [XYZZY] })
    expect(parseZoo({ pity: 1e12, sinceNew: 1e12 })).toMatchObject({ pity: 1_000_000, sinceNew: 1_000_000 })
    const many = Array.from({ length: 300 }, (_, i) => daemon('tim', { uid: i.toString(16).padStart(24, '0') }))
    expect(parseZoo({ daemons: many }).daemons).toHaveLength(ZOO_MAX_DAEMONS)
  })

  it('reads names, serials, seeds and origins, and trims a name', () => {
    const zoo = parseZoo({
      daemons: [daemon('tim', { serial: 42, seed: 13, name: '  pip ' }), daemon('gnu', { origin: 'local' }), { ...daemon('yak'), serial: 0 }, { ...daemon('mutt'), origin: 'mars' }],
      paired: uid('gnu'),
    })
    expect(zoo.daemons).toEqual([daemon('tim', { serial: 42, seed: 13, name: 'pip' }), daemon('gnu', { origin: 'local' })])
    expect(zoo.paired).toBe(uid('gnu'))
  })

  it('takes between 1 and 64 ops, each one of the eight', () => {
    expect(zooOpsBodySchema.safeParse({ ops: [] }).success).toBe(false)
    expect(zooOpsBodySchema.safeParse({ ops: Array.from({ length: 65 }, () => ({ op: 'zoo.habit', key: 'turn' })) }).success).toBe(false)
    expect(zooOpsBodySchema.safeParse({ ops: [{ op: 'zoo.draw', daemonId: 'beastie' }] }).success).toBe(false)
    expect(zooOpsBodySchema.safeParse({ ops: [{ op: 'zoo.hatch', eggId: 'a', daemonId: 'beastie' }] }).success).toBe(false)   // no client-sent results
    expect(zooOpsBodySchema.safeParse({ ops: [{ op: 'zoo.hatch', eggId: 'a', seed: 7 }] }).success).toBe(false)             // nor seeds
    expect(zooOpsBodySchema.safeParse({ ops: [{ op: 'zoo.pair', id: 'tim' }] }).success).toBe(false)                       // the old pair
  })

  it('makes egg ids unlike any egg in the nest', () => {
    // The first ten rolls spell the id of the egg already there; the next try does not.
    const zoo = zooOf({ eggs: [egg('aaaaaaaaaa')] })
    const r = apply(zoo, [{ op: 'zoo.easter', word: 'xyzzy' }], scripted(Array(10).fill(0), seeded(3)))
    expect(r.zoo.eggs).toHaveLength(2)
    expect(r.zoo.eggs[1].id).not.toBe('aaaaaaaaaa')
  })
})

describe('a zoo stored before individuals', () => {
  const USER = 'user-1'
  const stored = {
    daemons: [
      old('tim', { nickname: 'pip', xp: 400, bond: 3, version: '1.0', serial: 42, dupes: 3, shiny: true }),
      old('yak', { egg: 'turn', hatchedAt: '2026-09-05T00:00:00.000Z' }),
      old('gnu', { origin: 'local' }),
      old('lynx', { xp: undefined, bond: 2 }),
    ],
    eggs: [egg('a', 'turn')],
    pair: 'yak',
    pity: 3,
    habits: ['turn'],
  }

  it('reads each record as one individual: seed 0, its name, its hatch, its serial; the dupes dropped', () => {
    const zoo = parseZoo(stored, { userId: USER })
    expect(zoo.daemons).toEqual([
      { uid: legacyUid(USER, 'tim'), id: 'tim', seed: 0, serial: 42, name: 'pip', shiny: true, xp: 400, bond: 3, version: '1.0', hatched: '2026-09-01T00:00:00.000Z', egg: 'first' },
      { uid: legacyUid(USER, 'yak'), id: 'yak', seed: 0, shiny: false, xp: 0, bond: 0, version: '0.1', hatched: '2026-09-05T00:00:00.000Z', egg: 'turn' },
      { uid: legacyUid(USER, 'gnu'), id: 'gnu', seed: 0, shiny: false, xp: 0, bond: 0, version: '0.1', hatched: '2026-09-01T00:00:00.000Z', egg: 'first', origin: 'local' },
      // Stored before xp: the least xp its bond needs, as before.
      { uid: legacyUid(USER, 'lynx'), id: 'lynx', seed: 0, shiny: false, xp: 150, bond: 2, version: '1.0', hatched: '2026-09-01T00:00:00.000Z', egg: 'first' },
    ])
    for (const d of zoo.daemons) expect(d.uid).toMatch(UID)
    expect(zoo.paired).toBe(legacyUid(USER, 'yak'))
    expect(zoo).toMatchObject({ eggs: [egg('a', 'turn')], pity: 3, sinceNew: 0, habits: ['turn'] })
  })

  it('derives the same uids on every read, a different set for another account', () => {
    expect(parseZoo(stored, { userId: USER })).toEqual(parseZoo(structuredClone(stored), { userId: USER }))
    const other = parseZoo(stored, { userId: 'user-2' }).daemons.map((d) => d.uid)
    const mine = parseZoo(stored, { userId: USER }).daemons.map((d) => d.uid)
    expect(other.filter((u) => mine.includes(u))).toEqual([])
    expect(legacyUid(USER, 'tim')).toBe(legacyUid(USER, 'tim'))
    expect(legacyUid(USER, 'tim')).not.toBe(legacyUid(USER, 'yak'))
  })

  it('is idempotent: stored in the new shape and read again, nothing changes', () => {
    const first = parseZoo(stored, { userId: USER })
    const written = JSON.parse(JSON.stringify(first))
    expect(written).not.toHaveProperty('pair')
    expect(parseZoo(written, { userId: USER })).toEqual(first)
    // Whoever reads it next (another account's id, or none) reads the stored uids, not derived ones.
    expect(parseZoo(written, { userId: 'someone-else' })).toEqual(first)
    expect(parseZoo(written)).toEqual(first)
  })

  it('gives a second record of one species (from before duplicates merged) its own individual and uid', () => {
    const zoo = parseZoo({ daemons: [old('tim', { xp: 60 }), old('yak'), old('tim', { shiny: true }), old('tim', { dupes: 2 })], pair: 'tim' }, { userId: USER })
    expect(zoo.daemons.map((d) => [d.id, d.shiny, d.xp])).toEqual([['tim', false, 60], ['yak', false, 0], ['tim', true, 0], ['tim', false, 0]])
    expect(zoo.daemons.map((d) => d.uid)).toEqual([legacyUid(USER, 'tim'), legacyUid(USER, 'yak'), legacyUid(USER, 'tim', 1), legacyUid(USER, 'tim', 2)])
    expect(new Set(zoo.daemons.map((d) => d.uid)).size).toBe(4)
    expect(zoo.paired).toBe(legacyUid(USER, 'tim'))                               // the first of the old pair's species
  })

  it('takes ops by the uids it read, before and after the zoo is written in the new shape', () => {
    const read = parseZoo(stored, { userId: USER })
    const timUid = legacyUid(USER, 'tim')
    const ops: ZooOp[] = [{ op: 'zoo.pair', uid: timUid }, { op: 'zoo.nickname', uid: legacyUid(USER, 'gnu'), name: 'wanda' }]
    const r = apply(read, ops)
    expect(r.zoo.paired).toBe(timUid)
    expect(r.zoo.daemons.find((d) => d.id === 'gnu')?.name).toBe('wanda')
    // Written, read back: the same ops again land on the same individuals and change nothing.
    const back = parseZoo(JSON.parse(JSON.stringify(r.zoo)), { userId: USER })
    expect(apply(back, ops).changed).toBe(false)
  })

  it('drops the old pair when its species is not in the zoo, and a malformed old record like any other', () => {
    const zoo = parseZoo({ daemons: [old('tim'), old('yak', { bond: -1 }), old('gnu', { dupes: 0 }), { ...old('lynx'), extra: 1 }], pair: 'yak' }, { userId: USER })
    expect(zoo.daemons.map((d) => d.id)).toEqual(['tim'])
    expect(zoo.paired).toBeNull()
    // A `paired` in the document is the new shape: an old `pair` beside it is ignored.
    expect(parseZoo({ daemons: [old('tim')], paired: null, pair: 'tim' }, { userId: USER }).paired).toBeNull()
  })
})

describe('what a client draws (zoo_changed goes out only when it moves)', () => {
  const tim = daemon('tim', { xp: 5 })
  const base = (): Zoo => ({ ...emptyZoo(), daemons: [{ ...tim }], paired: tim.uid })

  it('ignores a tally: progress, batch ids, lesson ids, pity, the run toward a new species, easter hashes, xp short of a level', () => {
    const after = base()
    after.progress = { ...after.progress, turns: 12, days: { '2026-09-26': 12 }, batches: ['b1'], lessons: ['l1'], held: [] }
    after.daemons[0]!.xp = 30
    after.pity = 3
    after.sinceNew = 5
    after.easter = ['abc']
    expect(zooShownChanged(base(), after)).toBe(false)
  })

  it('sees what a window, the phone or hn draws', () => {
    const changes: Array<(z: Zoo) => void> = [
      (z) => { z.daemons[0]!.bond = 1 },
      (z) => { z.daemons[0]!.version = '1.0' },
      (z) => { z.daemons[0]!.name = 'timmy' },
      (z) => { z.daemons[0]!.shiny = true },
      (z) => { z.daemons[0]!.serial = 7 },
      (z) => { z.daemons.push({ ...tim, uid: uid('tim2') }) },
      (z) => { z.eggs.push({ id: 'e1', kind: 'turn', grantedAt: '2026-09-26T00:00:00.000Z' }) },
      (z) => { z.paired = null },
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
