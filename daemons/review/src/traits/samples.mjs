// node samples.mjs <id> <out.json> [n=6]: picks n seeds that show a species' range and renders each
// individual's idle loop (8 frames, 56 columns) with its trait marks.
import fs from 'node:fs'
import { plate } from '../eggproto/plate.mjs'
const [id, outPath, nArg] = process.argv.slice(2)
const N = +(nArg || 6)
const m = await import(`./${id}.mjs?` + Date.now())
const T = m.TRAITS
const pool = Array.from({ length: 3000 }, (_, i) => m.roll(i + 1))
const score = (set) => {
  const count = (k) => new Set(set.map((t) => String(t[k]))).size
  // every colour, marking and extra shown once beats any one shown twice
  const extras = new Set(set.filter((t) => t.extra).map((t) => t.extra)).size
  let s = count('colour') * 10 + count('marks') * 8 + extras * 14 + Math.min(1, set.filter((t) => t.oddEye).length) * 6
  const per = {}; for (const t of set) per[t.colour] = (per[t.colour] ?? 0) + 1
  s -= Object.values(per).reduce((a, n) => a + Math.max(0, n - 1) * 8, 0)
  return s
}
let best = null, bestScore = -1e9, a = 12345
const r = () => ((a = (a * 1103515245 + 12345) >>> 0) / 4294967296)
const special = pool.filter((t) => t.extra || t.oddEye)
for (let trial = 0; trial < 8000; trial++) {
  const ids = new Set(), set = []
  for (let k = 0; k < Math.min(3, N); k++) { const t = special[Math.floor(r() * special.length)]; if (t && !ids.has(t.seed)) { ids.add(t.seed); set.push(t) } }
  while (set.length < N) { const t = pool[Math.floor(r() * pool.length)]; if (!ids.has(t.seed)) { ids.add(t.seed); set.push(t) } }
  const sc = score(set); if (sc > bestScore) { bestScore = sc; best = set }
}
const out = best.map((tr) => {
  const frames = []
  for (let k = 0; k < 8; k++) { const mats = []; const rows = plate(m.model({ t: (k / 8) * Math.PI * 2, traits: tr }), 56, { mats }); frames.push({ rows, mats }) }
  let left = 99, right = 0, top = 99, bottom = 0
  for (const f of frames) f.rows.forEach((l, i) => { const x = l.search(/\S/); if (x >= 0) { left = Math.min(left, x); right = Math.max(right, l.trimEnd().length); top = Math.min(top, i); bottom = Math.max(bottom, i + 1) } })
  const cut = (ls) => ls.slice(top, bottom).map((l) => l.slice(left, right).padEnd(right - left)).join('\n')
  return { id, traits: tr, flags: m.flags(tr), oneIn: m.oneIn(tr), frames: frames.map((f) => ({ rows: cut(f.rows), mats: cut(f.mats) })) }
})
fs.writeFileSync(outPath, JSON.stringify(out))
console.log(out.map((o) => `${o.flags}   1 in ${o.oneIn}`).join('\n'))
