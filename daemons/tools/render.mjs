// The reference renderer for daemons/roster.json. The desktop (Dart) and hn (Rust) ports must draw
// exactly what this draws; daemons/frames.json pins the frames they are checked against.
import { rng } from './plate.mjs'
//
// Placeholders in sprites and portraits:
//   {e}          an eye: the mood's eye, or the lid while blinking (never in noBlinkMoods)
//   {<part>}     a moving part (d.parts): its `rest` glyph, or a frame of `work` every `ms` while working
//   {<moodPart>} a mood-driven part (d.moodParts): its value for the mood, else its idle value

export function eyeFor(roster, d, mood) {
  if (d.eyes && d.eyes[mood] != null) return d.eyes[mood]
  return roster.rules.eyes[mood] ?? 'o'
}

function fill(tpl, roster, d, mood, { t = 0, lid = null, motion = true } = {}) {
  const blinking = lid && !roster.rules.noBlinkMoods.includes(mood)
  const eye = blinking ? (d.lid ?? lid) : eyeFor(roster, d, mood)
  const moving = motion && mood === 'work'
  return tpl.replace(/\{([a-zA-Z]+)\}/g, (whole, key) => {
    if (key === 'e') return eye
    const mp = d.moodParts?.[key]
    if (mp) return mp[mood] ?? mp.idle
    const part = d.parts?.[key]
    if (part) return moving ? part.work[Math.floor(t / part.ms) % part.work.length] : part.rest
    return whole
  })
}

/** One line for the status bar. versionIndex is 0, 1 or 2 (0.1, 1.0, 2.0); t is milliseconds. */
export function renderSprite(roster, d, versionIndex, mood, { t = 0, lid = null, motion = true } = {}) {
  const { versions, statusCells, backFrameMs } = roster.rules
  const last = versions.length - 1
  const moving = motion && (mood === 'work' || mood === 'back')
  let tpl = d.sprites[versions[versionIndex]]
  if (moving && versionIndex === last) {
    const ms = mood === 'back' ? backFrameMs : d.workMs
    tpl = d.work[Math.floor(t / ms) % d.work.length]
  }
  let s = fill(tpl, roster, d, mood, { t, lid, motion: false })
  // Younger versions have no moving part yet; they borrow the twirling baton.
  if (moving && versionIndex < last && s.length <= statusCells - 2) s += ' ' + '|/-\\'[Math.floor(t / 130) % 4]
  if (mood === 'nap' && s.length < statusCells) s += 'z'
  return s
}

/** The portrait for a version, falling back to the nearest one drawn. */
export function portraitFor(roster, d, version) {
  if (d.portraits[version]) return d.portraits[version]
  const drawn = roster.rules.versions.filter(v => d.portraits[v])
  const at = roster.rules.versions.indexOf(version)
  const below = drawn.filter(v => roster.rules.versions.indexOf(v) <= at)
  return d.portraits[below.length ? below[below.length - 1] : drawn[0]]
}

export function renderPortrait(roster, d, version, mood, { t = 0, lid = null, motion = true } = {}) {
  return portraitFor(roster, d, version).map(line => fill(line, roster, d, mood, { t, lid, motion }))
}

/**
 * The status cell: statusCells wide plus one cell of gutter each side. The sprite is centred on its
 * base width (the version's sprite, before a borrowed baton or a nap's `z` is added), so those
 * additions grow to the right and the face never shifts a cell.
 */
export function statusCell(roster, sprite, baseWidth = sprite.length) {
  const cells = roster.rules.statusCells
  const left = Math.max(0, Math.floor((cells - Math.min(baseWidth, cells)) / 2))
  // Always exactly statusCells + 2 wide. A borrowed baton may run into the right gutter (a 6-cell
  // sprite, centred one cell in, plus ' |' ends on the gutter); nothing else ever reaches it.
  return (' ' + ' '.repeat(left) + sprite).padEnd(cells + 2).slice(0, cells + 2)
}

