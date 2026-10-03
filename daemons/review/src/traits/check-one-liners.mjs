// Throwaway proof for one-liners.json: every species x extra x version x mood x work frame x blink,
// rendered by daemons/tools/render.mjs and held to generate.mjs's sprite checks, plus the extra rules.
import { readFileSync } from 'node:fs'
import { renderSprite, statusCell, baseWidth } from 'REPO/daemons/tools/render.mjs'

const roster = JSON.parse(readFileSync('REPO/daemons/roster.json', 'utf8'))
const traits = JSON.parse(readFileSync(new URL('../traits-data.json', import.meta.url), 'utf8'))
const lines = JSON.parse(readFileSync(process.env.ONE_LINERS ?? new URL('./one-liners.json', import.meta.url), 'utf8'))
const { rules } = roster

// generate.mjs, verbatim
const printable = s => /^[\x20-\x7e]*$/.test(s)
const unsafe = rules.ligatureUnsafe ?? []
const ligature = s => unsafe.find(p => s.includes(p))

const problems = [], notes = []
const fail = m => problems.push(m)
const idle = tpl => tpl.replace(/\{e\}/g, 'o')
const init = roster.daemons.filter(d => d.drop === 'init')
const times = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200]
let renders = 0

// Every species in drop init, every extra it rolls, and nothing else.
for (const d of init) {
  const want = Object.values(traits).find(t => t.id === d.id).traits.extras.filter(([n]) => n).map(([n]) => n)
  const have = Object.keys(lines[d.id] ?? {})
  if (want.join() !== have.join()) fail(`${d.id}: extras ${have} do not match traits ${want}`)
}
for (const id of Object.keys(lines)) if (!init.some(d => d.id === id)) fail(`${id}: not a drop-init species`)

// Every other species' drawings, as templates and as idle renders.
const others = id => roster.daemons.filter(d => d.id !== id).flatMap(d => [...Object.values(d.sprites), ...(d.work ?? [])]
  .map(tpl => ({ who: d.id, tpl, out: renderSprite(roster, { ...d, sprites: { '0.1': tpl, '1.0': tpl, '2.0': tpl } }, 0, 'idle', { motion: false }) })))
const variantsOf = id => Object.entries(lines).filter(([sid]) => sid !== id).flatMap(([sid, ex]) => Object.entries(ex)
  .flatMap(([name, v]) => [...Object.values(v.sprites), ...v.work].map(tpl => ({ who: `${sid}/${name}`, tpl, out: idle(tpl) }))))

