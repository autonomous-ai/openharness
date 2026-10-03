import { describe, expect, it } from 'vitest'
import {
  applyZooOps, draw, drawWeights, emptyZoo, ZOO_FIRST_NEW, ZOO_NEW_AFTER, type Rng, type Zoo, type ZooDaemon, type ZooEgg, type ZooOp,
} from './zoo.js'
import { DAEMON_ROSTER } from './daemonRoster.g.js'

/**
 * The draw, measured. Every test here runs the real draw (and, where it matters, the real hatch op) with a
 * seeded generator hundreds of thousands of times and holds the observed frequencies to what the roster
 * says (daemons/README.md, "The draw") — computed here from the README's rules, not from `drawWeights`.
 *
 * Tolerances: a chi-square goodness-of-fit at alpha = 0.001 over every daemon that can come out, and each
 * proportion within 4.5 standard errors. The seeds are fixed, so a run is reproducible; the bounds are wide
 * enough that a correct draw passes for essentially any seed and tight enough that a mis-weighted one
 * (a lost boost, a secret leaking into an egg that cannot hold one) fails by orders of magnitude (see
 * "the tests have power").
 */

const R = DAEMON_ROSTER.rules
/** After drop 1's (init) release on 2026-09-27, with unix and tty on hold: drop 1 is every daemon a draw can give. */
const NOW = new Date('2026-10-01T12:00:00.000Z')
const OUT = new Set(DAEMON_ROSTER.drops.filter((d) => 'release' in d && Date.parse(`${d.release}T00:00:00.000Z`) <= NOW.getTime()).map((d) => d.id))
const ROSTER = DAEMON_ROSTER.daemons.filter((d) => OUT.has(d.drop))
const KINDS = Object.keys(R.eggs) as Array<keyof typeof R.eggs>
const REGULARS: readonly string[] = ROSTER.filter((d) => d.rarity !== 'secret').map((d) => d.id)
const SECRETS: readonly string[] = ROSTER.filter((d) => d.rarity === 'secret').map((d) => d.id)
const RARITY = new Map<string, string>(ROSTER.map((d) => [d.id, d.rarity]))
/** An hour on: when a retried request arrives. */
const LATER = new Date('2026-10-01T13:00:00.000Z')
const N = 200_000
const SHINY = 1 / R.shinyOneIn

/** sfc32: a small, well-mixed 128-bit-state generator; two outputs make one 53-bit uniform. */
function seeded(seed: number): Rng {
  let a = 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = seed >>> 0
  const u32 = (): number => {
    const t = (((a + b) | 0) + d) | 0
    d = (d + 1) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    c = (c + t) | 0
    return t >>> 0
  }
  for (let i = 0; i < 16; i++) u32()
  return (n) => Math.floor((((u32() >>> 5) * 67108864 + (u32() >>> 6)) / 9007199254740992) * n)
}

/** The README's numbers for new species ("The draw"): the first 4 hatches, and the one after 8 without. */
const FIRST_NEW = 4
const NEW_AFTER = 8

let uids = 0
const daemon = (id: string): ZooDaemon => ({
  uid: (++uids).toString(16).padStart(24, '0'), id, seed: 0, shiny: false, xp: 0, bond: 0, version: '0.1',
  hatched: '2026-09-27T00:00:00.000Z', egg: 'first',
})
/** A zoo owning `ids`, one individual each; `hatches` pads it with more of the first (a species hatched
 *  again), since a zoo's individuals are its hatches. */
const zooOwning = (ids: readonly string[], patch: Partial<Zoo> = {}, hatches = ids.length): Zoo =>
  ({ ...emptyZoo(), daemons: [...ids, ...Array(hatches - ids.length).fill(ids[0])].map(daemon), ...patch })
const egg = (id: string, kind: string): ZooEgg => ({ id, kind, grantedAt: '2026-09-27T00:00:00.000Z' })

/** What a zoo holds that the draw reads: the species owned, how many hatches, the run since a new one, pity. */
interface State { hatches?: number; sinceNew?: number; pity?: number }

/**
 * The README's odds for one hatch, restated independently of the implementation:
 * eligible = every regular, owned or not, + unowned secrets when the egg's secret weight is above 0;
 * weight = weights[rarity] / (eligible of that rarity), + pity for a secret, x boost. At pity
 * secretGuaranteeAt - 1 with an unowned secret, only the unowned secrets. Else, owed a new species (one of
 * the first 4 hatches while any is eligible, or after 8 in a row without one while an unowned regular is
 * left), only the unowned — unless they weigh nothing for this egg, when it draws as usual. An egg whose
 * eligible all weigh nothing draws from everyone.
 */
function expectedOdds(kind: keyof typeof R.eggs, owned: ReadonlySet<string>, state: State = {}): Map<string, number> {
  const { hatches = owned.size, sinceNew = 0, pity = 0 } = state
  const rule = R.eggs[kind] as { weights: Record<string, number>; boost?: Record<string, number> }
  const holdsSecret = (rule.weights.secret ?? 0) > 0
  const fresh = REGULARS.filter((id) => !owned.has(id))
  const secrets = holdsSecret ? SECRETS.filter((id) => !owned.has(id)) : []
  const weigh = (pool: readonly string[]): Map<string, number> => {
    const count = new Map<string, number>()
    for (const id of pool) count.set(RARITY.get(id)!, (count.get(RARITY.get(id)!) ?? 0) + 1)
    return new Map(pool.map((id) => {
      const rarity = RARITY.get(id)!
      const pityBonus = rarity === 'secret' && holdsSecret ? pity * R.pityPerMiss : 0
      return [id, ((rule.weights[rarity] ?? 0) / count.get(rarity)! + pityBonus) * (rule.boost?.[id] ?? 1)]
    }))
  }
  const weighs = (w: Map<string, number>) => [...w.values()].some((x) => x > 0)
  let weights: Map<string, number> | null = null
  if (secrets.length && pity >= R.secretGuaranteeAt - 1) weights = weigh(secrets)
  else {
    const owed = (hatches < FIRST_NEW && fresh.length + secrets.length > 0) || (sinceNew >= NEW_AFTER && fresh.length > 0)
    if (owed && weighs(weigh([...fresh, ...secrets]))) weights = weigh([...fresh, ...secrets])
    weights ??= weigh([...REGULARS, ...secrets])
    if (!weighs(weights)) weights = weigh(ROSTER.map((d) => d.id))
  }
  const total = [...weights.values()].reduce((s, w) => s + w, 0)
  return new Map([...weights].map(([id, w]) => [id, w / total]))
}

