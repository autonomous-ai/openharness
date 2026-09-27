#!/usr/bin/env node
// Checks daemons/roster.json against the art rules and writes the copies each client reads.
// Run after changing the roster: node daemons/tools/generate.mjs   (CI: --check)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { renderSprite, renderPortrait, statusCell, baseWidth, renderBanner, eggStage, eggLine, habitProgress, rollTraits, individualFlags, oneIn, individualDaemon, renderIndividualSprite } from './render.mjs'
import { cardLines } from './card.mjs'
import { plate as shade, cropBox, crop } from './plate.mjs'
import { bakePlates, plateColor, eggColor, individualColor } from './bake.mjs'
import { KINDS as EGG_KINDS, STAGES as EGG_STAGES } from '../plates/egg.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const check = process.argv.includes('--check')
const text = readFileSync(resolve(root, 'daemons/roster.json'), 'utf8')
const roster = JSON.parse(text)
const { rules } = roster

const problems = []
const whole = (v, min = 1) => Number.isInteger(v) && v >= min
const fail = msg => { if (!problems.includes(msg)) problems.push(msg) }
const printable = s => /^[\x20-\x7e]*$/.test(s)
// Programming fonts (Fira Code, JetBrains Mono, Cascadia) merge these pairs into one glyph, so two eyes
// side by side, or an eye against a face character, would draw as a symbol. No frame may contain one.
const unsafe = rules.ligatureUnsafe ?? []
if (!Array.isArray(unsafe) || !unsafe.length || unsafe.some(p => typeof p !== 'string' || p.length < 2 || !printable(p))) {
  fail('rules.ligatureUnsafe must list the printable character pairs that fonts merge')
}
const ligature = s => unsafe.find(p => s.includes(p))

/** The hex a terminal draws for an xterm-256 index from 16: the 6x6x6 cube, then the grey ramp. */
function xtermHex(n) {
  const hex = x => x.toString(16).padStart(2, '0')
  if (n >= 232) { const g = 8 + 10 * (n - 232); return `#${hex(g)}${hex(g)}${hex(g)}` }
  const level = [0, 0x5f, 0x87, 0xaf, 0xd7, 0xff], i = n - 16
  return `#${hex(level[Math.floor(i / 36)])}${hex(level[Math.floor(i / 6) % 6])}${hex(level[i % 6])}`
}

// A colour as the roster writes it: { xterm, hex }, an xterm-256 index from 16 with the hex a terminal shows.
const xtermColor = c => c && Number.isInteger(c.xterm) && c.xterm >= 16 && c.xterm <= 255 && c.hex === xtermHex(c.xterm)

