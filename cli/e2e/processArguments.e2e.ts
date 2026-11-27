/**
 * No process of the daemon shows a variable of its environment where its arguments are read.
 *
 * On 2026-11-17 `pgrep -fl harnessd` on a Mac listed the daemon's master and service processes with variables of their
 * environment after their names, a session's token among them. Each set `process.title`, and on Unix libuv writes a
 * title over the start of the process's argument area and blanks the rest. On macOS the environment follows that area,
 * and `pgrep -f`, which skips the blank strings, printed its first variables as the process's arguments.
 * Spec: docs/plans/2026-11-17-harnessd-process-title-env-design.md.
 *
 * It reads only the process groups it started itself, and never runs `pgrep -f` without `-g`: on a developer's Mac
 * that lists every process on the machine, their own daemon's environment with it.
 */
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { processTable } from '../src/testing/spawnedRuns.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { harnessdProcesses } from './harness/endurance.js'

/** A value no real variable holds. */
const SENTINEL = `sentinel-${randomBytes(8).toString('hex')}`

/** What a reader of arguments is shown for each process of the group [pgid] leads, by pid: `pgrep -fl` on macOS,
 *  `/proc/<pid>/cmdline` on Linux. */
function shownArguments(pgid: number): Map<number, string> {
  if (process.platform === 'darwin') {
    // `.`: every process of the group. Never without -g: that lists every process on the machine.
    const listed = execFileSync('pgrep', ['-fl', '-g', String(pgid), '.'], { encoding: 'utf8' })
    return new Map(listed.split('\n').flatMap((line) => {
      const row = /^(\d+) (.*)$/.exec(line)
      return row ? [[Number(row[1]), row[2]] as const] : []
    }))
  }
  // A probe the daemon ran (`ps`, `lsof`) can be gone between the listing and the read: left out.
  const read = (pid: number): string | null => {
    try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ') } catch { return null }
  }
  return new Map(processTable().filter((row) => row.pgid === pgid).flatMap((row) => {
    const shown = read(row.pid)
    return shown === null ? [] : [[row.pid, shown] as const]
  }))
}

describe('the daemon\'s processes', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('show their own arguments, and no variable of their environment, where arguments are read', async () => {
    const d = daemon = await IsolatedDaemon.create({ env: { HARNESSD_SERVICES: 'search' } })
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-80).join('\n')}`) })
    // First in the environment: after a title, pgrep -f showed the environment's first strings, one fewer than the
    // process had arguments (two for `node cli.js __harnessd`). A variable further down was never shown.
    const rest = { ...d.env }
    for (const name of Object.keys(d.env)) delete d.env[name]
    Object.assign(d.env, { E2E_ARGUMENTS_SENTINEL: SENTINEL }, rest)

    // The control, on macOS: a process of the test's own, with this environment, that sets a title shows the
    // sentinel to this reader. Without it a reader that saw nothing would pass for a daemon that leaks.
    if (process.platform === 'darwin') {
      const control = spawn(process.execPath,
        ['-e', 'process.title = "control"; process.stdout.write("up\\n"); setTimeout(() => {}, 30_000)'],
        { env: d.env, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
      try {
        // Up, or gone by name: a control that ended first would otherwise hold the test to its own timeout.
        await new Promise<void>((up, failed) => {
          control.stdout!.once('data', () => up())
          control.once('error', failed)
          control.once('exit', (code, signal) => failed(new Error(`the control process ended before it was up (${signal ?? code})`)))
        })
        expect(shownArguments(control.pid!).get(control.pid!)?.includes(SENTINEL),
          'the reader sees the environment of a process that sets a title').toBe(true)
      } finally { try { process.kill(-control.pid!, 'SIGKILL') } catch { /* gone */ } }
    }

    await d.start()
    await until('search to connect to the core', () => d.log().includes('[services] search connected') || null, 30_000, 200)
    const shown = shownArguments(d.pid!)
    const logged = harnessdProcesses(d)
    const ends = { master: ' __harnessd', core: ' __run', search: ' __service search' }
    const own = Object.keys(ends).map((name) => [name, logged.get(name)] as const)
    // Names only, in every message: a failure prints nothing of what was read.
    expect(own.filter(([, pid]) => !pid || !shown.has(pid)).map(([name]) => name), 'processes of the daemon that were not read').toEqual([])
    expect(own.filter(([, pid]) => shown.get(pid!)!.includes(SENTINEL)).map(([name]) => name),
      'processes whose arguments show a variable of their environment').toEqual([])
    expect(own.filter(([name, pid]) => !shown.get(pid!)!.trimEnd().endsWith(ends[name as keyof typeof ends])).map(([name]) => name),
      'processes whose arguments are not their own').toEqual([])
  })
})
