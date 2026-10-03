// Bakes the cracked-open eggs: progress p0..p4, then rock, burst, tumble, open; plus a tight crop of
// the resting egg for thumbnails.
import fs from 'node:fs'
const { plate } = await import('./plate.mjs')
const m = await import('./egg2.mjs')
const COLS = 64
function cropAll(seq) {
  let left = 999, right = 0, top = 999, bottom = 0
  for (const f of seq) f.rows.forEach((l, i) => { const a = l.search(/\S/); if (a >= 0) { left = Math.min(left, a); right = Math.max(right, l.trimEnd().length); top = Math.min(top, i); bottom = Math.max(bottom, i + 1) } })
  const cut = (lines) => lines.slice(top, bottom).map((l) => l.slice(left, right).padEnd(right - left)).join('\n')
  return seq.map((f) => ({ stage: f.stage, rows: cut(f.rows), mats: cut(f.mats) }))
}
const out = {}
for (const kind of Object.keys(m.KINDS)) {
  const seq = []
  const add = (name, opts) => { const mats = []; const rows = plate(m.model({ kind, ...opts }), COLS, { mats }); seq.push({ stage: name, rows, mats }) }
  for (let i = 0; i < 8; i++) add('p0', { stage: 'rest', t: (i / 8) * Math.PI * 2 })
  for (const lvl of [1, 2, 3]) add('p' + lvl, { stage: 'crack', level: lvl })
  for (let i = 0; i < 8; i++) add('p4', { stage: 'crack', level: 4, t: (i / 8) * Math.PI * 2, rock: 0.08 })
  for (let i = 0; i < 8; i++) add('rock', { stage: 'crack', level: 4, t: (i / 8) * Math.PI * 2, rock: 0.24 })
  for (const b of [0.12, 0.28, 0.45, 0.62, 0.8, 1]) add('burst', { stage: 'burst', b, t: b * 9 })
  for (const p of [0.08, 0.2, 0.34, 0.48, 0.62, 0.76, 0.9, 1]) add('tumble', { stage: 'tumble', p })
  add('open', { stage: 'open' })
  const entry = {}
  for (const f of cropAll(seq)) (entry[f.stage] ??= []).push({ rows: f.rows, mats: f.mats })
  entry.thumb = cropAll(seq.filter((f) => f.stage === 'p0')).map((f) => ({ rows: f.rows, mats: f.mats }))
  out[kind] = entry
  process.stderr.write(kind + ' ')
}
fs.writeFileSync(process.argv[2], JSON.stringify(out))