const ids = new Set()
const drops = new Set(roster.drops.map(d => d.id))
// A drop is announced 14 days before it is released; only released drops hatch, announced ones show as
// silhouettes (README, "The draw", "Cards and shelves").
const isoDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s
// A drop on hold is kept but has no dates: never announced, never drawn, until it gets them.
for (const drop of roster.drops) {
  if (drop.hold) {
    if (drop.hold !== true || 'announce' in drop || 'release' in drop) fail(`drop ${drop.id}: a drop on hold has hold: true and no dates`)
  } else if (!isoDay(drop.announce) || !isoDay(drop.release)) fail(`drop ${drop.id}: announce and release must be YYYY-MM-DD dates`)
  else if (Date.parse(drop.release) - Date.parse(drop.announce) !== 14 * 86_400_000) fail(`drop ${drop.id}: announce must be 14 days before release`)
}
if (roster.drops.every(d => d.hold)) fail('every drop is on hold: nothing could ever hatch')
// Plates (README, "Plates"): filled daemons are baked at these widths, with these frame counts.
const plateRules = rules.plate
if (roster.daemons.some(d => d.plate)) {
  if (!plateRules || !whole(plateRules.frameMs) || !whole(plateRules.frames?.idle) || !whole(plateRules.frames?.other)) fail('rules.plate needs frameMs and frames.idle and frames.other')
  else {
    for (const size of ['portrait', 'reveal']) {
      if (!whole(plateRules.cols?.[size]) || !whole(plateRules.maxRows?.[size])) fail(`rules.plate needs cols.${size} and maxRows.${size}`)
    }
    const ink = plateRules.ink ?? {}
    if (!Object.keys(ink).length || Object.entries(ink).some(([ch, v]) => ch.length !== 1 || !printable(ch) || ch === ' ' || !(v > 0 && v <= 2))) fail('rules.plate.ink maps each printed glyph to a brightness above 0 and at most 2')
  }
}
for (const d of roster.daemons) {
  if (ids.has(d.id)) fail(`${d.id}: duplicate id`)
  ids.add(d.id)
  if (!/^[a-z][a-z0-9-]{0,15}$/.test(d.id)) fail(`${d.id}: id must be a short lowercase command name`)
  if (!rules.rarities.includes(d.rarity)) fail(`${d.id}: unknown rarity ${d.rarity}`)
  if (!drops.has(d.drop)) fail(`${d.id}: unknown drop ${d.drop}`)
  // A filled daemon: its model is daemons/plates/<id>.mjs, and its colour runs top to bottom.
  if (d.plate != null) {
    if (d.plate !== true) fail(`${d.id}: plate must be true or absent`)
    else if (!existsSync(resolve(root, `daemons/plates/${d.id}.mjs`))) fail(`${d.id}: plate daemon has no model daemons/plates/${d.id}.mjs`)
    for (const [what, g] of [['gradient', d.gradient], ['shinyGradient', d.shinyGradient]]) {
      for (const stop of ['top', 'bottom']) {
        const c = g?.[stop]
        if (!c || !Number.isInteger(c.xterm) || c.xterm < 16 || c.xterm > 255 || c.hex !== xtermHex(c.xterm)) fail(`${d.id}: ${what}.${stop} must be an xterm-256 index from 16 with its hex`)
      }
    }
  }
  // Colours are xterm-256 indices with the hex a terminal shows for them. A shiny daemon wears its own.
  for (const [what, c] of [['color', d.color], ['shiny', d.shiny]]) {
    if (!c || !Number.isInteger(c.xterm) || c.xterm < 16 || c.xterm > 255) fail(`${d.id}: ${what}.xterm must be an xterm-256 index from 16 to 255`)
    else if (c.hex !== xtermHex(c.xterm)) fail(`${d.id}: ${what}.hex ${c.hex} is not xterm ${c.xterm} (${xtermHex(c.xterm)})`)
  }
  if (d.shiny && d.color && d.shiny.xterm === d.color.xterm) fail(`${d.id}: a shiny colour must differ from the usual one`)
  if (!d.first || !printable(d.first)) fail(`${d.id}: first words missing or not ASCII`)
  // Lines are templates: only known slots, and every template has an example with its slots filled.
  if (rules.lineSlots) {
    for (const mood of rules.moods) {
      const line = d.lines?.[mood] ?? ''
      for (const [, slot] of line.matchAll(/\{([a-zA-Z]+)\}/g)) {
        if (!rules.lineSlots.includes(slot)) fail(`${d.id}: line for ${mood} uses unknown slot {${slot}}`)
      }
      const ex = d.examples?.[mood]
      if (!ex) fail(`${d.id}: no example for ${mood}`)
      else if (/\{[a-zA-Z]+\}/.test(ex)) fail(`${d.id}: example for ${mood} still has a slot`)
      else if (!printable(ex)) fail(`${d.id}: example for ${mood} is not ASCII`)
    }
  }
  for (const mood of rules.moods) {
    if (!d.lines?.[mood]) fail(`${d.id}: no line for ${mood}`)
    else if (!printable(d.lines[mood])) fail(`${d.id}: line for ${mood} is not ASCII`)
  }
  for (const v of rules.versions) if (!d.sprites?.[v]) fail(`${d.id}: no sprite for ${v}`)
  if (!d.plate && !d.portraits?.['2.0']) fail(`${d.id}: no 2.0 portrait`)
  // A daemon may draw with fewer characters, as its lore did (tty: only what a Teletype Model 33 could
  // print; lp0: a line printer's density ramp). Eyes aside: every template, part and mood part keeps to it.
  if (d.charset != null) {
    if (typeof d.charset !== 'string' || !d.charset || !printable(d.charset)) fail(`${d.id}: charset must be a string of printable ASCII`)
    else {
      const drawn = [...Object.values(d.sprites ?? {}), ...(d.work ?? []), ...Object.values(d.portraits ?? {}).flat(),
        ...Object.values(d.parts ?? {}).flatMap(p => [p.rest, ...p.work]), ...Object.values(d.moodParts ?? {}).flatMap(m => Object.values(m))]
      for (const tpl of drawn) {
        const off = [...tpl.replace(/\{[a-zA-Z]+\}/g, '')].find(ch => !d.charset.includes(ch))
        if (off) fail(`${d.id}: "${off}" in "${tpl}" is outside its charset`)
      }
    }
  }
  // A line that types out, a character every typeMs (tty: a Model 33's ten characters a second).
  if (d.typeMs != null && !(Number.isInteger(d.typeMs) && d.typeMs >= 10 && d.typeMs <= 1000)) fail(`${d.id}: typeMs must be a whole number of ms from 10 to 1000`)
  // Every mood, every version, every frame of motion, plus both blink lids.
  const times = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200]
  for (const mood of rules.moods) {
    for (const [vi, v] of rules.versions.entries()) {
      for (const t of times) {
        for (const lid of [null, '-', '_']) {
          const s = renderSprite(roster, d, vi, mood, { t, lid })
          if (s.length > rules.statusCells) fail(`${d.id} ${v} ${mood}: sprite "${s}" is wider than ${rules.statusCells} cells`)
          if (!printable(s)) fail(`${d.id} ${v} ${mood}: sprite "${s}" is not printable ASCII`)
          if (ligature(s)) fail(`${d.id} ${v} ${mood}: sprite "${s}" has "${ligature(s)}", which fonts draw as one glyph`)
        }
      }
    }
    for (const v of Object.keys(d.portraits || {})) {
      for (const t of times) {
        for (const lid of [null, '-', '_']) {
          const lines = renderPortrait(roster, d, v, mood, { t, lid })
          if (lines.length > rules.portraitMaxRows) fail(`${d.id} ${v}: portrait has ${lines.length} rows`)
          for (const line of lines) {
            if (/\{[a-zA-Z]+\}/.test(line)) fail(`${d.id} ${v} ${mood}: unfilled placeholder in "${line}"`)
            if (!printable(line)) fail(`${d.id} ${v} ${mood}: portrait line "${line}" is not printable ASCII`)
            if (line.length > rules.portraitMaxCols) fail(`${d.id} ${v}: portrait line is ${line.length} columns`)
            if (ligature(line)) fail(`${d.id} ${v} ${mood}: portrait line "${line}" has "${ligature(line)}", which fonts draw as one glyph`)
          }
        }
      }
    }
  }
}
for (const [kind, egg] of Object.entries(rules.eggs)) {
  for (const r of rules.rarities) if (typeof egg.weights[r] !== 'number') fail(`egg ${kind}: no weight for ${r}`)
  for (const id of Object.keys(egg.boost || {})) if (!ids.has(id)) fail(`egg ${kind}: boosts unknown daemon ${id}`)
}
// Eggs (README, "Eggs"): every kind is drawn by daemons/plates/egg.mjs, runs down its own gradient, and
// shows in the status line as rules.eggLine with its mark. The one-line looks, the line-art egg and the
// nest stages they replace are gone.
if ('nest' in rules || 'egg' in rules) fail('rules.nest and rules.egg are gone: eggs are drawn by daemons/plates/egg.mjs and shown in one line by rules.eggLine')
for (const [kind, egg] of Object.entries(rules.eggs)) {
  if ('look' in egg) fail(`egg ${kind}: look is gone: the status line shows rules.eggLine with the kind's mark`)
  if (!EGG_KINDS[kind]) fail(`egg ${kind}: daemons/plates/egg.mjs does not draw it`)
  if (typeof egg.mark !== 'string' || egg.mark.length !== 1 || !printable(egg.mark)) fail(`egg ${kind}: mark must be one printable character`)
  for (const stop of ['top', 'bottom']) if (!xtermColor(egg.gradient?.[stop])) fail(`egg ${kind}: gradient.${stop} must be an xterm-256 index from 16 with its hex`)
  if (EGG_KINDS[kind]?.stars ? !xtermColor(egg.stars) : 'stars' in egg) fail(`egg ${kind}: stars must be an xterm colour exactly when the egg draws stars`)
}
const eggLineStages = ['p0', 'p1', 'p2', 'p3', 'p4', 'blink', 'rock', 'burst', 'tumble', 'open']
for (const stage of eggLineStages) {
  const tpl = rules.eggLine?.[stage]
  if (typeof tpl !== 'string') { fail(`rules.eggLine.${stage} is missing`); continue }
  if (/\{(?!k\})[^}]*\}/.test(tpl)) fail(`rules.eggLine.${stage}: the only placeholder is {k}, the kind's mark`)
}
for (const stage of Object.keys(rules.eggLine ?? {})) if (!eggLineStages.includes(stage)) fail(`rules.eggLine.${stage}: not a stage`)
const eggArt = (what, s) => {
  if (s.length > rules.statusCells) fail(`${what}: "${s}" is wider than ${rules.statusCells} cells`)
  if (!printable(s)) fail(`${what}: "${s}" is not printable ASCII`)
  if (ligature(s)) fail(`${what}: "${s}" has "${ligature(s)}", which fonts draw as one glyph`)
}
if (!problems.length) {
  for (const kind of Object.keys(rules.eggs)) {
    for (const stage of eggLineStages.filter(s => s !== 'blink')) {
      for (const lid of [null, '-', '_']) eggArt(`egg ${kind} ${stage}`, eggLine(roster, kind, stage, { lid }))
    }
  }
  // The hatchling between the halves of its shell, in its 0.1 sprite, eyes open and blinking.
  for (const d of roster.daemons) {
    for (const lid of [null, '-', '_']) eggArt(`${d.id} hatching`, eggLine(roster, 'first', 'hatchling', { sprite: renderSprite(roster, d, 0, 'idle', { lid }) }))
  }
}
// The light through an egg's cracks: plain while it is earned, the rarity's once it is opened.
for (const key of ['plain', ...rules.rarities, 'peek']) if (!xtermColor(rules.plate?.light?.[key])) fail(`rules.plate.light.${key} must be an xterm-256 index from 16 with its hex`)
for (const key of ['loop', 'rock', 'burstHold', 'burst', 'tumble', 'open']) if (!whole(rules.plate?.eggMs?.[key])) fail(`rules.plate.eggMs.${key} must be a whole number of ms`)
// Individuals (README, "Individuals"): every plate species has a trait catalogue, and the roll, the
// flags and the rarity come from it alone. Colours are xterm-256 hexes; weights whole; every name is a
// flag; a proportion's range holds 1 (the species plate); a rare extra carries its status-line variant,
// checked like every sprite.
const XTERM_HEXES = new Set(Array.from({ length: 240 }, (_, i) => xtermHex(i + 16)))
const flagName = s => typeof s === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(s)
if (roster.daemons.some(d => d.traits) && !xtermColor(rules.plate?.oddEye)) fail('rules.plate.oddEye must be an xterm-256 index from 16 with its hex')
if (roster.daemons.some(d => d.traits) && !whole(rules.plate?.room, 0)) fail('rules.plate.room: the portrait rows an individual may stand above its species, a whole number')
const spriteTimes = [0, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200]
for (const d of roster.daemons) {
  const T = d.traits
  if (!T) { if (d.plate) fail(`${d.id}: a plate species needs a traits catalogue`); continue }
  if (!d.plate) { fail(`${d.id}: only a plate species has traits`); continue }
  const named = []
  const weighted = (what, list, nulls) => {
    if (!Array.isArray(list) || list.length < 2) { fail(`${d.id}: traits.${what} needs at least two entries`); return }
    for (const e of list) {
      if (!Array.isArray(e) || !whole(e[1])) fail(`${d.id}: traits.${what} ${JSON.stringify(e?.[0])} needs a whole weight of at least 1`)
      if (e?.[0] === null) continue
      if (!flagName(e?.[0])) fail(`${d.id}: traits.${what} name ${JSON.stringify(e?.[0])} must be a short lowercase flag`)
      named.push(e?.[0])
    }
    if (list.filter(e => e?.[0] === null).length !== nulls) fail(`${d.id}: traits.${what} must have ${nulls ? 'one null entry (none)' : 'no null entry'}`)
  }
  weighted('colours', T.colours, 0)
  weighted('marks', T.marks, 1)
  weighted('extras', T.extras, 1)
  for (const [name, , top, bottom] of T.colours ?? []) if (!XTERM_HEXES.has(top) || !XTERM_HEXES.has(bottom)) fail(`${d.id}: colour ${name} must run between two xterm-256 hexes`)
  if (T.colours?.[0]?.[2] !== d.gradient?.top?.hex || T.colours?.[0]?.[3] !== d.gradient?.bottom?.hex) fail(`${d.id}: the first colour must be the species' gradient`)
  for (const [name, , hex, variant] of T.extras ?? []) {
    if (name === null ? hex !== null || variant !== undefined : !XTERM_HEXES.has(hex)) fail(`${d.id}: extra ${name} must have an xterm-256 hex (none for null)`)
    if (name !== null && variant !== undefined) {
      for (const v of rules.versions) if (typeof variant.sprites?.[v] !== 'string') fail(`${d.id} --${name}: no sprite for ${v}`)
      if (!Array.isArray(variant.work) || !variant.work.length || variant.work.some(w => typeof w !== 'string')) fail(`${d.id} --${name}: work must be a list of frames`)
    }
  }
  if (!T.accents?.length || T.accents.some(h => !XTERM_HEXES.has(h))) fail(`${d.id}: traits.accents must be xterm-256 hexes`)
  const props = Object.entries(T.props ?? {})
  if (!props.length) fail(`${d.id}: traits.props needs a proportion`)
  for (const [k, r] of props) {
    if (!/^[a-z][a-zA-Z]*$/.test(k) || !Array.isArray(r) || r.length !== 2 || !(r[0] < r[1]) || r[0] > 1 || r[1] < 1) fail(`${d.id}: traits.props.${k} must be [lo, hi] around 1`)
  }
  for (const [k, f] of Object.entries(T.flags ?? {})) {
    if (!T.props?.[k]) fail(`${d.id}: traits.flags.${k} names no proportion`)
    if (!f || (!f.high && !f.low) || Object.keys(f).some(x => x !== 'high' && x !== 'low')) fail(`${d.id}: traits.flags.${k} is { high, low }`)
    for (const x of [f?.high, f?.low].filter(Boolean)) { if (!flagName(x)) fail(`${d.id}: flag ${x} must be a short lowercase flag`); named.push(x) }
  }
  named.push('odd-eye', 'fidgety')
  const twice = named.find((x, i) => named.indexOf(x) !== i)
  if (twice) fail(`${d.id}: --${twice} means two things`)
  for (const key of ['oddEye', 'fidgety']) if (!(T[key] > 0 && T[key] < 1)) fail(`${d.id}: traits.${key} is a chance between 0 and 1`)
  // A fidgety individual works at half workMs, a whole number of ms.
  if (!whole(d.workMs) || d.workMs % 2) fail(`${d.id}: workMs must be even, so a fidgety one's half is whole`)
}
// A rare extra's status-line variant, like every sprite: every version, mood, frame of motion and
// blink, fidgety too, in 8 cells, printable, without a ligature; unlike its species' own and every
// other daemon's at the same version; and between the halves of its shell as it hatches.
if (!problems.length) {
  for (const d of roster.daemons.filter(d => d.traits)) {
    for (const [name, , , variant] of d.traits.extras) {
      if (!variant) continue
      for (const temper of ['calm', 'fidgety']) {
        const traits = { extra: name, temper }
        for (const mood of rules.moods) {
          for (const [vi, v] of rules.versions.entries()) {
            for (const t of spriteTimes) {
              for (const lid of [null, '-', '_']) {
                const s = renderIndividualSprite(roster, d.id, traits, vi, mood, { t, lid })
                const what = `${d.id} --${name} ${v} ${mood}`
                if (s.length > rules.statusCells) fail(`${what}: sprite "${s}" is wider than ${rules.statusCells} cells`)
                if (!printable(s)) fail(`${what}: sprite "${s}" is not printable ASCII`)
                if (ligature(s)) fail(`${what}: sprite "${s}" has "${ligature(s)}", which fonts draw as one glyph`)
                if (/\{[a-zA-Z]+\}/.test(s)) fail(`${what}: unfilled placeholder in "${s}"`)
              }
            }
          }
        }
      }
      const variantD = individualDaemon(roster, d.id, { extra: name })
      for (const [vi, v] of rules.versions.entries()) {
        const mine = renderSprite(roster, variantD, vi, 'idle', { motion: false })
        const clash = roster.daemons.find(o => renderSprite(roster, o, vi, 'idle', { motion: false }) === mine)
        if (clash) fail(`${d.id} --${name} ${v}: sprite "${mine}" is ${clash.id}'s`)
      }
      for (const lid of [null, '-', '_']) eggArt(`${d.id} --${name} hatching`, eggLine(roster, 'first', 'hatchling', { sprite: renderSprite(roster, variantD, 0, 'idle', { lid }) }))
    }
  }
}
// Every plate species' model takes every trait in its catalogue: DEFAULT (the species plate) holds each
// proportion at 1, and each marking, extra and the odd eye paints cells of its own material (2.0, idle,
// at the reveal width).
const plateModels = {}
for (const d of problems.length ? [] : roster.daemons.filter(d => d.plate && d.traits)) {
  const m = plateModels[d.id] = await import(pathToFileURL(resolve(root, `daemons/plates/${d.id}.mjs`)).href)
  const D = m.DEFAULT
  if (!D) { fail(`daemons/plates/${d.id}.mjs: no DEFAULT traits`); continue }
  for (const k of Object.keys(d.traits.props)) if (D[k] !== 1) fail(`daemons/plates/${d.id}.mjs: DEFAULT.${k} must be 1, the species plate`)
  if (D.marks !== null || D.extra !== null || D.oddEye !== false || D.temper !== 'calm' || D.seed !== 0) fail(`daemons/plates/${d.id}.mjs: DEFAULT is no markings, no extra, no odd eye, calm, seed 0`)
  const paints = (traits, letter) => {
    const mats = []
    shade(m.model({ t: 0, mood: 'idle', age: '2.0', traits: { ...D, seed: 7, ...traits } }), rules.plate.cols.reveal, { mats })
    return mats.some(row => row.includes(letter))
  }
  // An individual's canvas may have room above the species' for a hat: whole portrait rows, at most
  // rules.plate.room of them, so its plates stay within maxRows plus that (twice it at the reveal).
  const room = (m.model({ traits: D }).h - m.size.h) / (m.size.h / Math.max(1, Math.round((rules.plate.cols.portrait * m.size.h) / (2 * m.size.w))))
  if (Math.abs(room - Math.round(room)) > 1e-9 || room < 0 || room > rules.plate.room) fail(`daemons/plates/${d.id}.mjs: an individual's headroom must be whole portrait rows, at most rules.plate.room (${rules.plate.room})`)
  for (const [marks] of d.traits.marks) if (marks && !paints({ marks }, 'm')) fail(`${d.id} --${marks}: the model paints no marking cells`)
  for (const [extra] of d.traits.extras) if (extra && !paints({ extra }, 'a')) fail(`${d.id} --${extra}: the model paints no extra cells`)
  if (!paints({ oddEye: true }, 'e')) fail(`${d.id} --odd-eye: the model paints no odd eye`)
}
const habitKeys = rules.firstEgg.habits.map(h => h.key)
if (rules.firstEgg.need > habitKeys.length) fail('first egg needs more habits than exist')
for (const k of rules.firstEgg.require ?? []) if (!habitKeys.includes(k)) fail(`firstEgg.require names unknown habit ${k}`)
if ((rules.firstEgg.require ?? []).length > rules.firstEgg.need) fail('firstEgg requires more habits than it needs')
if (!(rules.setupEgg?.need > rules.firstEgg.need) || rules.setupEgg.need > habitKeys.length) fail('setupEgg.need must be more than firstEgg.need and at most every habit')
// Earning and growing (README, "Earning eggs and growing"): whole positive numbers, an egg rule for every
// kind the server grants, levels that climb from 0, and a version for every level a daemon can reach.
for (const kind of ['first', 'setup', 'easter', 'turn', 'week', 'marathon', 'night', 'history']) if (!rules.eggs[kind]) fail(`egg ${kind} is granted but has no egg rule`)
// Secrets sit outside the set: only an egg with a secret weight can hold one, so some egg must.
if (roster.daemons.some(d => d.rarity === 'secret') && !Object.values(rules.eggs).some(e => e.weights.secret > 0)) fail('a secret exists but no egg can hold one')
const earn = rules.earn ?? {}
for (const [path, v] of [['turn.every', earn.turn?.every], ['turn.dailyCap', earn.turn?.dailyCap], ['turn.minutesPerTurn', earn.turn?.minutesPerTurn],
  ['week.days', earn.week?.days], ['marathon.turns', earn.marathon?.turns], ['marathon.machines', earn.marathon?.machines],
  ['night.nights', earn.night?.nights], ['night.awayMinutes', earn.night?.awayMinutes], ['history.days', earn.history?.days]]) {
  if (!whole(v)) fail(`earn.${path} must be a whole number of at least 1`)
}
if (earn.week?.days > 7) fail('earn.week.days cannot be more than the 7 days of a week')
// A night may run past midnight: fromHour 22, toHour 6 is 22:00 to 06:59.
if (!whole(earn.night?.fromHour, 0) || !whole(earn.night?.toHour, 0) || earn.night.fromHour > 23 || earn.night.toHour > 23 || earn.night.fromHour === earn.night.toHour + 1) {
  fail('earn.night hours must be 0-23 and leave some hours of the day outside the night')
}
if (earn.history?.days > 28) fail('earn.history.days must be at most 28 (a history egg is once per date per year)')
for (const [path, v] of [['secretGuaranteeAt', rules.secretGuaranteeAt], ['duplicateXp', rules.duplicateXp], ['overflowXp', rules.overflowXp], ['lessonXp', rules.lessonXp]]) {
  if (!whole(v)) fail(`rules.${path} must be a whole number of at least 1`)
}
// Easter words are never shipped in the clear: the roster holds the sha256 of each lowercased word.
if ('easterWords' in rules) fail('rules.easterWords is gone: list sha256 hashes in rules.easterHashes')
if (!Array.isArray(rules.easterHashes) || rules.easterHashes.some(h => !/^[0-9a-f]{64}$/.test(h))) fail('rules.easterHashes must be lowercase sha256 hex strings')
const levels = rules.bond?.levels ?? []
if (levels[0] !== 0 || levels.some((x, i) => !whole(x, 0) || (i > 0 && x <= levels[i - 1]))) fail('bond.levels must start at 0 and climb')
if (!whole(rules.bond?.xpPerTurn, 0) || !whole(rules.bond?.xpPerDay, 0)) fail('bond.xpPerTurn and bond.xpPerDay must be whole numbers')
for (const v of rules.versions) {
  const at = rules.bondForVersion[v]
  if (!whole(at, 0) || at >= levels.length) fail(`bondForVersion.${v} must be a level from 0 to ${levels.length - 1}`)
}
if (rules.bondForVersion[rules.versions[0]] !== 0) fail('the first version must need bond level 0')
// A history date may name a daemon no drop holds yet: its eggs draw from the usual pool until one does.
for (const [date, id] of Object.entries(rules.historyDates ?? {})) {
  const [m, d] = date.split('-').map(Number)
  const real = /^\d\d-\d\d$/.test(date) && m >= 1 && m <= 12 && d >= 1 && new Date(Date.UTC(2024, m - 1, d)).getUTCDate() === d
  if (!real) fail(`historyDates: ${date} is not a MM-DD calendar date`)
  if (id !== null && !/^[a-z][a-z0-9-]{0,15}$/.test(id)) fail(`historyDates.${date}: ${id} is not a daemon id or null`)
}
if (text.includes("'''")) fail("roster.json may not contain ''' (the Dart copy is a raw string)")
// The banner face: printable, one row count, every letter a daemon's name needs.
const bannerText = readFileSync(resolve(root, 'daemons/banner.json'), 'utf8')
const banner = JSON.parse(bannerText)
for (const [ch, rows] of Object.entries(banner.glyphs)) {
  if (rows.length !== banner.rows) fail(`banner ${JSON.stringify(ch)}: ${rows.length} rows, not ${banner.rows}`)
  for (const r of rows) if (!printable(r)) fail(`banner ${JSON.stringify(ch)}: not printable ASCII`)
}
for (const d of roster.daemons) {
  for (const ch of d.id) if (!banner.glyphs[ch]) fail(`banner has no glyph for ${JSON.stringify(ch)} (in ${d.id})`)
  for (const line of renderBanner(banner, d.id)) {
    for (const pair of ['->', '=>', '==', '-<', '>-', '<=', '>=', '!=', '??', '::']) {
      if (line.includes(pair)) fail(`banner for ${d.id} draws ${pair}, which ligature fonts merge`)
    }
  }
}
if (bannerText.includes("'''")) fail("banner.json may not contain '''")
// Bake the plates (or reuse the baked file when nothing it came from changed), then check every frame:
// in its box, printable, no ligature pair, and one size for every mood and frame of a version.
const plates = roster.daemons.some(d => d.plate) && !problems.length ? await bakePlates(root, roster) : null
for (const d of plates ? roster.daemons.filter(d => d.plate) : []) {
  for (const size of ['portrait', 'reveal']) {
    for (const v of rules.versions) {
      const byMood = plates.daemons[d.id]?.[size]?.[v]
      if (!byMood) { fail(`${d.id}: no ${size} plate for ${v}`); continue }
      let box = null
      for (const mood of rules.moods) {
        const want = mood === 'idle' ? plateRules.frames.idle : plateRules.frames.other
        if (byMood[mood]?.length !== want) fail(`${d.id} ${size} ${v}: ${mood} has ${byMood[mood]?.length ?? 0} frames, not ${want}`)
        for (const frame of byMood[mood] ?? []) {
          const rows = frame.split('\n')
          const dims = `${rows.length}x${rows[0].length}`
          if (box && dims !== box) fail(`${d.id} ${size} ${v}: frames differ in size (${dims}, ${box})`)
          box ??= dims
          if (rows.length > plateRules.maxRows[size]) fail(`${d.id} ${size} ${v}: plate has ${rows.length} rows, more than ${plateRules.maxRows[size]}`)
          for (const row of rows) {
            if (row.length > plateRules.cols[size]) fail(`${d.id} ${size} ${v}: plate row is ${row.length} columns`)
            if (!printable(row)) fail(`${d.id} ${size} ${v} ${mood}: plate row is not printable ASCII`)
            if (ligature(row)) fail(`${d.id} ${size} ${v} ${mood}: plate row has "${ligature(row)}", which fonts draw as one glyph`)
            const off = [...row].find(ch => ch !== ' ' && plateRules.ink[ch] === undefined)
            if (off) fail(`${d.id} ${size} ${v} ${mood}: plate glyph "${off}" has no ink level`)
          }
        }
      }
    }
  }
}
// Every egg kind at both widths: every stage with its frames, one size for all of them, in its box,
// printable and ligature-free, and a material row for every row (g glow, s star, p peek, . none).
for (const kind of plates ? Object.keys(rules.eggs) : []) {
  for (const size of ['portrait', 'reveal']) {
    const byStage = plates.eggs?.[kind]?.[size]
    if (!byStage) { fail(`egg ${kind}: no ${size} plate`); continue }
    let box = null
    for (const [stage, list] of Object.entries(EGG_STAGES)) {
      if (byStage[stage]?.length !== list.length) fail(`egg ${kind} ${size}: ${stage} has ${byStage[stage]?.length ?? 0} frames, not ${list.length}`)
      for (const frame of byStage[stage] ?? []) {
        const rows = frame.rows.split('\n'), mats = frame.mats.split('\n')
        const dims = `${rows.length}x${rows[0].length}`
        if (box && dims !== box) fail(`egg ${kind} ${size}: frames differ in size (${dims}, ${box})`)
        box ??= dims
        if (rows.length > plateRules.maxRows[size]) fail(`egg ${kind} ${size}: ${rows.length} rows, more than ${plateRules.maxRows[size]}`)
        if (mats.length !== rows.length) fail(`egg ${kind} ${size} ${stage}: material rows do not match its rows`)
        rows.forEach((row, r) => {
          if (row.length > plateRules.cols[size]) fail(`egg ${kind} ${size}: a row is ${row.length} columns`)
          if (!printable(row)) fail(`egg ${kind} ${size} ${stage}: a row is not printable ASCII`)
          if (ligature(row)) fail(`egg ${kind} ${size} ${stage}: a row has "${ligature(row)}", which fonts draw as one glyph`)
          const off = [...row].find(ch => ch !== ' ' && plateRules.ink[ch] === undefined)
          if (off) fail(`egg ${kind} ${size} ${stage}: glyph "${off}" has no ink level`)
          const m = mats[r] ?? ''
          if (m.length !== row.length || /[^.gsp]/.test(m) || [...row].some((ch, c) => ch === ' ' && m[c] !== '.')) fail(`egg ${kind} ${size} ${stage}: material row "${m}" does not fit its row`)
        })
      }
    }
  }
}
if (problems.length) {
  console.error(problems.map(p => '  ' + p).join('\n'))
  console.error(`daemons/roster.json: ${problems.length} problem(s)`)
  process.exit(1)
}