/** Upper 0.1% points of chi-square, by degrees of freedom. */
const CHI2_999 = [NaN, 10.828, 13.816, 16.266, 18.467, 20.515, 22.458, 24.322, 26.124, 27.877, 29.588, 31.264]

/** Pearson's chi-square of `counts` against `odds`; anything seen that the odds say is impossible is Infinity. */
function chiSquare(counts: ReadonlyMap<string, number>, odds: ReadonlyMap<string, number>, n: number): { chi2: number; df: number } {
  let chi2 = 0
  let cells = 0
  for (const [id, seen] of counts) if (!((odds.get(id) ?? 0) > 0) && seen > 0) return { chi2: Infinity, df: 1 }
  for (const [id, p] of odds) {
    if (p <= 0) continue
    const e = p * n
    const o = counts.get(id) ?? 0
    chi2 += ((o - e) ** 2) / e
    cells++
  }
  return { chi2, df: Math.max(1, cells - 1) }
}

/** |observed - p| within `z` standard errors of a proportion over `n` trials. */
function expectProportion(seen: number, n: number, p: number, what: string, z = 4.5): void {
  const sigma = Math.sqrt((p * (1 - p)) / n)
  const observed = seen / n
  if (p === 0) { expect(seen, `${what}: impossible, yet seen ${seen} times`).toBe(0); return }
  expect(Math.abs(observed - p), `${what}: observed ${observed.toFixed(5)}, expected ${p.toFixed(5)} ± ${(z * sigma).toFixed(5)}`)
    .toBeLessThanOrEqual(z * sigma)
}

interface Tally { byId: Map<string, number>; byRarity: Map<string, number>; shiny: number; shinyByRarity: Map<string, number>; n: number }

function tallyDraws(zoo: Zoo, kind: string, n: number, seed: number): Tally {
  const rng = seeded(seed)
  const t: Tally = { byId: new Map(), byRarity: new Map(), shiny: 0, shinyByRarity: new Map(), n }
  for (let i = 0; i < n; i++) {
    const d = draw(zoo, kind, rng, NOW)!
    t.byId.set(d.id, (t.byId.get(d.id) ?? 0) + 1)
    t.byRarity.set(d.rarity, (t.byRarity.get(d.rarity) ?? 0) + 1)
    if (d.shiny) { t.shiny++; t.shinyByRarity.set(d.rarity, (t.shinyByRarity.get(d.rarity) ?? 0) + 1) }
  }
  return t
}

function rarityOdds(odds: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [id, p] of odds) out.set(RARITY.get(id)!, (out.get(RARITY.get(id)!) ?? 0) + p)
  return out
}

function expectMatches(t: Tally, odds: ReadonlyMap<string, number>, what: string): void {
  const { chi2, df } = chiSquare(t.byId, odds, t.n)
  expect(chi2, `${what}: chi-square ${chi2.toFixed(2)} on ${df} df`).toBeLessThan(CHI2_999[df])
  for (const [id, p] of odds) expectProportion(t.byId.get(id) ?? 0, t.n, p, `${what} ${id}`)
  for (const [rarity, p] of rarityOdds(odds)) expectProportion(t.byRarity.get(rarity) ?? 0, t.n, p, `${what} ${rarity}`)
  for (const id of t.byId.keys()) expect(odds.has(id), `${what}: ${id} came out but is not eligible`).toBe(true)
}

// One 200,000-draw run per egg kind from a fresh zoo, shared by the tests below.
const FRESH = new Map<string, Tally>()
const freshRun = (kind: string): Tally => {
  if (!FRESH.has(kind)) FRESH.set(kind, tallyDraws(emptyZoo(), kind, N, 0xC0FFEE ^ kind.length * 7919 ^ kind.charCodeAt(0)))
  return FRESH.get(kind)!
}

