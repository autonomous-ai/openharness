import fs from 'node:fs'
const { plate } = await import('./plate.mjs')
const m = await import('./egg2.mjs')
const COLS = 46
const r = (o) => plate(m.model({ kind: 'first', ...o }), COLS)
const frames = [
  ['1. 0/40 turns: whole', r({ stage: 'rest' })],
  ['2. 10/40: a crack', r({ stage: 'crack', level: 1 })],
  ['3. 20/40: across, chipped', r({ stage: 'crack', level: 2 })],
  ['4. 30/40: splits, light in', r({ stage: 'crack', level: 3 })],
  ['5. 40/40 ready: eyes peek', r({ stage: 'crack', level: 4 })],
  ['6. you open it: light bursts', r({ stage: 'burst', b: 0.75 })],
  ['7. the top breaks in two', r({ stage: 'tumble', p: 0.45 })],
  ['8. cracked open', r({ stage: 'open' })],
]
// one crop for all, so they line up
let left = 99, right = 0, top = 99, bottom = 0
for (const [, f] of frames) f.forEach((l, i) => { const a = l.search(/\S/); if (a >= 0) { left = Math.min(left, a); right = Math.max(right, l.trimEnd().length); top = Math.min(top, i); bottom = Math.max(bottom, i + 1) } })
const cut = (f) => f.slice(top, bottom).map((l) => l.slice(left, right).padEnd(right - left))
// 9: tim rises out of the bottom half
const P = JSON.parse(fs.readFileSync('REPO/daemons/plates.json', 'utf8'))
const tim = P.daemons.tim.portrait['0.1'].idle[0].split('\n')
const open = cut(frames[7][1])
const firstShell = open.findIndex((l) => l.trim())
const W = right - left
const center = (l) => (' '.repeat(Math.max(0, Math.floor((W - l.length) / 2))) + l).padEnd(W).slice(0, W)
const risen = [...tim.map(center), ...open.slice(firstShell + 1)]
const pad = (lines, h) => [...Array(Math.max(0, h - lines.length)).fill(' '.repeat(W)), ...lines]
const all = [...frames.map(([t, f]) => [t, cut(f)]), ['9. tim hatches', risen]]
const rows = []
for (let i = 0; i < all.length; i += 3) {
  const group = all.slice(i, i + 3)
  const h = Math.max(...group.map(([, f]) => f.length))
  const padded = group.map(([t, f]) => [t, pad(f, h)])
  for (let k = 0; k < h; k++) rows.push(padded.map(([, f]) => f[k]).join('  ').trimEnd())
  rows.push(padded.map(([t]) => t.padEnd(W)).join('  ').trimEnd())
  rows.push('')
}
console.log(rows.join('\n'))
