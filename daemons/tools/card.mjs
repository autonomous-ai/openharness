#!/usr/bin/env node
// Shareable daemon cards and zoo shelves, as text (for a fenced code block) and as SVG (for X, Slack
// previews and a GitHub profile README, where a code block does not travel). Never shows a live mood:
// a card is a portrait, not a presence indicator.
//
//   node daemons/tools/card.mjs tim [--version 1.0] [--shiny] [--serial 42] [--name pip] [--seed 1363] [--svg]
//   node daemons/tools/card.mjs --shelf tim*x2,vim,grue [--drop unix] [--svg]
//
// With --seed the card is that individual (render.mjs rollTraits): its own portrait, its flags and how
// rare it is.
//
// A shelf entry is a daemon id, `*` when it is shiny, and `xN` for N of it (the original and N-1
// duplicates merged into it).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderPortrait, renderSprite, rollTraits, individualFlags, oneIn } from './render.mjs'

const W = 42
const INNER = W - 4

const regulars = roster => roster.daemons.filter(d => d.rarity !== 'secret')
/** `#03/09`, or `#S/09` for a secret: secrets sit outside the numbered set. */
export function cardNumber(roster, d) {
  const set = regulars(roster).filter(x => x.drop === d.drop)
  const of = String(set.length).padStart(2, '0')
  if (d.rarity === 'secret') return `#S/${of}`
  return `#${String(set.indexOf(d) + 1).padStart(2, '0')}/${of}`
}

function wrap(text, width) {
  const out = []
  let line = ''
  for (const word of text.split(' ')) {
    if ((line + ' ' + word).trim().length > width) { out.push(line.trim()); line = word } else line += ' ' + word
  }
  if (line.trim()) out.push(line.trim())
  return out
}

/**
 * An individual's flags as card lines, `width` at most: wrapped at spaces as a long command is, every
 * line but the last ending in ` \` and the lines after the first indented two.
 */
export function flagLines(flags, width) {
  const words = flags.split(' ')
  const out = []
  let line = ''
  words.forEach((word, i) => {
    const indent = out.length ? '  ' : ''
    const next = indent + line + ' ' + word
    // A line that breaks keeps room for its ` \`; the last line may run to the edge.
    if (!line) line = word
    else if (next.length <= width - 2 || (i === words.length - 1 && next.length <= width)) line += ' ' + word
    else { out.push(indent + line + ' \\'); line = word }
  })
  out.push((out.length ? '  ' : '') + line)
  return out
}

/** `1 in 2,130`: a rarity's N with a comma every three digits. */
export const oneInText = n => `1 in ${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`

/**
 * The card as lines of printable ASCII, 42 columns wide. A filled daemon passes its portrait plate
 * (daemons/plates.json: portrait, the version, idle, frame 0; an individual's own when harnessd has
 * drawn it) as `plate`, in place of line art. An individual passes its `traits` (render.mjs
 * rollTraits) and the `name` it was given at the hatch: the card says `pip the tim`, then its flags and
 * how rare it is.
 */
export function cardLines(roster, d, { version = roster.rules.versions[0], shiny = false, serial = null, name = null, nickname = null, traits = null, hatched = null, egg = null, plate = null } = {}) {
  const drop = roster.drops.find(x => x.id === d.drop) ?? { n: 1, name: d.drop }
  const L = s => '| ' + s.padEnd(INNER).slice(0, INNER) + ' |'
  const head = `${cardNumber(roster, d)}  DROP ${drop.n}: ${drop.name.toUpperCase()}`
  const rarity = (shiny ? 'SHINY ' : '') + d.rarity.toUpperCase()
  const called = name ?? nickname
  const title = `${called ? `${called} the ` : ''}${d.id} ${version}${serial != null ? `  #${String(serial).padStart(4, '0')}` : ''}`
  if (d.plate && !plate) throw new Error(`${d.id} is drawn filled: pass its portrait plate`)
  const portrait = plate ?? renderPortrait(roster, d, version, 'idle', { motion: false })
  const width = Math.max(...portrait.map(l => l.length))
  const pad = Math.max(0, Math.floor((INNER - width) / 2))
  return [
    '.' + '-'.repeat(W - 2) + '.',
    L(head + ' '.repeat(Math.max(1, INNER - head.length - rarity.length)) + rarity),
    L(''),
    ...portrait.map(l => L(' '.repeat(pad) + l)),
    L(''),
    L('  ' + title),
    ...(traits ? [...flagLines(individualFlags(roster, d.id, traits), INNER - 2).map(l => L('  ' + l)), L('  ' + oneInText(oneIn(roster, d.id, traits)))] : []),
    L('  ' + d.family.map(f => f[0]).join(' -> ')),
    L(''),
    ...wrap(`"${d.first}"`, INNER - 2).map(l => L('  ' + l)),
    ...(hatched || egg ? [L(''), L(`  hatched ${hatched ?? ''}${egg ? `, ${egg} egg` : ''}`.replace(/\s+,/, ','))] : []),
    "'" + '-'.repeat(W - 2) + "'",
  ]
}