describe('the draw, measured: 200,000 hatches per egg kind', () => {
  it.each(KINDS)('a fresh %s egg lands on each daemon at the configured odds', (kind) => {
    const odds = expectedOdds(kind, new Set())
    // The configured weights, as the implementation holds them, are the README's to the millionth.
    const units = drawWeights(emptyZoo(), kind, NOW)
    const total = units.reduce((s, w) => s + w.weight, 0)
    for (const w of units) expect(Math.abs(w.weight / total - (odds.get(w.id) ?? 0))).toBeLessThan(1e-6)
    expectMatches(freshRun(kind), odds, `${kind} egg`)
  }, 60_000)

  it('gives the secret only from an egg whose secret weight is above 0 (night, easter)', () => {
    const holding = KINDS.filter((k) => (R.eggs[k].weights as Record<string, number>).secret > 0)
    expect(holding.sort()).toEqual(['easter', 'night'])
    for (const kind of KINDS) {
      const secrets = freshRun(kind).byRarity.get('secret') ?? 0
      if (holding.includes(kind)) {
        const p = rarityOdds(expectedOdds(kind, new Set())).get('secret')!
        expect(p).toBeGreaterThan(0)
        expectProportion(secrets, N, p, `${kind} secret`)
      } else {
        expect(secrets, `${kind} egg gave a secret`).toBe(0)
      }
    }
    // The secret never leaks from a non-secret egg at any pity, however high.
    for (const kind of KINDS.filter((k) => !holding.includes(k))) {
      const t = tallyDraws(zooOwning([], { pity: R.secretGuaranteeAt - 1 }), kind, 20_000, 77)
      expect(t.byRarity.get('secret') ?? 0).toBe(0)
    }
  }, 60_000)

  it('makes tim the likely first hatch: his boosted share of the first egg', () => {
    const first = R.eggs.first as { weights: Record<string, number>; boost: Record<string, number> }
    const commons = ROSTER.filter((d) => d.rarity === 'common').length
    const timWeight = (first.weights.common / commons) * first.boost.tim
    const total = first.weights.common - first.weights.common / commons + timWeight + first.weights.rare + first.weights.legendary
    const share = timWeight / total                                       // 60 / 144 in drop 1
    expect(share).toBeCloseTo(60 / 144, 12)
    expectProportion(freshRun('first').byId.get('tim') ?? 0, N, share, 'tim from the first egg')
    // Nobody else comes close: tim alone outdraws every rare and legendary together.
    const t = freshRun('first')
    expect(t.byId.get('tim')!).toBeGreaterThan((t.byRarity.get('rare') ?? 0) + (t.byRarity.get('legendary') ?? 0))
  }, 60_000)

  it('makes tim the likely first hatch through the real flow: three habits, the first egg, its hatch', () => {
    const rng = seeded(4242)
    let tim = 0
    let shiny = 0
    const n = N
    for (let i = 0; i < n; i++) {
      const granted = applyZooOps(emptyZoo(), [
        { op: 'zoo.habit', key: 'turn' }, { op: 'zoo.habit', key: 'split' }, { op: 'zoo.habit', key: 'find' },
      ], rng, NOW)
      expect(granted.grants.length).toBe(1)
      const hatched = applyZooOps(granted.zoo, [{ op: 'zoo.hatch', eggId: granted.grants[0].eggId! }], rng, NOW)
      const h = hatched.hatched[0]
      if (h.daemonId === 'tim') tim++
      if (h.shiny) shiny++
      expect(hatched.zoo.paired).toBe(h.uid)
    }
    expectProportion(tim, n, expectedOdds('first', new Set()).get('tim')!, 'tim through the flow')
    expectProportion(shiny, n, SHINY, 'shiny through the flow')
  }, 120_000)

  it('rolls shiny 1 in 256, for every egg kind and independent of who hatched', () => {
    let shiny = 0
    let total = 0
    for (const kind of KINDS) {
      const t = freshRun(kind)
      expectProportion(t.shiny, t.n, SHINY, `${kind} shiny`)
      // Independence: within each rarity that came out often enough to measure, shiny stays 1 in 256.
      for (const [rarity, count] of t.byRarity) {
        if (count < 20_000) continue
        expectProportion(t.shinyByRarity.get(rarity) ?? 0, count, SHINY, `${kind} ${rarity} shiny`)
      }
      shiny += t.shiny
      total += t.n
    }
    expect(total).toBe(KINDS.length * N)
    expectProportion(shiny, total, SHINY, 'shiny over every egg')
  }, 60_000)

  it('weighs a rarity by how many of it are left while a new species is owed, and gives an emptied rarity to nobody', () => {
    expect([ZOO_FIRST_NEW, ZOO_NEW_AFTER]).toEqual([FIRST_NEW, NEW_AFTER])
    // [kind, owned, state]: every case owes a new species (under four hatches, or eight without one).
    const cases: Array<[keyof typeof R.eggs, string[], State]> = [
      ['first', ['tim', 'gnu', 'lynx', 'mutt'], { sinceNew: 8 }],     // no common left: its 60 goes nowhere
      ['first', ['tim'], {}],                                         // tim owned: the boost has nothing to boost
      ['turn', ['tim', 'gnu', 'yak'], {}],
      ['week', ['yak', 'gopher', 'bug', 'tux', 'auk'], { sinceNew: 8 }],   // only commons left
      ['marathon', ['tim', 'gnu', 'lynx', 'mutt', 'tux'], { sinceNew: 11 }],
      ['night', ['bug'], { pity: 3 }],                                // the boosted one owned; pity 3 on beastie
      ['night', [], { pity: 6 }],
      ['easter', ['tux'], { pity: 2 }],
      ['turn', ['tim'], { hatches: 3 }],                              // three tims: still owed a new one
    ]
    for (const [kind, owned, state] of cases) {
      const zoo = zooOwning(owned, { pity: state.pity ?? 0, sinceNew: state.sinceNew ?? 0 }, state.hatches)
      const odds = expectedOdds(kind, new Set(owned), state)
      for (const id of owned) expect(odds.has(id), `${kind} would give ${id} again`).toBe(false)
      expectMatches(tallyDraws(zoo, kind, N, 900 + (state.pity ?? 0) + owned.length), odds, `${kind} owning [${owned}] ${JSON.stringify(state)}`)
    }
  }, 120_000)

  it('draws every regular at its rarity\'s share once no new species is owed, owned or not', () => {
    const cases: Array<[keyof typeof R.eggs, string[], State]> = [
      ['turn', ['tim', 'gnu', 'yak', 'tux'], {}],                     // the fifth hatch: owned ones come again
      ['first', ['gnu', 'lynx', 'mutt', 'yak', 'bug'], { sinceNew: 7 }],   // one short of the guarantee
      ['week', REGULARS.slice(0, 8), { sinceNew: 3 }],
      ['night', ['tim', 'gnu', 'lynx', 'mutt'], { pity: 4, sinceNew: 5 }],
      ['turn', [...REGULARS], { sinceNew: 40 }],                      // every regular owned: nothing to owe
      ['night', [...REGULARS], { sinceNew: 40, pity: 2 }],
    ]
    for (const [kind, owned, state] of cases) {
      const zoo = zooOwning(owned, { pity: state.pity ?? 0, sinceNew: state.sinceNew ?? 0 })
      const odds = expectedOdds(kind, new Set(owned), state)
      for (const id of REGULARS) expect(odds.get(id), `${kind}: ${id} not eligible`).toBeGreaterThan(0)
      expectMatches(tallyDraws(zoo, kind, N, 1900 + (state.sinceNew ?? 0) + owned.length), odds, `${kind} owning [${owned}] ${JSON.stringify(state)}`)
    }
  }, 120_000)

  it('the tests have power: a lost boost or a leaked secret fails by orders of magnitude', () => {
    const t = freshRun('first')
    const noBoost = new Map([...expectedOdds('setup', new Set())])        // setup: the first egg's weights, no boost
    const lost = chiSquare(t.byId, noBoost, t.n)
    expect(lost.chi2).toBeGreaterThan(100 * CHI2_999[lost.df])
    // A turn egg that could hold beastie (as if its secret weight were the night egg's) would be told apart too.
    const leaky = new Map([...expectedOdds('turn', new Set())].map(([id, p]) => [id, p * 0.92] as [string, number]))
    leaky.set('beastie', 0.08)
    expect(chiSquare(freshRun('turn').byId, leaky, N).chi2).toBeGreaterThan(100 * CHI2_999[9])
  }, 60_000)
})