function output(path, content) {
  const full = resolve(root, path)
  if (check) {
    if (!existsSync(full) || readFileSync(full, 'utf8') !== content) {
      console.error(`${path} is stale; run node daemons/tools/generate.mjs`)
      process.exit(1)
    }
  } else {
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

const header = '// Generated from daemons/roster.json by daemons/tools/generate.mjs. Do not edit.\n'
// The Dart clients read the whole roster as a raw string: the desktop and the phone, each its own
// package (the phone depends on nothing else in this repo), so each gets its own copy.
const dartRoster = `${header}// ignore_for_file: prefer_single_quotes\nconst daemonRosterJson = r'''\n${text}''';\nconst daemonBannerJson = r'''\n${bannerText}''';\n`
output('desktop/lib/daemons/roster.g.dart', dartRoster)
output('mobile/lib/daemons/roster.g.dart', dartRoster)
// Baked plates: the canonical file here (hn reads it at build time), and a raw-string copy per Dart client.
if (plates) {
  const platesText = JSON.stringify(plates) + '\n'
  if (platesText.includes("'''")) fail("plates.json may not contain '''")
  output('daemons/plates.json', platesText)
  const dartPlates = `${header}// ignore_for_file: prefer_single_quotes\nconst daemonPlatesJson = r'''\n${platesText}''';\n`
  output('desktop/lib/daemons/plates.g.dart', dartPlates)
  output('mobile/lib/daemons/plates.g.dart', dartPlates)
}

// The server needs only what decides a draw, a grant or a level: who exists, how rare, the egg rules,
// what earns an egg and how bond grows. Art stays in the clients.
const server = {
  version: roster.version,
  rules: {
    rarities: rules.rarities,
    shinyOneIn: rules.shinyOneIn,
    pityPerMiss: rules.pityPerMiss,
    secretGuaranteeAt: rules.secretGuaranteeAt,
    duplicateXp: rules.duplicateXp,
    overflowXp: rules.overflowXp,
    lessonXp: rules.lessonXp,
    firstEgg: { need: rules.firstEgg.need, require: rules.firstEgg.require ?? [], habits: habitKeys },
    setupEgg: rules.setupEgg,
    eggs: Object.fromEntries(Object.entries(rules.eggs).map(([k, e]) => [k, { weights: e.weights, ...(e.boost ? { boost: e.boost } : {}) }])),
    easterHashes: rules.easterHashes,
    versions: rules.versions,
    bondForVersion: rules.bondForVersion,
    bond: rules.bond,
    earn: rules.earn,
    historyDates: rules.historyDates,
  },
  drops: roster.drops.map(d => d.hold ? { id: d.id, hold: true } : { id: d.id, announce: d.announce, release: d.release }),
  // A plate species' trait catalogue, for the roll (render.mjs rollTraits): the server stores only the
  // seed, and names an individual's traits from it. The extras' status-line variants stay with the art.
  daemons: roster.daemons.map(d => ({ id: d.id, n: d.n, drop: d.drop, rarity: d.rarity, ...(d.traits ? { traits: { ...d.traits, extras: d.traits.extras.map(e => e.slice(0, 3)) } } : {}) })),
}
output('backend/src/lib/daemonRoster.g.ts', `${header}export const DAEMON_ROSTER = ${JSON.stringify(server, null, 2)} as const\n`)
// The pair brain's template voice (cli/src/pair/voice.ts): who exists and what each says per mood, and —
// for the pair harness's instructions (cli/src/pair/pairHarness.ts) — each daemon's lore, first words and
// family. Also how long an absence makes a finished turn an away turn (cli/src/lib/zooTurns.ts, the night
// egg). The cli compiles only what is under cli/src, so it gets its own copy rather than reading this folder.
const pair = {
  lineSlots: rules.lineSlots ?? [],
  awayMinutes: rules.earn.night.awayMinutes,
  daemons: roster.daemons.map(d => ({ id: d.id, lore: d.lore, first: d.first, family: d.family, lines: d.lines })),
}
output('cli/src/pair/roster.g.ts', `${header}export const PAIR_ROSTER = ${JSON.stringify(pair, null, 2)} as const\n`)
// harnessd draws each individual on the machine (README, "Individual art"): the shader, every plate
// species' model and the reference roll, copied as they are (type-checking off: they are the reference
// JavaScript), with what they read from the roster. PLATE_MODELS[id].model goes to bakeModel with
// PLATE_ROSTER.rules and rollTraits(PLATE_ROSTER, id, seed).
const copyHeader = source => `// Generated from ${source} by daemons/tools/generate.mjs. Do not edit.\n// @ts-nocheck\n`
const plateIds = roster.daemons.filter(d => d.plate).map(d => d.id)
output('cli/src/pair/plates/plate.g.ts', copyHeader('daemons/tools/plate.mjs') + readFileSync(resolve(root, 'daemons/tools/plate.mjs'), 'utf8'))
output('cli/src/pair/plates/render.g.ts', copyHeader('daemons/tools/render.mjs') + readFileSync(resolve(root, 'daemons/tools/render.mjs'), 'utf8').replace("from './plate.mjs'", "from './plate.g.js'"))
for (const id of plateIds) {
  const src = readFileSync(resolve(root, `daemons/plates/${id}.mjs`), 'utf8')
  if (!src.includes("from '../tools/plate.mjs'")) fail(`daemons/plates/${id}.mjs must import the shader from '../tools/plate.mjs'`)
  output(`cli/src/pair/plates/${id}.g.ts`, copyHeader(`daemons/plates/${id}.mjs`) + src.replace("from '../tools/plate.mjs'", "from './plate.g.js'"))
}
const plateRoster = {
  rules: { versions: rules.versions, moods: rules.moods, plate: { cols: rules.plate.cols, maxRows: rules.plate.maxRows, frameMs: rules.plate.frameMs, frames: rules.plate.frames } },
  daemons: roster.daemons.filter(d => d.traits).map(d => ({ id: d.id, traits: { ...d.traits, extras: d.traits.extras.map(e => e.slice(0, 3)) } })),
}
// PLATE_SOURCE is plates.json's source hash: what the models and shader were when these were copied,
// so harnessd keys its cache of individual art by it and draws again after a change.
output('cli/src/pair/plates/models.g.ts', `${header}${plateIds.map(id => `import * as ${id.replace(/-/g, '_')} from './${id}.g.js'`).join('\n')}\n\n` +
  `export const PLATE_MODELS = { ${plateIds.map(id => (/^[a-z]+$/.test(id) ? id : `'${id}': ${id.replace(/-/g, '_')}`)).join(', ')} }\n\n` +
  `export const PLATE_SOURCE = '${plates?.source ?? ''}'\n\n` +
  `export const PLATE_ROSTER = ${JSON.stringify(plateRoster, null, 2)}\n`)
// Frames every port must reproduce exactly (desktop and hn tests read this file).
const frames = { sprites: [], portraits: [] }
for (const d of roster.daemons) {
  for (const mood of rules.moods) {
    for (const t of [0, 300]) {
      for (const [vi, v] of rules.versions.entries()) {
        for (const lid of [null, '-']) frames.sprites.push({ id: d.id, v, mood, t, lid, out: renderSprite(roster, d, vi, mood, { t, lid }) })
        if (!d.plate) frames.portraits.push({ id: d.id, v, mood, t, out: renderPortrait(roster, d, v, mood, { t }) })
      }
    }
  }
}
// Status cells: the sprite placed in its slot, centred on the version's base width.
frames.cells = []
for (const d of roster.daemons) {
  for (const [vi, v] of rules.versions.entries()) {
    for (const mood of rules.moods) {
      for (const t of [0, 300]) {
        const s = renderSprite(roster, d, vi, mood, { t })
        frames.cells.push({ id: d.id, v, mood, t, out: statusCell(roster, s, baseWidth(roster, d, vi)) })
      }
    }
  }
}
// Cards every client draws the same way (daemons/tools/card.mjs).
// A filled daemon's card shows its portrait plate, idle, first frame.
const cardPlate = (d, version) => d.plate ? plates.daemons[d.id].portrait[version].idle[0].split('\n') : null
frames.cards = []
for (const d of roster.daemons) {
  for (const version of rules.versions) {
    frames.cards.push({ id: d.id, version, out: cardLines(roster, d, { version, plate: cardPlate(d, version) }) })
    frames.cards.push({ id: d.id, version, shiny: true, serial: 42, nickname: 'pip', hatched: '2026-09-26', egg: 'first', out: cardLines(roster, d, { version, plate: cardPlate(d, version), shiny: true, serial: 42, nickname: 'pip', hatched: '2026-09-26', egg: 'first' }) })
  }
}
// An individual's card: its name, its flags (the longest line of them among the first thousand seeds,
// so they wrap) and how rare it is, on its species' plate until harnessd has drawn its own.
for (const d of roster.daemons.filter(d => d.traits)) {
  let seed = 1
  for (let s = 1; s <= 1000; s++) if (individualFlags(roster, d.id, rollTraits(roster, d.id, s)).length > individualFlags(roster, d.id, rollTraits(roster, d.id, seed)).length) seed = s
  const traits = rollTraits(roster, d.id, seed)
  frames.cards.push({ id: d.id, version: '2.0', seed, name: 'pip', serial: 42, hatched: '2026-09-27', egg: 'turn', out: cardLines(roster, d, { version: '2.0', plate: cardPlate(d, '2.0'), traits, name: 'pip', serial: 42, hatched: '2026-09-27', egg: 'turn' }) })
}
// Plate colours every client must reproduce: each row's colour, and every distinct glyph of one frame.
frames.plateColors = []
for (const d of plates ? roster.daemons.filter(d => d.plate) : []) {
  for (const shiny of [false, true]) {
    const rows = plates.daemons[d.id].reveal['2.0'].idle[0].split('\n')
    const cells = []
    rows.forEach((row, r) => [...row].forEach((ch, c) => {
      if (ch !== ' ' && (c + r) % 7 === 0) cells.push({ r, c, ch, hex: plateColor(roster, d, rows.length, r, ch, { shiny }) })
    }))
    frames.plateColors.push({ id: d.id, size: 'reveal', v: '2.0', mood: 'idle', frame: 0, shiny, bg: '#0c0c0c', rows: rows.length, cells })
  }
}
// An individual's colours: its colour family down the rows, its markings in its accent, its extra in
// the extra's colour and its odd eye (render.mjs rollTraits, bake.mjs individualColor), at the portrait
// width. Each case carries its rows and material rows, so a port checks its painting without a model.
frames.individualColors = []
for (const d of roster.daemons.filter(d => d.traits && plateModels[d.id])) {
  const traits = { ...rollTraits(roster, d.id, 1), marks: d.traits.marks[1][0], extra: d.traits.extras[0][0], oddEye: true }
  const mats = []
  const frame = shade(plateModels[d.id].model({ t: 0, mood: 'idle', age: '2.0', traits }), rules.plate.cols.portrait, { mats })
  const box = cropBox([frame]), rows = crop([frame], box)[0], cells = crop([mats], box)[0]
  for (const shiny of [false, true]) {
    const out = []
    rows.forEach((row, r) => [...row].forEach((ch, c) => {
      if (ch !== ' ' && (cells[r][c] !== '.' || (c + r) % 7 === 0)) out.push({ r, c, ch, mat: cells[r][c], hex: individualColor(roster, d, traits, rows.length, r, ch, cells[r][c], { shiny }) })
    }))
    frames.individualColors.push({ id: d.id, traits, shiny, bg: '#0c0c0c', rows: rows.join('\n'), mats: cells.join('\n'), cells: out })
  }
}
for (const c of frames.cells) {
  if (c.out.length !== rules.statusCells + 2) fail(`${c.id} ${c.v} ${c.mood}: status cell is ${c.out.length} wide, not ${rules.statusCells + 2}`)
  if (c.out.trimEnd().length > rules.statusCells + 2) fail(`${c.id} ${c.v} ${c.mood}: status cell content overflows`)
}
// Eggs: the stage for progress, the first egg over its habits, and every one-line look (every client
// shows the same egg for the same progress).
frames.eggStages = [[0, 40, false], [1, 40, false], [13, 40, false], [14, 40, false], [26, 40, false], [27, 40, false], [39, 40, false],
  [40, 40, false], [40, 40, true], [0, 3, true], [1, 3, false], [2, 3, false], [0, 1, false], [0, 0, false]]
  .map(([done, need, ready]) => ({ done, need, ready, stage: eggStage(done, need, ready) }))
const habitCases = [[], ['turn'], ['split'], ['split', 'find'], ['split', 'find', 'store'], ['turn', 'split'],
  ['turn', 'split', 'find'], habitKeys, ['turn', 'turn', 'bogus']]
frames.firstEgg = habitCases.flatMap(habits => ['first', 'setup'].map(kind => {
  const { done, need } = habitProgress(roster, habits, kind)
  const stage = eggStage(done, need)
  return { habits, kind, done, need, stage, out: eggLine(roster, kind, stage) }
}))
frames.eggLines = []
for (const kind of Object.keys(rules.eggs)) {
  for (const stage of eggLineStages.filter(s => s !== 'blink')) {
    for (const lid of [null, '-']) frames.eggLines.push({ kind, stage, lid, out: eggLine(roster, kind, stage, { lid }) })
  }
}
for (const d of roster.daemons) {
  const sprite = renderSprite(roster, d, 0, 'idle')
  frames.eggLines.push({ kind: 'first', stage: 'hatchling', id: d.id, sprite, out: eggLine(roster, 'first', 'hatchling', { sprite }) })
}
// Egg colours every client must reproduce: the ready egg (plain light, the eyes peeking), and the
// opening's light in each rarity's colour, a secret's dimmed; every material cell and every 7th other.
frames.eggColors = []
for (const kind of plates ? ['first', 'night'] : []) {
  for (const [stage, frame, light, dim] of [['p4', 0, 'plain', false], ...rules.rarities.map(r => ['burst', 3, r, r === 'secret'])]) {
    const { rows: text, mats: matText } = plates.eggs[kind].reveal[stage][frame]
    const rows = text.split('\n'), mats = matText.split('\n')
    const cells = []
    rows.forEach((row, r) => [...row].forEach((ch, c) => {
      if (ch !== ' ' && (mats[r][c] !== '.' || (c + r) % 7 === 0)) cells.push({ r, c, ch, mat: mats[r][c], hex: eggColor(roster, kind, rows.length, r, ch, mats[r][c], { light, dim }) })
    }))
    frames.eggColors.push({ kind, size: 'reveal', stage, frame, light, dim, bg: '#0c0c0c', rows: rows.length, cells })
  }
}
// Individuals: the roll, the flags and the rarity for a spread of seeds, and the first seed that rolls
// each colour, marking, extra, odd eye and proportion flag. Every port (the server's first) must match
// these exactly.
frames.traitRolls = []
for (const d of roster.daemons.filter(d => d.traits)) {
  const T = d.traits, want = new Map()
  for (const [c] of T.colours) want.set(`colour ${c}`, null)
  for (const [m] of T.marks) if (m) want.set(`marks ${m}`, null)
  for (const [x] of T.extras) if (x) want.set(`extra ${x}`, null)
  want.set('odd-eye', null)
  for (const f of Object.values(T.flags ?? {})) for (const x of [f.high, f.low].filter(Boolean)) want.set(`flag ${x}`, null)
  for (let seed = 1; seed < 200000 && [...want.values()].includes(null); seed++) {
    const tr = rollTraits(roster, d.id, seed), flags = individualFlags(roster, d.id, tr).split(' ')
    const hits = [`colour ${tr.colour}`, `marks ${tr.marks}`, `extra ${tr.extra}`, ...(tr.oddEye ? ['odd-eye'] : []), ...flags.filter(f => f.startsWith('--')).map(f => `flag ${f.slice(2)}`)]
    for (const h of hits) if (want.get(h) === null) want.set(h, seed)
  }
  for (const [what, seed] of want) if (seed === null) fail(`${d.id}: no seed below 200000 rolls ${what}`)
  const seeds = [...new Set([0, 1, 2, 3, 42, 1000, 65535, 2147483648, 4294967295, ...want.values()])].filter(s => s !== null).sort((a, b) => a - b)
  for (const seed of seeds) {
    const traits = rollTraits(roster, d.id, seed)
    frames.traitRolls.push({ id: d.id, seed, traits, flags: individualFlags(roster, d.id, traits), oneIn: oneIn(roster, d.id, traits) })
  }
}
// An individual's status line: with each rare extra, fidgety, and plain; every version and mood, at
// rest and 150 ms on (a fidgety one's work frames turn twice as fast), and the cell it sits in.
frames.individualSprites = []
for (const d of roster.daemons.filter(d => d.traits)) {
  const rolls = frames.traitRolls.filter(r => r.id === d.id)
  const picks = [rolls.find(r => !r.traits.extra && r.traits.temper === 'calm'), rolls.find(r => r.traits.temper === 'fidgety'),
    ...d.traits.extras.filter(e => e[0]).map(([x]) => rolls.find(r => r.traits.extra === x))]
  for (const { seed, traits } of [...new Set(picks.filter(Boolean))]) {
    const base = vi => baseWidth(roster, individualDaemon(roster, d.id, traits), vi)
    for (const [vi, v] of rules.versions.entries()) {
      for (const mood of rules.moods) {
        for (const t of [0, 150]) {
          const out = renderIndividualSprite(roster, d.id, traits, vi, mood, { t })
          frames.individualSprites.push({ id: d.id, seed, v, mood, t, lid: null, out, cell: statusCell(roster, out, base(vi)) })
        }
      }
      const out = renderIndividualSprite(roster, d.id, traits, vi, 'idle', { lid: '-' })
      frames.individualSprites.push({ id: d.id, seed, v, mood: 'idle', t: 0, lid: '-', out, cell: statusCell(roster, out, base(vi)) })
    }
  }
}
frames.banners = roster.daemons.map(d => ({ id: d.id, out: renderBanner(banner, d.id) }))
output('daemons/frames.json', JSON.stringify(frames) + '\n')

// The lookbook draws from the roster itself, so art and odds never drift from what ships.
const lookbookPath = resolve(root, 'daemons/lookbook.html')
if (existsSync(lookbookPath)) {
  const page = readFileSync(lookbookPath, 'utf8')
  const start = '<!-- roster:start -->', end = '<!-- roster:end -->'
  const a = page.indexOf(start), b = page.indexOf(end)
  if (a < 0 || b < a) {
    console.error('daemons/lookbook.html has no roster markers')
    process.exit(1)
  }
  const data = JSON.stringify({ ...roster, banner, plates }).replace(/</g, '\\u003c')
  output('daemons/lookbook.html', page.slice(0, a + start.length) + `\n<script type="application/json" id="roster-data">${data}</script>\n` + page.slice(b))
}
console.log(check ? 'daemons: roster and copies are current' : `daemons: ${roster.daemons.length} daemons checked, copies written`)
