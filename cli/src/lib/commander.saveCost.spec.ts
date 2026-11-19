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
// Every flush a save makes: the state writer's (lib/secureState.ts imports node:fs).
const flushes = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, fsyncSync: (fd: number) => { flushes.count++; return actual.fsyncSync(fd) } }
})

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

function fullMirror(): CommanderMirror {
  writeFullHistory()
  const mirror = new CommanderMirror({ send: () => {}, sendWeb: () => {}, hasDevice: () => true, dataDir: dir,
    summarize: async () => null })
  expect(mirror.sessions()).toHaveLength(SESSIONS)
  return mirror
}

/** Times [save] SAVES times, and says its median, p95 and flushes a save. */
function measure(name: string, save: () => void): void {
  const times: number[] = []
  flushes.count = 0
  for (let i = 0; i < SAVES; i++) {
    const start = performance.now()
    save()
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  const median = (times[SAVES / 2 - 1] + times[SAVES / 2]) / 2
  const p95 = times[Math.ceil(SAVES * 0.95) - 1]
  const bytes = FILES.reduce((sum, file) => sum + statSync(join(dir, file)).size, 0)
  // Straight to stdout: vitest's default reporter drops a passing case's console lines.
  process.stdout.write(`${name} · ${SESSIONS} sessions · ${bytes} bytes · median ${median.toFixed(1)} ms · p95 ${p95.toFixed(1)} ms`
    + ` · ${flushes.count / SAVES} fsyncs a save\n`)
  for (const file of FILES) expect(() => JSON.parse(readFileSync(join(dir, file), 'utf8'))).not.toThrow()
}

it.runIf(process.env.RECAP_SAVE_COST === '1')('a recap save with a full history', () => {
  // The save as the timer makes it: the private scheduler, then the 200 ms it waits.
  const scheduler = fullMirror() as unknown as { saveSoon(): void }
  measure('recap save', () => { scheduler.saveSoon(); vi.advanceTimersByTime(200) })
})

it.runIf(process.env.RECAP_SAVE_COST === '1')('the save as the process stops, with a full history', () => {
  const mirror = fullMirror()
  measure('save before stop', () => mirror.saveBeforeStop())
})