// ── The pity guarantee ───────────────────────────────────────────────────────────────────────────
/**
 * The exact distribution of which night hatch (1..8) first gives beastie, from a fresh zoo hatching only
 * night eggs: the chance of every (regulars owned, hatches since a new one) carried forward a hatch at a
 * time, each with the README's odds (pity is the hatch count, as every egg is a night egg).
 */
function beastieArrival(): number[] {
  const arrival = new Array(R.secretGuaranteeAt + 1).fill(0)
  let states = new Map<string, number>([['|0', 1]])                     // 'owned,ids|sinceNew' -> chance
  for (let hatch = 1; hatch <= R.secretGuaranteeAt; hatch++) {
    const next = new Map<string, number>()
    for (const [key, p] of states) {
      const [list, since] = key.split('|')
      const owned = new Set(list ? list.split(',') : [])
      const odds = expectedOdds('night', owned, { hatches: hatch - 1, sinceNew: Number(since), pity: hatch - 1 })
      for (const [id, q] of odds) {
        if (q <= 0) continue
        if (RARITY.get(id) === 'secret') { arrival[hatch] += p * q; continue }
        const now = [...new Set([...owned, id])].sort().join(',')
        const k = `${now}|${owned.has(id) ? Number(since) + 1 : 0}`
        next.set(k, (next.get(k) ?? 0) + p * q)
      }
    }
    states = next
  }
  return arrival
}

describe('the dark egg: the secret by the 8th egg that can hold it', () => {
  const players = N
  it(`always gives beastie by the ${R.secretGuaranteeAt}th night egg, at the README's odds for each hatch (${players} players)`, () => {
    const rng = seeded(8)
    const seen = new Array(R.secretGuaranteeAt + 1).fill(0)
    const eggs = Array.from({ length: R.secretGuaranteeAt }, (_, i) => egg(`n${i + 1}`, 'night'))
    const ops: ZooOp[] = eggs.map((e) => ({ op: 'zoo.hatch', eggId: e.id }))
    for (let i = 0; i < players; i++) {
      const r = applyZooOps({ ...emptyZoo(), eggs }, ops, rng, NOW)
      expect(r.hatched.length).toBe(R.secretGuaranteeAt)
      // The first four are four species; after that one may come again.
      expect(new Set(r.hatched.slice(0, FIRST_NEW).map((h) => h.daemonId)).size).toBe(FIRST_NEW)
      expect(r.zoo.daemons.length).toBe(R.secretGuaranteeAt)
      const at = r.hatched.findIndex((h) => SECRETS.includes(h.daemonId))
      expect(at, 'no beastie in eight night eggs').toBeGreaterThanOrEqual(0)
      seen[at + 1]++
      // Pity counts the night hatches since beastie.
      expect(r.zoo.pity).toBe(R.secretGuaranteeAt - 1 - at)
    }
    const exact = beastieArrival()
    expect(exact.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 12)
    expect(exact[1]).toBeCloseTo(8 / 130, 12)                             // drop 1: 8 of 130 on the first night egg
    // The guarantee carries the most weight: the 8th hatch is the likeliest single arrival.
    for (let k = 1; k < R.secretGuaranteeAt; k++) expect(exact[R.secretGuaranteeAt]).toBeGreaterThan(exact[k])
    const odds = new Map(exact.map((p, k) => [String(k), p] as [string, number]).filter(([, p]) => p > 0))
    const counts = new Map(seen.map((c, k) => [String(k), c] as [string, number]).filter(([, c]) => c > 0))
    const { chi2, df } = chiSquare(counts, odds, players)
    expect(chi2, `arrival chi-square ${chi2.toFixed(2)} on ${df} df`).toBeLessThan(CHI2_999[df])
    for (const [k, p] of odds) expectProportion(counts.get(k) ?? 0, players, p, `beastie at night hatch ${k}`)
  }, 120_000)

  it('holds across night and easter eggs mixed with eggs that cannot hold it, which never move the pity', () => {
    const rng = seeded(88)
    const pickKind = (): string => KINDS[rng(KINDS.length)]
    for (let player = 0; player < 20_000; player++) {
      let zoo = emptyZoo()
      let capable = 0
      for (let step = 0; step < 40 && !zoo.daemons.some((d) => SECRETS.includes(d.id)); step++) {
        const kind = pickKind()
        const pityBefore = zoo.pity
        const r = applyZooOps({ ...zoo, eggs: [egg('x', kind)] }, [{ op: 'zoo.hatch', eggId: 'x' }], rng, NOW)
        zoo = r.zoo
        const holds = kind === 'night' || kind === 'easter'
        if (holds) capable++
        if (!holds) expect(zoo.pity, `${kind} moved the pity`).toBe(pityBefore)
        expect(capable, 'the 8th egg that could hold beastie did not').toBeLessThanOrEqual(R.secretGuaranteeAt)
      }
      if (capable === R.secretGuaranteeAt) expect(zoo.daemons.some((d) => SECRETS.includes(d.id))).toBe(true)
    }
  }, 120_000)

  it('guarantees from any stored pity: at 7 the next egg that can hold it is beastie, every time', () => {
    const rng = seeded(7)
    for (const kind of ['night', 'easter']) {
      const t = tallyDraws(zooOwning(['tim', 'yak'], { pity: R.secretGuaranteeAt - 1 }), kind, 20_000, 7)
      expect(t.byId.get('beastie')).toBe(20_000)
      const r = applyZooOps(zooOwning([], { pity: 999, eggs: [egg('e', kind)] }), [{ op: 'zoo.hatch', eggId: 'e' }], rng, NOW)
      expect(r.hatched[0].daemonId).toBe('beastie')
      expect(r.zoo.pity).toBe(0)
    }
    // With beastie owned, pity guarantees nothing: a night egg draws its regulars at its usual odds.
    const owned = zooOwning(['beastie'], { pity: R.secretGuaranteeAt - 1 })
    expectMatches(tallyDraws(owned, 'night', N, 70), expectedOdds('night', new Set(['beastie']), { pity: R.secretGuaranteeAt - 1 }), 'night with beastie owned')
    const later = zooOwning(['beastie', 'tim', 'gnu', 'yak'], { pity: R.secretGuaranteeAt - 1 })
    expectMatches(tallyDraws(later, 'night', N, 71), expectedOdds('night', new Set(['beastie', 'tim', 'gnu', 'yak']), { pity: R.secretGuaranteeAt - 1 }), 'night with beastie owned, four hatches in')
  }, 120_000)
})

