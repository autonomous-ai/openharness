// Bakes every plate a client can show into daemons/plates.json, so no client runs a model: each prints
// text. For every daemon with `plate: true`, at the portrait and reveal widths (rules.plate), every
// version and mood gets its loop of frames; all frames of one width and version share one crop, so
// nothing jumps between moods. Every egg kind gets every stage (daemons/plates/egg.mjs STAGES) with
// its material rows; all stages of one kind and width share one crop. The file carries a hash of what
// it was baked from, and is baked again only when a model, the shader, the egg kinds or what
// rules.plate says about frames changes (a bake takes minutes).
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { plate, crop, cropBox, bakeModel } from './plate.mjs'

export function plateSource(root, roster) {
  const { cols, frames, frameMs } = roster.rules.plate
  const h = createHash('sha256')
  h.update(readFileSync(resolve(root, 'daemons/tools/plate.mjs')))
  h.update(JSON.stringify({ cols, frames, frameMs, eggs: Object.keys(roster.rules.eggs) }))
  h.update(readFileSync(resolve(root, 'daemons/plates/egg.mjs')))
  for (const d of roster.daemons.filter(d => d.plate)) {
    h.update(d.id)
    h.update(readFileSync(resolve(root, `daemons/plates/${d.id}.mjs`)))
  }
  return h.digest('hex')
}

export async function bakePlates(root, roster) {
  const { rules } = roster
  const spec = rules.plate
  const source = plateSource(root, roster)
  const path = resolve(root, 'daemons/plates.json')
  if (existsSync(path)) {
    const old = JSON.parse(readFileSync(path, 'utf8'))
    if (old.source === source) return old
  }
  const out = { source, frameMs: spec.frameMs, daemons: {} }
  for (const d of roster.daemons.filter(d => d.plate)) {
    const m = await import(pathToFileURL(resolve(root, `daemons/plates/${d.id}.mjs`)).href)
    out.daemons[d.id] = bakeModel(m.model, rules)
    process.stderr.write(`  baked ${d.id}\n`)
  }
  out.eggs = await bakeEggs(root, roster)
  return out
}

// Every egg kind at both widths: eggs[kind][size][stage] = [{ rows, mats }], each a string of rows
// joined by newlines; `mats` holds each cell's material (plate.mjs: g glow, s star, p peek, . none).
async function bakeEggs(root, roster) {
  const egg = await import(pathToFileURL(resolve(root, 'daemons/plates/egg.mjs')).href)
  const eggs = {}
  for (const kind of Object.keys(roster.rules.eggs)) {
    eggs[kind] = {}
    for (const [size, cols] of Object.entries(roster.rules.plate.cols)) {
      const stages = [], frames = [], mats = []
      for (const [stage, list] of Object.entries(egg.STAGES)) {
        for (const inputs of list) {
          const m = []
          frames.push(plate(egg.model({ kind, ...inputs }), cols, { mats: m }))
          mats.push(m)
          stages.push(stage)
        }
      }
      const box = cropBox(frames), rows = crop(frames, box), cells = crop(mats, box)
      const byStage = {}
      rows.forEach((r, i) => (byStage[stages[i]] ??= []).push({ rows: r.join('\n'), mats: cells[i].join('\n') }))
      eggs[kind][size] = byStage
    }
    process.stderr.write(`  baked the ${kind} egg\n`)
  }
  return eggs
}

// The colour of one character of a plate, as every client draws it: row r of `rows` takes its colour
// from the daemon's gradient, top to bottom; a faint glyph mixes from the background toward it, a dense
// one is the row colour, and `@` mixes on toward white. Returns #rrggbb.
export function plateColor(roster, d, rows, r, ch, { bg = '#0c0c0c', shiny = false } = {}) {
  const g = shiny ? d.shinyGradient : d.gradient
  const row = mix(rgb(g.top.hex), rgb(g.bottom.hex), rows > 1 ? r / (rows - 1) : 0)
  return inked(roster, row, ch, bg)
}

// The colour of one character of an egg plate. The shell runs down the kind's gradient like a daemon's
// plate; a glow cell (`g`, the light inside) is rules.plate.light[light]: `plain` while it is earned,
// the rarity's (common, rare, legendary, secret) once it is opened; a peek cell (`p`, the eyes in the
// chip) is light.peek; a star cell (`s`) is the kind's stars. `dim` (a secret's opening, while the
// light is violet) takes the shell down to 0.22 of its colour and the stars to 0.3; the light stays.
export function eggColor(roster, kind, rows, r, ch, mat, { bg = '#0c0c0c', light = 'plain', dim = false } = {}) {
  const egg = roster.rules.eggs[kind], L = roster.rules.plate.light
  let base
  if (mat === 'g') base = rgb(L[light].hex)
  else if (mat === 'p') base = rgb(L.peek.hex)
  else if (mat === 's') base = dim ? mix(rgb(bg), rgb(egg.stars.hex), 0.3) : rgb(egg.stars.hex)
  else {
    const row = mix(rgb(egg.gradient.top.hex), rgb(egg.gradient.bottom.hex), rows > 1 ? r / (rows - 1) : 0)
    base = dim ? mix(rgb(bg), row, 0.22) : row
  }
  return inked(roster, base, ch, bg)
}

// The colour of one character of an individual's plate (harnessd draws it; rows and material rows).
// Its body runs down its colour family (render.mjs rollTraits `colour`; a shiny one's is the species'
// shinyGradient); a marking cell (`m`) is its accent, an extra's (`a`) the extra's colour, the odd eye
// (`e`) rules.plate.oddEye. Clients paint the species plate in the colour family until the individual's
// own plate arrives.
export function individualColor(roster, d, traits, rows, r, ch, mat, { bg = '#0c0c0c', shiny = false } = {}) {
  let base
  if (mat === 'm') base = rgb(traits.accent)
  else if (mat === 'a') base = rgb(d.traits.extras.find(e => e[0] === traits.extra)[2])
  else if (mat === 'e') base = rgb(roster.rules.plate.oddEye.hex)
  else {
    const family = d.traits.colours.find(c => c[0] === traits.colour)
    const [top, bottom] = shiny ? [d.shinyGradient.top.hex, d.shinyGradient.bottom.hex] : [family[2], family[3]]
    base = mix(rgb(top), rgb(bottom), rows > 1 ? r / (rows - 1) : 0)
  }
  return inked(roster, base, ch, bg)
}

const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))
// A glyph's brightness from rules.plate.ink: at most 1 mixes from the background toward the colour,
// above 1 on toward white by the excess. Null for a character with no ink (a space).
function inked(roster, c, ch, bg) {
  const level = roster.rules.plate.ink[ch]
  if (level === undefined) return null
  const out = level > 1 ? mix(c, [255, 255, 255], level - 1) : mix(rgb(bg), c, level)
  return '#' + out.map(v => v.toString(16).padStart(2, '0')).join('')
}