/** The base width statusCell centres on: the version's sprite in its idle mood. */
export function baseWidth(roster, d, versionIndex) {
  return renderSprite(roster, d, versionIndex, 'idle', { motion: false }).length
}

/**
 * A daemon's name as a banner, in the face from daemons/banner.json: every glyph padded to its own
 * widest row, `gap` columns between letters, blank rows dropped.
 */
export function renderBanner(banner, word) {
  const blank = banner.glyphs[' ']
  const glyphs = [...word.toLowerCase()].map(ch => {
    const g = banner.glyphs[ch] ?? blank
    const w = Math.max(...g.map(r => r.length))
    return g.map(r => r.padEnd(w))
  })
  const rows = Array.from({ length: banner.rows }, (_, r) => glyphs.map(g => g[r]).join(' '.repeat(banner.gap)).trimEnd())
  return rows.filter(l => l.trim())
}

/**
 * How far along the first egg is: habits count up to firstEgg.need, and until every required habit
 * (a finished turn) is among them at most need - 1 count. Unknown and repeated habits count nothing.
 * The setup egg counts every known habit toward setupEgg.need the same way, without a requirement.
 */
export function habitProgress(roster, habitsDone, kind = 'first') {
  const { firstEgg, setupEgg } = roster.rules
  const known = new Set(firstEgg.habits.map(h => h.key))
  const done = [...new Set(habitsDone)].filter(k => known.has(k))
  if (kind === 'setup') return { done: Math.min(done.length, setupEgg.need), need: setupEgg.need }
  const required = (firstEgg.require ?? []).every(k => done.includes(k))
  return { done: Math.min(done.length, required ? firstEgg.need : firstEgg.need - 1), need: firstEgg.need }
}

/**
 * The stage an egg shows while it is earned (daemons/plates.json eggs[kind][size][stage], and
 * rules.eggLine): p4 once it is earned and waits to be opened; otherwise by done / need, p0 at none,
 * p1 below a third, p2 below two thirds, p3 from there until it is earned.
 */
export function eggStage(done, need, ready = false) {
  if (ready) return 'p4'
  const f = need > 0 ? done / need : 0
  if (!(f > 0)) return 'p0'
  return f < 1 / 3 ? 'p1' : f < 2 / 3 ? 'p2' : 'p3'
}

/**
 * An egg in the status line, 8 cells at most (rules.eggLine). `{k}` is the kind's mark; a ready egg
 * (p4, or rocking as it opens) blinks with `lid`. Once the shell is open, stage `hatchling` shows the
 * hatchling's 0.1 sprite between the halves, `)` + sprite + `(`, or the sprite alone when that does
 * not fit.
 */
export function eggLine(roster, kind, stage, { lid = null, sprite = '' } = {}) {
  const { eggLine: lines, eggs, statusCells } = roster.rules
  if (stage === 'hatchling') return sprite.length + 2 <= statusCells ? `)${sprite}(` : sprite
  const line = lid && (stage === 'p4' || stage === 'rock') ? lines.blink : lines[stage]
  return line.replace('{k}', eggs[kind]?.mark ?? ' ')
}

// ---------- individuals ----------
// A species (tim, the octopus) is a type; every hatch is its own individual. The server draws a seed;
// the traits follow from the species and the seed alone, the same on every client, from the species'
// catalogue (roster daemons[].traits). A trait is never stored as truth: only the seed is.

/**
 * The traits of an individual of species `id` hatched with `seed`, a whole number from 1 to
 * 4294967295. Seed 0 is the species as it was drawn before individuals (a zoo from before them): its
 * first colour, no markings, no extra, every proportion 1, calm. Otherwise one stream of rng(seed)
 * (mulberry32, plate.mjs) is drawn in this order: the colour, the markings and the extra (each a
 * weighted pick: r * total weight, walked down the list), the odd eye (r < oddEye), each proportion in
 * the catalogue's order (lo + (hi - lo) * r, rounded to hundredths), and the temper (r < fidgety). The
 * markings' accent colour is accents[seed % accents.length]. Null for a species without a catalogue.
 */