// ── New species: the first four, and never nine in a row without one ────────────────────────────
describe('new species: the first four hatches, and one after eight without', () => {
  /** Egg kinds for these runs: easter one time in three, so its exception (below) is exercised often. */
  const pickKind = (rng: Rng): string => (rng(3) === 0 ? 'easter' : KINDS[rng(KINDS.length)])
  /** Whether an easter egg has no species to give that the zoo lacks: tux, auk and beastie all owned. */
  const easterHasNothingNew = (owned: ReadonlySet<string>) => ['tux', 'auk', 'beastie'].every((id) => owned.has(id))

  it('hatches four different species first, whatever the eggs (20,000 accounts)', () => {
    const rng = seeded(99)
    let easterExceptions = 0
    for (let account = 0; account < 20_000; account++) {
      let zoo = emptyZoo()
      for (let i = 0; i < FIRST_NEW; i++) {
        const kind = pickKind(rng)
        const owned = new Set(zoo.daemons.map((d) => d.id))
        const r = applyZooOps({ ...zoo, eggs: [egg('x', kind)] }, [{ op: 'zoo.hatch', eggId: 'x' }], rng, NOW)
        const got = r.hatched[0].daemonId
        if (owned.has(got)) {
          // The one exception (README, "The draw"): an easter egg, which gives only legendaries and the secret,
          // after those three were the first three hatches. It gives a legendary again rather than nobody.
          expect(kind).toBe('easter')
          expect(easterHasNothingNew(owned)).toBe(true)
          easterExceptions++
        }
        zoo = r.zoo
      }
      expect(zoo.daemons.length).toBe(FIRST_NEW)
    }
    expect(easterExceptions).toBeGreaterThan(0)                          // the exception is exercised, not assumed
  }, 120_000)

  it('never hatches nine in a row without a new species while an unowned regular is left (5,000 collections)', () => {
    const rng = seeded(1999)
    let guaranteed = 0
    let easterWaits = 0
    let longest = 0
    for (let c = 0; c < 5_000; c++) {
      let zoo = emptyZoo()
      let dry = 0
      for (let step = 0; step < 400 && !REGULARS.every((id) => zoo.daemons.some((d) => d.id === id)); step++) {
        const kind = pickKind(rng)
        const owned = new Set(zoo.daemons.map((d) => d.id))
        const r = applyZooOps({ ...zoo, eggs: [egg('x', kind)] }, [{ op: 'zoo.hatch', eggId: 'x' }], rng, NOW)
        const isNew = !owned.has(r.hatched[0].daemonId)
        if (dry >= NEW_AFTER && !isNew) {
          // Owed a new one, it gave one owned: only an easter egg with no legendary or secret left to give.
          expect(kind).toBe('easter')
          expect(easterHasNothingNew(owned)).toBe(true)
          easterWaits++
        } else if (dry >= NEW_AFTER) {
          guaranteed++
        }
        dry = isNew ? 0 : dry + 1
        expect(r.zoo.sinceNew).toBe(dry)                                 // the zoo counts the run as the README does
        longest = Math.max(longest, kind === 'easter' ? 0 : dry)
        zoo = r.zoo
      }
      expect(REGULARS.every((id) => zoo.daemons.some((d) => d.id === id))).toBe(true)
      // Every hatch an individual of its own.
      expect(new Set(zoo.daemons.map((d) => d.uid)).size).toBe(zoo.daemons.length)
    }
    expect(guaranteed).toBeGreaterThan(100)                              // the guarantee is exercised, not assumed
    expect(easterWaits).toBeGreaterThan(0)
    expect(longest).toBeLessThanOrEqual(NEW_AFTER)
  }, 180_000)

  it('owed a new species after eight without, draws the unowned at their odds', () => {
    const cases: Array<[keyof typeof R.eggs, string[]]> = [
      ['turn', ['tim', 'gnu', 'lynx', 'mutt', 'yak']],
      ['first', ['gnu', 'lynx', 'mutt', 'yak', 'gopher', 'bug', 'tux', 'auk']],       // only tim left: always tim
      ['night', ['tim', 'gnu', 'lynx', 'mutt', 'yak', 'gopher']],                   // beastie beside the unowned
      ['easter', ['tim', 'gnu', 'lynx', 'mutt', 'yak', 'tux']],                     // only auk and beastie are new
    ]
    for (const [kind, owned] of cases) {
      const state: State = { sinceNew: NEW_AFTER }
      const zoo = zooOwning(owned, { sinceNew: NEW_AFTER })
      const odds = expectedOdds(kind, new Set(owned), state)
      for (const id of owned) expect(odds.has(id), `${kind} owed a new one would give ${id}`).toBe(false)
      expectMatches(tallyDraws(zoo, kind, N, 3100 + owned.length), odds, `${kind} owed a new one, owning [${owned}]`)
    }
  }, 120_000)
})

// ── Replay and racing writers ────────────────────────────────────────────────────────────────────
const DAYS = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']
const WORDS = ['xyzzy', 'plugh', 'XYZZY']

/**
 * A random op a client could send against `zoo`: mostly names that exist there, some that do not. With
 * `seenOnly`, an individual or a species is named only when the zoo holds it — what a client that saw this
 * zoo can name.
 */
