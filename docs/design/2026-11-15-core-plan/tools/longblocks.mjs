// The longest runs of non-idle samples in a V8 CPU profile, and what they spent their time in.
import { readFileSync } from 'node:fs'
const [file, fromUs, toUs] = process.argv.slice(2)
const p = JSON.parse(readFileSync(file, 'utf8'))
const byId = new Map(p.nodes.map(n => [n.id, n]))
const parent = new Map()
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const name = (id) => { const n = byId.get(id); const f = n.callFrame; return `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}` }
const stack = (id) => { const out = []; for (let at = id; at !== undefined; at = parent.get(at)) out.push(name(at)); return out }
let t = p.startTime
const samples = p.samples.map((id, i) => { t += p.timeDeltas[i]; return { id, t } })
const idle = (id) => { const f = byId.get(id).callFrame.functionName; return f === '(idle)' }
const runs = []
let cur = null
for (let i = 0; i < samples.length; i++) {
  const s = samples[i]
  if (fromUs && (s.t < +fromUs || s.t > +toUs)) { if (cur) { runs.push(cur); cur = null } continue }
  if (idle(s.id)) { if (cur) { cur.end = s.t; runs.push(cur); cur = null } continue }
  if (!cur) cur = { start: s.t, end: s.t, ids: [] }
  cur.ids.push(s.id); cur.end = s.t
}
if (cur) runs.push(cur)
runs.sort((a, b) => (b.end - b.start) - (a.end - a.start))
console.log('profile', ((p.endTime - p.startTime) / 1e6).toFixed(1), 's; window', fromUs ? (((+toUs) - (+fromUs)) / 1e6).toFixed(1) + ' s' : 'all', '; samples', samples.length)
for (const r of runs.slice(0, 6)) {
  const ms = (r.end - r.start) / 1000
  const counts = new Map()
  for (const id of r.ids) for (const frame of new Set(stack(id))) counts.set(frame, (counts.get(frame) ?? 0) + 1)
  const top = [...counts].filter(([f]) => !/^\(root\)|^\(program\)/.test(f)).sort((a, b) => b[1] - a[1]).slice(0, 14)
  console.log(`\n== ${ms.toFixed(0)} ms at +${fromUs ? ((r.start - +fromUs) / 1000).toFixed(0) : r.start} ms, ${r.ids.length} samples`)
  for (const [f, c] of top) console.log(`  ${(100 * c / r.ids.length).toFixed(0)}%  ${f}`)
}
