// Renders every drop-3 plate the lookbook needs into plates.json:
// { id: { ages: { '0.1': { idle: [8 frames], <mood>: [4 frames] }, ... }, paper: { ... } } }
import fs from 'node:fs'
const root = 'REPO/daemons'
const { plate, crop } = await import(root + '/tools/plate.mjs')
const IDS = ['octopus', 'tux', 'yak', 'gopher', 'bug', 'gnu', 'lynx', 'mutt', 'auk', 'beastie']
const MOODS = ['idle', 'work', 'need', 'done', 'fail', 'back', 'nap', 'boop']
const COLS = { '0.1': 56, '1.0': 56, '2.0': 56 }
const out = {}
for (const id of IDS) {
  const f = `${root}/plates/${id}.mjs`
  if (!fs.existsSync(f)) continue
  let m
  try { m = await import(f + '?' + Date.now()) } catch (e) { console.error(id, e.message); continue }
  const entry = { ink: {}, paper: {}, small: {} }
  for (const age of ['0.1', '1.0', '2.0']) {
    for (const look of ['ink', 'paper']) {
      const frames = {}
      for (const mood of MOODS) {
        const n = mood === 'idle' ? 8 : 4
        frames[mood] = []
        for (let i = 0; i < n; i++) frames[mood].push(plate(m.model({ t: (i / n) * Math.PI * 2, mood, age }), COLS[age], { paper: look === 'paper' }))
      }
      entry[look][age] = frames
    }
    entry.small[age] = crop([plate(m.model({ t: 0, mood: 'idle', age }), 28)])[0]
  }
  // one crop for every frame of a look, so nothing jumps between moods and ages
  for (const look of ['ink', 'paper']) {
    const all = []
    for (const age in entry[look]) for (const mood in entry[look][age]) all.push(...entry[look][age][mood])
    const cropped = crop(all)
    let k = 0
    for (const age in entry[look]) for (const mood in entry[look][age]) entry[look][age][mood] = entry[look][age][mood].map(() => cropped[k++].join('\n'))
  }
  for (const age in entry.small) entry.small[age] = entry.small[age].join('\n')
  out[id] = entry
  console.error(id, 'ok')
}
fs.writeFileSync(process.argv[2], JSON.stringify(out))
