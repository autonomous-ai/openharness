// ⌘B's router on a snapshot of a real desk: deciding only, nothing is ever sent (README.md).
// usage (from cli/): npx tsx scripts/route-eval/eval.mts <desk.json> <cases.json[,more.json]> [runs]
import { readFileSync } from 'node:fs'
import { createJevDecide } from '../../src/lib/jev/jevClient.ts'
import { decideRoute, type RouteSession } from '../../src/lib/routeDecide.ts'
type D = { id: string; name: string; machine: string; at: number; asks: string[]; about?: string; stoppedAgoMs?: number }
type Case = { text: string; want: (number | 'new')[]; last?: number }
const desk: D[] = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const sids: (string | null)[] = desk.map((s) => (s as { conversation?: string }).conversation ?? null)
const cases: Case[] = process.argv[3].split(',').flatMap((f) => JSON.parse(readFileSync(f, 'utf8')))
const RUNS = Number(process.argv[4] ?? 2)
// The desktop's order: live newest first, then stopped newest first, 80 at most.
const order = desk.map((_, i) => i).sort((a, b) => ((desk[a].stoppedAgoMs === undefined ? 0 : 1) - (desk[b].stoppedAgoMs === undefined ? 0 : 1)) || (desk[b].at || 0) - (desk[a].at || 0)).slice(0, 80)
const sessions: RouteSession[] = order.map((i) => ({ id: String(i), name: desk[i].name, asks: desk[i].asks, ...(desk[i].about ? { about: desk[i].about } : {}), ...(desk[i].stoppedAgoMs !== undefined ? { stoppedAgoMs: desk[i].stoppedAgoMs } : {}), machine: desk[i].machine, ...(sids[i] ? { conversation: sids[i]! } : {}) }))
const jev = createJevDecide()
let right = 0, wrong = 0, missed = 0, i = 0
const wrongs = new Map<string, number>()
const jobs = cases.flatMap((c) => Array.from({ length: RUNS }, () => c))
await Promise.all(Array.from({ length: 8 }, async () => {
  while (i < jobs.length) {
    const c = jobs[i++]
    const v = await decideRoute({ text: c.text, sessions, projects: [], agents: [], ...(c.last !== undefined ? { last: { id: String(c.last), agoMs: 60_000 } } : {}) }, { jev })
    const got: number | 'new' = v.kind === 'session' ? Number(v.id) : 'new'
    if (c.want.includes(got)) right++; else if (got !== 'new') { wrong++; const k = `${c.text.slice(0, 70)} → ${desk[got as number].name}`; wrongs.set(k, (wrongs.get(k) ?? 0) + 1) } else missed++
  }
}))
console.log(`real router: right ${right}/${jobs.length} (${(100 * right / jobs.length).toFixed(1)}%), WRONG SENDS ${wrong}, missed ${missed}`)
for (const [k, n] of wrongs) console.log(`  WRONG×${n} ${k}`)