function randomOp(zoo: Zoo, rng: Rng, seenOnly = false): ZooOp {
  const pick = <T>(xs: readonly T[]): T => xs[rng(xs.length)]
  const someDaemon = (): string => (zoo.daemons.length && (seenOnly || rng(4)) ? pick(zoo.daemons).id : seenOnly ? 'nobody' : pick(ROSTER).id)
  const someUid = (): string => (zoo.daemons.length && (seenOnly || rng(4)) ? pick(zoo.daemons).uid : rng(0x1_0000_0000).toString(16).padStart(24, 'f'))
  switch (rng(10)) {
    case 0: return { op: 'zoo.habit', key: pick([...R.firstEgg.habits, 'bogus']) }
    case 1: case 2: return { op: 'zoo.hatch', eggId: zoo.eggs.length && rng(5) ? pick(zoo.eggs).id : `gone${rng(3)}` }
    case 3: return { op: 'zoo.pair', uid: someUid() }
    case 4: return { op: 'zoo.nickname', uid: someUid(), name: rng(3) ? pick(['Tim', 'x', 'grue!']) : null }
    case 5: return { op: 'zoo.autonomy', level: pick(['watch', 'suggest', 'act-on-key', 'act-within-rules', 'future']) }
    case 6: return { op: 'zoo.easter', word: pick(WORDS) }
    // A lesson for a daemon you do not own grows the paired one; with nothing paired yet it waits (it is not
    // remembered), so a batch that hatches your first daemon would credit it on the replay. A client that saw
    // no pair has nothing to credit, so `seenOnly` sends none.
    case 7: return seenOnly && zoo.paired === null ? { op: 'zoo.habit', key: 'days' } : { op: 'zoo.lesson', lessonId: `l${rng(6)}`, daemonId: someDaemon() }
    default: {
      const n = 1 + rng(30)
      return {
        op: 'zoo.turn', batchId: `b${rng(40)}`, n, minutes: rng(2) ? rng(300) : undefined, away: rng(2) ? rng(n + 1) : undefined,
        day: pick(DAYS), hour: rng(24), machineId: pick(['m1', 'm2', 'm3']),
      }
    }
  }
}

/** A zoo reached by real ops from empty: some daemons, eggs, progress, the dial and consent moved. */
function reachableZoo(rng: Rng, steps: number): Zoo {
  let zoo = applyZooOps(emptyZoo(), [
    { op: 'zoo.habit', key: 'turn' }, { op: 'zoo.habit', key: 'split' }, { op: 'zoo.habit', key: 'find' },
  ], rng, NOW).zoo
  for (let i = 0; i < steps; i++) {
    const ops = Array.from({ length: 1 + rng(6) }, () => randomOp(zoo, rng))
    if (rng(8) === 0) ops.push({ op: 'zoo.consent', watching: rng(2) === 0 })
    zoo = applyZooOps(zoo, ops, rng, NOW).zoo
  }
  return zoo
}

describe('replay: the same request twice changes nothing the second time', () => {
  it('every single op is idempotent from any reachable zoo (5,000 zoos x 8 ops)', () => {
    const rng = seeded(2026)
    for (let z = 0; z < 5_000; z++) {
      const zoo = reachableZoo(rng, rng(12))
      for (let k = 0; k < 8; k++) {
        const op = k === 7 ? { op: 'zoo.consent' as const, watching: rng(2) === 0 } : randomOp(zoo, rng)
        const once = applyZooOps(zoo, [op], rng, NOW)
        const twice = applyZooOps(once.zoo, [op], rng, NOW)
        expect(twice.changed, JSON.stringify(op)).toBe(false)
        expect(twice.zoo).toEqual(once.zoo)
        expect(twice.hatched).toEqual([])
        expect(twice.grants).toEqual([])
        expect(twice.levelUps).toEqual([])
      }
    }
  }, 120_000)

  // A batch is what one client queued against the zoo it last saw, so it names only daemons that zoo held.
  // (An op naming a daemon the same batch hatches is dropped on the first delivery and lands on the replay:
  // no client can send one, since the draw is the server's.)
  it('a replayed batch lands on the state the first delivery left (5,000 batches of up to 64 ops)', () => {
    const rng = seeded(64)
    for (let z = 0; z < 5_000; z++) {
      const zoo = reachableZoo(rng, rng(8))
      // Consent answered any number of times, before and after dial moves: no exception (see below).
      const ops = Array.from({ length: 1 + rng(64) }, () => (rng(10) ? randomOp(zoo, rng, true) : { op: 'zoo.consent' as const, watching: rng(2) === 0 }))
      const once = applyZooOps(zoo, ops, rng, NOW)
      // Delivered again an hour later: consent's time is the first delivery's, like everything else.
      const twice = applyZooOps(once.zoo, ops, rng, LATER)
      expect(twice.zoo, JSON.stringify(ops)).toEqual(once.zoo)
      expect(twice.hatched).toEqual([])
      expect(twice.grants).toEqual([])
    }
  }, 120_000)
})