for (const d of init) {
  for (const [extra, v] of Object.entries(lines[d.id])) {
    const tag = `${d.id}/${extra}`
    const dv = { ...structuredClone(d), sprites: v.sprites, work: v.work }
    const tpls = [...Object.values(v.sprites), ...v.work]
    if (Object.keys(v.sprites).join() !== rules.versions.join()) fail(`${tag}: sprites must be exactly ${rules.versions}`)
    if (v.work.length !== d.work.length) fail(`${tag}: ${v.work.length} work frames, species has ${d.work.length}`)
    for (const tpl of tpls) {
      const cells = tpl.replace(/\{e\}/g, 'e').length
      if (cells > rules.statusCells) fail(`${tag}: "${tpl}" is ${cells} cells`)
      if (/\{e\}\{e\}/.test(tpl)) fail(`${tag}: eyes touch in "${tpl}"`)
      // render.mjs substitutes /\{([a-zA-Z]+)\}/: anything but {e} would be a part these species lack.
      for (const [, key] of tpl.matchAll(/\{([a-zA-Z]+)\}/g)) if (key !== 'e') fail(`${tag}: "${tpl}" has placeholder {${key}}`)
      if ((tpl.match(/\{e\}/g) ?? []).length !== (d.sprites['2.0'].match(/\{e\}/g) ?? []).length) fail(`${tag}: "${tpl}" has the wrong number of eyes`)
      if (!printable(tpl)) fail(`${tag}: "${tpl}" is not printable ASCII`)
    }
    // Work frames: one width, at most 2 cells between any two, the first is the 2.0 sprite at rest.
    const w = v.work.map(idle)
    if (new Set(w.map(s => s.length)).size !== 1) fail(`${tag}: work frames differ in width`)
    for (let i = 0; i < w.length; i++) for (let j = i + 1; j < w.length; j++) {
      const diff = [...w[i]].filter((c, k) => c !== w[j][k]).length
      if (diff > 2) fail(`${tag}: work frames ${i} and ${j} differ by ${diff} cells`)
    }
    if (v.work[0] !== v.sprites['2.0']) fail(`${tag}: work[0] is not the 2.0 sprite`)
    // generate.mjs's loop (every mood, version, time, lid) plus every work frame at workMs, half workMs
    // (fidgety) and backFrameMs.
    for (const mood of rules.moods) for (const [vi, ver] of rules.versions.entries()) {
      const ts = new Set(times)
      for (let k = 0; k < v.work.length; k++) for (const ms of [d.workMs, d.workMs / 2, rules.backFrameMs]) ts.add(k * ms)
      for (const t of ts) for (const lid of [null, '-', '_']) {
        for (const half of [false, true]) {
          const s = renderSprite(roster, half ? { ...dv, workMs: d.workMs / 2 } : dv, vi, mood, { t, lid })
          renders++
          if (s.length > rules.statusCells) fail(`${tag} ${ver} ${mood}: sprite "${s}" is wider than ${rules.statusCells} cells`)
          if (!printable(s)) fail(`${tag} ${ver} ${mood}: sprite "${s}" is not printable ASCII`)
          if (ligature(s)) fail(`${tag} ${ver} ${mood}: sprite "${s}" has "${ligature(s)}", which fonts draw as one glyph`)
          const cell = statusCell(roster, s, baseWidth(roster, dv, vi))
          if (cell.length !== rules.statusCells + 2) fail(`${tag} ${ver} ${mood}: status cell is ${cell.length} wide`)
        }
      }
    }
    // Distinct: from every other species' sprite and work frame, and from every other species' variants.
    for (const tpl of tpls) {
      for (const o of [...others(d.id), ...variantsOf(d.id)]) {
        if (o.tpl === tpl || o.out === idle(tpl)) fail(`${tag}: "${idle(tpl)}" equals ${o.who}'s "${o.out}"`)
      }
    }
    // The extra shows: 2.0 and 1.0 differ from the species; note where 0.1 does not.
    for (const ver of rules.versions) {
      if (v.sprites[ver] === d.sprites[ver]) (ver === '0.1' ? notes : problems).push(`${tag} ${ver}: same as the species (extra not shown)`)
    }
    // Soft: where the species' younger sprite borrows the baton and this one no longer does.
    for (const [vi, ver] of rules.versions.slice(0, -1).entries()) {
      const b = baseWidth(roster, d, vi), n = baseWidth(roster, dv, vi)
      if (b <= rules.statusCells - 2 && n > rules.statusCells - 2) notes.push(`${tag} ${ver}: ${n} cells, so no borrowed baton (species ${b})`)
    }
  }
  // The three extras of one species never draw alike.
  for (const ver of rules.versions) {
    const seen = Object.entries(lines[d.id]).map(([n, v]) => v.sprites[ver])
    if (new Set(seen).size !== seen.length) fail(`${d.id} ${ver}: two extras draw the same`)
  }
}

console.log(`${renders} renders checked`)
console.log(problems.length ? `PROBLEMS (${problems.length}):\n  ${problems.join('\n  ')}` : 'all checks passed')
if (notes.length) console.log(`notes:\n  ${notes.join('\n  ')}`)

console.log('\n2.0 through statusCell (| marks the 10-cell slot): idle, then each work frame')
for (const d of init) for (const [extra, v] of Object.entries(lines[d.id])) {
  const dv = { ...d, sprites: v.sprites, work: v.work }
  const bw = baseWidth(roster, dv, 2)
  const cells = [renderSprite(roster, dv, 2, 'idle'), ...v.work.map((_, k) => renderSprite(roster, dv, 2, 'work', { t: k * d.workMs }))]
    .map(s => `|${statusCell(roster, s, bw)}|`)
  console.log(`${d.id.padEnd(8)}${extra.padEnd(12)}${cells.join(' ')}`)
}

console.log('\ntable')
for (const d of init) {
  console.log(`${d.id.padEnd(8)}${'(species)'.padEnd(12)}${rules.versions.map(v => idle(d.sprites[v]).padEnd(10)).join('')}`)
  for (const [extra, v] of Object.entries(lines[d.id])) console.log(`${''.padEnd(8)}${extra.padEnd(12)}${rules.versions.map(ver => idle(v.sprites[ver]).padEnd(10)).join('')}`)
}
