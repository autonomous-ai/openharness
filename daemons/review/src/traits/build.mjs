// Picks twelve seeds that show every trait, and renders each tim's idle loop with its trait marks.
import fs from 'node:fs'
import { plate } from '../eggproto/plate.mjs'
import * as m from './tim.mjs'
const NAMES = ['pip', 'zed', 'ada', 'nim', 'dot', 'kip', 'bix', 'rho', 'lux', 'moe', 'sol', 'ivy']
// Choose a dozen that show the range: every colour at most twice, every marking, both tempers,
// and each rare extra (at their real odds a dozen random hatches would rarely show one).
const pool = Array.from({ length: 4000 }, (_, i) => m.roll(i + 1))
const score = (set) => {
  const by = (k) => set.reduce((acc, t) => (acc[t[k]] = (acc[t[k]] ?? 0) + 1, acc), {})
  const colours = by('colour'), marks = by('marks'), extras = by('extra')
  let s = Object.keys(colours).length * 10 + Object.keys(marks).length * 10
  s -= Object.values(colours).reduce((a, n) => a + Math.max(0, n - 2) * 15, 0)
  s += Math.min(2, extras.glasses ?? 0) * 12 + Math.min(1, extras.beanie ?? 0) * 12 + Math.min(1, extras.headset ?? 0) * 12
  s += Math.min(1, set.filter((t) => t.oddEye).length) * 12 + Math.min(4, set.filter((t) => t.temper === 'fidgety').length) * 3
  return s
}
const special = pool.filter((t) => t.extra || t.oddEye)
let best = null, bestScore = -1e9
const r = m.rng(42)
for (let trial = 0; trial < 20000; trial++) {
  const set = []
  const ids = new Set()
  for (let k = 0; k < 5; k++) { const t = special[Math.floor(r() * special.length)]; if (!ids.has(t.seed)) { ids.add(t.seed); set.push(t) } }
  while (set.length < 12) { const t = pool[Math.floor(r() * pool.length)]; if (!ids.has(t.seed)) { ids.add(t.seed); set.push(t) } }
  const sc = score(set)
  if (sc > bestScore) { bestScore = sc; best = set }
}
const chosen = best
const flags = (tr) => ['tim', '-c ' + tr.colour, tr.marks && '--' + tr.marks, tr.extra && '--' + tr.extra, tr.oddEye && '--odd-eye',
  tr.head > 1.07 && '--big-head', tr.arms > 1.08 && '--long-arms', tr.curl > 1.25 && '--curly', tr.eyes > 1.15 && '--wide-eyes', tr.temper === 'fidgety' && '--fidgety'].filter(Boolean).join(' ')
const out = chosen.map((tr, i) => {
  const frames = []
  for (let k = 0; k < 8; k++) {
    const mats = []
    const rows = plate(m.model({ t: (k / 8) * Math.PI * 2, traits: tr }), 56, { mats })
    frames.push({ rows, mats })
  }
  // one crop per tim
  let left = 99, right = 0, top = 99, bottom = 0
  for (const f of frames) f.rows.forEach((l, r) => { const a = l.search(/\S/); if (a >= 0) { left = Math.min(left, a); right = Math.max(right, l.trimEnd().length); top = Math.min(top, r); bottom = Math.max(bottom, r + 1) } })
  const cut = (ls) => ls.slice(top, bottom).map((l) => l.slice(left, right).padEnd(right - left)).join('\n')
  console.error(NAMES[i], flags(tr))
  return { name: NAMES[i], traits: tr, flags: flags(tr), frames: frames.map((f) => ({ rows: cut(f.rows), mats: cut(f.mats) })) }
})
fs.writeFileSync(process.argv[2], JSON.stringify(out))
