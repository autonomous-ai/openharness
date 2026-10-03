/**
 * An individual's traits, from its species and seed: the server's port of daemons/tools/render.mjs
 * `rollTraits`, `individualFlags` and `oneIn` (daemons/README.md, "Individuals"). The zoo stores only the
 * seed (lib/zoo.ts); these are what follows from it, the same on every client, pinned by
 * daemons/frames.json `traitRolls`, which this port matches exactly (zooTraits.test.ts).
 */
import { DAEMON_ROSTER } from './daemonRoster.g.js'

/** A species' trait catalogue (roster.json `daemons[].traits`). */
interface TraitCatalogue {
  colours: ReadonlyArray<readonly [string, number, string, string]>
  marks: ReadonlyArray<readonly [string | null, number]>
  extras: ReadonlyArray<readonly [string | null, number, ...unknown[]]>
  props: Readonly<Record<string, readonly [number, number]>>
  flags?: Readonly<Record<string, { readonly high?: string; readonly low?: string }>>
  accents: readonly string[]
  oddEye: number
  fidgety: number
}

/** What an individual's seed gives it. Each proportion of its species' catalogue is a key of its own. */
export interface Traits {
  seed: number
  colour: string
  marks: string | null
  extra: string | null
  oddEye: boolean
  temper: 'calm' | 'fidgety'
  accent: string
  [proportion: string]: number | string | boolean | null
}

const CATALOGUES: ReadonlyMap<string, TraitCatalogue> = new Map(
  (DAEMON_ROSTER.daemons as ReadonlyArray<{ id: string; traits?: unknown }>)
    .filter((d) => d.traits)
    .map((d) => [d.id, d.traits as TraitCatalogue]),
)

/** mulberry32 on `seed` (daemons/tools/plate.mjs `rng`): uniform in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The traits a seed gives an individual of species `id`, or null for a species without a catalogue.
 * Seed 0 is the species as it was drawn before individuals: the first colour, no markings, no extra, every
 * proportion 1, calm. Otherwise one mulberry32 stream on the seed, drawn in this order: the colour, the
 * markings, the extra (each a weighted pick), the odd eye, each proportion in the catalogue's key order
 * (rounded to hundredths), the temper. The accent is `accents[seed % accents.length]`.
 */
export function rollTraits(id: string, seed: number): Traits | null {
  const T = CATALOGUES.get(id)
  if (!T) return null
  // Built in the reference's key order: seed, colour, marks, extra, oddEye, the proportions, temper, accent.
  const traits = { seed, colour: T.colours[0][0], marks: null, extra: null, oddEye: false } as Traits
  const props = Object.entries(T.props)
  for (const [k] of props) traits[k] = 1
  traits.temper = 'calm'
  traits.accent = T.accents[0]
  if (!seed) return traits
  const r = mulberry32(seed)
  const pick = <V>(list: ReadonlyArray<readonly [V, number, ...unknown[]]>): V => {
    let x = r() * list.reduce((a, e) => a + e[1], 0)
    for (const e of list) if ((x -= e[1]) < 0) return e[0]
    return list[0][0]
  }
  traits.colour = pick(T.colours)
  traits.marks = pick(T.marks)
  traits.extra = pick(T.extras) as string | null
  traits.oddEye = r() < T.oddEye
  for (const [k, [lo, hi]] of props) traits[k] = Math.round((lo + (hi - lo) * r()) * 100) / 100
  traits.temper = r() < T.fidgety ? 'fidgety' : 'calm'
  traits.accent = T.accents[seed % T.accents.length]
  return traits
}

/**
 * An individual as command-line flags: `tim -c coral --spots --glasses --fidgety`. The colour always;
 * then its markings, its extra, `--odd-eye`, a proportion's flag when it falls in the top fifth of its
 * range (a `low` flag, the bottom fifth), in catalogue order, and `--fidgety`.
 */
export function individualFlags(id: string, traits: Traits): string {
  const T = CATALOGUES.get(id)!
  const out = [id, `-c ${traits.colour}`]
  if (traits.marks) out.push(`--${traits.marks}`)
  if (traits.extra) out.push(`--${traits.extra}`)
  if (traits.oddEye) out.push('--odd-eye')
  for (const [k, [lo, hi]] of Object.entries(T.props)) {
    const f = T.flags?.[k]
    const v = traits[k] as number
    if (f?.high && v >= hi - (hi - lo) * 0.2) out.push(`--${f.high}`)
    if (f?.low && v <= lo + (hi - lo) * 0.2) out.push(`--${f.low}`)
  }
  if (traits.temper === 'fidgety') out.push('--fidgety')
  return out.join(' ')
}

/** How rare an individual's look is, as `1 in N`: N = round(1 / p), p the chance of its colour, its
 *  markings, its extra and its eyes together. Proportions and temper do not count. */
export function oneIn(id: string, traits: Traits): number {
  const T = CATALOGUES.get(id)!
  const chance = (list: ReadonlyArray<readonly [string | null, number, ...unknown[]]>, v: string | null) =>
    (list.find((e) => e[0] === v)?.[1] ?? 0) / list.reduce((a, e) => a + e[1], 0)
  const p = chance(T.colours, traits.colour) * chance(T.marks, traits.marks) * chance(T.extras, traits.extra)
    * (traits.oddEye ? T.oddEye : 1 - T.oddEye)
  return Math.round(1 / p)
}
