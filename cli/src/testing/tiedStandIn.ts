/**
 * A service's process stood in for, and killed the way a crash kills it: with no chance to stop what it started
 * (lib/tied.ts). Each crash of a service left its children running on the person's computer, one more per crash, and
 * a spec proves a child ends with its service by starting it here, through the service's own helper, and SIGKILLing
 * this stand-in.
 *
 * The fake program is a shell script, not a Node one: it has logged its pid within milliseconds, before a caller's own
 * short timeout can end it. Its pids are read from the log, never from a grep of argv: the tie's watcher shares its
 * command's argv.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, onTestFinished, vi } from 'vitest'
import { alive } from './spawnedRuns.js'

const CLI = fileURLToPath(new URL('../..', import.meta.url))

export interface TiedScene {
  /** A folder of the scene's own, removed when the test ends; the stand-in's TMPDIR. */
  readonly dir: string
  /** The file a fake appends its pid to, one a line: for a fake the spec writes itself. */
  readonly log: string
  /** Writes `<dir>/<name>`, an executable that logs its pid and waits. `withChild`: it first starts a child that
   *  stays in the program's process group, and logs that pid too. Returns its path. */
  program(name: string, options?: { withChild?: boolean }): string
  pids(): number[]
  /** Runs `body` (an ES module's text, through tsx) in a Node process of its own, in place of the service's, with
   *  `env` over this process's. Once `count` pids are logged (1 unless said) it is SIGKILLed, and every logged pid
   *  must be gone within 10 s. */
  endsWithItsProcess(body: string, options?: { env?: NodeJS.ProcessEnv; count?: number }): Promise<void>
}

/** Called inside a test: its end SIGKILLs every logged pid and the stand-in, by pid, then removes the folder. */
export function tiedScene(): TiedScene {
  const dir = mkdtempSync(join(tmpdir(), 'tied-scene-'))
  const log = join(dir, 'pids')
  const pids = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(Number) : [])
  const gone = (started: number[]) => vi.waitFor(() => expect(started.filter(alive)).toEqual([]), { timeout: 10_000, interval: 20 })
  let standIn: ChildProcess | undefined
  onTestFinished(async () => {
    // By their exact pids, and before their folder goes: this process tracks none of the fakes.
    const started = [...pids(), ...(standIn?.pid === undefined ? [] : [standIn.pid])]
    for (const pid of started) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    try { await gone(started) } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  return {
    dir,
    log,
    pids,
    program(name, { withChild = false } = {}) {
      const path = join(dir, name)
      writeFileSync(path, [
        '#!/bin/sh',
        `echo $$ >> '${log}'`,
        ...(withChild ? [`/bin/sleep 600 & echo $! >> '${log}'`] : []),
        'exec /bin/sleep 600',
        '',
      ].join('\n'), { mode: 0o755 })
      return path
    },
    async endsWithItsProcess(body, { env = {}, count = 1 } = {}) {
      const script = join(dir, 'stand-in.mts')
      writeFileSync(script, `${body}\nsetInterval(() => {}, 1 << 30)\n`)
      const service = spawn(process.execPath, ['--import', 'tsx', script],
        { cwd: CLI, env: { ...process.env, TMPDIR: dir, ...env }, stdio: ['ignore', 'ignore', 'inherit'] })
      standIn = service
      let ended: string | undefined
      service.once('exit', (code, signal) => { ended = String(code ?? signal) })
      // 60 s: tsx loads a large module graph for some services. A stand-in that ends first ends the wait at once.
      await vi.waitFor(() => { if (ended === undefined) expect(pids()).toHaveLength(count) }, { timeout: 60_000, interval: 20 })
      expect(pids(), `the stand-in ended (${ended}) before its pids were logged`).toHaveLength(count)
      service.kill('SIGKILL')
      await gone(pids())
    },
  }
}
