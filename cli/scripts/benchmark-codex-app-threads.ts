/** The ChatGPT app's threads read (`CodexAppThreads`): warm reads of 20, 200 and 2,000 threads, a read while the app's
 * writer holds the WAL, a first read that parses the JSON file, and the devices event loop's block before and after.
 * Only on fixture Codex homes in a throwaway folder: never the real `~/.codex`, never a real home.
 * Run from cli/: node --import tsx scripts/benchmark-codex-app-threads.ts [output.json]
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

const output = process.argv[2]

// A throwaway home before any module of the tree loads: a module that resolves a path under the home at load time
// lands here, never in the person's own.
const home = mkdtempSync(join(tmpdir(), 'harness-codex-app-threads-'))
process.env.HOME = home
process.env.USERPROFILE = home
for (const [name, folder] of [['ADAPTER_DATA_DIR', 'data'], ['ADAPTER_RUNTIME_DIR', 'runtime'], ['HARNESS_AUTH_DIR', 'auth']]) {
  process.env[name] = join(home, folder)
  mkdirSync(process.env[name]!)
}
delete process.env.HARNESS_ENV_FILE
delete process.env.DOTENV_CONFIG_PATH

const RUNS = 100
const PROJECTS = 4
// The size of a long-used app's sidebar file.
const STATE_BYTES = 135_000
const START = 1_794_000_000_000

interface Case { name: string; threads: number; runs: number; medianMs: number; p90Ms: number; rows: number }
interface Loop { maxMs: number; p99Ms: number }

try {
  const { CodexAppThreads } = await import('../src/cable/hosts/codexAppThreads.js')
  const { codexAppFixture } = await import('../src/testing/codexAppFixture.js')

  const uuid = (i: number): string => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`
  /** A Codex home of `count` threads, one second apart, half of them in 4 projects, each named in the session index. */
  function codexHome(count: number) {
    const fixture = codexAppFixture(join(home, `codex-${count}`))
    const ids = Array.from({ length: count }, (_, i) => uuid(i))
    fixture.threads(ids.map((id, i) => ({ id, cwd: `/work/project-${i % PROJECTS}`, recencyAtMs: START + i * 1000 })))
    const projectOrder = Array.from({ length: PROJECTS }, (_, p) => `/work/project-${p}`)
    const assignments = Object.fromEntries(ids.filter((_, i) => i % 2 === 0)
      .map((id, i) => [id, { projectKind: 'local', projectId: projectOrder[i % PROJECTS] }]))
    fixture.state({ projectOrder, assignments, padTo: STATE_BYTES })
    ids.forEach((id, i) => fixture.name(id, `Thread ${i}`))
    return fixture
  }

  const round2 = (n: number): number => Math.round(n * 100) / 100
  const at = (sorted: readonly number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!
  async function measure(name: string, threads: number, run: () => Promise<number>): Promise<Case> {
    const times: number[] = []
    let rows = 0
    for (let i = 0; i < RUNS; i++) {
      const start = performance.now()
      rows = await run()
      times.push(performance.now() - start)
    }
    times.sort((a, b) => a - b)
    return { name, threads, runs: RUNS, medianMs: round2(at(times, 0.5)), p90Ms: round2(at(times, 0.9)), rows }
  }
  const rowsOf = async (reader: InstanceType<typeof CodexAppThreads>): Promise<number> => {
    const read = await reader.read()
    if (!read.ok) throw new Error('a fixture read failed')
    return read.rows
  }
  /** The reader parses the JSON file on its first read; the warm cases time the reads after it. */
  async function warm(path: string): Promise<InstanceType<typeof CodexAppThreads>> {
    const reader = new CodexAppThreads(path)
    await rowsOf(reader)
    return reader
  }

  const homes = new Map([20, 200, 2000].map((count) => [count, codexHome(count)]))
  const cases: Case[] = []
  for (const [count, fixture] of homes) {
    const reader = await warm(fixture.home)
    cases.push(await measure(`warm-${count}`, count, () => rowsOf(reader)))
  }

  const fixture200 = homes.get(200)!
  // The app's writer holds a write in the WAL, so the store is not idle and the read opens it mode=ro.
  const writer = fixture200.writer()
  try {
    writer.exec('PRAGMA wal_autocheckpoint = 0')
    writer.exec(`UPDATE threads SET updated_at_ms = ${START} WHERE id = '${uuid(0)}'`)
    const reader = await warm(fixture200.home)
    cases.push(await measure('warm-200-wal', 200, () => rowsOf(reader)))
  } finally {
    writer.close()
  }

  cases.push(await measure('first-200', 200, () => rowsOf(new CodexAppThreads(fixture200.home))))

  const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
  /** The loop's delay over `RUNS` turns, each running `work` once. */
  async function loop(work: () => Promise<unknown>): Promise<Loop> {
    const histogram = monitorEventLoopDelay({ resolution: 1 })
    histogram.enable()
    for (let i = 0; i < RUNS; i++) {
      await turn()
      await work()
    }
    histogram.disable()
    return { maxMs: round2(histogram.max / 1e6), p99Ms: round2(histogram.percentile(99) / 1e6) }
  }
  const reader = await warm(fixture200.home)
  const before = await loop(async () => {})
  const after = await loop(() => rowsOf(reader))

  const result = { node: process.version, platform: platform(), arch: arch(), cases, loop: { before, after } }
  console.log(JSON.stringify(result, null, 2))
  if (output) writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
} finally {
  rmSync(home, { recursive: true, force: true })
}
