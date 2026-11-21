/**
 * What a tier B scenario of the dial eval costs (docs/plans/2026-11-21-dial-app-eval-design.md, "Tier B", D8): the
 * devices process's CPU over the scenario's wall time, its event-loop delay p99 as corePerf.cjs measures it in that
 * process, and the processes under the daemon's root the scenario left running. The daemon exposes no such stat itself.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Seen } from '../../src/testing/dialAppEval/types.js'
import { rootProcesses, workingFolders } from '../../src/testing/rootProcesses.js'
import { alive, processTable } from '../../src/testing/spawnedRuns.js'
import { until, type IsolatedDaemon } from './daemon.js'
import { devicesPids } from './desk.js'

type Cost = NonNullable<Seen['cost']>

const CORE_PERF = join(dirname(fileURLToPath(import.meta.url)), 'corePerf.cjs')
/** The daemon's own processes: its master, its core and its services, whatever Node or link runs them. */
const DAEMON_OWN = /\s__(harnessd|run|service)(\s|$)/
/** A command the daemon runs for a moment (`ps`, the root's `lsof`, `plutil`) can be caught running: only what still
 *  runs after this long is left behind. */
const LEFT_WITHIN_MS = 5_000

/** The settings that have a daemon's devices process measured, its perf files in its root; `nodeOptions` preloads the
 *  probe, for the daemon's NODE_OPTIONS. */
export function costEnv(root: string): { env: Record<string, string>; nodeOptions: string } {
  const dir = join(root, 'perf')
  mkdirSync(dir, { recursive: true })
  return {
    env: { HARNESS_E2E_PERF_DEVICES: '1', HARNESS_E2E_PERF_DIR: dir, HARNESS_E2E_PERF_TOKEN: randomUUID() },
    nodeOptions: `--require=${JSON.stringify(CORE_PERF)}`,
  }
}

/** `ps`'s `time`, `[[dd-]hh:]mm:ss[.cc]`, in ms. */
export function psTime(text: string): number {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(text)
  if (!m) throw new Error(`ps gave no CPU time: ${text.trim()}`)
  const [, days = '0', hours = '0', minutes, seconds] = m
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes!)) * 60_000 + Number(seconds!) * 1_000
}

let ticks: number | undefined
/** The process's CPU time so far, ms. Linux's `ps` prints whole seconds, too coarse for a scenario of seconds, so its
 *  `/proc` stat is read there: utime and stime, fields 14 and 15, in clock ticks. */
function cpuMs(pid: number): number {
  if (process.platform !== 'linux') return psTime(execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }))
  ticks ??= Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }))
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  // After the command, which may hold a space or a bracket: the fields from the third (state) on.
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
  return (Number(fields[11]) + Number(fields[12])) * 1_000 / ticks
}

/** Every process under the root, by pid, with its command. */
function underRoot(root: string): Map<number, string> {
  const table = processTable()
  const { all } = rootProcesses(root, table, process.pid, workingFolders(table))
  return new Map(table.filter((row) => all.includes(row.pid)).map((row) => [row.pid, row.command]))
}

async function perf(port: number, token: string, path: '/start' | '/end'): Promise<Record<string, any>> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'x-harness-perf-token': token }, body: JSON.stringify({ label: 'scenario' }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await answer.json() as Record<string, any>
  if (!answer.ok) throw new Error(`the devices process's perf probe ${path}: ${String(body.error)}`)
  return body
}

/** Time 0 of a scenario's cost; `end()` once its children are ended. */
export async function beginCost(d: IsolatedDaemon): Promise<{ end(): Promise<Cost> }> {
  const pids = devicesPids(d)
  if (pids.length !== 1) throw new Error(`the daemon runs ${pids.length} devices processes, not one`)
  const pid = pids[0]!
  const token = d.env.HARNESS_E2E_PERF_TOKEN!
  const ready = join(d.env.HARNESS_E2E_PERF_DIR!, `core-${pid}.json`)
  const { port } = await until("the devices process's perf probe", () => {
    try { return JSON.parse(readFileSync(ready, 'utf8')) as { port: number } } catch { return null }
  }, 30_000, 50)
  const before = underRoot(d.root)
  await perf(port, token, '/start')
  const cpu = cpuMs(pid)
  const began = Date.now()
  return {
    async end() {
      const used = cpuMs(pid) - cpu
      const wall = Date.now() - began
      const measured = await perf(port, token, '/end')
      const p99 = measured.eventLoop?.p99Ms
      if (typeof p99 !== 'number') throw new Error("the devices process's perf probe measured no event-loop delay")
      const fresh = [...underRoot(d.root)].filter(([at, command]) => !before.has(at) && !DAEMON_OWN.test(command)).map(([at]) => at)
      const deadline = Date.now() + LEFT_WITHIN_MS
      while (fresh.some(alive) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100))
      return {
        cpuPercent: Math.round(1_000 * used / wall) / 10,
        loopP99Ms: Math.round(p99 * 10) / 10,
        leftovers: fresh.filter(alive).length,
      }
    },
  }
}
