// Before/after: a Codex resume's rollout repair on a generated rollout, and the longest the event loop is held
// (wall time between 1 ms ticks, and the loop thread's CPU time between them).
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const src = process.env.SRC!
const { prepareResume } = await import(join(src, 'engines/launchPrep.ts'))
const SESSION = '01a0a3cd-a374-71f2-a11a-1fc1cc41b36d'
const MB = Number(process.env.MB ?? 200)
const repairable = process.env.REPAIR === '1'

const profile = mkdtempSync(join(tmpdir(), 'repair-bench-'))
const dir = join(profile, 'sessions', '2026', '11', '15')
mkdirSync(dir, { recursive: true })
const file = join(dir, `rollout-2026-11-15T08-00-00-${SESSION}.jsonl`)
const record = (type: string, payload: unknown) => JSON.stringify({ timestamp: '2026-11-15T08:00:00.000Z', type, payload }) + '\n'
const fd = openSync(file, 'wx')
let written = 0
const write = (s: string) => { written += writeSync(fd, s) }
write(record('session_meta', { id: SESSION, cwd: '/workspace', model_provider: 'openai' }))
for (let i = 1; written < MB * 1024 * 1024; i++) {
  const k = i % 10
  if (k < 4) write(record('response_item', { type: 'message', role: k % 2 ? 'user' : 'assistant', content: [{ type: 'output_text', text: 'word '.repeat(200 + (i % 900)) }] }))
  else if (k < 6) write(record('response_item', { type: 'reasoning', id: `rs_${i}`, summary: [{ type: 'summary_text', text: 'thinking '.repeat(50) }], encrypted_content: 'g'.repeat(2000 + (i % 3000)) }))
  else if (k < 8) write(record('response_item', { type: 'function_call_output', call_id: `call_${i}`, output: 'out\n'.repeat(500 + (i % 5000)) }))
  else if (k === 8) write(record('event_msg', { type: 'token_count', info: { total: i } }))
  else write(record('response_item', { type: 'function_call', call_id: `call_${i}`, name: 'exec', arguments: JSON.stringify({ cmd: 'ls '.repeat(100) }) }))
  if (i % 4000 === 0) write(record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(1_500_000) }] }))
}
if (repairable) write(record('response_item', { type: 'reasoning', id: 'msg_bad', summary: [{ type: 'summary_text', text: 'local' }], content: [] }))
closeSync(fd)
const size = statSync(file).size

const threadCpu = () => { const u = (process as any).threadCpuUsage(); return (u.user + u.system) / 1000 }
await new Promise((r) => setTimeout(r, 50))
let lastWall = performance.now(), maxWall = 0, lastCpu = threadCpu(), maxCpu = 0
const ticker = setInterval(() => {
  const w = performance.now(), c = threadCpu()
  maxWall = Math.max(maxWall, w - lastWall); maxCpu = Math.max(maxCpu, c - lastCpu)
  lastWall = w; lastCpu = c
}, 1)
const started = performance.now()
const cpu0 = process.cpuUsage()
const result = await prepareResume({ engine: 'codex', sessionId: SESSION, transcriptPath: file, codexHome: profile }, () => true)
const took = performance.now() - started
const used = process.cpuUsage(cpu0)
{ const w = performance.now(), c = threadCpu(); maxWall = Math.max(maxWall, w - lastWall); maxCpu = Math.max(maxCpu, c - lastCpu) }
clearInterval(ticker)
console.log(JSON.stringify({ sizeMB: +(size / 1048576).toFixed(1), repaired: result.repairedItems, unrepaired: result.unrepaired, tookMs: Math.round(took), longestWallGapMs: Math.round(maxWall), longestLoopCpuMs: +maxCpu.toFixed(1), processCpuMs: Math.round((used.user + used.system) / 1000) }))
rmSync(profile, { recursive: true, force: true })