export function rollTraits(roster, id, seed) {
  const T = roster.daemons.find(d => d.id === id)?.traits
  if (!T) return null
  const traits = { seed, colour: T.colours[0][0], marks: null, extra: null, oddEye: false }
  for (const k of Object.keys(T.props)) traits[k] = 1
  Object.assign(traits, { temper: 'calm', accent: T.accents[0] })
  if (!seed) return traits
  const r = rng(seed)
  const pick = list => {
    let x = r() * list.reduce((a, e) => a + e[1], 0)
    for (const e of list) if ((x -= e[1]) < 0) return e[0]
    return list[0][0]
  }
  traits.colour = pick(T.colours)
  traits.marks = pick(T.marks)
  traits.extra = pick(T.extras)
  traits.oddEye = r() < T.oddEye
  for (const [k, [lo, hi]] of Object.entries(T.props)) traits[k] = Math.round((lo + (hi - lo) * r()) * 100) / 100
  traits.temper = r() < T.fidgety ? 'fidgety' : 'calm'
  traits.accent = T.accents[seed % T.accents.length]
  return traits
}

/**
 * An individual as command-line flags: `tim -c coral --spots --glasses --fidgety`. The colour always;
 * then its markings, its extra, `--odd-eye`, a proportion's flag (catalogue `flags`) when it falls in
 * the top fifth of its range (or, for a `low` flag, the bottom fifth), in catalogue order, and
 * `--fidgety`.
 */
export function individualFlags(roster, id, traits) {
  const T = roster.daemons.find(d => d.id === id).traits
  const out = [id, `-c ${traits.colour}`]
  if (traits.marks) out.push(`--${traits.marks}`)
  if (traits.extra) out.push(`--${traits.extra}`)
  if (traits.oddEye) out.push('--odd-eye')
  for (const [k, [lo, hi]] of Object.entries(T.props)) {
    const f = T.flags?.[k]
    if (f?.high && traits[k] >= hi - (hi - lo) * 0.2) out.push(`--${f.high}`)
    if (f?.low && traits[k] <= lo + (hi - lo) * 0.2) out.push(`--${f.low}`)
  }
  if (traits.temper === 'fidgety') out.push('--fidgety')
  return out.join(' ')
}

/**
 * How rare an individual's look is, as `1 in N`: N = round(1 / p), p the chance of its colour, its
 * markings, its extra and its eyes (odd or not) together. Proportions and temper do not count.
 */
export function oneIn(roster, id, traits) {
  const T = roster.daemons.find(d => d.id === id).traits
  const chance = (list, v) => (list.find(e => e[0] === v)?.[1] ?? 0) / list.reduce((a, e) => a + e[1], 0)
  const p = chance(T.colours, traits.colour) * chance(T.marks, traits.marks) * chance(T.extras, traits.extra) * (traits.oddEye ? T.oddEye : 1 - T.oddEye)
  return Math.round(1 / p)
}

/**
 * The daemon as an individual shows it in the status line: a rare extra brings its own sprites and
 * work frames (catalogue `extras[i][3]`), and a fidgety one works at half `workMs`. Colour, markings
 * and the odd eye do not show there. Use it wherever a daemon's sprite is drawn (renderSprite,
 * baseWidth, eggLine's hatchling).
 */
export function individualDaemon(roster, id, traits) {
  const d = roster.daemons.find(x => x.id === id)
  const extra = traits?.extra ? d.traits?.extras.find(e => e[0] === traits.extra)?.[3] : null
  const fidgety = traits?.temper === 'fidgety'
  if (!extra && !fidgety) return d
  return { ...d, ...(extra ? { sprites: extra.sprites, work: extra.work } : {}), ...(fidgety ? { workMs: d.workMs / 2 } : {}) }
}

/** renderSprite for an individual: its extra's sprite, and its temper's pace. */
export function renderIndividualSprite(roster, id, traits, versionIndex, mood, opts = {}) {
  return renderSprite(roster, individualDaemon(roster, id, traits), versionIndex, mood, opts)
}