/** A drop's state at `now`: `released` (its daemons hatch), `announced` (they show as silhouettes), or
 *  `hidden` (not announced yet). Dates are UTC days. */
export function dropState(drop, now = new Date()) {
  if (drop?.hold) return 'hidden'
  const at = day => Date.parse(`${day}T00:00:00.000Z`)
  if (!drop?.release || at(drop.release) <= now.getTime()) return 'released'
  return drop.announce && at(drop.announce) <= now.getTime() ? 'announced' : 'hidden'
}

/** The hatchling before it has colour: every drawn cell becomes `#`. */
export const silhouette = sprite => sprite.replace(/[^ ]/g, '#')

/** A shelf entry: an id, or `{ id, shiny, dupes }` for a daemon with duplicates merged into it. */
const ownedMap = owned => new Map(owned.map(o => typeof o === 'string' ? [o, { id: o }] : [o.id, o]))

/**
 * A shelf: the zoo's sprites in order, `[ ? ]` for missing regulars, `[ ! ]` for a missing secret, and
 * `x2` beside a daemon with a duplicate merged into it. A drop announced but not released shows its
 * regulars as silhouettes (and its secret as `[ ! ]`); a drop not yet announced shows nothing.
 */
export function shelfLines(roster, owned, { drop = roster.drops[0].id, now = new Date() } = {}) {
  const have = ownedMap(owned)
  const set = roster.daemons.filter(d => d.drop === drop)
  const drop1 = roster.drops.find(x => x.id === drop)
  const state = dropState(drop1, now)
  if (state === 'hidden') return []
  const cells = set.map(d => {
    const number = d.rarity === 'secret' ? 'secret' : cardNumber(roster, d).slice(0, 3)
    if (state === 'announced') return { top: d.rarity === 'secret' ? '[ ! ]' : silhouette(renderSprite(roster, d, 0, 'idle', { motion: false })), label: number }
    const mine = have.get(d.id)
    if (!mine) return { top: d.rarity === 'secret' ? '[ ! ]' : '[ ? ]', label: number }
    return { top: renderSprite(roster, d, roster.rules.versions.length - 1, 'idle', { motion: false }), label: mine.dupes ? `${d.id} x${mine.dupes + 1}` : d.id }
  })
  const rows = []
  for (let i = 0; i < cells.length; i += 5) {
    const slice = cells.slice(i, i + 5)
    rows.push(slice.map(c => c.top.padEnd(10)).join('').trimEnd())
    rows.push(slice.map(c => c.label.padEnd(10)).join('').trimEnd())
    rows.push('')
  }
  const count = set.filter(d => have.has(d.id) && d.rarity !== 'secret').length
  const of = set.filter(d => d.rarity !== 'secret').length
  const head = `zoo: drop ${drop1?.n ?? 1} ${drop1?.name ?? drop}  ` +
    (state === 'announced' ? `out ${drop1.release}` : `${count}/${of}${set.some(d => d.rarity === 'secret' && have.has(d.id)) ? '  +secret' : ''}`)
  return [head, '', ...rows].slice(0, -1)
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Lines of text as an SVG terminal. `colors` maps a line index to a colour (the portrait gets the
 * daemon's colour, the rest the ink). Monospace system fonts only, so it renders on GitHub.
 */
export function svgFor(lines, { colors = {}, ink = '#d0d0d0', bg = '#121212', border = '#3a3a3a', title = 'daemon' } = {}) {
  const cw = 8.4, lh = 17, padX = 18, padY = 22
  const cols = Math.max(...lines.map(l => l.length))
  const w = Math.ceil(cols * cw + padX * 2)
  const h = Math.ceil(lines.length * lh + padY * 2 - 4)
  const text = lines.map((l, i) =>
    `<text x="${padX}" y="${padY + i * lh + 12}" fill="${colors[i] ?? ink}" xml:space="preserve">${esc(l)}</text>`).join('\n  ')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="6" fill="${bg}" stroke="${border}"/>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="14" font-variant-ligatures="none">
  ${text}
  </g>
</svg>
`
}

export function cardSvg(roster, d, opts = {}) {
  const lines = cardLines(roster, d, opts)
  const portraitRows = opts.plate ? opts.plate.length : renderPortrait(roster, d, opts.version ?? roster.rules.versions[0], 'idle', { motion: false }).length
  const color = opts.shiny && d.shiny ? d.shiny.hex : d.color.hex
  const colors = {}
  // A plate runs down its gradient, a row at a time: an individual's own colour family (a shiny one's
  // is the shiny gradient).
  const family = opts.traits && d.traits?.colours.find(c => c[0] === opts.traits.colour)
  const g = opts.plate && (opts.shiny ? d.shinyGradient : family ? { top: { hex: family[2] }, bottom: { hex: family[3] } } : d.gradient)
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
  const rowColor = r => '#' + rgb(g.top.hex).map((v, i) => Math.round(v + (rgb(g.bottom.hex)[i] - v) * (portraitRows > 1 ? r / (portraitRows - 1) : 0)).toString(16).padStart(2, '0')).join('')
  for (let i = 3; i < 3 + portraitRows; i++) colors[i] = g ? rowColor(i - 3) : color
  colors[1] = { common: '#d0d0d0', rare: '#5fafaf', legendary: '#d7af5f', secret: '#af87af' }[d.rarity]
  return svgFor(lines, { colors, title: `${d.id}, a ${d.rarity} daemon` })
}

/** The shelf as SVG, each owned daemon in its own colour (a shiny one in its shiny colour) and the empty
 *  slots and silhouettes faint. */
export function shelfSvg(roster, owned, opts = {}) {
  const have = ownedMap(owned)
  const set = roster.daemons.filter(d => d.drop === (opts.drop ?? roster.drops[0].id))
  const lines = shelfLines(roster, owned, opts)
  const svg = svgFor(lines, { title: 'daemon zoo' })
  // Colour the sprite rows cell by cell: rows 2, 5, 8… hold sprites, ten columns per cell.
  return svg.replace(/<text x="(\d+)" y="(\d+)" fill="[^"]+" xml:space="preserve">([^<]*)<\/text>/g, (whole, x, y, body) => {
    const row = lines.findIndex(l => esc(l) === body)
    if (row < 2 || (row - 2) % 3 !== 0) return whole
    const first = ((row - 2) / 3) * 5
    const spans = set.slice(first, first + 5).map((d, i) => {
      const cell = lines[row].slice(i * 10, i * 10 + 10)
      const mine = dropState(roster.drops.find(x => x.id === d.drop), opts.now) === 'released' && have.get(d.id)
      const color = mine ? (mine.shiny && d.shiny ? d.shiny.hex : d.color.hex) : '#626262'
      return `<tspan fill="${color}">${esc(cell)}</tspan>`
    }).join('')
    return `<text x="${x}" y="${y}" xml:space="preserve">${spans}</text>`
  })
}

// ---------- command line ----------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const roster = JSON.parse(readFileSync(new URL('../roster.json', import.meta.url), 'utf8'))
  const args = process.argv.slice(2)
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? true) : null }
  const svg = args.includes('--svg')
  const shelf = flag('--shelf')
  if (shelf) {
    // `tim*x3`: a shiny tim with two duplicates merged into it.
    const owned = String(shelf).split(',').filter(Boolean).map(entry => {
      const [, id, star, n] = /^([a-z][a-z0-9-]*)(\*?)(?:x(\d+))?$/.exec(entry) ?? [null, entry, '', null]
      return { id, shiny: star === '*', ...(n && Number(n) > 1 ? { dupes: Number(n) - 1 } : {}) }
    })
    const opts = { drop: flag('--drop') ?? undefined }
    process.stdout.write(svg ? shelfSvg(roster, owned, opts) : shelfLines(roster, owned, opts).join('\n') + '\n')
  } else {
    const d = roster.daemons.find(x => x.id === args[0])
    if (!d) { console.error(`usage: card.mjs <${roster.daemons.map(x => x.id).join('|')}> [--version v] [--shiny] [--serial n] [--name s] [--seed n] [--svg]`); process.exit(2) }
    const version = flag('--version') ?? roster.rules.versions[0]
    const seed = flag('--seed')
    const traits = seed != null && d.traits ? rollTraits(roster, d.id, Number(seed)) : null
    let plate = d.plate ? JSON.parse(readFileSync(new URL('../plates.json', import.meta.url), 'utf8')).daemons[d.id].portrait[version].idle[0].split('\n') : null
    if (traits) {
      // The individual's own portrait, as harnessd bakes it (one crop over every mood of the version).
      const { bakeModel } = await import('./plate.mjs')
      const { model } = await import(`../plates/${d.id}.mjs`)
      plate = bakeModel(model, { ...roster.rules, versions: [version] }, { traits }).portrait[version].idle[0].split('\n')
    }
    const opts = { version, plate, traits, shiny: args.includes('--shiny'), serial: flag('--serial'), name: flag('--name') ?? flag('--nickname') }
    process.stdout.write(svg ? cardSvg(roster, d, opts) : cardLines(roster, d, opts).join('\n') + '\n')
  }
}