describe('replay: consent and the dial, in any order', () => {
  // Found by the replay property above (it held these out as a known exception until fixed): `zoo.consent
  // { watching: true }` dropped the dial to `watch` only on the transition, so its effect depended on the
  // consent it found, and a retried request (its answer lost) landed somewhere else than the first delivery:
  //  - [dial up, agree]: the first delivery lands at `watch`; the replay found consent given, kept the dial
  //    move and ended ABOVE `watch`, at a level the person never chose after agreeing.
  //  - [agree, revoke] on a zoo agreed at act-on-key: the first delivery kept act-on-key; the replay agreed
  //    from "revoked", which dropped it to `watch`.
  // Now each op is an assignment in the person's order — a level sets the dial, a yes sets it to `watch`
  // (every yes, a repeated one too), a no leaves it — and consent's time moves only when a request changes
  // the answer. So a request lands in the same place however often it arrives.
  const dialUpThenAgree: ZooOp[] = [{ op: 'zoo.autonomy', level: 'act-on-key' }, { op: 'zoo.consent', watching: true }]
  const agreeThenRevoke: ZooOp[] = [{ op: 'zoo.consent', watching: true }, { op: 'zoo.consent', watching: false }]
  const agreed: Zoo = { ...emptyZoo(), autonomy: 'act-on-key', consent: { watching: true, at: '2026-09-30T00:00:00.000Z' } }

  it('a replay of [dial up, agree to be watched] stays at watch', () => {
    const once = applyZooOps(emptyZoo(), dialUpThenAgree, seeded(1), NOW)
    expect(once.zoo).toMatchObject({ autonomy: 'watch', consent: { watching: true, at: NOW.toISOString() } })
    const twice = applyZooOps(once.zoo, dialUpThenAgree, seeded(1), LATER)
    expect(twice.zoo).toEqual(once.zoo)
    expect(twice.changed).toBe(false)
  })

  it('a replay of [agree, revoke] keeps the dial where the first delivery left it', () => {
    // The yes starts the dial at watch (the person agreed again, so they opt in again); the no keeps it.
    const once = applyZooOps(agreed, agreeThenRevoke, seeded(1), NOW)
    expect(once.zoo).toMatchObject({ autonomy: 'watch', consent: { watching: false, at: NOW.toISOString() } })
    const twice = applyZooOps(once.zoo, agreeThenRevoke, seeded(1), LATER)
    expect(twice.zoo).toEqual(once.zoo)
    expect(twice.changed).toBe(false)
  })

  // Everything a person can do to these two in one request, in every order: each of the six moves below,
  // every sequence of up to four (so every permutation of every choice of four), from every start there is.
  type Move = 'watch' | 'suggest' | 'act-on-key' | 'act-within-rules' | 'agree' | 'revoke'
  const MOVES: Move[] = ['watch', 'suggest', 'act-on-key', 'act-within-rules', 'agree', 'revoke']
  const opOf = (move: Move): ZooOp => move === 'agree' || move === 'revoke'
    ? { op: 'zoo.consent', watching: move === 'agree' }
    : { op: 'zoo.autonomy', level: move }
  const sequences = (n: number): Move[][] => n === 0 ? [[]] : sequences(n - 1).flatMap((s) => MOVES.map((m) => [...s, m]))
  const ALL = [1, 2, 3, 4].flatMap(sequences)
  const STARTS: Zoo[] = [null, true, false].flatMap((watching) => (['watch', 'suggest', 'act-on-key', 'act-within-rules'] as const).map((autonomy): Zoo => ({
    ...emptyZoo(), autonomy, consent: watching === null ? null : { watching, at: '2026-09-29T00:00:00.000Z' },
  })))
  /** What the person's moves, in their order, say: the last answer, and the last move of the dial — a yes
   *  being a move to `watch`. Computed from the moves alone, not from the zoo's code. */
  const meant = (start: Zoo, moves: Move[]): { autonomy: string; watching: boolean | null } => {
    const answers = moves.filter((m) => m === 'agree' || m === 'revoke')
    const dial = moves.filter((m) => m !== 'revoke').map((m) => (m === 'agree' ? 'watch' : m))
    return {
      autonomy: dial.length ? dial[dial.length - 1] : start.autonomy,
      watching: answers.length ? answers[answers.length - 1] === 'agree' : start.consent?.watching ?? null,
    }
  }

  it(`every order of up to four moves, from every start: lands where the moves say, and a replay moves nothing (${ALL.length} x ${STARTS.length})`, () => {
    for (const start of STARTS) {
      for (const moves of ALL) {
        const ops = moves.map(opOf)
        const why = `${JSON.stringify(start.consent)} ${start.autonomy} + [${moves.join(', ')}]`
        const once = applyZooOps(start, ops, seeded(1), NOW)
        expect({ autonomy: once.zoo.autonomy, watching: once.zoo.consent?.watching ?? null }, why).toEqual(meant(start, moves))
        // Consent's time moves exactly when the request changed the answer.
        const moved = (once.zoo.consent?.watching ?? null) !== (start.consent?.watching ?? null)
        expect(once.zoo.consent?.at ?? null, why).toBe(moved ? NOW.toISOString() : start.consent?.at ?? null)
        expect(once.changed, why).toBe(once.zoo.autonomy !== start.autonomy || moved)
        // The replay, later, and a third delivery: nothing moves, nothing is written.
        const twice = applyZooOps(once.zoo, ops, seeded(1), LATER)
        expect(twice.zoo, why).toEqual(once.zoo)
        expect(twice.changed, why).toBe(false)
        // One request is the same as the moves sent one at a time (a client that never batched).
        const oneByOne = ops.reduce((zoo, op) => applyZooOps(zoo, [op], seeded(1), NOW).zoo, start)
        expect({ autonomy: oneByOne.autonomy, watching: oneByOne.consent?.watching ?? null }, why).toEqual(meant(start, moves))
        // A level above watch is only ever one the person chose after their last yes.
        const lastYes = moves.lastIndexOf('agree')
        if (lastYes >= 0 && once.zoo.autonomy !== 'watch') {
          expect(moves.slice(lastYes + 1), why).toContain(once.zoo.autonomy)
        }
      }
    }
  })

  it('a revoked level is never raised again by the yes that follows, in one request or two', () => {
    const revoked = applyZooOps(agreed, [{ op: 'zoo.consent', watching: false }], seeded(1), NOW).zoo
    expect(revoked).toMatchObject({ autonomy: 'act-on-key', consent: { watching: false } })
    expect(applyZooOps(revoked, [{ op: 'zoo.consent', watching: true }], seeded(1), LATER).zoo.autonomy).toBe('watch')
    const both = applyZooOps(agreed, [{ op: 'zoo.consent', watching: false }, { op: 'zoo.consent', watching: true }], seeded(1), NOW)
    // Agreed before and after: consent (and its time) did not change, but the yes still starts at watch.
    expect(both.zoo).toMatchObject({ autonomy: 'watch', consent: agreed.consent })
    expect(both.changed).toBe(true)
  })

  it('two writers racing a yes and a dial move: the later write wins, as the person\'s later move', () => {
    // The compare-and-set loser replays its request on the winner's zoo (last writer wins by the zoo's
    // revision): the result is the two moves in the order they were written, either of which a person
    // could have made — a raise after the yes stands, a yes after the raise starts at watch.
    const agree: ZooOp[] = [{ op: 'zoo.consent', watching: true }]
    const raise: ZooOp[] = [{ op: 'zoo.autonomy', level: 'suggest' }]
    const after = (first: ZooOp[], second: ZooOp[]): Zoo => applyZooOps(applyZooOps(emptyZoo(), first, seeded(1), NOW).zoo, second, seeded(1), NOW).zoo
    expect(after(agree, raise)).toMatchObject({ autonomy: 'suggest', consent: { watching: true } })
    expect(after(raise, agree)).toMatchObject({ autonomy: 'watch', consent: { watching: true } })
    // The later write delivered again changes nothing.
    expect(applyZooOps(after(agree, raise), raise, seeded(1), LATER).changed).toBe(false)
    expect(applyZooOps(after(raise, agree), agree, seeded(1), LATER).changed).toBe(false)
  })
})

