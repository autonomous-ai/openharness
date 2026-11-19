import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CommanderMirror } from './commander.js'

// What one recap save costs with a full history: a measurement for the pull request, not a gate, so it sets no limit
// and runs only when asked (`RECAP_SAVE_COST=1`).
const SESSIONS = 200
const TURNS = 3
// commander.ts's FULL_TEXT_MAX_BYTES and ASK_MAX_CHARS: every stored answer and question at its cap.
const FULL_TEXT_BYTES = 8192
const ASK_CHARS = 1000
const SAVES = 30
const FILES = ['summaries.json', 'summaries-history.json', 'summaries-fulltext.json', 'summaries-asks.json']

let dir = ''
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  dir = mkdtempSync(join(tmpdir(), 'adapter-commander-cost-'))
})
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) })

const text = (length: number, seed: number) => `turn ${seed} `.padEnd(length, 'the agent reports progress. ').slice(0, length)

function writeFullHistory(): void {
  const ids = Array.from({ length: SESSIONS }, (_, i) => `session-${i}`)
  const turns = (length: number) => Object.fromEntries(ids.map((id, i) => [id, Array.from({ length: TURNS }, (_, t) => text(length, i * TURNS + t))]))
  const files = [
    Object.fromEntries(ids.map((id, i) => [id, `Recap ${i}\n\n${text(400, i)}`])),
    turns(400),
    turns(FULL_TEXT_BYTES),
    turns(ASK_CHARS),
  ]
  FILES.forEach((name, i) => writeFileSync(join(dir, name), JSON.stringify(files[i], null, 2)))
}

it.runIf(process.env.RECAP_SAVE_COST === '1')('a recap save with a full history', () => {
  writeFullHistory()
  const mirror = new CommanderMirror({ send: () => {}, sendWeb: () => {}, hasDevice: () => true, dataDir: dir,
    summarize: async () => null })
  expect(mirror.sessions()).toHaveLength(SESSIONS)
  // The save as the timer makes it: the private scheduler, then the 200 ms it waits.
  const scheduler = mirror as unknown as { saveSoon(): void }
  const times: number[] = []
  for (let i = 0; i < SAVES; i++) {
    scheduler.saveSoon()
    const start = performance.now()
    vi.advanceTimersByTime(200)
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  const median = (times[SAVES / 2 - 1] + times[SAVES / 2]) / 2
  const p95 = times[Math.ceil(SAVES * 0.95) - 1]
  const bytes = FILES.reduce((sum, name) => sum + statSync(join(dir, name)).size, 0)
  // Straight to stdout: vitest's default reporter drops a passing case's console lines.
  process.stdout.write(`recap save · ${SESSIONS} sessions · ${bytes} bytes · median ${median.toFixed(1)} ms · p95 ${p95.toFixed(1)} ms\n`)
  for (const name of FILES) expect(() => JSON.parse(readFileSync(join(dir, name), 'utf8'))).not.toThrow()
})