/**
 * Two (or more) writers racing on one zoo document, the way routes/zoo.ts writes it: read the revision,
 * apply the ops, compare-and-set; a writer that lost re-reads and applies its ops again. Interleavings are
 * chosen by a seeded scheduler.
 */
describe('racing writers under compare-and-set', () => {
  interface Doc { revision: number; zoo: Zoo }
  interface Writer { ops: ZooOp[]; phase: 'read' | 'write' | 'done'; seen?: Doc; applied?: ReturnType<typeof applyZooOps>; answered?: ReturnType<typeof applyZooOps>; attempts: number }

  function race(start: Zoo, batches: ZooOp[][], rng: Rng): { doc: Doc; writers: Writer[]; commits: number } {
    const doc: Doc = { revision: 7, zoo: start }
    const writers: Writer[] = batches.map((ops) => ({ ops, phase: 'read', attempts: 0 }))
    let commits = 0
    for (let guard = 0; writers.some((w) => w.phase !== 'done'); guard++) {
      if (guard > 1000) throw new Error('the race never settled')
      const live = writers.filter((w) => w.phase !== 'done')
      const w = live[rng(live.length)]
      if (w.phase === 'read') {
        w.attempts++
        w.seen = { revision: doc.revision, zoo: doc.zoo }
        w.applied = applyZooOps(w.seen.zoo, w.ops, rng, NOW)
        if (!w.applied.changed) { w.answered = w.applied; w.phase = 'done'; continue }
        w.phase = 'write'
      } else if (w.phase === 'write') {
        if (doc.revision === w.seen!.revision) {
          doc.revision++
          doc.zoo = w.applied!.zoo
          commits++
          w.answered = w.applied
          w.phase = 'done'
        } else {
          w.phase = 'read'                                                  // lost the race: replay on the fresh zoo
        }
      }
    }
    return { doc, writers, commits }
  }

  it('two phones hatching the same eggs: each egg hatches once, and each answer is what was written', () => {
    const rng = seeded(5150)
    for (let trial = 0; trial < 5_000; trial++) {
      const eggs = Array.from({ length: 1 + rng(12) }, (_, i) => egg(`e${i}`, KINDS[rng(KINDS.length)]))
      const start: Zoo = { ...zooOwning(REGULARS.slice(0, rng(4))), eggs }
      const hatchAll = eggs.map((e): ZooOp => ({ op: 'zoo.hatch', eggId: e.id }))
      const shuffled = [...hatchAll].sort(() => rng(3) - 1)
      const { doc, writers, commits } = race(start, [hatchAll, shuffled], rng)
      // The document moved once per write that won; nothing was written twice.
      expect(doc.revision).toBe(7 + commits)
      expect(doc.zoo.eggs).toEqual([])
      const answered = writers.flatMap((w) => w.answered!.hatched)
      expect(new Set(answered.map((h) => h.eggId)).size).toBe(answered.length)
      expect(answered.map((h) => h.eggId).sort()).toEqual(eggs.map((e) => e.id).sort())
      // What the zoo holds is exactly the owned-before plus the individuals answered, each once, as answered.
      expect(doc.zoo.daemons.slice(0, start.daemons.length)).toEqual(start.daemons)
      const added = doc.zoo.daemons.slice(start.daemons.length)
      expect(added.map((d) => d.uid).sort()).toEqual(answered.map((h) => h.uid).sort())
      for (const h of answered) {
        const { eggId: _egg, daemonId, ...individual } = h
        expect(individual.id).toBe(daemonId)
        expect(added.find((d) => d.uid === h.uid)).toEqual(individual)
      }
      expect(new Set(doc.zoo.daemons.map((d) => d.uid)).size).toBe(doc.zoo.daemons.length)
    }
  }, 120_000)

  it('racing turn reports count each batch once, and a batch both machines sent counts once', () => {
    const rng = seeded(1984)
    for (let trial = 0; trial < 5_000; trial++) {
      const day = DAYS[rng(DAYS.length)]
      const mk = (id: string, n: number, machineId: string): ZooOp => ({ op: 'zoo.turn', batchId: id, n, day, hour: 10, machineId })
      const shared = mk('shared', 1 + rng(5), 'm1')
      const a = [shared, mk('a1', 1 + rng(5), 'm1')]
      const b = [mk('b1', 1 + rng(5), 'm2'), shared]
      const c = [mk('c1', 1 + rng(5), 'm3')]
      const { doc } = race(emptyZoo(), [a, b, c], rng)
      const n = (op: ZooOp) => (op.op === 'zoo.turn' ? op.n : 0)
      const want = Math.min(R.earn.turn.dailyCap, n(shared) + n(a[1]) + n(b[0]) + n(c[0]))
      expect(doc.zoo.progress.turns).toBe(want)
      expect(doc.zoo.progress.days[day]).toBe(want)
      // Four batches of at most 5 never pass the daily cap of 20, so each one counted and is remembered once.
      expect([...doc.zoo.progress.batches].sort()).toEqual(['a1', 'b1', 'c1', 'shared'])
      // Two machines seen (only the first `earn.marathon.machines` are remembered): the marathon egg, once.
      expect(doc.zoo.progress.machines.length).toBe(R.earn.marathon.machines)
      expect(doc.zoo.progress.marathon).toEqual(['machines'])
      expect(doc.zoo.eggs.filter((e) => e.kind === 'marathon').length).toBe(1)
    }
  }, 120_000)

  it('a first egg claimed by two racing habit reports is granted once', () => {
    const rng = seeded(3)
    for (let trial = 0; trial < 5_000; trial++) {
      const start = { ...emptyZoo(), habits: ['turn', 'split'] }
      const { doc, writers } = race(start, [[{ op: 'zoo.habit', key: 'find' }], [{ op: 'zoo.habit', key: 'store' }]], rng)
      expect(doc.zoo.eggs.map((e) => e.kind)).toEqual(['first'])
      expect(writers.flatMap((w) => w.answered!.grants)).toEqual([{ kind: 'first', eggId: doc.zoo.eggs[0].id }])
      expect(doc.zoo.firstEgg).toBe(true)
    }
  }, 60_000)
})
